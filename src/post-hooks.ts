import { onAbort, type AbortSignalLike } from './abort.js'
import { invokeHook, type HookTurn, type OperationOutcome } from './hooks.js'

/**
 * How many detached hook runs may be queued or running at once, across the whole
 * server. A run beyond the bound is dropped and logged instead of queued, so a
 * slow or hung detached hook can never grow server memory without limit. The
 * bound equals the connection ceiling, which is also what bounds how many
 * operations can be waiting on a hook at once.
 */
export const MAX_DETACHED_HOOKS = 1024

/**
 * One upload or link request's outcome, settled exactly once. Detached hooks of
 * that operation wait for it, so they start only after the answer was attempted
 * and are told how the operation ended. The first outcome wins.
 */
export class OperationScope {
  readonly outcome: Promise<OperationOutcome>
  private resolve: (outcome: OperationOutcome) => void = () => {}
  private done = false

  constructor() {
    this.outcome = new Promise<OperationOutcome>((resolve) => {
      this.resolve = resolve
    })
  }

  settle(outcome: OperationOutcome): void {
    if (this.done) return
    this.done = true
    this.resolve(outcome)
  }
}

/** Why a detached run did not complete: it threw, was over the bound, or the server closed first. */
export type DetachedProblem = 'failed' | 'dropped' | 'skipped'

export type DetachedHookName = 'afterCommit' | 'afterLink' | 'onFailure'

/** What a report says about a run that did not complete: the hook and its log fields, never data. */
export interface DetachedInfo {
  hook: DetachedHookName
  fields: Readonly<Record<string, unknown>>
}

/** One detached callback call. */
export interface DetachedJob<Context extends object> {
  hook: DetachedHookName
  callback: (context: Context & { readonly outcome: OperationOutcome }) => unknown
  context: Context
  /** What the hook is told: the scope's outcome once it settles, or a fixed one. */
  outcome: OperationScope | OperationOutcome
  /**
   * A place in an ordered line of hooks (per link name, per artifact name),
   * reserved in decision order by the caller. The job owns it: it is released
   * when the call finishes, is dropped, or is skipped.
   */
  turn: HookTurn | null
  /** The artifact's transfer ID, pinned against retention from now until the call ends. */
  pin: string | null
  /** Non-secret fields for the log line when the run did not complete. */
  fields: Readonly<Record<string, unknown>>
}

/**
 * Runs detached post-operation callbacks: on their own, after the operation that
 * asked for them has settled, outside every lease and upload slot, in order per
 * turn line, and best effort. There is no queue on disk and no retry; a call that
 * has not finished when the server closes is lost.
 */
export class DetachedHooks {
  private readonly signal: AbortSignalLike
  private readonly report: (problem: DetachedProblem, info: DetachedInfo) => void
  private readonly jobs = new Set<Promise<void>>()
  private readonly pinned = new Map<string, number>()

  constructor(
    signal: AbortSignalLike,
    report: (problem: DetachedProblem, info: DetachedInfo) => void
  ) {
    this.signal = signal
    this.report = report
  }

  /** Runs that are queued or running. */
  get size(): number {
    return this.jobs.size
  }

  /** Transfer IDs of artifacts a queued or running call still needs, for retention. */
  pins(): Iterable<string> {
    return this.pinned.keys()
  }

  /**
   * Registers a call. Synchronous, so a caller can reserve its turn and register
   * under the same lease and keep decision order; nothing runs before the
   * operation settles. A call over `MAX_DETACHED_HOOKS` is dropped and its turn
   * released.
   */
  start<Context extends object>(job: DetachedJob<Context>): void {
    if (this.jobs.size >= MAX_DETACHED_HOOKS) {
      job.turn?.release()
      this.tell('dropped', job)
      return
    }
    if (job.pin !== null) this.pinned.set(job.pin, (this.pinned.get(job.pin) ?? 0) + 1)
    const run = this.run(job)
    this.jobs.add(run)
    const done = (): void => {
      this.jobs.delete(run)
    }
    void run.then(done, done)
  }

  /**
   * Settles once every run's own bookkeeping is done. After the server's signal
   * aborted this is prompt: waits end and a callback that is still running is
   * abandoned (it keeps running detached), so closing never waits on hook code.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  private tell<Context extends object>(problem: DetachedProblem, job: DetachedJob<Context>): void {
    try {
      this.report(problem, { hook: job.hook, fields: job.fields })
    } catch {}
  }

  private unpin(pin: string | null): void {
    if (pin === null) return
    const count = (this.pinned.get(pin) ?? 0) - 1
    if (count > 0) this.pinned.set(pin, count)
    else this.pinned.delete(pin)
  }

  /** The operation's outcome, or `null` when the server closed first. */
  private async settled(scope: OperationScope): Promise<OperationOutcome | null> {
    let release = (): void => {}
    const aborted = new Promise<null>((resolve) => {
      release = onAbort(this.signal, () => resolve(null))
    })
    try {
      return await Promise.race([scope.outcome, aborted])
    } finally {
      release()
    }
  }

  private async run<Context extends object>(job: DetachedJob<Context>): Promise<void> {
    try {
      const outcome =
        job.outcome instanceof OperationScope ? await this.settled(job.outcome) : job.outcome
      if (outcome === null) {
        this.tell('skipped', job)
        return
      }
      if (job.turn !== null && (await job.turn.ready(this.signal)) === 'aborted') {
        this.tell('skipped', job)
        return
      }
      if (this.signal.aborted) {
        this.tell('skipped', job)
        return
      }
      try {
        const context = { ...job.context, outcome } as Context & {
          readonly outcome: OperationOutcome
        }
        Object.freeze(context)
        // The returned value is never read: `invokeHook` only waits for the call to settle.
        await invokeHook(job.callback, context, this.signal)
      } catch {
        this.tell('failed', job)
      }
    } finally {
      job.turn?.release()
      this.unpin(job.pin)
    }
  }
}
