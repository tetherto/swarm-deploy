import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { assertSafeDirectory, openSafeRegularFile, withSafeDirectoryIdentity } from './layout.js'
import { assertSafeUint } from '../protocol/validation.js'
import { withRootLease } from './root-coordinator.js'
import type { CommitRecord } from './commit-journal.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout, StorageStat } from './types.js'

const DEFAULT_RESUME_TTL = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL = 15 * 60 * 1000
const MAX_CLEANUP_INTERVAL = 0x7fffffff

interface Session {
  state: string
}

interface SessionStore {
  sessions?: Map<string, Session>
  expire(ttl: number, shouldExpire: (session: Session) => boolean): Promise<number>
}

interface CommitStore {
  storage?: StorageAdapter
  list(): Promise<CommitRecord[]>
  delete(record: CommitRecord): Promise<boolean>
  purge(record: CommitRecord): Promise<false | { purged: true; preservedPath: boolean }>
}

interface Logger {
  info?: (message: string, details: Record<string, unknown>) => void
  warn?: (message: string, details: Record<string, unknown>) => void
  error?: (message: string, details: Record<string, unknown>) => void
}

interface Clock {
  now(): number
}

interface Scheduler {
  setInterval(callback: () => void, interval: number): unknown
  clearInterval(timer: unknown): void
}

function unrefTimer(timer: unknown): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return
  if (typeof timer.unref === 'function') timer.unref()
}

type RetentionEvent =
  | {
      type: 'retention'
      trigger: string
      status: 'completed'
      expiredSessions: number
      scrubbed: number
      ageDeleted: number
      storageDeleted: number
    }
  | { type: 'retention'; trigger: string; status: 'failed'; reason: string }
  | { type: 'retention'; trigger: 'scheduled'; status: 'deferred'; reason: 'ACTIVE_RECEIVE' }

type RetentionEventPayload =
  | {
      trigger: string
      status: 'completed'
      expiredSessions: number
      scrubbed: number
      ageDeleted: number
      storageDeleted: number
    }
  | { trigger: string; status: 'failed'; reason: string }
  | { trigger: 'scheduled'; status: 'deferred'; reason: 'ACTIVE_RECEIVE' }

interface RetentionRunOptions {
  incomingBytes?: number
  trigger?: string
}

interface RetentionManagerOptions {
  layout: StorageLayout
  sessionStore: SessionStore
  commitStore: CommitStore
  maxAge?: number
  maxStorageBytes?: number
  resumeTtl?: number
  cleanupInterval?: number
  clock?: Clock
  storage?: StorageAdapter
  isSessionActive: (session: Session) => boolean
  hasActiveUploads?: () => boolean
  logger?: Logger | null
  scheduler?: Scheduler
  onEvent?: ((event: RetentionEvent) => void) | null
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function cleanupError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.CLEANUP_FAILED, message, cause)
}

function isMissing(error: unknown): boolean {
  if (errorCode(error) === 'ENOENT') return true
  return (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    errorCode(error.cause) === 'ENOENT'
  )
}

function assertPositiveSafeUint(value: unknown, name: string): asserts value is number {
  assertSafeUint(value, name)
  if (value === 0) throw storageError(`Invalid ${name}`)
}

function report(
  logger: Logger | null,
  level: keyof Logger,
  message: string,
  details: Record<string, unknown>
): void {
  if (!logger || typeof logger[level] !== 'function') return
  try {
    logger[level]?.(message, details)
  } catch {}
}

function compareRecords(left: CommitRecord, right: CommitRecord): number {
  if (left.committedAt !== right.committedAt) return left.committedAt - right.committedAt
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function identityMatches(left: StorageStat, right: StorageStat): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function readExactly(
  handle: StorageFileHandle,
  bytes: Uint8Array,
  position: number
): Promise<boolean> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) return false
    offset += count
  }
  return true
}

async function inspectManagedFinal(
  record: CommitRecord,
  { layout, storage, hash }: { layout: StorageLayout; storage: StorageAdapter; hash: boolean }
): Promise<
  | 'MISSING'
  | 'SYMLINK'
  | 'NON_REGULAR'
  | 'WRONG_SIZE'
  | 'VALID'
  | 'CHANGED'
  | 'TRUNCATED'
  | 'DIGEST_INVALID'
