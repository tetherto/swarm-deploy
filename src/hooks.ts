import { onAbort, type AbortSignalLike } from './abort.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { copyHookResult, type HookResult } from './hook-result.js'
import type { ReleaseCoordinates } from './release.js'
import type { ArtifactKind } from './types.js'

/**
 * Where an operation failed. `link` is an explicit link request that failed
 * before or outside its `afterLink` hook (a policy rejection, a missing target, a
 * conflict, a storage failure); the others describe an upload.
 */
export type HookFailurePhase =
  | 'offer'
  | 'transfer'
  | 'verification'
  | 'beforeCommit'
  | 'commit'
  | 'afterCommit'
  | 'afterLink'
  | 'link'

/**
 * How a post-operation hook takes part in the operation's answer, declared per
 * hook and never inferred from the callback.
 *
 * - `detached` (the default): the callback runs on its own after the answer was
 *   written. Nothing waits for it, its return value is never read, and a failure
 *   of it is logged and can never change an answer already sent.
 * - `response`: the callback is awaited before the answer. It may return a plain
 *   JSON object (see `HookResult`) or `undefined` (no extra data), and a failure
 *   or an unusable value fails the operation.
 */
export type HookResponse = 'response' | 'detached'

/** The post-operation hooks that take a `HookResponse` declaration. */
export interface HookModes {
  afterCommit?: HookResponse
  afterLink?: HookResponse
  onFailure?: HookResponse
}

/** How the operation a hook observes ended, as far as that hook can know. */
export type OperationOutcome =
  | { readonly status: 'succeeded' }
  | {
      readonly status: 'failed'
      /** The stable code of the failure the operation's answer reports. */
      readonly code: ErrorCode
      readonly phase: HookFailurePhase
    }

export type FailedOutcome = Extract<OperationOutcome, { status: 'failed' }>

/** Immutable, secret-free description of the artifact a hook is observing. */
export interface HookArtifact {
  name: string
  kind: ArtifactKind
  size: number
  /** The file digest, or the canonical tree digest. */
  sha256: string
  transferId: string
  /** Present only for a directory artifact. */
  entryCount?: number
  sourceParent?: string
  release?: ReleaseCoordinates
}

export interface BeforeCommitContext {
  artifact: HookArtifact
  /** Absolute path of the verified staging file. */
  path: string
  resumed: boolean
  alreadyCommitted: false
}

export interface AfterCommitContext {
  artifact: HookArtifact
  /** Absolute path of the durably committed artifact. */
  path: string
  resumed: boolean
  alreadyCommitted: boolean
  /**
   * `succeeded` for a `response` hook, which runs before the upload's answer. A
   * `detached` hook runs after the answer and sees how the upload ended: `failed`
   * when a later awaited step (another `response` hook) failed the upload after
   * the artifact was committed.
   */
  outcome: OperationOutcome
}

/** Who owns a managed link: a server rule, or an explicit client request. */
export type HookLinkMode = 'automatic' | 'manual'

/**
 * The link decision this call observed, never proof that anything was published.
 * `LINKED` when this call created or repointed the link, took over an unrecorded
 * symlink (even one whose old text already read as the target), or repaired an
 * automatic link's ownership record; `UNCHANGED` when the link was already owned
 * and already pointed at the target.
 * An earlier attempt, another commit's retention pass or reconciliation, or a
 * concurrent request may have moved the link first, so a fresh upload or request
 * can still see `UNCHANGED`, and a manual ownership-metadata refresh for the same
 * target is `UNCHANGED` too. Decide what to publish from your own record of the
 * link name and artifact transfer ID.
 */
export type HookLinkStatus = 'LINKED' | 'UNCHANGED'

/**
 * What asked for the link: an upload (fresh or already committed) whose
 * artifact an automatic rule selected, or an explicit link request.
 */
export type HookLinkTrigger = 'upload' | 'request'

/** Immutable, secret-free description of the managed link a hook is observing. */
export interface HookLink {
  /** The link's basename in the storage root. */
  name: string
  /** The basename of the committed artifact the link points at. */
  target: string
  mode: HookLinkMode
  /** Absolute path of the link itself, a symbolic link in the storage root. */
  path: string
  /** Absolute path of the committed target artifact. */
  targetPath: string
}

export interface AfterLinkContext {
  link: HookLink
  /** The committed artifact the link was set to point at. */
  artifact: HookArtifact
  status: HookLinkStatus
  trigger: HookLinkTrigger
  /** As for `AfterCommitContext.outcome`. */
  outcome: OperationOutcome
}

