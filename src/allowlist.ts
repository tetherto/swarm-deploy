import EventEmitter from '#events'
import fs from '#fs'
import { parsePublicKey } from './identity.js'
import type { StorageAdapter } from './storage/types.js'
import type { Logger, ServerScheduler } from './types.js'

const DEFAULT_POLL_INTERVAL = 5_000
const MAX_POLL_INTERVAL = 0x7fffffff

export type AllowlistStorage = Pick<StorageAdapter, 'readFile'>
export type AllowlistScheduler = Pick<ServerScheduler, 'setInterval' | 'clearInterval'>
export type AllowlistLogger = Logger

export interface AllowlistReloadedEvent {
  count: number
}

export interface AllowlistRemovedEvent {
  removed: number
}

export interface AllowlistFailureEvent {
  reason: string
}

export interface AllowlistWatcherOptions {
  filePath: string
  storage?: Pick<StorageAdapter, 'readFile'>
  onReload(keys: Set<string>): void | Promise<void>
  /** `null` is accepted and treated as "no handler". */
  onFailure?: ((event: AllowlistFailureEvent) => void) | null
  pollInterval?: number
  scheduler?: Pick<ServerScheduler, 'setInterval' | 'clearInterval'>
  logger?: Logger | null
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const { code } = error
  return typeof code === 'string' && code.length > 0 ? code : null
}

function wasAllowlistApplied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'allowlistApplied' in error &&
    error.allowlistApplied === true
  )
}

function assertPollInterval(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_POLL_INTERVAL
  ) {
    throw new RangeError('Invalid allowlist poll interval')
  }
}

export function parseAllowlist(text: string): Set<string> {
  if (typeof text !== 'string') throw new TypeError('Allowlist must be text')

  const keys = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    parsePublicKey(line)
    keys.add(line)
  }
  return keys
}

/** See `Server` for why the dynamic overload uses a `never[]` rest. */
export interface AllowlistWatcher {
  on(event: 'reloaded', listener: (event: AllowlistReloadedEvent) => void): this
  on(event: 'removed', listener: (event: AllowlistRemovedEvent) => void): this
  on(event: 'failure', listener: (event: AllowlistFailureEvent) => void): this
  on(event: string | symbol, listener: (...args: never[]) => void): this
  once(event: 'reloaded', listener: (event: AllowlistReloadedEvent) => void): this
  once(event: 'removed', listener: (event: AllowlistRemovedEvent) => void): this
  once(event: 'failure', listener: (event: AllowlistFailureEvent) => void): this
  once(event: string | symbol, listener: (...args: never[]) => void): this
}

export class AllowlistWatcher extends EventEmitter {
  readonly filePath: string
  readonly pollInterval: number
  keys: Set<string>
  closed: boolean
  private storage: AllowlistStorage
  private onReload: (keys: Set<string>) => void | Promise<void>
  private onFailure: ((event: AllowlistFailureEvent) => void) | null
  private scheduler: AllowlistScheduler
  private logger: Logger | null
  private timer: unknown | null
  private pending: Promise<void>

  constructor({
    filePath,
    storage = fs.promises,
    onReload,
    onFailure = null,
    pollInterval = DEFAULT_POLL_INTERVAL,
    scheduler = { setInterval, clearInterval },
    logger = null
  }: AllowlistWatcherOptions) {
    super()
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('Invalid allowlist path')
    }
    if (!storage || typeof storage.readFile !== 'function') {
      throw new TypeError('Invalid allowlist storage')
    }
    if (typeof onReload !== 'function') throw new TypeError('Invalid allowlist reload handler')
    if (onFailure !== null && typeof onFailure !== 'function') {
      throw new TypeError('Invalid allowlist failure handler')
    }
    assertPollInterval(pollInterval)
    if (
      !scheduler ||
      typeof scheduler.setInterval !== 'function' ||
      typeof scheduler.clearInterval !== 'function'
    ) {
      throw new TypeError('Invalid allowlist scheduler')
    }

    this.filePath = filePath
    this.storage = storage
    this.onReload = onReload
    this.onFailure = onFailure
    this.pollInterval = pollInterval
    this.scheduler = scheduler
    this.logger = logger
    this.keys = new Set()
    this.timer = null
    this.closed = false
    this.pending = Promise.resolve()
  }

  private _report(level: keyof Logger, message: string, details: Record<string, unknown>): void {
    if (!this.logger || typeof this.logger[level] !== 'function') return
    try {
      this.logger[level](message, details)
    } catch {}
  }

  private _notifyFailure(err: unknown): AllowlistFailureEvent {
    const details = {
      reason: errorCode(err) ?? 'PROTOCOL_INVALID'
    }
    try {
      this.onFailure?.(details)
    } catch {}
    try {
      this.emit('failure', details)
    } catch {}
    return details
  }

  poll(): Promise<boolean> {
    const run = this.pending.then(
      () => this._poll(),
      () => this._poll()
    )
    this.pending = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async _poll(): Promise<boolean> {
    if (this.closed) return false
    let next
    try {
      const text = await this.storage.readFile(this.filePath, 'utf8')
      next = parseAllowlist(typeof text === 'string' ? text : text.toString())
    } catch (err: unknown) {
      this._notifyFailure(err)
      throw err
    }
    try {
      await this.onReload(new Set(next))
    } catch (err: unknown) {
      if (!wasAllowlistApplied(err)) throw err
      this._applySnapshot(next)
      throw err
    }
    this._applySnapshot(next)
    return true
  }

  private _applySnapshot(next: Set<string>): void {
    const previous = this.keys
    this.keys = next
    let removed = 0
    for (const key of previous) if (!next.has(key)) removed++
    if (removed > 0) this.emit('removed', { removed })
    this.emit('reloaded', { count: next.size })
  }

  async load(): Promise<boolean> {
    if (this.closed) return false
    return this.poll()
  }

  startPolling(): void {
    if (this.closed || this.timer) return
    this.timer = this.scheduler.setInterval(() => {
      return this.poll().catch((err: unknown) => {
        this._report('warn', 'Allowlist reload failed', {
          reason: errorCode(err) ?? 'PROTOCOL_INVALID'
        })
        return false
      })
    }, this.pollInterval)
    if (
      typeof this.timer === 'object' &&
      this.timer !== null &&
      'unref' in this.timer &&
      typeof this.timer.unref === 'function'
    ) {
      this.timer.unref()
    }
  }

  async start(): Promise<void> {
    if (this.closed || this.timer) return
    await this.load()
    if (this.closed || this.timer) return
    this.startPolling()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) this.scheduler.clearInterval(this.timer)
    this.timer = null
    await this.pending
  }
}

export { DEFAULT_POLL_INTERVAL, MAX_POLL_INTERVAL }
