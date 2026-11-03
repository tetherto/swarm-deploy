import b4a from 'b4a'
import { errorCode, isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  LEGACY_REAPPEARED_MESSAGE,
  assertSafeDirectory,
  legacyStatePresent,
  openSafeRegularFile,
  withSafeDirectoryIdentity
} from './layout.js'
import { digestMatches, SodiumSha256 } from '../tar-protocol/hash.js'
import { assertSafeUint } from '../validation.js'
import { withRootLease } from './root-coordinator.js'
import { isReservedHistoryName } from '../files.js'
import {
  compareReleaseVersions,
  ReleaseMatcher,
  releaseVersionGroup,
  type VersionGranularity
} from '../release.js'
import {
  commitRecordKind,
  compareCommitOrder,
  type CommitRecord,
  type CommitRelease
} from './commit-journal.js'
import { digestTree } from './tree-fs.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout, StorageStat } from './types.js'

const DEFAULT_RESUME_TTL = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL = 15 * 60 * 1000
const MAX_CLEANUP_INTERVAL = 0x7fffffff
/** How many unmanaged names one scan names individually; the rest are counted. */
const MAX_UNKNOWN_LOGGED = 32

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
  scrubRecords(): Promise<{ records: CommitRecord[]; deleted: number }>
  delete(record: CommitRecord): Promise<boolean>
  purge(
    record: CommitRecord,
    options?: { preservePath?: boolean }
  ): Promise<false | { purged: true; preservedPath: boolean }>
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
      countDeleted: number
      versionDeleted: number
      storageDeleted: number
      /** Present only when retention scopes are configured. */
      scopedDeleted?: number
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
      countDeleted: number
      versionDeleted: number
      storageDeleted: number
      scopedDeleted?: number
    }
  | { trigger: string; status: 'failed'; reason: string }
  | { trigger: 'scheduled'; status: 'deferred'; reason: 'ACTIVE_RECEIVE' }

/**
 * A cleanup rule for the committed artifacts whose final name matches `pattern`, independent of
 * which names uploads may use and of any `artifactPatterns`. `pattern` is an existing release
 * template (`{series}`, `{version}`) over the artifact's basename only, such as
 * `beta-{version}`; it needs a literal character, so a bare `{version}` cannot match every
 * release. Limits are optional but at least one is required. `maxCount` keeps the newest
 * `maxCount` matching artifacts per series (newest by commit time, like the global
 * `maxCount`) and needs `{version}` in `pattern`: a template without it gives every name its own
 * series, so a count could never remove anything and is refused. `maxAge` removes matching
 * artifacts committed that many milliseconds ago and works with any valid pattern. An artifact
 * over either limit of any scope is removed, unless it is pinned by anything that pins an
 * artifact against retention.
 */
export interface RetentionScope {
  pattern: string
  maxCount?: number
  /** Milliseconds. */
  maxAge?: number
}

const MAX_RETENTION_SCOPES = 16
const MAX_SCOPE_PATTERN_LENGTH = 256
const SCOPE_KEYS: ReadonlySet<string> = new Set(['pattern', 'maxCount', 'maxAge'])

export interface CompiledRetentionScope extends RetentionScope {
  readonly matcher: ReleaseMatcher
}

function scopeError(): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid retention scope')
}

function ownValue(value: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function scopeLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw scopeError()
  return value
}

/**
 * Validates and snapshots retention scopes: plain objects with only `pattern`, `maxCount`, and
 * `maxAge`; a basename template with at least one literal character and no `/`; at least one
 * positive safe-integer limit, where `maxCount` also requires `{version}` in the template; no
 * duplicate pattern; at most 16. The result is frozen and shares
 * nothing with the input. Throws the same fixed `PROTOCOL_INVALID` message for every problem, so
 * a rejected value is never echoed.
 */