/** What `onFailure` is told about a failed operation. */
export interface HookFailureContext {
  /** The operation that failed: an upload connection or an explicit link request. */
  operation: 'upload' | 'link'
  /**
   * The artifact the operation concerned. For an upload it comes from the decoded
   * offer, so it is not yet verified content. For a link request it is the
   * target's durable commit record, or `null` when the request failed before its
   * target was resolved.
   */
  artifact: HookArtifact | null
  /**
   * The best known absolute path, or `null` when none exists, which is the case
   * for every failure before a durable artifact or link: none is made up. For
   * `afterLink` it is the path of the link.
   */
  path: string | null
  phase: HookFailurePhase
  resumed: boolean
  alreadyCommitted: boolean
  error: unknown
  /** Present only when `phase` is `afterLink`. */
  link?: HookLink
  /** Present only for a link request: the name and target it asked for. */
  request?: { readonly name: string; readonly target: string }
  /** Always `failed`: the stable code the operation's answer reports and where it failed. */
  outcome: FailedOutcome
}

/**
 * The post-operation hooks (`afterCommit`, `afterLink`, `onFailure`) are
 * `detached` unless a `HookModes` declaration makes them `response`. A callback
 * may return `void`, `undefined`, or a promise of either; only a `response` hook
 * may return data (a plain JSON object, see `HookResult`), and only when it is
 * declared so. A `detached` hook's return value is never read. `beforeCommit` is
 * not post-operation: it is a validation gate that is always awaited.
 */
export interface ServerHooks {
  beforeCommit?(context: BeforeCommitContext): void | Promise<void>
  afterCommit?(context: AfterCommitContext): void | HookResult | Promise<void | HookResult>
  afterLink?(context: AfterLinkContext): void | HookResult | Promise<void | HookResult>
  /**
   * Runs for a failed operation, including those that fail before any durable
   * artifact or link exists (an offer, a transfer, verification, `beforeCommit`,
   * a commit, or a link request that was refused). Declared `response`, it is
   * awaited before the failed answer and may add data to it; its own failure is
   * logged and never replaces the failure being reported.
   */
  onFailure?(context: HookFailureContext): void | HookResult | Promise<void | HookResult>
}

const WRAPPED_CALLBACK_ERRORS = new WeakMap<SwarmDeployError, unknown>()
/** Every callback name a hooks object or hooks module may carry. */
export const HOOK_NAMES = ['beforeCommit', 'afterCommit', 'afterLink', 'onFailure'] as const

/**
 * Validates and freezes caller hooks. Each property is read exactly once and no
 * receiver is bound, so later mutation of the caller's object cannot change the
 * callbacks a running server invokes.
 */