> {
  const finalPath = path.join(layout.root, record.name)
  return withSafeDirectoryIdentity(layout.root, storage, async () => {
    let initial
    try {
      initial = await storage.lstat(finalPath)
    } catch (err) {
      if (isMissing(err)) return 'MISSING'
      throw err
    }
    if (initial.isSymbolicLink()) return 'SYMLINK'
    if (!initial.isFile()) return 'NON_REGULAR'
    if (initial.size !== record.size) return 'WRONG_SIZE'
    if (!hash) return 'VALID'

    const digest = crypto.createHash('sha256')
    let handle = null
    try {
      handle = await openSafeRegularFile(finalPath, 'read', storage)
      const before = await handle.stat()
      if (!before.isFile() || before.size !== record.size || !identityMatches(initial, before)) {
        return 'CHANGED'
      }
      let position = 0
      while (position < record.size) {
        const bytes = b4a.alloc(Math.min(64 * 1024, record.size - position))
        if (!(await readExactly(handle, bytes, position))) return 'TRUNCATED'
        digest.update(bytes)
        position += bytes.byteLength
      }
      const after = await handle.stat()
      if (
        !after.isFile() ||
        after.size !== record.size ||
        !identityMatches(before, after) ||
        !b4a.equals(digest.digest(), b4a.from(record.sha256, 'hex'))
      ) {
        return 'DIGEST_INVALID'
      }
      return 'VALID'
    } finally {
      if (handle) await handle.close()
    }
  })
}

class RetentionManager {
  layout: StorageLayout
  sessionStore: SessionStore
  commitStore: CommitStore
  maxAge: number | undefined
  maxStorageBytes: number | undefined
  resumeTtl: number
  cleanupInterval: number
  clock: Clock
  storage: StorageAdapter
  isSessionActive: (session: Session) => boolean
  hasActiveUploads: () => boolean
  logger: Logger | null
  timer: unknown | null
  cleanupFailure: unknown | null
  scheduler: Scheduler
  onEvent: ((event: RetentionEvent) => void) | null
  startPromise: Promise<void> | null
  tickPromise: Promise<void> | null
  tickQueued: boolean
  lifecycle: number

  constructor({
    layout,
    sessionStore,
    commitStore,
    maxAge,
    maxStorageBytes,
    resumeTtl = DEFAULT_RESUME_TTL,
    cleanupInterval = DEFAULT_CLEANUP_INTERVAL,
    clock = Date,
    storage = commitStore?.storage || fs.promises,
    isSessionActive,
    hasActiveUploads = () => false,
    logger = null,
    scheduler = { setInterval, clearInterval },
    onEvent = null
  }: RetentionManagerOptions) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    if (!sessionStore || typeof sessionStore.expire !== 'function') {
      throw storageError('Invalid session store')
    }
    if (
      !commitStore ||
      typeof commitStore.list !== 'function' ||
      typeof commitStore.delete !== 'function' ||
      typeof commitStore.purge !== 'function'
    ) {
      throw storageError('Invalid commit store')
    }
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')
    if (
      !scheduler ||
      typeof scheduler.setInterval !== 'function' ||
      typeof scheduler.clearInterval !== 'function'
    ) {
      throw storageError('Invalid retention scheduler')
    }
    if (typeof isSessionActive !== 'function') {
      throw storageError('Invalid session activity predicate')
    }
    if (typeof hasActiveUploads !== 'function') {
      throw storageError('Invalid active upload predicate')
    }
    if (onEvent !== null && typeof onEvent !== 'function') {
      throw storageError('Invalid retention event callback')
    }
    if (maxAge !== undefined) assertSafeUint(maxAge, 'maxAge')
    if (maxStorageBytes !== undefined) assertSafeUint(maxStorageBytes, 'maxStorageBytes')
    assertPositiveSafeUint(resumeTtl, 'resumeTtl')
    assertPositiveSafeUint(cleanupInterval, 'cleanupInterval')
    if (cleanupInterval > MAX_CLEANUP_INTERVAL) throw storageError('Invalid cleanupInterval')