export function compileRetentionScopes(input: unknown): readonly CompiledRetentionScope[] {
  if (input === undefined) return Object.freeze([])
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as Iterable<unknown>)[Symbol.iterator] !== 'function'
  ) {
    throw scopeError()
  }
  const scopes: CompiledRetentionScope[] = []
  const seen = new Set<string>()
  for (const candidate of input as Iterable<unknown>) {
    if (scopes.length >= MAX_RETENTION_SCOPES) throw scopeError()
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw scopeError()
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || !SCOPE_KEYS.has(key)) throw scopeError()
    }
    const pattern = ownValue(candidate, 'pattern')
    const maxCount = scopeLimit(ownValue(candidate, 'maxCount'))
    const maxAge = scopeLimit(ownValue(candidate, 'maxAge'))
    if (
      typeof pattern !== 'string' ||
      pattern.length === 0 ||
      pattern.length > MAX_SCOPE_PATTERN_LENGTH ||
      pattern.includes('/') ||
      pattern.split('{series}').join('').split('{version}').join('').length === 0 ||
      (maxCount === undefined && maxAge === undefined) ||
      (maxCount !== undefined && !pattern.includes('{version}')) ||
      seen.has(pattern)
    ) {
      throw scopeError()
    }
    let matcher: ReleaseMatcher
    try {
      matcher = new ReleaseMatcher([pattern])
    } catch {
      throw scopeError()
    }
    seen.add(pattern)
    scopes.push(
      Object.freeze({
        pattern,
        ...(maxCount === undefined ? {} : { maxCount }),
        ...(maxAge === undefined ? {} : { maxAge }),
        matcher
      })
    )
  }
  return Object.freeze(scopes)
}

/** The scope without its compiled matcher: the plain, immutable form a server exposes. */
export function plainRetentionScope(scope: CompiledRetentionScope): RetentionScope {
  return Object.freeze({
    pattern: scope.pattern,
    ...(scope.maxCount === undefined ? {} : { maxCount: scope.maxCount }),
    ...(scope.maxAge === undefined ? {} : { maxAge: scope.maxAge })
  })
}

interface RetentionRunOptions {
  incomingBytes?: number
  trigger?: string
}