export function snapshotHooks(hooks: ServerHooks | null | undefined): Readonly<ServerHooks> {
  if (hooks === null || hooks === undefined) return Object.freeze({})
  if (typeof hooks !== 'object') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid hooks')
  }
  for (const name of Reflect.ownKeys(hooks)) {
    if (!(HOOK_NAMES as readonly (string | symbol)[]).includes(name)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Unknown hook')
    }
  }
  const snapshot: ServerHooks = {}
  for (const name of HOOK_NAMES) {
    const callback: unknown = hooks[name]
    if (callback === undefined) continue
    if (typeof callback !== 'function') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name} hook`)
    }
    Object.defineProperty(snapshot, name, {
      value: callback,
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return Object.freeze(snapshot)
}

/** Every hook that takes a `HookResponse` declaration. */
export const HOOK_MODE_NAMES = ['afterCommit', 'afterLink', 'onFailure'] as const

/**
 * Validates and freezes hook declarations against the hooks they describe. Only
 * the post-operation hooks can be declared, only with a known mode, and only if
 * that hook is configured, so a typo fails at construction instead of silently
 * leaving a hook detached. Each property is read exactly once.
 */
export function snapshotHookModes(
  modes: HookModes | null | undefined,
  hooks: Readonly<ServerHooks>
): Readonly<HookModes> {
  if (modes === null || modes === undefined) return Object.freeze({})
  if (typeof modes !== 'object' || Array.isArray(modes)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid hook modes')
  }
  for (const name of Reflect.ownKeys(modes)) {
    if (!(HOOK_MODE_NAMES as readonly (string | symbol)[]).includes(name)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Unknown hook mode')
    }
  }
  const snapshot: HookModes = {}
  for (const name of HOOK_MODE_NAMES) {
    const mode: unknown = modes[name]
    if (mode === undefined) continue
    if (mode !== 'response' && mode !== 'detached') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name} hook mode`)
    }
    if (hooks[name] === undefined) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Hook mode for missing ${name} hook`)
    }
    snapshot[name] = mode
  }
  return Object.freeze(snapshot)
}

/**
 * Wraps a failed callback. The message is fixed so callback text (which may
 * carry secrets) never reaches the wire; the original error stays on `cause`.
 */
export function hookError(phase: HookFailurePhase, cause: unknown): SwarmDeployError {
  const error = new SwarmDeployError(
    ERRORS.HOOK_FAILED,
    `Deployment hook failed during ${phase}`,
    cause
  )
  WRAPPED_CALLBACK_ERRORS.set(error, cause)
  return error
}

/**
 * The checked copy of what a `response` hook returned, or `undefined` for a hook
 * that finished with nothing. Any other value that is not a valid result fails
 * like a throw: `HOOK_FAILED` with a fixed message, and the reason (never the
 * value) on `cause` for `onFailure`.
 */
export function hookResultOf(
  returned: unknown,
  phase: 'afterCommit' | 'afterLink'
): HookResult | undefined {
  if (returned === undefined) return undefined
  try {
    return copyHookResult(returned)
  } catch (cause) {
    throw hookError(phase, cause)
  }
}

/**
 * The error an `onFailure` hook should see: the raw exception for failures this
 * module wrapped, otherwise the error unchanged. Only identity-tracked wrappers
 * unwrap, so a forged `HOOK_FAILED` error cannot masquerade as one.
 */
export function callbackError(error: unknown): unknown {
  return error instanceof SwarmDeployError && WRAPPED_CALLBACK_ERRORS.has(error)
    ? WRAPPED_CALLBACK_ERRORS.get(error)
    : error
}

/**
 * How a hook call ended. `value` is whatever the callback returned or resolved
 * to; the caller decides whether to read it.
 */
export type HookOutcome = { status: 'completed'; value: unknown } | { status: 'aborted' }

/**
 * Calls a callback with no receiver and settles when it does or when the
 * server aborts, whichever is first. A callback that outlives an abort keeps
 * running detached; its later rejection is swallowed.
 */
export async function invokeHook<Context>(
  callback: (context: Context) => unknown,
  context: Context,
  signal: AbortSignalLike
): Promise<HookOutcome> {
  let pending: Promise<unknown>
  try {
    pending = Promise.resolve(callback(context))
  } catch (cause) {
    pending = Promise.reject(cause)
  }
  pending.catch(() => {})
  let release = (): void => {}
  const aborted = new Promise<HookOutcome>((resolve) => {
    release = onAbort(signal, () => resolve({ status: 'aborted' }))
  })
  try {
    return await Promise.race([
      pending.then((value): HookOutcome => ({ status: 'completed', value })),
      aborted
    ])
  } finally {
    release()
  }
}

/** One place in a key's line of hooks. */
export interface HookTurn {
  /**
   * Settles `'ready'` once every earlier turn for the key has been released,
   * or `'aborted'` when the signal aborts first.
   */
  ready(signal: AbortSignalLike): Promise<'ready' | 'aborted'>
  /** Hands the key to the next turn. Safe to call any number of times. */
  release(): void
}

/**
 * First-in, first-out lines of hooks, one per key. Hooks for one key start in
 * reservation order and never overlap; different keys never wait on each other.
 *
 * This is deliberately not a lock around the work the hooks follow: callers
 * reserve while they hold the lease that orders the underlying decisions, so
 * the line matches decision order, and then wait for their turn outside it.
 * Hook code therefore never runs under a storage lease.
 */
export class HookTurns {
  private readonly tails = new Map<string, Promise<void>>()

  /** Keys that still have a pending turn; a drained line is dropped. */
  get size(): number {
    return this.tails.size
  }

  /** Queues behind every earlier turn for `key`. Synchronous, so reservation order is call order. */
  reserve(key: string): HookTurn {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let open = (): void => {}
    const released = new Promise<void>((resolve) => {
      open = resolve
    })
    const tail = previous.then(() => released)
    this.tails.set(key, tail)
    let done = false
    return {
      ready: async (signal) => {
        let remove = (): void => {}
        const aborted = new Promise<'aborted'>((resolve) => {
          remove = onAbort(signal, () => resolve('aborted'))
        })
        try {
          return await Promise.race([previous.then(() => 'ready' as const), aborted])
        } finally {
          remove()
        }
      },
      release: () => {
        if (done) return
        done = true
        open()
        void tail.then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key)
        })
      }
    }
  }
}