    this.layout = layout
    this.sessionStore = sessionStore
    this.commitStore = commitStore
    this.maxAge = maxAge
    this.maxStorageBytes = maxStorageBytes
    this.resumeTtl = resumeTtl
    this.cleanupInterval = cleanupInterval
    this.clock = clock
    this.storage = storage
    this.isSessionActive = isSessionActive
    this.hasActiveUploads = hasActiveUploads
    this.logger = logger
    this.timer = null
    this.cleanupFailure = null
    this.scheduler = scheduler
    this.onEvent = onEvent
    this.startPromise = null
    this.tickPromise = null
    this.tickQueued = false
    this.lifecycle = 0
  }

  _emit(payload: RetentionEventPayload): void {
    if (!this.onEvent) return
    try {
      this.onEvent({ type: 'retention', ...payload })
    } catch {}
  }

  _hasActiveReceivingUpload(): boolean {
    if (this.hasActiveUploads()) return true
    if (!(this.sessionStore.sessions instanceof Map)) return false
    for (const session of this.sessionStore.sessions.values()) {
      if (session.state === 'receiving' && this.isSessionActive(session)) return true
    }
    return false
  }

  async expireSessions(): Promise<number> {
    return this.sessionStore.expire(this.resumeTtl, (session) => !this.isSessionActive(session))
  }

  async scrubCommitted({ hash = true }: { hash?: boolean } = {}): Promise<{
    records: CommitRecord[]
    deleted: number
    unknown: string[]
  }> {
    if (typeof hash !== 'boolean') throw storageError('Invalid scrub hash option')
    for (const directory of [this.layout.root, this.layout.internal, this.layout.commits]) {
      await assertSafeDirectory(directory, this.storage)
    }
    const records = await this.commitStore.list()
    const knownNames = new Set(records.map((record) => record.name))
    const rootNames = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.readdir(this.layout.root)
    )
    const unknown = rootNames
      .filter((name) => name !== '.swarm-deploy' && !knownNames.has(name))
      .sort()
    for (const name of unknown) {
      report(this.logger, 'warn', 'Ignoring unknown committed path', { name })
    }

    const valid = []
    let deleted = 0
    for (const record of records) {
      const status = await inspectManagedFinal(record, {
        layout: this.layout,
        storage: this.storage,
        hash
      })
      if (status === 'VALID') {
        valid.push(record)
        continue
      }
      let purged
      try {
        purged = await this.commitStore.purge(record)
        if (!purged) {
          throw storageError('Managed commit record disappeared during scrub')
        }
      } catch (err) {
        throw cleanupError('Unable to remove invalid managed commit', err)
      }
      deleted++
      if (purged.preservedPath) {
        unknown.push(record.name)
        report(this.logger, 'warn', 'Preserving non-empty managed directory', {
          name: record.name
        })
      }
      report(this.logger, 'warn', 'Removed invalid managed commit', {
        name: record.name,
        reason: status
      })
    }
    return { records: valid, deleted, unknown: unknown.sort() }
  }

  async _deleteRecord(record: CommitRecord, reason: 'MAX_AGE' | 'MAX_STORAGE'): Promise<void> {
    try {
      if (!(await this.commitStore.delete(record))) {
        throw storageError('Managed commit record disappeared during retention')
      }
    } catch (err) {
      throw cleanupError('Unable to remove managed commit', err)
    }
    report(this.logger, 'info', 'Removed managed commit', { name: record.name, reason })
  }

  _totalSize(records: CommitRecord[]): number {
    let total = 0
    for (const record of records) {
      if (total > Number.MAX_SAFE_INTEGER - record.size) {
        throw storageError('Managed commit size exceeds safe integer range')
      }
      total += record.size
    }
    return total
  }

  run(options: RetentionRunOptions = {}): Promise<{
    expiredSessions: number
    scrubbed: number
    ageDeleted: number
    storageDeleted: number
  }> {
    return withRootLease(this.layout.root, () => this._runUnlocked(options))
  }

  async _runUnlocked(options: RetentionRunOptions = {}): Promise<{
    expiredSessions: number
    scrubbed: number
    ageDeleted: number
    storageDeleted: number
  }> {
    const trigger = options.trigger || 'manual'
    try {
      const result = await this._run(options)
      this.cleanupFailure = null
      this._emit({ trigger, status: 'completed', ...result })
      return result
    } catch (err) {
      this.cleanupFailure = err
      this._emit({ trigger, status: 'failed', reason: errorCode(err) || ERRORS.CLEANUP_FAILED })
      throw err
    }
  }

  admit(incomingBytes: number): Promise<boolean> {
    return withRootLease(this.layout.root, () => this._admitUnlocked(incomingBytes))
  }

  async _admitUnlocked(incomingBytes: number): Promise<boolean> {
    assertSafeUint(incomingBytes, 'incomingBytes')
    if (this.maxStorageBytes === undefined) return true
    if (incomingBytes > this.maxStorageBytes) {
      throw new SwarmDeployError(
        ERRORS.FILE_TOO_LARGE,
        'Incoming artifact exceeds committed storage limit'
      )
    }
    let records
    try {
      records = await this.commitStore.list()
    } catch (err) {
      throw cleanupError('Unable to inspect committed storage capacity', err)
    }
    const total = this._totalSize(records)
    if (this.cleanupFailure && total > this.maxStorageBytes - incomingBytes) {
      throw cleanupError('Committed storage cleanup is unhealthy', this.cleanupFailure)
    }
    return true
  }

  async _run({ incomingBytes = 0 }: RetentionRunOptions = {}): Promise<{
    expiredSessions: number
    scrubbed: number
    ageDeleted: number
    storageDeleted: number
  }> {
    assertSafeUint(incomingBytes, 'incomingBytes')
    if (this.maxStorageBytes !== undefined && incomingBytes > this.maxStorageBytes) {
      throw new SwarmDeployError(
        ERRORS.FILE_TOO_LARGE,
        'Incoming artifact exceeds committed storage limit'
      )
    }

    const expiredSessions = await this.expireSessions()
    const scrub = await this.scrubCommitted({ hash: false })
    const current = scrub.records.slice()
    let ageDeleted = 0
    if (this.maxAge !== undefined) {
      const now = this.clock.now()
      assertSafeUint(now, 'current timestamp')
      for (const record of current.slice().sort(compareRecords)) {
        if (now < record.committedAt || now - record.committedAt < this.maxAge) continue
        await this._deleteRecord(record, 'MAX_AGE')
        current.splice(current.indexOf(record), 1)
        ageDeleted++
      }
    }

    let storageDeleted = 0
    if (this.maxStorageBytes !== undefined) {
      const permitted = this.maxStorageBytes - incomingBytes
      let total = this._totalSize(current)
      for (const record of current.slice().sort(compareRecords)) {
        if (total <= permitted) break
        await this._deleteRecord(record, 'MAX_STORAGE')
        total -= record.size
        storageDeleted++
      }
      if (total > permitted) throw storageError('Unable to reserve committed storage capacity')
    }
    return { expiredSessions, scrubbed: scrub.deleted, ageDeleted, storageDeleted }
  }

  async afterCommit(): Promise<boolean> {
    return withRootLease(this.layout.root, () => this._afterCommitUnlocked())
  }

  async _afterCommitUnlocked(): Promise<boolean> {
    try {
      await this._runUnlocked({ trigger: 'post-commit' })
      return true
    } catch (err) {
      this.cleanupFailure = err
      report(this.logger, 'error', 'Post-commit retention failed', { message: errorMessage(err) })
      return false
    }
  }

  start(): Promise<void> {
    if (this.timer) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    const lifecycle = ++this.lifecycle
    const start = (async () => {
      await this.run({ trigger: 'startup' })
      if (lifecycle !== this.lifecycle || this.timer) return
      this.timer = this.scheduler.setInterval(
        () => this._scheduleTick(lifecycle),
        this.cleanupInterval
      )
      unrefTimer(this.timer)
    })()
    this.startPromise = start
    start.then(
      () => {
        if (this.startPromise === start) this.startPromise = null
      },
      () => {
        if (this.startPromise === start) this.startPromise = null
      }
    )
    return start
  }

  _scheduleTick(lifecycle: number): void {
    if (lifecycle !== this.lifecycle || !this.timer) return
    if (this.tickPromise) {
      this.tickQueued = true
      return
    }
    const tick = this._drainTicks(lifecycle)
    this.tickPromise = tick
    tick.then(
      () => {
        if (this.tickPromise === tick) this.tickPromise = null
      },
      () => {
        if (this.tickPromise === tick) this.tickPromise = null
      }
    )
  }

  async _drainTicks(lifecycle: number): Promise<void> {
    do {
      this.tickQueued = false
      if (this._hasActiveReceivingUpload()) {
        this._emit({ trigger: 'scheduled', status: 'deferred', reason: 'ACTIVE_RECEIVE' })
        return
      }
      try {
        await this.run({ trigger: 'scheduled' })
      } catch (err) {
        this.cleanupFailure = err
        report(this.logger, 'error', 'Scheduled retention failed', { message: errorMessage(err) })
      }
    } while (this.tickQueued && lifecycle === this.lifecycle && this.timer)
  }

  async stop(): Promise<void> {
    this.lifecycle++
    if (this.timer) this.scheduler.clearInterval(this.timer)
    this.timer = null
    this.tickQueued = false
    await Promise.allSettled([this.startPromise, this.tickPromise].filter(Boolean))
  }

  close(): Promise<void> {
    return this.stop()
  }
}

export { RetentionManager, DEFAULT_RESUME_TTL, DEFAULT_CLEANUP_INTERVAL, MAX_CLEANUP_INTERVAL }