interface RetentionManagerOptions {
  layout: StorageLayout
  sessionStore: SessionStore
  commitStore: CommitStore
  maxAge?: number
  maxCount?: number
  maxVersions?: number
  versionGranularity?: VersionGranularity
  maxStorageBytes?: number
  /** Optional cleanup rules for matching names only; see {@link RetentionScope}. Off by default. */
  scopes?: Iterable<RetentionScope>
  resumeTtl?: number
  cleanupInterval?: number
  clock?: Clock
  storage?: StorageAdapter
  isSessionActive: (session: Session) => boolean
  hasActiveUploads?: () => boolean
  isPinned?: (record: CommitRecord) => boolean
  /**
   * Reconciles managed symlinks and returns the transfer IDs pinned by a rule.
   * Called once per pass with the scrubbed record set, with the root lease
   * already held; it must not acquire the root lease itself.
   */
  reconcileLinks?: (records: CommitRecord[]) => Promise<ReadonlySet<string>>
  /**
   * When link reconciliation fails, returns transfer IDs that must stay pinned
   * from desired links and durable ownership records.
   */
  linkPinsFallback?: (records: CommitRecord[]) => Promise<ReadonlySet<string>>
  /** Names in the storage root that are server-managed symlinks, not artifacts. */
  managedLinkNames?: () => ReadonlySet<string>
  logger?: Logger | null
  scheduler?: Scheduler
  onEvent?: ((event: RetentionEvent) => void) | null
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

interface RetentionResult {
  expiredSessions: number
  scrubbed: number
  ageDeleted: number
  countDeleted: number
  versionDeleted: number
  storageDeleted: number
  /** Present only when retention scopes are configured, so a server without them is unchanged. */
  scopedDeleted?: number
}

function bySeries(records: CommitRecord[]): Map<string, CommitRecord[]> {
  const groups = new Map<string, CommitRecord[]>()
  for (const record of records) {
    if (!record.release) continue
    const group = groups.get(record.release.series)
    if (group) group.push(record)
    else groups.set(record.release.series, [record])
  }
  return groups
}

/** Transfer IDs of the newest `maxCount` released records in every series. */
function countKeepSet(records: CommitRecord[], maxCount: number): Set<string> {
  const keep = new Set<string>()
  for (const group of bySeries(records).values()) {
    for (const record of group.sort(compareCommitOrder).slice(0, maxCount)) {
      keep.add(record.transferId)
    }
  }
  return keep
}

/** Transfer IDs of every versioned record in each series' newest `maxVersions` groups. */
function versionKeepSet(
  records: CommitRecord[],
  maxVersions: number,
  granularity: VersionGranularity
): Set<string> {
  const keep = new Set<string>()
  for (const group of bySeries(records).values()) {
    const versioned = group.filter((record) => record.release?.version !== undefined)
    versioned.sort((left, right) => {
      const order = compareReleaseVersions(right.release!.version!, left.release!.version!)
      return order !== 0 ? order : compareCommitOrder(left, right)
    })
    const groups = new Set<string>()
    for (const record of versioned) {
      const key = releaseVersionGroup(record.release!.version!, granularity)
      if (!groups.has(key) && groups.size >= maxVersions) continue
      groups.add(key)
      keep.add(record.transferId)
    }
  }
  return keep
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

function inspectManagedFinal(
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
    if (commitRecordKind(record) === 'directory') {
      if (initial.isSymbolicLink() || !initial.isDirectory()) return 'NON_REGULAR'
      if (!hash) return 'VALID'
      let digested
      try {
        digested = await digestTree(finalPath, storage)
      } catch {
        return 'DIGEST_INVALID'
      }
      if (digested.entryCount !== record.entryCount || digested.payloadBytes !== record.size) {
        return 'WRONG_SIZE'
      }
      return digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
        ? 'VALID'
        : 'DIGEST_INVALID'
    }
    if (!initial.isFile()) return 'NON_REGULAR'
    if (initial.size !== record.size) return 'WRONG_SIZE'
    if (!hash) return 'VALID'

    const digest = new SodiumSha256()
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
      if (!after.isFile() || after.size !== record.size || !identityMatches(before, after)) {
        return 'CHANGED'
      }
      if (!digestMatches(digest.digest(), b4a.from(record.sha256, 'hex'))) return 'DIGEST_INVALID'
      let visible
      try {
        visible = await storage.lstat(finalPath)
      } catch (err) {
        if (isMissing(err)) return 'CHANGED'
        throw err
      }
      if (!visible.isFile() || visible.size !== record.size || !identityMatches(initial, visible)) {
        return 'CHANGED'
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
  maxCount: number | undefined
  maxVersions: number | undefined
  versionGranularity: VersionGranularity | undefined
  maxStorageBytes: number | undefined
  scopes: readonly CompiledRetentionScope[]
  resumeTtl: number
  cleanupInterval: number
  clock: Clock
  storage: StorageAdapter
  isSessionActive: (session: Session) => boolean
  hasActiveUploads: () => boolean
  isPinned: (record: CommitRecord) => boolean
  reconcileLinks: ((records: CommitRecord[]) => Promise<ReadonlySet<string>>) | undefined
  linkPinsFallback: ((records: CommitRecord[]) => Promise<ReadonlySet<string>>) | undefined
  managedLinkNames: (() => ReadonlySet<string>) | undefined
  logger: Logger | null
  /** The unmanaged names the last scan logged, at most `MAX_UNKNOWN_LOGGED`, so a repeat is quiet. */
  unknownLogged: Set<string>
  /** How many unmanaged names past that limit the last scan counted. */
  unknownOverflow: number
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
    maxCount,
    maxVersions,
    versionGranularity,
    maxStorageBytes,
    scopes,
    resumeTtl = DEFAULT_RESUME_TTL,
    cleanupInterval = DEFAULT_CLEANUP_INTERVAL,
    clock = Date,
    storage = commitStore?.storage || fs.promises,
    isSessionActive,
    hasActiveUploads = () => false,
    isPinned = () => false,
    reconcileLinks,
    linkPinsFallback,
    managedLinkNames,
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
      typeof commitStore.scrubRecords !== 'function' ||
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
    if (typeof isPinned !== 'function') throw storageError('Invalid retention pin predicate')
    if (reconcileLinks !== undefined && typeof reconcileLinks !== 'function') {
      throw storageError('Invalid link reconciliation callback')
    }
    if (linkPinsFallback !== undefined && typeof linkPinsFallback !== 'function') {
      throw storageError('Invalid link pin fallback callback')
    }
    if (managedLinkNames !== undefined && typeof managedLinkNames !== 'function') {
      throw storageError('Invalid managed link name callback')
    }
    if (onEvent !== null && typeof onEvent !== 'function') {
      throw storageError('Invalid retention event callback')
    }
    if (maxAge !== undefined) assertSafeUint(maxAge, 'maxAge')
    if (maxStorageBytes !== undefined) assertSafeUint(maxStorageBytes, 'maxStorageBytes')
    if (maxCount !== undefined) assertPositiveSafeUint(maxCount, 'maxCount')
    if (maxVersions !== undefined) assertPositiveSafeUint(maxVersions, 'maxVersions')
    if (maxVersions === undefined) {
      if (versionGranularity !== undefined) throw storageError('Invalid versionGranularity')
    } else if (versionGranularity !== 'major' && versionGranularity !== 'minor') {
      throw storageError('Invalid versionGranularity')
    }
    assertPositiveSafeUint(resumeTtl, 'resumeTtl')
    assertPositiveSafeUint(cleanupInterval, 'cleanupInterval')
    if (cleanupInterval > MAX_CLEANUP_INTERVAL) throw storageError('Invalid cleanupInterval')

    this.layout = layout
    this.sessionStore = sessionStore
    this.commitStore = commitStore
    this.maxAge = maxAge
    this.maxCount = maxCount
    this.maxVersions = maxVersions
    this.versionGranularity = versionGranularity
    this.maxStorageBytes = maxStorageBytes
    this.scopes = compileRetentionScopes(scopes)
    this.resumeTtl = resumeTtl
    this.cleanupInterval = cleanupInterval
    this.clock = clock
    this.storage = storage
    this.isSessionActive = isSessionActive
    this.hasActiveUploads = hasActiveUploads
    this.isPinned = isPinned
    this.reconcileLinks = reconcileLinks
    this.linkPinsFallback = linkPinsFallback
    this.managedLinkNames = managedLinkNames
    this.logger = logger
    this.unknownLogged = new Set()
    this.unknownOverflow = 0
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

  expireSessions(): Promise<number> {
    return this.sessionStore.expire(this.resumeTtl, (session) => !this.isSessionActive(session))
  }

  /**
   * Logs the entries of the output root that no record owns. They are legitimate (an
   * operator's own file, an artifact whose metadata was deleted) and are never adopted or
   * removed. A scan runs after every commit and on a schedule, so a name is logged when it
   * first shows up, and again only if it went away and came back, not on every pass. What is
   * remembered is the last scan's first `MAX_UNKNOWN_LOGGED` names, so it cannot grow with the
   * root; the rest are counted, and that count is logged again only when it changes.
   */
  _reportUnknown(unknown: readonly string[]): void {
    const listed = unknown.slice(0, MAX_UNKNOWN_LOGGED)
    for (const name of listed) {
      if (this.unknownLogged.has(name)) continue
      report(this.logger, 'warn', 'Ignoring unknown committed path', { name })
    }
    const more = unknown.length - listed.length
    if (more > 0 && more !== this.unknownOverflow) {
      report(this.logger, 'warn', 'Ignoring more unknown committed paths', { count: more })
    }
    this.unknownLogged = new Set(listed)
    this.unknownOverflow = more
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
    let scanned
    try {
      scanned = await this.commitStore.scrubRecords()
    } catch (err) {
      throw cleanupError('Unable to scrub managed commit metadata', err)
    }
    const records = scanned.records
    const knownNames = new Set(records.map((record) => record.name))
    const rootNames = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.readdir(this.layout.root)
    )
    const linkNames = this.managedLinkNames ? this.managedLinkNames() : new Set<string>()
    const unknown = rootNames.filter((name) => !knownNames.has(name) && !linkNames.has(name)).sort()
    this._reportUnknown(unknown)

    const valid = []
    let deleted = scanned.deleted
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
        purged = await this.commitStore.purge(record, {
          preservePath: status === 'CHANGED' || commitRecordKind(record) === 'directory'
        })
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

  async _deleteRecord(
    record: CommitRecord,
    reason:
      'MAX_AGE' | 'MAX_COUNT' | 'MAX_VERSIONS' | 'MAX_STORAGE' | 'SCOPE_MAX_AGE' | 'SCOPE_MAX_COUNT'
  ): Promise<void> {
    try {
      if (!(await this.commitStore.delete(record))) {
        throw storageError('Managed commit record disappeared during retention')
      }
    } catch (err) {
      throw cleanupError('Unable to remove managed commit', err)
    }
    report(this.logger, 'info', 'Removed managed commit', { name: record.name, reason })
  }

  /**
   * Configured mutable current records survive age and quota eviction. Their
   * size still counts toward the logical total so a replacement that cannot be
   * afforded fails instead of silently exceeding the limit.
   */
  _isPinned(record: CommitRecord): boolean {
    return this.isPinned(record) === true
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

  run(options: RetentionRunOptions = {}): Promise<RetentionResult> {
    return withRootLease(this.layout.root, () => this._runUnlocked(options))
  }

  async _runUnlocked(options: RetentionRunOptions = {}): Promise<RetentionResult> {
    const trigger = options.trigger || 'manual'
    try {
      const result = await this._run(options)
      if (!this.cleanupFailure) this.cleanupFailure = null
      this._emit({ trigger, status: 'completed', ...result })
      return result
    } catch (err) {
      this.cleanupFailure = err
      this._emit({ trigger, status: 'failed', reason: errorCode(err) || ERRORS.CLEANUP_FAILED })
      throw err
    }
  }

  async _run({
    incomingBytes = 0,
    trigger = 'manual'
  }: RetentionRunOptions = {}): Promise<RetentionResult> {
    assertSafeUint(incomingBytes, 'incomingBytes')
    // Legacy state in the output root means an older release or another writer is using this
    // root. Deleting by this instance's records could then remove that writer's files, so no
    // maintenance runs until an operator resolves it.
    if (legacyStatePresent(this.layout.root)) throw storageError(LEGACY_REAPPEARED_MESSAGE)
    if (this.maxStorageBytes !== undefined && incomingBytes > this.maxStorageBytes) {
      throw new SwarmDeployError(
        ERRORS.FILE_TOO_LARGE,
        'Incoming artifact exceeds committed storage limit'
      )
    }

    const expiredSessions = await this.expireSessions()
    const scrub = await this.scrubCommitted({ hash: false })
    const current = scrub.records.slice()
    let linkPinned = new Set<string>()
    let linkReconcileError: unknown = null
    if (this.reconcileLinks) {
      try {
        linkPinned = new Set(await this.reconcileLinks(current.slice()))
      } catch (err) {
        linkReconcileError = err
        if (this.linkPinsFallback) {
          linkPinned = new Set(await this.linkPinsFallback(current.slice()))
        }
        report(this.logger, 'warn', 'Managed link reconciliation failed during retention', {
          reason: errorMessage(err)
        })
      }
    }
    const pinned = (record: CommitRecord): boolean =>
      this._isPinned(record) || linkPinned.has(record.transferId)
    let scopedDeleted = 0
    if (this.scopes.length > 0) {
      for (const [record, reason] of this._scopedRemovals(current, pinned)) {
        await this._deleteRecord(record, reason)
        current.splice(current.indexOf(record), 1)
        scopedDeleted++
      }
    }
    let ageDeleted = 0
    if (this.maxAge !== undefined) {
      const now = this.clock.now()
      assertSafeUint(now, 'current timestamp')
      for (const record of current.slice().sort(compareRecords)) {
        if (pinned(record)) continue
        if (now < record.committedAt || now - record.committedAt < this.maxAge) continue
        await this._deleteRecord(record, 'MAX_AGE')
        current.splice(current.indexOf(record), 1)
        ageDeleted++
      }
    }

    let countDeleted = 0
    if (this.maxCount !== undefined) {
      const keep = countKeepSet(current, this.maxCount)
      for (const record of current.slice().sort(compareRecords)) {
        if (!record.release || keep.has(record.transferId) || pinned(record)) continue
        await this._deleteRecord(record, 'MAX_COUNT')
        current.splice(current.indexOf(record), 1)
        countDeleted++
      }
    }

    let versionDeleted = 0
    if (this.maxVersions !== undefined && this.versionGranularity !== undefined) {
      const keep = versionKeepSet(current, this.maxVersions, this.versionGranularity)
      for (const record of current.slice().sort(compareRecords)) {
        if (record.release?.version === undefined) continue
        if (keep.has(record.transferId) || pinned(record)) continue
        await this._deleteRecord(record, 'MAX_VERSIONS')
        current.splice(current.indexOf(record), 1)
        versionDeleted++
      }
    }

    let storageDeleted = 0
    if (this.maxStorageBytes !== undefined) {
      const permitted = this.maxStorageBytes - incomingBytes
      let total = this._totalSize(current)
      for (const record of current.slice().sort(compareRecords)) {
        if (total <= permitted) break
        if (pinned(record)) continue
        await this._deleteRecord(record, 'MAX_STORAGE')
        total -= record.size
        storageDeleted++
      }
      if (total > permitted) throw storageError('Unable to reserve committed storage capacity')
    }
    if (linkReconcileError) {
      this.cleanupFailure = linkReconcileError
      if (trigger !== 'commit') throw linkReconcileError
    }
    return {
      expiredSessions,
      scrubbed: scrub.deleted,
      ageDeleted,
      countDeleted,
      versionDeleted,
      storageDeleted,
      ...(this.scopes.length > 0 ? { scopedDeleted } : {})
    }
  }

  /**
   * What the configured scopes remove from `records`, oldest first. Every scope is judged against
   * the same snapshot, so a record any scope selects goes, and one scope's removals cannot change
   * what another keeps. Only valid, current, non-history records whose basename matches the
   * scope's template are candidates, whatever `artifactPatterns` admitted: unmanaged files and
   * every other name are never considered.
   *
   * `maxCount` is the global rule over the matches: the newest `maxCount` per series are kept by
   * the same keep-set, pinned or not, so a pinned newest record holds one of the places and a
   * pinned older record survives in addition. A pinned record is never removed.
   */
  _scopedRemovals(
    records: CommitRecord[],
    pinned: (record: CommitRecord) => boolean
  ): Array<[CommitRecord, 'SCOPE_MAX_AGE' | 'SCOPE_MAX_COUNT']> {
    const now = this.clock.now()
    assertSafeUint(now, 'current timestamp')
    const chosen = new Map<CommitRecord, 'SCOPE_MAX_AGE' | 'SCOPE_MAX_COUNT'>()
    for (const scope of this.scopes) {
      const matches: Array<{ record: CommitRecord; release: CommitRelease }> = []
      for (const record of records) {
        if (isReservedHistoryName(record.name)) continue
        const release = scope.matcher.match(record.name)
        if (release !== null) matches.push({ record, release })
      }
      const keep =
        scope.maxCount === undefined
          ? null
          : countKeepSet(
              matches.map(({ record, release }) => ({ ...record, release })),
              scope.maxCount
            )
      for (const { record } of matches) {
        if (chosen.has(record) || pinned(record)) continue
        if (keep !== null && !keep.has(record.transferId)) {
          chosen.set(record, 'SCOPE_MAX_COUNT')
        } else if (
          scope.maxAge !== undefined &&
          now >= record.committedAt &&
          now - record.committedAt >= scope.maxAge
        ) {
          chosen.set(record, 'SCOPE_MAX_AGE')
        }
      }
    }
    return [...chosen].sort(([left], [right]) => compareRecords(left, right))
  }

  afterCommit(): Promise<boolean> {
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
