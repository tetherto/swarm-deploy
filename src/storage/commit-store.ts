import b4a from 'b4a'
import { errorCode, isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import type { ReleaseCoordinates } from '../release.js'
import {
  historyName,
  isReservedHistoryName,
  validateBasename,
  validateReplaceNames
} from '../files.js'
import { digestMatches, SodiumSha256, sodiumSha256 } from '../tar-protocol/hash.js'
import { assertMetadataTransferId } from '../tar-protocol/manifest.js'
import { assertTreeMetadataTransferId } from '../tar-protocol/tree-manifest.js'
import { assertFixed32, assertSafeUint } from '../validation.js'
import {
  STATE_FEATURE_DIRECTORY_REPLACEMENT,
  assertSafeDirectory,
  assertSafeFile,
  openSafeRegularFile,
  protectedDirectories,
  requireStateFeature,
  withSafeDirectoryIdentity
} from './layout.js'
import { MetadataFormatError, readJson, writeAtomic } from './atomic-file.js'
import {
  CorruptJournalError,
  JOURNAL_VERSION,
  COMMIT_VERSION,
  DIRECTORY_COMMIT_VERSION,
  DIRECTORY_HISTORY_COMMIT_VERSION,
  DIRECTORY_JOURNAL_VERSION,
  DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
  REPLACEMENT_COMMIT_VERSION,
  REPLACEMENT_JOURNAL_VERSION,
  MAX_COMMIT_METADATA_BYTES,
  assertCommitRelease,
  assertCommitRecord as assertRecord,
  isDirectoryJournal,
  isDirectoryReplacementJournal,
  isReplacementJournal,
  readCommitJournal,
  serializeJournal,
  isHex,
  fileIdentity,
  identitiesEqual
} from './commit-journal.js'
import { withNameLease, withRootLease } from './root-coordinator.js'
import type {
  AnyCommitJournal,
  CommitJournal,
  CommitRecord,
  CommitRelease,
  FileIdentity,
  DirectoryCommitJournal,
  DirectoryPhase,
  DirectoryReplacementJournal,
  DirectoryReplacementPhase,
  ReplacementJournal,
  ReplacementPhase
} from './commit-journal.js'
import {
  captureTreeSnapshot,
  digestTree,
  inspectTreePath,
  normalizeTreePublicationModes,
  removeTree,
  treeMatchesSnapshot,
  type TreeIdentitySnapshot,
  type TreePathState
} from './tree-fs.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout, StorageStat } from './types.js'

interface AbortSignalLike {
  aborted: boolean
}

interface CommitSession {
  id: string
  transferId: Uint8Array
  ownerKey: Uint8Array
  kind?: 'file' | 'directory'
  name: string
  sourceParent?: string
  size: number
  digest: Uint8Array
  entryCount?: number
  /** Direct-TAR sessions carry these immutable archive fields. */
  tarSize: number
  tarDigest: Uint8Array
  state: string
}

interface CommitOffer {
  name: string
  kind?: 'file' | 'directory'
  size: number
  digest: Uint8Array
  entryCount?: number
  transferId: Uint8Array
  /** Matched release identity; transfer and release must agree for an idempotent result. */
  release?: ReleaseCoordinates | null
}

interface RetentionManager {
  run(options?: { trigger?: string }): Promise<unknown>
  afterCommit(): Promise<unknown>
  _runUnlocked(options: {
    incomingBytes: number
    trigger: 'commit'
    pinNames?: readonly string[]
  }): Promise<unknown>
  _afterCommitUnlocked(): Promise<unknown>
}

interface SessionStore {
  readVerified(transferId: Uint8Array): Promise<CommitSession>
  sessions?: Map<string, CommitSession>
}

interface Logger {
  warn?: (message: string, details: Record<string, unknown>) => void
}

interface CommitStoreOptions {
  layout: StorageLayout
  clock?: { now(): number }
  storage?: StorageAdapter
  logger?: Logger | null
}

/**
 * What lets an upload replace a managed artifact. It only ever widens who is *eligible*: whatever
 * it allows, a replacement still needs a Swarm-managed current artifact of the same kind whose
 * content is proven against its record. It pins nothing against retention.
 */
export interface ReplacePermission {
  /** Whether an upload named `name` may replace the managed artifact that holds the name. */
  allows(name: string): boolean
  /**
   * Whether the artifact's public path is in use right now by a hook or a link request, so
   * replacing it would change what that work reads. It is asked again under the root lease
   * before anything is changed, and a refusal is retryable (`FILE_BUSY`), never permanent.
   */
  busy?(record: CommitRecord): boolean | Promise<boolean>
}

interface ReplacePolicy {
  /** Exact names that may be replaced (the legacy `replaceNames`). */
  replaceNames?: Iterable<string>
  replace?: ReplacePermission
}

/** The two questions a commit or an inspection asks about replacing one name. */
interface ReplaceRules {
  permits(name: string): boolean
  busy(record: CommitRecord): Promise<boolean>
}

function replaceRules(names: Set<string>, permission: ReplacePermission | undefined): ReplaceRules {
  if (permission !== undefined) {
    if (
      permission === null ||
      typeof permission !== 'object' ||
      typeof permission.allows !== 'function' ||
      (permission.busy !== undefined && typeof permission.busy !== 'function')
    ) {
      throw storageError('Invalid replacement permission')
    }
  }
  return {
    permits: (name) => names.has(name) || permission?.allows(name) === true,
    busy: async (record) => (permission?.busy ? (await permission.busy(record)) === true : false)
  }
}

/** The visible state of one top-level path, without following symlinks. */
interface RootPathState {
  present: boolean
  /** Set only for a regular file; an unmanaged non-regular path leaves it null. */
  stat: StorageStat | null
}

/** One directory slot, as observed: absent, a real directory with its identity, or anything else. */
type TreeSlot =
  { state: 'MISSING' } | { state: 'DIRECTORY'; identity: FileIdentity } | { state: 'UNMANAGED' }

type ReplacementPlan =
  | { mode: 'create' }
  | { mode: 'idempotent'; record: CommitRecord }
  | { mode: 'replace'; oldRecord: CommitRecord; finalIdentity: FileIdentity }

type DirectoryReplacementPlan =
  | { mode: 'idempotent'; record: CommitRecord }
  | {
      mode: 'replace'
      oldRecord: CommitRecord
      oldTreeIdentity: FileIdentity
      oldTreeSnapshot: TreeIdentitySnapshot
    }

/** A history copy of the returning content (A, B, A), proven and ready to be parked. */
interface DirectoryDedup {
  record: CommitRecord
  name: string
  identity: FileIdentity
}

type InspectResult =
  | { status: 'AVAILABLE' }
  | { status: 'ALREADY_COMMITTED'; record: CommitRecord }
  | { status: 'REPLACEABLE'; record: CommitRecord }
  | { status: 'FILE_EXISTS' }
  /** Replaceable, but a hook or link request is using the artifact's path right now. */
  | { status: 'BUSY' }
  /** Replaceable, but the storage cannot exchange directories atomically. */
  | { status: 'UNSUPPORTED' }

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function commitError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.COMMIT_FAILED, message, cause)
}

function existsError(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.FILE_EXISTS, message)
}

/** Scratch directories of the atomic-exchange probe; a valid basename, so a tree helper accepts it. */
const PROBE_PREFIX = 'swap-probe-'
const PROBE_MARKER = 'marker'
/** What a filesystem or adapter that cannot exchange directories reports. */
const UNSUPPORTED_EXCHANGE_CODES: ReadonlySet<string> = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'ENOSYS'
])

function unsupportedExchange(cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(
    ERRORS.UNSUPPORTED_STORAGE,
    'The storage cannot exchange directories atomically, so a directory cannot be replaced',
    cause
  )
}

function isUnsupportedExchange(error: unknown): boolean {
  if (error instanceof SwarmDeployError && error.code === ERRORS.UNSUPPORTED_STORAGE) return true
  const code = errorCode(error)
  return code !== null && UNSUPPORTED_EXCHANGE_CODES.has(code)
}

function assertNotAborted(signal: AbortSignalLike | null): void {
  if (signal?.aborted) throw new SwarmDeployError(ERRORS.ABORTED, 'Upload was aborted')
}

function toHex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}
function sameHex32(left: string, right: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(left) &&
    /^[0-9a-f]{64}$/.test(right) &&
    sodium.sodium_memcmp(b4a.from(left, 'hex'), b4a.from(right, 'hex'))
  )
}

function isCommitRecordName(name: unknown): name is string {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
}

function attemptId(): string {
  const bytes = b4a.allocUnsafe(32)
  sodium.randombytes_buf(bytes)
  return toHex(bytes)
}

function fingerprint(ownerKey: Uint8Array): string {
  return toHex(sodiumSha256(ownerKey))
}

function replacementsEqual(
  left: CommitRecord['replaces'],
  right: CommitRecord['replaces']
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.name === right.name &&
    sameHex32(left.transferId, right.transferId) &&
    left.historyName === right.historyName
  )
}

function releasesEqual(left: CommitRecord['release'], right: CommitRecord['release']): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.series === right.series && left.version === right.version
}

function recordsEqual(left: CommitRecord, right: CommitRecord): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.size === right.size &&
    left.entryCount === right.entryCount &&
    sameHex32(left.sha256, right.sha256) &&
    left.committedAt === right.committedAt &&
    left.uploaderFingerprint === right.uploaderFingerprint &&
    sameHex32(left.transferId, right.transferId) &&
    releasesEqual(left.release, right.release) &&
    replacementsEqual(left.replaces, right.replaces)
  )
}

function sameContent(left: CommitRecord, right: CommitRecord): boolean {
  return left.size === right.size && sameHex32(left.sha256, right.sha256)
}

function snapshotRelease(
  release: ReleaseCoordinates | null | undefined
): CommitRelease | undefined {
  if (release === null || release === undefined) return undefined
  const snapshot: CommitRelease = {
    series: release.series,
    ...(release.version === undefined ? {} : { version: release.version })
  }
  assertCommitRelease(snapshot)
  return snapshot
}

/**
 * The record the old sidecar becomes once its artifact is only reachable as history. A directory's
 * becomes a version 4 record, the only shape allowed to carry a reserved history name.
 */
function historyRecord(oldRecord: CommitRecord, name: string): CommitRecord {
  if (oldRecord.kind === 'directory') {
    return assertRecord({ ...oldRecord, version: DIRECTORY_HISTORY_COMMIT_VERSION, name })
  }
  return assertRecord({ ...oldRecord, name })
}

function assertSession(session: unknown): asserts session is CommitSession {
  if (!session || typeof session !== 'object') throw storageError('Invalid commit session')
  const candidate = session as Record<string, unknown>
  if (candidate.state !== 'verified') throw storageError('Session is not verified')
  if (!isHex(candidate.id)) throw storageError('Invalid session ID')
  assertFixed32(candidate.transferId, 'session transfer ID')
  assertFixed32(candidate.ownerKey, 'session owner key')
  if (typeof candidate.name !== 'string') throw storageError('Invalid filename')
  validateBasename(candidate.name)
  assertSafeUint(candidate.size, 'session size')
  assertFixed32(candidate.digest, 'session digest')
  if (!sameHex32(candidate.id, toHex(candidate.transferId))) {
    throw storageError('Session ID mismatch')
  }

  assertSafeUint(candidate.tarSize, 'session TAR size')
  assertFixed32(candidate.tarDigest, 'session TAR digest')
  if (candidate.kind === 'directory') {
    assertSafeUint(candidate.entryCount, 'session entry count')
    assertTreeMetadataTransferId(candidate.ownerKey as Uint8Array, {
      v: 1,
      kind: 'directory',
      name: candidate.name as string,
      ...(candidate.sourceParent === undefined
        ? {}
        : { sourceParent: candidate.sourceParent as string }),
      entryCount: candidate.entryCount as number,
      payloadBytes: candidate.size as number,
      treeSha256: toHex(candidate.digest as Uint8Array),
      tarSize: candidate.tarSize as number,
      tarSha256: toHex(candidate.tarDigest as Uint8Array),
      transferId: candidate.id,
      reset: false
    })
    return
  }
  if (candidate.kind !== 'file' && candidate.kind !== undefined) {
    throw storageError('Invalid session artifact kind')
  }
  assertMetadataTransferId(candidate.ownerKey as Uint8Array, {
    v: 1,
    name: candidate.name as string,
    ...(candidate.sourceParent === undefined
      ? {}
      : { sourceParent: candidate.sourceParent as string }),
    fileSize: candidate.size as number,
    fileSha256: toHex(candidate.digest as Uint8Array),
    tarSize: candidate.tarSize as number,
    tarSha256: toHex(candidate.tarDigest as Uint8Array),
    transferId: candidate.id,
    reset: false
  })
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

async function writeAll(handle: StorageFileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write commit journal')
    }
    offset += count
  }
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function digestExactFile(
  filePath: string,
  size: number,
  storage: StorageAdapter,
  syncFirst = false,
  expectedIdentity?: FileIdentity
): Promise<{ digest: Buffer; identity: FileIdentity } | null> {
  return withSafeDirectoryIdentity(path.dirname(filePath), storage, async () => {
    const handle = await openSafeRegularFile(filePath, 'read', storage)
    try {
      if (syncFirst) await handle.sync()
      const before = await handle.stat()
      if (!before.isFile() || before.size !== size) return null
      if (expectedIdentity && !identitiesEqual(fileIdentity(before), expectedIdentity)) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging file changed before digest')
      }

      const hash = new SodiumSha256()
      let position = 0
      while (position < size) {
        const bytes = b4a.alloc(Math.min(64 * 1024, size - position))
        if (!(await readExactly(handle, bytes, position))) return null
        hash.update(bytes)
        position += bytes.byteLength
      }

      const after = await handle.stat()
      if (
        !after.isFile() ||
        after.size !== size ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        if (expectedIdentity) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging file changed during digest')
        }
        return null
      }
      return {
        digest: hash.digest(),
        identity: fileIdentity(before)
      }
    } finally {
      await handle.close()
    }
  })
}

class CommitStore {
  layout: StorageLayout
  clock: { now(): number }
  storage: StorageAdapter
  logger: Logger | null
  journalAttempts: Map<string, string>
  /**
   * Whether this layout's filesystem exchanges directories atomically, learned once by trying it
   * on scratch directories. It belongs to this store, and so to one layout and one mount: a
   * negative answer for one filesystem is never reused for another.
   */
  swapSupport: Promise<boolean> | null = null

  constructor({ layout, clock = Date, storage = fs.promises, logger = null }: CommitStoreOptions) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')

    this.layout = layout
    this.clock = clock
    this.storage = storage
    this.logger = logger
    this.journalAttempts = new Map()
  }

  _stagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.part`)
  }

  _tarStagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.tar.part`)
  }

  _treeStagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.tree`)
  }

  _trashTreePath(id: string): string {
    return path.join(this.layout.trash, `${id}.tree`)
  }

  /** The visible state of one top-level directory path, without following links. */
  _rootTreeState(name: string): Promise<TreePathState> {
    return inspectTreePath(this._finalPath(name), this.layout.root, this.storage)
  }

  _sessionPath(id: string): string {
    return path.join(this.layout.sessions, `${id}.json`)
  }

  _journalPath(id: string): string {
    return path.join(this.layout.journals, `${id}.json`)
  }

  _recordPath(id: string): string {
    return path.join(this.layout.commits, `${id}.json`)
  }

  _finalPath(name: string): string {
    return path.join(this.layout.root, name)
  }

  _publicationPath(name: string): string {
    return path.join(this.layout.publications, name)
  }

  async _assertLayout(): Promise<void> {
    for (const directory of protectedDirectories(this.layout)) {
      await assertSafeDirectory(directory, this.storage)
    }
  }

  /** Inspects one top-level path without following or trusting symlinks. */
  _rootPathState(name: string): Promise<RootPathState> {
    const filePath = this._finalPath(name)
    return withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      let stat: StorageStat
      try {
        stat = await this.storage.lstat(filePath)
      } catch (err) {
        if (isMissing(err)) return { present: false, stat: null }
        throw err
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return { present: true, stat: null }
      return { present: true, stat }
    })
  }

  async _syncRoot(): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      syncDirectory(this.layout.root, this.storage)
    )
  }

  async _safeFileOrAbsent(filePath: string, directory: string): Promise<StorageStat | null> {
    try {
      return await withSafeDirectoryIdentity(directory, this.storage, () =>
        assertSafeFile(filePath, this.storage)
      )
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async _readRecordOrAbsent(recordPath: string): Promise<CommitRecord | null> {
    const stat = await this._safeFileOrAbsent(recordPath, this.layout.commits)
    if (!stat) return null
    return assertRecord(await readJson(recordPath, this.storage, MAX_COMMIT_METADATA_BYTES))
  }

  async _writeRecord(record: CommitRecord): Promise<boolean> {
    const recordPath = this._recordPath(record.transferId)
    const existing = await this._readRecordOrAbsent(recordPath)
    if (existing) {
      if (!recordsEqual(existing, record)) throw storageError('Conflicting commit record')
      return false
    }
    await writeAtomic(recordPath, b4a.from(JSON.stringify(record)), this.storage)
    return true
  }

  /** Persists a sidecar transition over its own previous durable content. */
  async _rewriteRecord(record: CommitRecord): Promise<void> {
    assertRecord(record)
    await writeAtomic(
      this._recordPath(record.transferId),
      b4a.from(JSON.stringify(record)),
      this.storage
    )
  }

  async _removeFile(filePath: string, directory: string): Promise<boolean> {
    let removed = false
    await withSafeDirectoryIdentity(directory, this.storage, async () => {
      try {
        await assertSafeFile(filePath, this.storage)
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      await this.storage.unlink(filePath)
      removed = true
    })
    if (removed) {
      await withSafeDirectoryIdentity(directory, this.storage, () =>
        syncDirectory(directory, this.storage)
      )
    }
    return removed
  }

  async _removeManagedFinalOrAbsent(
    record: CommitRecord
  ): Promise<{ removed: boolean; preservedPath: boolean }> {
    let removed = false
    let preservedPath = false
    const finalPath = this._finalPath(record.name)
    await withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      let stat
      try {
        stat = await this.storage.lstat(finalPath)
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      if (stat.isDirectory()) {
        try {
          await this.storage.rmdir(finalPath)
          removed = true
        } catch (err) {
          if (errorCode(err) === 'ENOTEMPTY' || errorCode(err) === 'EEXIST') {
            preservedPath = true
            return
          }
          throw err
        }
        return
      }
      await this.storage.unlink(finalPath)
      removed = true
    })
    if (removed) {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
    }
    return { removed, preservedPath }
  }

  async _linkJournal(id: string, journal: AnyCommitJournal, attempt: string): Promise<void> {
    const journalPath = this._journalPath(id)
    const temporary = path.join(this.layout.journals, `.${id}.${attempt}.tmp`)
    const bytes = b4a.from(JSON.stringify(serializeJournal(journal)))
    try {
      await withSafeDirectoryIdentity(this.layout.journals, this.storage, async () => {
        const handle = await openSafeRegularFile(temporary, 'create', this.storage)
        try {
          await writeAll(handle, bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.storage.link(temporary, journalPath)
        this.journalAttempts.set(id, attempt)
        await syncDirectory(this.layout.journals, this.storage)
      })
    } finally {
      await this._removeFile(temporary, this.layout.journals).catch(() => {})
    }
  }

  async _writeJournal(record: CommitRecord, sourceStagingIdentity: FileIdentity): Promise<string> {
    const journalPath = this._journalPath(record.transferId)
    if (await this._safeFileOrAbsent(journalPath, this.layout.journals)) {
      let existing
      try {
        existing = await this._readJournal(record.transferId)
      } catch (err) {
        if (!(err instanceof CorruptJournalError)) throw err
        await this.retireCorruptJournal(record.transferId)
      }
      if (existing) {
        if (
          existing.version !== JOURNAL_VERSION ||
          existing.state !== 'committing' ||
          !recordsEqual(existing.record, record) ||
          !identitiesEqual(existing.sourceStagingIdentity, sourceStagingIdentity) ||
          this.journalAttempts.get(record.transferId) !== existing.attemptId
        ) {
          throw storageError('Foreign commit journal already exists')
        }
        await withSafeDirectoryIdentity(this.layout.journals, this.storage, () =>
          syncDirectory(this.layout.journals, this.storage)
        )
        return existing.attemptId
      }
    }
    const id = attemptId()
    await this._linkJournal(
      record.transferId,
      {
        version: JOURNAL_VERSION,
        state: 'committing',
        attemptId: id,
        sourceStagingIdentity,
        record
      },
      id
    )
    return id
  }

  /** A replacement or directory commit always starts a fresh attempt; leftovers belong to recovery. */
  async _writeFreshJournal(
    journal: ReplacementJournal | DirectoryCommitJournal | DirectoryReplacementJournal
  ): Promise<void> {
    const id = journal.transferId
    if (await this._safeFileOrAbsent(this._journalPath(id), this.layout.journals)) {
      let existing: AnyCommitJournal | null = null
      try {
        existing = await this._readJournal(id)
      } catch (err) {
        if (!(err instanceof CorruptJournalError)) throw err
        await this.retireCorruptJournal(id)
      }
      if (existing) throw storageError('Foreign commit journal already exists')
    }
    await this._linkJournal(id, journal, journal.attemptId)
  }

  /**
   * Records the boundary an attempt has already passed. The observable
   * filesystem state stays authoritative during recovery; the phase is the
   * durable intent trail the journal must carry.
   */
  async _setReplacementPhase(
    journal: ReplacementJournal,
    phase: ReplacementPhase
  ): Promise<ReplacementJournal> {
    const next: ReplacementJournal = { ...journal, phase }
    await writeAtomic(
      this._journalPath(journal.transferId),
      b4a.from(JSON.stringify(serializeJournal(next))),
      this.storage
    )
    return next
  }

  async retireCorruptJournal(id: string): Promise<boolean> {
    if (!isHex(id)) throw storageError('Invalid corrupt journal ID')
    const journalPath = this._journalPath(id)
    const quarantine = path.join(this.layout.journals, `.${id}.corrupt-${attemptId()}`)
    let retired = false
    await withSafeDirectoryIdentity(this.layout.journals, this.storage, async () => {
      try {
        await assertSafeFile(journalPath, this.storage)
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      await this.storage.rename(journalPath, quarantine)
      retired = true
    })
    if (retired) {
      this.journalAttempts.delete(id)
      await withSafeDirectoryIdentity(this.layout.journals, this.storage, () =>
        syncDirectory(this.layout.journals, this.storage)
      )
    }
    return retired
  }

  async retireCorruptAttempt(id: string): Promise<{ retired: boolean; removedStaging: boolean }> {
    if (!isHex(id)) throw storageError('Invalid corrupt journal ID')
    const session = await this._safeFileOrAbsent(this._sessionPath(id), this.layout.sessions)
    let removedStaging = false
    if (!session) {
      removedStaging = await this._removeFile(this._stagingPath(id), this.layout.staging)
    }
    const retired = await this.retireCorruptJournal(id)
    return { retired, removedStaging }
  }

  async _discardJournal(id: string, expectedAttemptId: string): Promise<boolean> {
    const journal = await this._readJournal(id)
    if (!journal) {
      if (this.journalAttempts.get(id) === expectedAttemptId) this.journalAttempts.delete(id)
      return false
    }
    if (journal.attemptId !== expectedAttemptId) return false
    const removed = await this._removeFile(this._journalPath(id), this.layout.journals)
    if (removed && this.journalAttempts.get(id) === expectedAttemptId) {
      this.journalAttempts.delete(id)
    }
    return removed
  }

  async _markAttemptAborting(id: string, expectedAttemptId: string): Promise<AnyCommitJournal> {
    const journal = await this._readJournal(id)
    if (!journal || journal.attemptId !== expectedAttemptId) {
      throw storageError('Commit journal changed before abort')
    }
    if (journal.state === 'aborting') return journal
    const bytes = b4a.from(JSON.stringify({ ...serializeJournal(journal), state: 'aborting' }))
    await writeAtomic(this._journalPath(id), bytes, this.storage)
    const marked = await this._readJournal(id)
    if (
      !marked ||
      marked.version !== journal.version ||
      marked.attemptId !== expectedAttemptId ||
      marked.state !== 'aborting'
    ) {
      throw storageError('Commit journal changed while marking abort')
    }
    return marked
  }

  _linkStaging(
    stagingPath: string,
    finalPath: string,
    expectedIdentity: FileIdentity,
    signal: AbortSignalLike | null
  ): Promise<void> {
    return withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
        const staging = await assertSafeFile(stagingPath, this.storage)
        if (!identitiesEqual(fileIdentity(staging), expectedIdentity)) {
          throw storageError('Staging file changed before commit')
        }
        assertNotAborted(signal)
        await this.storage.link(stagingPath, finalPath)
        assertNotAborted(signal)
      })
    )
  }

  /**
   * Makes a verified staging inode public through its O_NOFOLLOW descriptor,
   * while the staging directory identity is pinned. This runs before linking
   * the inode into the visible artifact root.
   */
  _normalizeFilePublicationMode(stagingPath: string): Promise<FileIdentity> {
    return withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
      let handle: StorageFileHandle | null = null
      let operationError: unknown = null
      try {
        handle = await openSafeRegularFile(stagingPath, 'read', this.storage)
        const before = await handle.stat()
        if (typeof before.nlink === 'number' && before.nlink > 1) {
          throw storageError('Staging file cannot be hard linked before publication')
        }
        if (typeof handle.chmod !== 'function') {
          throw new SwarmDeployError(
            ERRORS.UNSUPPORTED_STORAGE,
            'Storage adapter cannot normalize published artifact modes'
          )
        }
        try {
          await handle.chmod(0o644)
        } catch (error: unknown) {
          throw commitError('Unable to normalize published artifact modes', error)
        }
        const after = await handle.stat()
        if (!identitiesEqual(fileIdentity(after), fileIdentity(before))) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging file changed during publication')
        }
        await handle.sync()
        return fileIdentity(after)
      } catch (error: unknown) {
        operationError = error
        throw error instanceof SwarmDeployError
          ? error
          : commitError('Unable to normalize published artifact modes', error)
      } finally {
        if (handle) {
          if (operationError !== null) {
            await handle.close().catch(() => {})
          } else {
            try {
              await handle.close()
            } catch (error: unknown) {
              throw commitError('Unable to close published artifact', error)
            }
          }
        }
      }
    })
  }

  async _removeAbortedPublication(
    record: CommitRecord,
    expectedIdentity: FileIdentity
  ): Promise<void> {
    const errors: unknown[] = []
    try {
      const finalPath = this._finalPath(record.name)
      const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
      if (final && identitiesEqual(fileIdentity(final), expectedIdentity)) {
        await this._removeFile(finalPath, this.layout.root)
      }
    } catch (err) {
      errors.push(err)
    }
    try {
      const recordPath = this._recordPath(record.transferId)
      const sidecar = await this._readRecordOrAbsent(recordPath)
      if (sidecar && recordsEqual(sidecar, record)) {
        await this._removeFile(recordPath, this.layout.commits)
      }
    } catch (err) {
      errors.push(err)
    }
    if (errors.length) throw new AggregateError(errors, 'Unable to roll back publication')
  }

  _reportCleanupPending(record: CommitRecord, err: unknown): void {
    try {
      // The full SHA-256 of the uploader's public key; the server's logs carry its first 12
      // characters as `publicKeyId`.
      this.logger?.warn?.('Committed artifact cleanup remains pending', {
        uploaderKeyId: record.uploaderFingerprint,
        name: record.name,
        code: errorCode(err),
        reason: err instanceof Error ? err.message : String(err)
      })
    } catch {}
  }

  async _abortAttempt(
    record: CommitRecord,
    expectedIdentity: FileIdentity,
    attemptId: string,
    aborted: unknown
  ): Promise<never> {
    try {
      await this._markAttemptAborting(record.transferId, attemptId)
      await this._removeAbortedPublication(record, expectedIdentity)
      await this._discardJournal(record.transferId, attemptId)
    } catch (cleanupError) {
      throw new AggregateError([aborted, cleanupError], 'Unable to clean up aborted commit')
    }
    throw aborted
  }

  async _removeOwnedFile(
    filePath: string,
    directory: string,
    identity: FileIdentity
  ): Promise<boolean> {
    const stat = await this._safeFileOrAbsent(filePath, directory)
    if (!stat || !identitiesEqual(fileIdentity(stat), identity)) return false
    return this._removeFile(filePath, directory)
  }

  async _matchesRecord(
    filePath: string,
    directory: string,
    record: CommitRecord,
    syncFirst = false
  ): Promise<boolean> {
    const stat = await this._safeFileOrAbsent(filePath, directory)
    if (!stat) return false
    const result = await digestExactFile(filePath, record.size, this.storage, syncFirst)
    return result !== null && digestMatches(result.digest, b4a.from(record.sha256, 'hex'))
  }

  _recordFromSession(session: CommitSession, release?: CommitRelease): CommitRecord {
    assertSession(session)
    const base = {
      name: session.name,
      size: session.size,
      sha256: toHex(session.digest),
      committedAt: this.clock.now(),
      uploaderFingerprint: fingerprint(session.ownerKey),
      transferId: session.id,
      ...(release === undefined ? {} : { release })
    }
    return assertRecord(
      session.kind === 'directory'
        ? {
            version: DIRECTORY_COMMIT_VERSION,
            kind: 'directory' as const,
            entryCount: session.entryCount,
            ...base
          }
        : { version: COMMIT_VERSION, ...base }
    )
  }

  async inspect(
    name: string,
    offer: CommitOffer,
    { replaceNames, replace }: ReplacePolicy = {}
  ): Promise<InspectResult> {
    await this._assertLayout()
    validateBasename(name)
    if (isReservedHistoryName(name)) {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
    }
    if (!offer || typeof offer !== 'object') throw storageError('Invalid commit offer')
    if (offer.name !== name) throw storageError('Commit offer name mismatch')
    assertSafeUint(offer.size, 'commit offer size')
    assertFixed32(offer.digest, 'commit offer digest')
    assertFixed32(offer.transferId, 'commit offer transfer ID')
    if (offer.kind !== undefined && offer.kind !== 'file' && offer.kind !== 'directory') {
      throw storageError('Invalid commit offer kind')
    }
    if (offer.kind === 'directory') assertSafeUint(offer.entryCount, 'commit offer entry count')
    const release = snapshotRelease(offer.release)
    const rules = replaceRules(validateReplaceNames(replaceNames), replace)

    return withNameLease(this.layout.root, name, () => this._inspect(name, offer, rules, release))
  }

  async _inspect(
    name: string,
    offer: CommitOffer,
    rules: ReplaceRules,
    release: CommitRelease | undefined
  ): Promise<InspectResult> {
    if (offer.kind === 'directory') return this._inspectDirectory(name, offer, rules, release)

    const finalPath = this._finalPath(name)
    const occupied = await this._rootPathState(name)
    if (!occupied.present) return { status: 'AVAILABLE' }
    // A directory, a link or a special file is another kind of thing: never replaced.
    if (occupied.stat === null) return { status: 'FILE_EXISTS' }
    const final = occupied.stat

    const id = toHex(offer.transferId)
    const record = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      record &&
      record.name === name &&
      record.size === offer.size &&
      sameHex32(record.sha256, toHex(offer.digest)) &&
      sameHex32(record.transferId, id) &&
      releasesEqual(record.release, release) &&
      (await this._matchesRecord(finalPath, this.layout.root, record))
    ) {
      return { status: 'ALREADY_COMMITTED', record }
    }
    if (!rules.permits(name)) return { status: 'FILE_EXISTS' }

    const current = await this._managedCurrent(name)
    if (!current || !identitiesEqual(current.identity, fileIdentity(final))) {
      return { status: 'FILE_EXISTS' }
    }
    const sameRelease = releasesEqual(current.record.release, release)
    if (sameHex32(current.record.transferId, id) && !sameRelease) {
      // One transfer ID names one authenticated upload; its release identity is immutable.
      throw storageError('Release identity conflicts with the committed transfer')
    }
    if (
      sameRelease &&
      current.record.size === offer.size &&
      sameHex32(current.record.sha256, toHex(offer.digest))
    ) {
      return { status: 'ALREADY_COMMITTED', record: current.record }
    }
    if (await rules.busy(current.record)) return { status: 'BUSY' }
    return { status: 'REPLACEABLE', record: current.record }
  }

  async _inspectDirectory(
    name: string,
    offer: CommitOffer,
    rules: ReplaceRules,
    release: CommitRelease | undefined
  ): Promise<InspectResult> {
    if ((await this._rootTreeState(name)) === 'MISSING') {
      const occupied = await this._safeFileOrAbsent(this._finalPath(name), this.layout.root)
      return occupied ? { status: 'FILE_EXISTS' } : { status: 'AVAILABLE' }
    }
    const id = toHex(offer.transferId)
    const record = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      record &&
      record.kind === 'directory' &&
      record.version === DIRECTORY_COMMIT_VERSION &&
      record.name === name &&
      record.size === offer.size &&
      record.entryCount === offer.entryCount &&
      sameHex32(record.sha256, toHex(offer.digest)) &&
      sameHex32(record.transferId, id)
    ) {
      // This very upload is already committed here, provided the tree on disk still is it.
      const proven = await this._provenDirectoryTree(name, record)
      return proven === null ? { status: 'FILE_EXISTS' } : { status: 'ALREADY_COMMITTED', record }
    }
    if (!rules.permits(name)) return { status: 'FILE_EXISTS' }

    const current = await this._managedDirectoryCurrent(name)
    if (current === null) return { status: 'FILE_EXISTS' }
    const sameRelease = releasesEqual(current.record.release, release)
    if (sameHex32(current.record.transferId, id) && !sameRelease) {
      throw storageError('Release identity conflicts with the committed transfer')
    }
    if (
      sameRelease &&
      current.record.size === offer.size &&
      current.record.entryCount === offer.entryCount &&
      sameHex32(current.record.sha256, toHex(offer.digest))
    ) {
      return { status: 'ALREADY_COMMITTED', record: current.record }
    }
    if (await rules.busy(current.record)) return { status: 'BUSY' }
    // Asked last, so a name nobody may replace never pays for a probe, and a server that never
    // replaces a directory never loads the native addon.
    if (!(await this.supportsAtomicSwap())) return { status: 'UNSUPPORTED' }
    return { status: 'REPLACEABLE', record: current.record }
  }

  /** The managed record whose verified content currently owns a visible name. */
  async _managedCurrent(
    name: string
  ): Promise<{ record: CommitRecord; identity: FileIdentity } | null> {
    const finalPath = this._finalPath(name)
    const matches = (await this._scanRecords()).filter((record) => record.name === name)
    if (matches.length === 0) return null
    if (matches.length > 1) throw storageError('Duplicate managed commit filename')
    const record = matches[0]
    if (record.kind === 'directory') return null
    const digested = await digestExactFile(finalPath, record.size, this.storage)
    if (!digested || !digestMatches(digested.digest, b4a.from(record.sha256, 'hex'))) return null
    return { record, identity: digested.identity }
  }

  /**
   * Proves the tree visible at `name` is exactly the one `record` describes, and returns its root
   * identity and an identity snapshot of every member. The snapshot is taken first and the digest
   * is computed against it, so the digested tree is known to be the snapshotted one: a child added,
   * removed or changed (an empty directory included) is a tree that is not the record's. A forbidden
   * entry, a symlink, a concurrent change or any other kind of path is `null`, never a surprise.
   */
  async _provenDirectoryTree(
    name: string,
    record: CommitRecord
  ): Promise<{ identity: FileIdentity; snapshot: TreeIdentitySnapshot } | null> {
    if ((await this._rootTreeState(name)) !== 'DIRECTORY') return null
    const finalPath = this._finalPath(name)
    let snapshot: TreeIdentitySnapshot
    let digested
    try {
      snapshot = await captureTreeSnapshot(finalPath, this.storage)
      digested = await digestTree(finalPath, this.storage, snapshot)
    } catch (error: unknown) {
      if (
        error instanceof SwarmDeployError &&
        (error.code === ERRORS.INVALID_FILENAME ||
          error.code === ERRORS.PROTOCOL_INVALID ||
          error.code === ERRORS.FILE_BUSY)
      ) {
        return null
      }
      throw error
    }
    if (
      digested.entryCount !== record.entryCount ||
      digested.payloadBytes !== record.size ||
      !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
    ) {
      return null
    }
    const stat = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.lstat(finalPath)
    )
    return { identity: fileIdentity(stat), snapshot }
  }

  /** The managed directory record whose proven tree currently owns a visible name. */
  async _managedDirectoryCurrent(name: string): Promise<{
    record: CommitRecord
    identity: FileIdentity
    snapshot: TreeIdentitySnapshot
  } | null> {
    const matches = (await this._scanRecords()).filter((record) => record.name === name)
    if (matches.length === 0) return null
    if (matches.length > 1) throw storageError('Duplicate managed commit filename')
    const record = matches[0]
    if (record.kind !== 'directory' || record.version !== DIRECTORY_COMMIT_VERSION) return null
    const proven = await this._provenDirectoryTree(name, record)
    return proven === null ? null : { record, ...proven }
  }

  _assertSessionMatchesRecord(session: CommitSession, record: CommitRecord, message: string): void {
    assertSession(session)
    if (
      session.name !== record.name ||
      session.size !== record.size ||
      toHex(session.digest) !== record.sha256 ||
      fingerprint(session.ownerKey) !== record.uploaderFingerprint ||
      (record.kind === 'directory' &&
        (session.kind !== 'directory' || session.entryCount !== record.entryCount))
    ) {
      throw new CorruptJournalError(message)
    }
  }

  async _validateAttemptLeftovers(
    id: string,
    journal: CommitJournal,
    sessionStore: SessionStore
  ): Promise<{ sessionFile: StorageStat | null; staging: StorageStat | null }> {
    const { record, sourceStagingIdentity } = journal
    const sessionPath = this._sessionPath(id)
    const stagingPath = this._stagingPath(id)
    const sessionFile = await this._safeFileOrAbsent(sessionPath, this.layout.sessions)
    const staging = await this._safeFileOrAbsent(stagingPath, this.layout.staging)
    if (sessionFile) {
      if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
        throw storageError('Session store cannot validate commit cleanup')
      }
      const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
      this._assertSessionMatchesRecord(
        session,
        record,
        'Commit journal does not match verified session'
      )
    }
    if (
      staging &&
      (!identitiesEqual(fileIdentity(staging), sourceStagingIdentity) ||
        !(await this._matchesRecord(stagingPath, this.layout.staging, record)))
    ) {
      throw storageError('Staging file does not match commit journal')
    }
    return { sessionFile, staging }
  }

  commit(
    session: CommitSession,
    {
      retentionManager = null,
      signal = null,
      replaceNames,
      replace,
      release = null,
      deferPostCommitRetention = false
    }: {
      retentionManager?: RetentionManager | null
      signal?: AbortSignalLike | null
      /** Exact names that may be replaced (the legacy `replaceNames`). */
      replaceNames?: Iterable<string>
      /** The wider, opt-in permission to replace managed artifacts; see {@link ReplacePermission}. */
      replace?: ReplacePermission
      release?: ReleaseCoordinates | null
      /**
       * Skips the post-commit retention pass so the caller can run it later
       * (via the retention manager) once work that needs the committed files
       * has finished. Pre-commit quota and age checks still run.
       */
      deferPostCommitRetention?: boolean
    } = {}
  ): Promise<CommitRecord> {
    try {
      assertSession(session)
      const releaseSnapshot = snapshotRelease(release)
      if (
        retentionManager !== null &&
        (typeof retentionManager.run !== 'function' ||
          typeof retentionManager.afterCommit !== 'function' ||
          typeof retentionManager._runUnlocked !== 'function' ||
          typeof retentionManager._afterCommitUnlocked !== 'function')
      ) {
        return Promise.reject(storageError('Invalid retention manager'))
      }
      if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
        return Promise.reject(storageError('Invalid commit abort signal'))
      }
      const rules = replaceRules(validateReplaceNames(replaceNames), replace)
      return withNameLease(this.layout.root, session.name, () =>
        withRootLease(this.layout.root, () =>
          this._commit(
            session,
            retentionManager,
            signal,
            rules,
            releaseSnapshot,
            deferPostCommitRetention === true
          )
        )
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  async _commit(
    session: CommitSession,
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null,
    rules: ReplaceRules = replaceRules(new Set(), undefined),
    release?: CommitRelease,
    deferPostCommitRetention = false
  ): Promise<CommitRecord> {
    assertNotAborted(signal)
    await this._assertLayout()
    const record = this._recordFromSession(session, release)
    if (isReservedHistoryName(record.name)) {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
    }
    if (session.kind === 'directory') {
      return this._commitDirectory(
        record,
        retentionManager,
        signal,
        rules,
        deferPostCommitRetention
      )
    }
    const stagingPath = this._stagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)

    const normalizedIdentity = await this._normalizeFilePublicationMode(stagingPath)
    const stagingDigest = await digestExactFile(
      stagingPath,
      record.size,
      this.storage,
      true,
      normalizedIdentity
    )
    if (
      stagingDigest === null ||
      !digestMatches(stagingDigest.digest, b4a.from(record.sha256, 'hex'))
    ) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging file checksum mismatch')
    }

    if (rules.permits(record.name)) {
      const plan = await this._planReplacement(record)
      if (plan.mode === 'idempotent') {
        await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
        await this._removeFile(stagingPath, this.layout.staging)
        return plan.record
      }
      if (plan.mode === 'replace') {
        // Asked again here, under the root lease: nothing can start using the artifact's path
        // between this answer and the change. Retryable, and never decided for good.
        if (await rules.busy(plan.oldRecord)) {
          throw new SwarmDeployError(
            ERRORS.FILE_BUSY,
            'Artifact is in use by a hook or a link request'
          )
        }
        return this._replace(
          record,
          stagingDigest.identity,
          plan,
          retentionManager,
          signal,
          deferPostCommitRetention
        )
      }
    }

    if (retentionManager) {
      await retentionManager._runUnlocked({ incomingBytes: record.size, trigger: 'commit' })
    }
    assertNotAborted(signal)

    const journalAttemptId = await this._writeJournal(record, stagingDigest.identity)
    let linked = false
    let linearized = false
    try {
      assertNotAborted(signal)
      await this._linkStaging(stagingPath, finalPath, stagingDigest.identity, signal)
      linked = true
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
      assertNotAborted(signal)
      await this._writeRecord(record)
      linearized = true
      assertNotAborted(signal)
      await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
      assertNotAborted(signal)
      await this._removeFile(stagingPath, this.layout.staging)
      await this._removeFile(this._tarStagingPath(record.transferId), this.layout.staging)
      assertNotAborted(signal)
      await this._discardJournal(record.transferId, journalAttemptId)
      if (retentionManager && !deferPostCommitRetention) {
        await retentionManager._afterCommitUnlocked()
      }
      return record
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(record, err)
        return record
      }
      if (errorCode(err) === ERRORS.ABORTED) {
        return this._abortAttempt(record, stagingDigest.identity, journalAttemptId, err)
      }
      if (!linked && errorCode(err) !== 'EEXIST') {
        const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
        linked =
          !!final &&
          identitiesEqual(fileIdentity(final), stagingDigest.identity) &&
          (await this._matchesRecord(finalPath, this.layout.root, record))
      }
      if (linked) {
        try {
          await this._removeAbortedPublication(record, stagingDigest.identity)
          await this._discardJournal(record.transferId, journalAttemptId)
        } catch (cleanupError) {
          throw new AggregateError([err, cleanupError], 'Unable to roll back failed publication')
        }
        throw err
      }

      try {
        await this._discardJournal(record.transferId, journalAttemptId)
      } catch (cleanupCause) {
        throw Object.assign(commitError('Unable to create final artifact', err), { cleanupCause })
      }
      if (errorCode(err) === 'EEXIST') {
        throw new SwarmDeployError(ERRORS.FILE_EXISTS, 'Destination already exists', err)
      }
      throw commitError('Unable to create final artifact', err)
    }
  }

  /**
   * Publishes one verified staging tree by rename. An unoccupied name is created. An occupied one
   * is replaced only when the name may be replaced (`rules`), the occupant is a managed directory
   * whose tree is proven against its record, and the storage can exchange directories atomically;
   * anything else (an unmanaged path, a modified tree, another kind of artifact) is an
   * existing-name conflict and is left exactly as it is.
   */
  async _commitDirectory(
    record: CommitRecord,
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null,
    rules: ReplaceRules,
    deferPostCommitRetention = false
  ): Promise<CommitRecord> {
    const treePath = this._treeStagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'DIRECTORY') {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Verified staging tree is missing')
    }
    const normalizedIdentities = await normalizeTreePublicationModes(treePath, this.storage)
    const digested = await digestTree(treePath, this.storage, normalizedIdentities)
    if (
      digested.entryCount !== record.entryCount ||
      digested.payloadBytes !== record.size ||
      !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
    ) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging tree checksum mismatch')
    }
    const stagingTreeIdentity = fileIdentity(
      await withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
        this.storage.lstat(treePath)
      )
    )
    const occupied =
      (await this._scanRecords()).some((existing) => existing.name === record.name) ||
      (await this._rootTreeState(record.name)) !== 'MISSING'
    if (occupied) {
      if (!rules.permits(record.name)) throw existsError('Destination already exists')
      return this._replaceDirectory(
        record,
        stagingTreeIdentity,
        normalizedIdentities,
        retentionManager,
        signal,
        rules,
        deferPostCommitRetention
      )
    }
    if (retentionManager) {
      await retentionManager._runUnlocked({ incomingBytes: record.size, trigger: 'commit' })
    }
    assertNotAborted(signal)

    const attempt = attemptId()
    let journal: DirectoryCommitJournal = {
      version: DIRECTORY_JOURNAL_VERSION,
      intent: 'create-directory',
      state: 'committing',
      phase: 'journaled',
      transferId: record.transferId,
      attemptId: attempt,
      name: record.name,
      stagingTreeName: `${record.transferId}.tree`,
      stagingTreeIdentity,
      record
    }
    await this._writeFreshJournal(journal)

    let linearized = false
    try {
      assertNotAborted(signal)
      if ((await this._rootTreeState(record.name)) !== 'MISSING') {
        throw existsError('Destination already exists')
      }
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
          this.storage.rename(treePath, finalPath)
        )
      )
      await this._syncRoot()
      journal = await this._setDirectoryPhase(journal, 'renamed')

      assertNotAborted(signal)
      await this._writeRecord(record)
      linearized = true
      journal = await this._setDirectoryPhase(journal, 'sidecar')

      await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
      await this._removeFile(this._tarStagingPath(record.transferId), this.layout.staging)
      await this._discardJournal(record.transferId, attempt)
      if (retentionManager && !deferPostCommitRetention) {
        await retentionManager._afterCommitUnlocked()
      }
      return record
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(record, err)
        return record
      }
      try {
        await this._rollbackDirectory(journal)
      } catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'Unable to roll back directory commit')
      }
      throw err
    }
  }

  async _setDirectoryPhase(
    journal: DirectoryCommitJournal,
    phase: DirectoryPhase
  ): Promise<DirectoryCommitJournal> {
    const next: DirectoryCommitJournal = { ...journal, phase }
    await writeAtomic(
      this._journalPath(journal.transferId),
      b4a.from(JSON.stringify(serializeJournal(next))),
      this.storage
    )
    return next
  }

  /** Returns a proven renamed tree to staging; a foreign destination is preserved. */
  async _rollbackDirectory(journal: DirectoryCommitJournal): Promise<void> {
    const finalPath = this._finalPath(journal.name)
    const treePath = this._treeStagingPath(journal.transferId)
    if ((await this._rootTreeState(journal.name)) !== 'DIRECTORY') {
      if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) === 'DIRECTORY') {
        await this._discardJournal(journal.transferId, journal.attemptId)
      }
      return
    }
    const visible = fileIdentity(
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.lstat(finalPath)
      )
    )
    if (!identitiesEqual(visible, journal.stagingTreeIdentity)) {
      throw storageError('Foreign artifact at directory destination')
    }
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'MISSING') {
      throw storageError('Directory staging tree already exists')
    }
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
        this.storage.rename(finalPath, treePath)
      )
    )
    await this._syncRoot()
    await this._discardJournal(journal.transferId, journal.attemptId)
  }

  // -------------------------------------------------------------------------
  // Directory replacement
  // -------------------------------------------------------------------------

  /**
   * Whether this layout's filesystem exchanges two directories atomically. It is learned once, by
   * exchanging two scratch directories, and remembered by this store alone: the answer belongs to
   * one layout on one mount. A probe that could not run at all is not an answer and is retried.
   * Nothing calls it for a file, and it is the only thing that can load the native addon.
   */
  supportsAtomicSwap(): Promise<boolean> {
    if (this.swapSupport === null) {
      const probe = this._probeAtomicSwap()
      this.swapSupport = probe
      probe.catch(() => {
        if (this.swapSupport === probe) this.swapSupport = null
      })
    }
    return this.swapSupport
  }

  async _probeAtomicSwap(): Promise<boolean> {
    const swap = this.storage.atomicSwap
    if (typeof swap !== 'function') return false
    await this._assertLayout()
    await this._sweepProbes(this.layout.publications)
    await this._sweepProbes(this.layout.trash)
    const token = attemptId().slice(0, 16)
    const first = path.join(this.layout.publications, `${PROBE_PREFIX}${token}`)
    const second = path.join(this.layout.trash, `${PROBE_PREFIX}${token}`)
    try {
      await this._makeProbe(first, this.layout.publications, 'first')
      await this._makeProbe(second, this.layout.trash, 'second')
      const beforeFirst = await this._treeSlot(first, this.layout.publications)
      const beforeSecond = await this._treeSlot(second, this.layout.trash)
      try {
        await swap.call(this.storage, first, second)
      } catch (error: unknown) {
        if (isUnsupportedExchange(error)) return false
        throw commitError('Unable to probe the atomic directory exchange', error)
      }
      const afterFirst = await this._treeSlot(first, this.layout.publications)
      const afterSecond = await this._treeSlot(second, this.layout.trash)
      const flipped =
        beforeFirst.state === 'DIRECTORY' &&
        beforeSecond.state === 'DIRECTORY' &&
        afterFirst.state === 'DIRECTORY' &&
        afterSecond.state === 'DIRECTORY' &&
        identitiesEqual(afterFirst.identity, beforeSecond.identity) &&
        identitiesEqual(afterSecond.identity, beforeFirst.identity)
      if (!flipped) return false
      // The names exchanged inodes; the contents travelled with them.
      return (
        (await this._probeMarker(first)) === 'second' &&
        (await this._probeMarker(second)) === 'first'
      )
    } finally {
      await removeTree(first, this.layout.publications, this.storage, {
        layout: this.layout
      }).catch(() => {})
      await removeTree(second, this.layout.trash, this.storage, { layout: this.layout }).catch(
        () => {}
      )
    }
  }

  /** Removes scratch directories an earlier, interrupted probe left in one private directory. */
  async _sweepProbes(parent: string): Promise<void> {
    const names = await withSafeDirectoryIdentity(parent, this.storage, () =>
      this.storage.readdir(parent)
    )
    for (const name of names.filter((entry) => entry.startsWith(PROBE_PREFIX))) {
      await removeTree(path.join(parent, name), parent, this.storage, {
        layout: this.layout
      }).catch(() => {})
    }
  }

  async _makeProbe(directory: string, parent: string, content: string): Promise<void> {
    await withSafeDirectoryIdentity(parent, this.storage, async () => {
      await this.storage.mkdir(directory, { mode: 0o700 })
      const handle = await openSafeRegularFile(
        path.join(directory, PROBE_MARKER),
        'create',
        this.storage
      )
      try {
        await writeAll(handle, b4a.from(content))
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  async _probeMarker(directory: string): Promise<string> {
    const value = await this.storage.readFile(path.join(directory, PROBE_MARKER), 'utf8')
    return typeof value === 'string' ? value : b4a.toString(value, 'utf8')
  }

  /** The state of one top-level directory slot, without following links. */
  _treeSlot(target: string, parent: string): Promise<TreeSlot> {
    return withSafeDirectoryIdentity(parent, this.storage, async (): Promise<TreeSlot> => {
      let stat: StorageStat
      try {
        stat = await this.storage.lstat(target)
      } catch (error: unknown) {
        if (isMissing(error)) return { state: 'MISSING' }
        throw error
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'UNMANAGED' }
      return { state: 'DIRECTORY', identity: fileIdentity(stat) }
    })
  }

  /** Whether `slot` is the directory with exactly this inode. */
  _holds(slot: TreeSlot, identity: FileIdentity): boolean {
    return slot.state === 'DIRECTORY' && identitiesEqual(slot.identity, identity)
  }

  async _syncDirectories(...directories: string[]): Promise<void> {
    for (const directory of directories) {
      await withSafeDirectoryIdentity(directory, this.storage, () =>
        syncDirectory(directory, this.storage)
      )
    }
  }

  /**
   * Moves one directory between two private or public directories by rename, only after proving
   * that the source is the directory with the expected inode and that the destination is free.
   * The move is atomic; both parents are synced before it counts.
   */
  async _moveTree(
    from: string,
    fromParent: string,
    to: string,
    toParent: string,
    expected: FileIdentity
  ): Promise<void> {
    await withSafeDirectoryIdentity(fromParent, this.storage, () =>
      withSafeDirectoryIdentity(toParent, this.storage, async () => {
        const source = await this.storage.lstat(from)
        if (
          source.isSymbolicLink() ||
          !source.isDirectory() ||
          !identitiesEqual(fileIdentity(source), expected)
        ) {
          throw storageError('Directory changed before it was moved')
        }
        let occupied = true
        try {
          await this.storage.lstat(to)
        } catch (error: unknown) {
          if (!isMissing(error)) throw error
          occupied = false
        }
        if (occupied) throw existsError('Directory destination already exists')
        await this.storage.rename(from, to)
      })
    )
    await this._syncDirectories(fromParent, toParent)
  }

  /**
   * Exchanges the directory at the publication path with the one at the visible name, in one
   * atomic step, after proving both are directories with the expected inodes on one filesystem.
   * What the exchange did is read back rather than assumed, so an adapter that reports an error
   * after exchanging is recognized as having exchanged, and one that did nothing as having
   * changed nothing.
   */
  async _swapTrees(
    publication: string,
    final: string,
    expectedPublication: FileIdentity,
    expectedFinal: FileIdentity
  ): Promise<void> {
    const swap = this.storage.atomicSwap
    if (typeof swap !== 'function') throw unsupportedExchange()
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.publications, this.storage, async () => {
        const first = await this.storage.lstat(publication)
        const second = await this.storage.lstat(final)
        for (const [stat, expected] of [
          [first, expectedPublication],
          [second, expectedFinal]
        ] as const) {
          if (
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            !identitiesEqual(fileIdentity(stat), expected)
          ) {
            throw storageError('Directory changed before the exchange')
          }
        }
        if (fileIdentity(first).dev !== fileIdentity(second).dev) {
          throw unsupportedExchange()
        }
        let failure: unknown = null
        try {
          await swap.call(this.storage, publication, final)
        } catch (error: unknown) {
          failure = error
        }
        const nowPublication = fileIdentity(await this.storage.lstat(publication))
        const nowFinal = fileIdentity(await this.storage.lstat(final))
        const exchanged =
          identitiesEqual(nowPublication, expectedFinal) &&
          identitiesEqual(nowFinal, expectedPublication)
        const unchanged =
          identitiesEqual(nowPublication, expectedPublication) &&
          identitiesEqual(nowFinal, expectedFinal)
        if (exchanged) return
        if (!unchanged) throw storageError('Unexpected outcome of the directory exchange')
        if (failure !== null) {
          throw isUnsupportedExchange(failure)
            ? unsupportedExchange(failure)
            : commitError('Unable to exchange the directories', failure)
        }
        throw unsupportedExchange()
      })
    )
    await this._syncDirectories(this.layout.root, this.layout.publications)
  }

  /**
   * Classifies an occupied directory name. Only a managed directory record whose tree is proven
   * against it may be replaced; every other occupant, another kind of artifact included, is an
   * existing-name conflict.
   */
  async _planDirectoryReplacement(record: CommitRecord): Promise<DirectoryReplacementPlan> {
    const current = await this._managedDirectoryCurrent(record.name)
    if (current === null) throw existsError('Destination already exists')
    const sameRelease = releasesEqual(current.record.release, record.release)
    if (current.record.transferId === record.transferId && !sameRelease) {
      // One transfer ID names one authenticated upload; its release identity is immutable.
      throw storageError('Release identity conflicts with the committed transfer')
    }
    if (
      sameContent(current.record, record) &&
      current.record.entryCount === record.entryCount &&
      sameRelease
    ) {
      return { mode: 'idempotent', record: current.record }
    }
    return {
      mode: 'replace',
      oldRecord: current.record,
      oldTreeIdentity: current.identity,
      oldTreeSnapshot: current.snapshot
    }
  }

  /**
   * Looks, without changing anything, for a history copy of the content now returning (A, B, A).
   * When there is one, it is proven against its record and returned so the transaction can park it
   * and restore it exactly if the replacement does not complete. A history name occupied by
   * anything that is not that proven copy is a conflict.
   */
  async _planDirectoryDedup(record: CommitRecord): Promise<DirectoryDedup | null> {
    const name = historyName(record.transferId)
    const slot = await this._treeSlot(this._finalPath(name), this.layout.root)
    const existing = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (existing === null) {
      if (slot.state !== 'MISSING') throw existsError('History destination already exists')
      return null
    }
    if (
      existing.version !== DIRECTORY_HISTORY_COMMIT_VERSION ||
      existing.name !== name ||
      !sameContent(existing, record) ||
      existing.entryCount !== record.entryCount ||
      !releasesEqual(existing.release, record.release)
    ) {
      throw storageError('Conflicting commit record')
    }
    if (slot.state !== 'DIRECTORY') throw existsError('History destination already exists')
    const proven = await this._provenDirectoryTree(name, existing)
    if (proven === null) throw existsError('History destination already exists')
    return { record: existing, name, identity: proven.identity }
  }

  async _setDirectoryReplacementPhase(
    journal: DirectoryReplacementJournal,
    phase: DirectoryReplacementPhase
  ): Promise<DirectoryReplacementJournal> {
    const next: DirectoryReplacementJournal = { ...journal, phase }
    await writeAtomic(
      this._journalPath(journal.transferId),
      b4a.from(JSON.stringify(serializeJournal(next))),
      this.storage
    )
    return next
  }

  /**
   * Replaces a managed directory by atomic exchange. The visible name never stops existing and is
   * never half populated: the new tree waits at a private path, one exchange puts it at the name,
   * and the old tree waits at that same private path until it is moved to its history name.
   *
   * Everything before the new current record is durable can be undone exactly (the exchange is
   * repeated, the new tree returns to staging, a parked history copy returns to its name). The old
   * tree and a parked history copy are never deleted before then. Every move is preceded by a
   * proof of the inode being moved and of the destination being free, and anything else found at
   * a path (a foreign directory, a link, a changed inode) stops the transaction without touching
   * it. Before any of that, the state directory is durably marked as needing this release.
   */
  async _replaceDirectory(
    record: CommitRecord,
    stagingTreeIdentity: FileIdentity,
    stagingSnapshot: TreeIdentitySnapshot,
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null,
    rules: ReplaceRules,
    deferPostCommitRetention: boolean
  ): Promise<CommitRecord> {
    const treePath = this._treeStagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)
    const plan = await this._planDirectoryReplacement(record)
    if (plan.mode === 'idempotent') {
      await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
      await this._removeFile(this._tarStagingPath(record.transferId), this.layout.staging)
      await removeTree(treePath, this.layout.staging, this.storage, { layout: this.layout })
      return plan.record
    }
    const { oldRecord, oldTreeIdentity, oldTreeSnapshot } = plan
    const history = historyName(oldRecord.transferId)

    // The commit's own retention pass runs with the replaced name held, so it cannot delete what
    // is about to be replaced; it is a temporary pin under the root lease, never a permission.
    if (retentionManager) {
      await retentionManager._runUnlocked({
        incomingBytes: record.size,
        trigger: 'commit',
        pinNames: [record.name]
      })
    }
    assertNotAborted(signal)
    // The pass may have rewritten or removed anything it was allowed to: prove again, cheaply,
    // that the name still holds the very tree and record that were proven.
    const visible = await this._treeSlot(finalPath, this.layout.root)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(oldRecord.transferId))
    if (
      !this._holds(visible, oldTreeIdentity) ||
      sidecar === null ||
      !recordsEqual(sidecar, oldRecord) ||
      !(await treeMatchesSnapshot(finalPath, this.storage, oldTreeSnapshot))
    ) {
      throw existsError('Destination already exists')
    }
    if ((await this._treeSlot(this._finalPath(history), this.layout.root)).state !== 'MISSING') {
      throw existsError('History destination already exists')
    }
    const dedup = await this._planDirectoryDedup(record)
    // Asked under the root lease, after everything that could take time, so the answer is the one
    // the exchange acts on. Retryable: nothing has changed.
    if (await rules.busy(oldRecord)) {
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Artifact is in use by a hook or a link request')
    }
    if (!(await this.supportsAtomicSwap())) throw unsupportedExchange()
    // Durable before the first byte of anything an older release could not read.
    requireStateFeature(this.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT)

    const attempt = attemptId()
    let journal: DirectoryReplacementJournal = {
      version: DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
      intent: 'replace-directory',
      state: 'committing',
      phase: 'journaled',
      transferId: record.transferId,
      attemptId: attempt,
      name: record.name,
      historyName: history,
      publicationName: `${attempt}.tree`,
      dedupName: dedup === null ? null : `${attempt}.dedup`,
      stagingTreeIdentity,
      oldTreeIdentity,
      dedupTreeIdentity: dedup === null ? null : dedup.identity,
      dedupRecord: dedup === null ? null : dedup.record,
      oldRecord,
      record
    }
    await this._writeFreshJournal(journal)
    const publication = this._publicationPath(journal.publicationName)

    let linearized = false
    try {
      assertNotAborted(signal)
      if (dedup !== null && journal.dedupName !== null) {
        await this._moveTree(
          this._finalPath(dedup.name),
          this.layout.root,
          this._publicationPath(journal.dedupName),
          this.layout.publications,
          dedup.identity
        )
        journal = await this._setDirectoryReplacementPhase(journal, 'dedup-moved')
        assertNotAborted(signal)
      }
      await this._moveTree(
        treePath,
        this.layout.staging,
        publication,
        this.layout.publications,
        stagingTreeIdentity
      )
      journal = await this._setDirectoryReplacementPhase(journal, 'moved')
      assertNotAborted(signal)
      if (!(await treeMatchesSnapshot(publication, this.storage, stagingSnapshot))) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging tree changed before publication')
      }
      await this._swapTrees(publication, finalPath, stagingTreeIdentity, oldTreeIdentity)
      journal = await this._setDirectoryReplacementPhase(journal, 'swapped')
      // The old tree is private now. It must still be exactly what was proven, or the exchange
      // is repeated and the replacement fails: nothing changed under a hook's feet unnoticed.
      if (!(await treeMatchesSnapshot(publication, this.storage, oldTreeSnapshot))) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Managed directory changed during replacement')
      }
      assertNotAborted(signal)
      await this._writeCurrentDirectoryRecord(journal)
      linearized = true
      journal = await this._setDirectoryReplacementPhase(journal, 'current-sidecar')
      await this._finishDirectoryReplacement(journal)
      if (retentionManager && !deferPostCommitRetention) {
        await retentionManager._afterCommitUnlocked()
      }
      return record
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(record, err)
        return record
      }
      const aborted = errorCode(err) === ERRORS.ABORTED
      try {
        if (aborted) await this._markAttemptAborting(record.transferId, attempt)
        await this._rollbackDirectoryReplacement(journal)
        await this._discardJournal(record.transferId, attempt)
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          aborted
            ? 'Unable to clean up aborted directory replacement'
            : 'Unable to roll back failed directory replacement'
        )
      }
      throw err
    }
  }

  /**
   * The linearization point: the new current record becomes durable. When the returning content
   * already has a history record under this transfer ID, that record is replaced in one atomic
   * step by the current one, so the sidecar never goes missing.
   */
  async _writeCurrentDirectoryRecord(journal: DirectoryReplacementJournal): Promise<void> {
    if (journal.dedupRecord === null) {
      await this._writeRecord(journal.record)
      return
    }
    const existing = await this._readRecordOrAbsent(this._recordPath(journal.record.transferId))
    if (existing === null || !recordsEqual(existing, journal.dedupRecord)) {
      throw storageError('Replacement dedup record changed')
    }
    await this._rewriteRecord(journal.record)
  }

  /**
   * Completes a linearized directory replacement; every step is idempotent, so recovery repeats
   * it from wherever a crash stopped. The new tree must be the visible one. The old tree is moved
   * from the publication path to its history name unless it is already there, the old sidecar
   * becomes its history record, and only then is a parked duplicate history copy (proven by its
   * inode) removed, the session and TAR part retired and the journal discarded.
   */
  async _finishDirectoryReplacement(journal: DirectoryReplacementJournal): Promise<void> {
    const id = journal.transferId
    const finalPath = this._finalPath(journal.name)
    const historyPath = this._finalPath(journal.historyName)
    const publication = this._publicationPath(journal.publicationName)
    const visible = await this._treeSlot(finalPath, this.layout.root)
    if (!this._holds(visible, journal.stagingTreeIdentity)) {
      throw storageError('Linearized replacement does not own its final artifact')
    }
    const parked = await this._treeSlot(publication, this.layout.publications)
    const history = await this._treeSlot(historyPath, this.layout.root)
    if (this._holds(parked, journal.oldTreeIdentity)) {
      if (history.state !== 'MISSING') {
        throw storageError('Foreign artifact at replacement history name')
      }
      await this._moveTree(
        publication,
        this.layout.publications,
        historyPath,
        this.layout.root,
        journal.oldTreeIdentity
      )
      journal = await this._setDirectoryReplacementPhase(journal, 'history-moved')
    } else if (parked.state !== 'MISSING' || !this._holds(history, journal.oldTreeIdentity)) {
      throw storageError('Replaced directory is not where the journal says')
    }
    await this._repairDirectoryHistorySidecar(journal)
    journal = await this._setDirectoryReplacementPhase(journal, 'history-sidecar')
    await this._cleanupDirectoryReplacement(journal)
    await this._discardJournal(id, journal.attemptId)
  }

  /** Writes the old sidecar's history form; the old form is also accepted, and replaced. */
  async _repairDirectoryHistorySidecar(journal: DirectoryReplacementJournal): Promise<void> {
    const expected = historyRecord(journal.oldRecord, journal.historyName)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(journal.oldRecord.transferId))
    if (
      sidecar !== null &&
      !recordsEqual(sidecar, expected) &&
      !recordsEqual(sidecar, journal.oldRecord)
    ) {
      throw storageError('Replacement history sidecar does not match journal')
    }
    if (sidecar === null || !recordsEqual(sidecar, expected)) await this._rewriteRecord(expected)
  }

  /** Removes what a finished replacement no longer needs, each only when proven to be ours. */
  async _cleanupDirectoryReplacement(journal: DirectoryReplacementJournal): Promise<void> {
    if (journal.dedupName !== null && journal.dedupTreeIdentity !== null) {
      const parked = this._publicationPath(journal.dedupName)
      const slot = await this._treeSlot(parked, this.layout.publications)
      if (slot.state === 'DIRECTORY') {
        if (!identitiesEqual(slot.identity, journal.dedupTreeIdentity)) {
          throw storageError('Foreign artifact at replacement dedup path')
        }
        await removeTree(parked, this.layout.publications, this.storage, { layout: this.layout })
      } else if (slot.state === 'UNMANAGED') {
        throw storageError('Foreign artifact at replacement dedup path')
      }
    }
    await this._removeFile(this._sessionPath(journal.transferId), this.layout.sessions)
    await this._removeFile(this._tarStagingPath(journal.transferId), this.layout.staging)
  }

  /**
   * Restores the state before the replacement, from what is observed on disk: the exchange is
   * repeated if it happened, the new tree returns to staging, a parked history copy returns to its
   * name, and a current record that reached disk through an ambiguous write is undone. A path that
   * holds anything unexpected is not touched and the rollback fails closed.
   */
  async _rollbackDirectoryReplacement(journal: DirectoryReplacementJournal): Promise<void> {
    const newId = journal.record.transferId
    const finalPath = this._finalPath(journal.name)
    const historyPath = this._finalPath(journal.historyName)
    const publication = this._publicationPath(journal.publicationName)
    const treePath = this._treeStagingPath(newId)
    const sidecarPath = this._recordPath(newId)

    const sidecar = await this._readRecordOrAbsent(sidecarPath)
    if (sidecar !== null && recordsEqual(sidecar, journal.record)) {
      if (journal.dedupRecord !== null) await this._rewriteRecord(journal.dedupRecord)
      else await this._removeFile(sidecarPath, this.layout.commits)
    } else if (journal.dedupRecord !== null) {
      if (sidecar === null || !recordsEqual(sidecar, journal.dedupRecord)) {
        throw storageError('Replacement dedup record is missing')
      }
    } else if (sidecar !== null) {
      throw storageError('Commit sidecar does not match journal')
    }

    let visible = await this._treeSlot(finalPath, this.layout.root)
    let parked = await this._treeSlot(publication, this.layout.publications)
    if (this._holds(visible, journal.stagingTreeIdentity)) {
      if (!this._holds(parked, journal.oldTreeIdentity)) {
        throw storageError('Replacement cannot restore the old artifact')
      }
      await this._swapTrees(
        publication,
        finalPath,
        journal.oldTreeIdentity,
        journal.stagingTreeIdentity
      )
      visible = await this._treeSlot(finalPath, this.layout.root)
      parked = await this._treeSlot(publication, this.layout.publications)
    }
    if (!this._holds(visible, journal.oldTreeIdentity)) {
      throw storageError('Foreign artifact at replacement destination')
    }
    if ((await this._treeSlot(historyPath, this.layout.root)).state !== 'MISSING') {
      throw storageError('Foreign artifact at replacement history name')
    }
    const staged = await this._treeSlot(treePath, this.layout.staging)
    if (this._holds(parked, journal.stagingTreeIdentity)) {
      if (staged.state !== 'MISSING') throw storageError('Directory staging tree already exists')
      await this._moveTree(
        publication,
        this.layout.publications,
        treePath,
        this.layout.staging,
        journal.stagingTreeIdentity
      )
    } else if (parked.state !== 'MISSING') {
      throw storageError('Foreign artifact at replacement publication path')
    } else if (!this._holds(staged, journal.stagingTreeIdentity)) {
      throw storageError('Replacement lost the new tree')
    }

    if (journal.dedupName !== null && journal.dedupTreeIdentity !== null) {
      const parkedCopy = this._publicationPath(journal.dedupName)
      const copyName = this._finalPath(historyName(newId))
      const copy = await this._treeSlot(parkedCopy, this.layout.publications)
      const restored = await this._treeSlot(copyName, this.layout.root)
      if (this._holds(copy, journal.dedupTreeIdentity)) {
        if (restored.state !== 'MISSING') {
          throw storageError('Foreign artifact at replacement dedup history name')
        }
        await this._moveTree(
          parkedCopy,
          this.layout.publications,
          copyName,
          this.layout.root,
          journal.dedupTreeIdentity
        )
      } else if (copy.state !== 'MISSING') {
        throw storageError('Foreign artifact at replacement dedup path')
      } else if (!this._holds(restored, journal.dedupTreeIdentity)) {
        throw storageError('Replacement lost the dedup history copy')
      }
    }
  }

  /**
   * Startup recovery of one directory replacement. A durable new current record means the
   * replacement happened and is completed; otherwise it is undone exactly. An owner revoked since,
   * or a journal already marked aborting, makes an unfinished replacement abort instead of resume.
   */
  async _recoverDirectoryReplacement(
    id: string,
    journal: DirectoryReplacementJournal,
    sessionStore: SessionStore | null,
    isAuthorized: ((ownerKey: Uint8Array) => boolean) | null
  ): Promise<{ status: 'COMMITTED' | 'ABORTED' | 'RESUMABLE'; record: CommitRecord }> {
    let forceAbort = journal.state === 'aborting'
    if (isAuthorized && journal.state === 'committing') {
      if (!sessionStore || !(sessionStore.sessions instanceof Map)) {
        throw storageError('Session store cannot validate commit journal')
      }
      const session = sessionStore.sessions.get(id)
      if (session && !isAuthorized(session.ownerKey)) forceAbort = true
    }
    const sidecar = await this._readRecordOrAbsent(this._recordPath(id))
    const linearized = sidecar !== null && recordsEqual(sidecar, journal.record)
    if (
      sidecar !== null &&
      !linearized &&
      !(journal.dedupRecord !== null && recordsEqual(sidecar, journal.dedupRecord))
    ) {
      throw storageError('Commit sidecar does not match journal')
    }
    if (linearized) {
      await this._finishDirectoryReplacement(journal)
      return { status: 'COMMITTED', record: journal.record }
    }
    if (forceAbort && journal.state === 'committing') {
      const marked = await this._markAttemptAborting(id, journal.attemptId)
      if (!isDirectoryReplacementJournal(marked)) {
        throw storageError('Commit journal changed before abort')
      }
      journal = marked
    }
    await this._rollbackDirectoryReplacement(journal)
    await this._discardJournal(id, journal.attemptId)
    return {
      status: journal.state === 'aborting' ? 'ABORTED' : 'RESUMABLE',
      record: journal.record
    }
  }

  /**
   * Classifies a configured mutable name. Only an exact managed current record
   * whose verified content owns the visible path may be replaced; every other
   * occupied path is an existing-name conflict.
   */
  async _planReplacement(record: CommitRecord): Promise<ReplacementPlan> {
    if ((await this._rootTreeState(record.name)) === 'DIRECTORY') {
      throw existsError('Destination already exists')
    }
    const state = await this._rootPathState(record.name)
    if (!state.present) return { mode: 'create' }
    if (!state.stat) throw existsError('Destination already exists')
    const current = await this._managedCurrent(record.name)
    if (!current || !identitiesEqual(current.identity, fileIdentity(state.stat))) {
      throw existsError('Destination already exists')
    }
    const sameRelease = releasesEqual(current.record.release, record.release)
    if (current.record.transferId === record.transferId && !sameRelease) {
      // One transfer ID names one authenticated upload; its release identity is immutable.
      throw storageError('Release identity conflicts with the committed transfer')
    }
    if (sameContent(current.record, record) && sameRelease) {
      return { mode: 'idempotent', record: current.record }
    }
    return { mode: 'replace', oldRecord: current.record, finalIdentity: current.identity }
  }

  /**
   * A repeated A→B→A sequence reuses a transfer ID that already owns a history
   * artifact of identical content. Nothing of it is changed here, and nothing is
   * deleted until the new current record is durable: the history record is then
   * replaced by the current one in a single atomic step, and only afterwards is
   * the superseded duplicate file removed (once proven to be a copy of the
   * returning content), so the content ends as its only copy. Before that point
   * both the history file and its record are exactly as they were, and an
   * aborted or interrupted attempt leaves them so.
   */
  async _dedupHistory(
    record: CommitRecord
  ): Promise<{ name: string; identity: FileIdentity | null; record: CommitRecord } | null> {
    const name = historyName(record.transferId)
    const existing = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (!existing) return null
    if (
      existing.name !== name ||
      !sameContent(existing, record) ||
      !releasesEqual(existing.release, record.release)
    ) {
      throw storageError('Conflicting commit record')
    }
    const state = await this._rootPathState(name)
    if (!state.present) return { name, identity: null, record: existing }
    if (!state.stat) throw existsError('History destination already exists')
    const digested = await digestExactFile(this._finalPath(name), existing.size, this.storage)
    if (!digested || !digestMatches(digested.digest, b4a.from(existing.sha256, 'hex'))) {
      throw existsError('History destination already exists')
    }
    return { name, identity: digested.identity, record: existing }
  }

  /**
   * Whether `sidecar` is the history record of the content a replacement is returning, still in
   * place under the new transfer ID: what the journal's `dedupHistoryName` names, with the
   * returning content and release. Before the new current record is durable this is the expected
   * content of the sidecar path, not a conflict.
   */
  _isReturningHistoryRecord(
    sidecar: CommitRecord,
    journal: Pick<ReplacementJournal, 'dedupHistoryName' | 'record'>
  ): boolean {
    return (
      journal.dedupHistoryName !== null &&
      sidecar.name === journal.dedupHistoryName &&
      sameContent(sidecar, journal.record) &&
      releasesEqual(sidecar.release, journal.record.release)
    )
  }

  /**
   * Removes the superseded duplicate history file of returning content, after the new current
   * record is durable. It goes only when it is proven to be that duplicate: the very inode proven
   * when the replacement began, or, from a journal alone, a file whose bytes are those of the
   * current record. Anything else at that name (a directory, a link, other bytes) is not ours and is
   * left as it is.
   */
  async _cleanupDedupHistory(
    journal: ReplacementJournal,
    identity: FileIdentity | null = null
  ): Promise<void> {
    if (journal.dedupHistoryName === null) return
    const target = this._finalPath(journal.dedupHistoryName)
    const state = await this._rootPathState(journal.dedupHistoryName)
    if (!state.present || !state.stat) return
    if (identity !== null) {
      if (!identitiesEqual(fileIdentity(state.stat), identity)) return
    } else if (!(await this._matchesRecord(target, this.layout.root, journal.record))) {
      return
    }
    await this._removeFile(target, this.layout.root)
  }

  async _replace(
    record: CommitRecord,
    stagingIdentity: FileIdentity,
    plan: { oldRecord: CommitRecord; finalIdentity: FileIdentity },
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null,
    deferPostCommitRetention = false
  ): Promise<CommitRecord> {
    const { oldRecord, finalIdentity } = plan
    const history = historyName(oldRecord.transferId)
    const newRecord = assertRecord({
      ...record,
      version: REPLACEMENT_COMMIT_VERSION,
      replaces: { name: record.name, transferId: oldRecord.transferId, historyName: history }
    })
    const finalPath = this._finalPath(record.name)
    const historyPath = this._finalPath(history)
    const stagingPath = this._stagingPath(record.transferId)

    const historyState = await this._rootPathState(history)
    if (
      historyState.present &&
      !(historyState.stat && identitiesEqual(fileIdentity(historyState.stat), finalIdentity))
    ) {
      throw existsError('History destination already exists')
    }

    if (retentionManager) {
      // The replaced name is held for this pass, so the artifact about to be replaced survives
      // it even when no standing pin protects it (a permission to replace pins nothing).
      await retentionManager._runUnlocked({
        incomingBytes: newRecord.size,
        trigger: 'commit',
        pinNames: [record.name]
      })
    }
    assertNotAborted(signal)
    const pinned = await this._rootPathState(record.name)
    if (!pinned.stat || !identitiesEqual(fileIdentity(pinned.stat), finalIdentity)) {
      throw commitError('Managed artifact changed before replacement')
    }
    // Planned only now, under the same lease, like a directory replacement: the pass above may
    // legitimately have evicted the history copy of the returning content (quota, age, count), and
    // a plan made before it would then name a copy and a record that are gone. What this finds is
    // what the journal records and what linearization re-proves.
    const dedup = await this._dedupHistory(newRecord)

    const attempt = attemptId()
    let journal: ReplacementJournal = {
      version: REPLACEMENT_JOURNAL_VERSION,
      intent: 'replace',
      state: 'committing',
      phase: 'journaled',
      transferId: newRecord.transferId,
      attemptId: attempt,
      name: newRecord.name,
      historyName: history,
      publicationName: `${attempt}.part`,
      sourceStagingIdentity: stagingIdentity,
      finalIdentity,
      historyIdentity: finalIdentity,
      publicationIdentity: stagingIdentity,
      dedupHistoryName: dedup ? dedup.name : null,
      oldRecord,
      record: newRecord
    }
    const publicationPath = this._publicationPath(journal.publicationName)
    await this._writeFreshJournal(journal)

    let linearized = false
    try {
      assertNotAborted(signal)
      // A returning history copy (A, B, A) is neither removed nor rewritten here: its file and its
      // record stay exactly as they are until the new current record is durable, so any step
      // that fails or is interrupted before then leaves both intact.
      if (!(await this._rootPathState(history)).present) {
        await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
          this.storage.link(finalPath, historyPath)
        )
        await this._syncRoot()
      }
      journal = await this._setReplacementPhase(journal, 'history-linked')

      assertNotAborted(signal)
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
          this.storage.link(stagingPath, publicationPath)
        )
      )
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        syncDirectory(this.layout.publications, this.storage)
      )
      journal = await this._setReplacementPhase(journal, 'publication-linked')

      assertNotAborted(signal)
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
          this.storage.rename(publicationPath, finalPath)
        )
      )
      await this._syncRoot()
      journal = await this._setReplacementPhase(journal, 'final-renamed')

      assertNotAborted(signal)
      if (dedup) {
        // The history record of the returning content is replaced by the current one in one atomic
        // step, so the sidecar path is never missing and never conflicting.
        const parked = await this._readRecordOrAbsent(this._recordPath(newRecord.transferId))
        if (parked === null || !recordsEqual(parked, dedup.record)) {
          throw storageError('Replacement dedup record changed')
        }
        await this._rewriteRecord(newRecord)
      } else {
        await this._writeRecord(newRecord)
      }
      linearized = true
      journal = await this._setReplacementPhase(journal, 'current-sidecar')

      await this._rewriteRecord(historyRecord(oldRecord, history))
      journal = await this._setReplacementPhase(journal, 'history-sidecar')

      // Only now that the current record is durable does the superseded duplicate go.
      await this._cleanupDedupHistory(journal, dedup ? dedup.identity : null)
      await this._removeFile(this._sessionPath(newRecord.transferId), this.layout.sessions)
      await this._removeFile(stagingPath, this.layout.staging)
      await this._removeFile(this._tarStagingPath(newRecord.transferId), this.layout.staging)
      await this._discardJournal(newRecord.transferId, attempt)
      if (retentionManager && !deferPostCommitRetention) {
        await retentionManager._afterCommitUnlocked()
      }
      return newRecord
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(newRecord, err)
        return newRecord
      }
      const aborted = errorCode(err) === ERRORS.ABORTED
      try {
        if (aborted) await this._markAttemptAborting(newRecord.transferId, attempt)
        await this._rollbackReplacement(journal, dedup ? dedup.record : null)
        await this._discardJournal(newRecord.transferId, attempt)
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          aborted
            ? 'Unable to clean up aborted replacement'
            : 'Unable to roll back failed replacement'
        )
      }
      throw err
    }
  }

  /**
   * Restores the exact pinned old inode at the mutable name and removes only
   * transaction-owned history, publication, and sidecar paths. A foreign
   * destination is never overwritten or removed. `dedupRecord`, known only to the attempt that is
   * still running, is the history record of returning content: if an ambiguous write left the new
   * current record in its place, the history record is put back instead of the sidecar being lost.
   */
  async _rollbackReplacement(
    journal: ReplacementJournal,
    dedupRecord: CommitRecord | null = null
  ): Promise<void> {
    const { name, historyName: history, sourceStagingIdentity, finalIdentity } = journal
    const finalPath = this._finalPath(name)
    const historyPath = this._finalPath(history)
    const publicationPath = this._publicationPath(journal.publicationName)

    const final = await this._rootPathState(name)
    const historyState = await this._rootPathState(history)
    const ownsHistory =
      historyState.present &&
      historyState.stat !== null &&
      identitiesEqual(fileIdentity(historyState.stat), finalIdentity)
    if (historyState.present && !ownsHistory) {
      throw storageError('Foreign artifact at replacement history name')
    }

    if (final.stat && identitiesEqual(fileIdentity(final.stat), finalIdentity)) {
      if (ownsHistory) await this._removeFile(historyPath, this.layout.root)
    } else if (
      (final.stat && identitiesEqual(fileIdentity(final.stat), sourceStagingIdentity)) ||
      !final.present
    ) {
      if (!ownsHistory) {
        if (final.present) throw storageError('Replacement cannot restore the old artifact')
      } else {
        await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
          this.storage.rename(historyPath, finalPath)
        )
        await this._syncRoot()
      }
    } else {
      throw storageError('Foreign artifact at replacement destination')
    }

    await this._removeOwnedFile(publicationPath, this.layout.publications, sourceStagingIdentity)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(journal.record.transferId))
    if (sidecar && recordsEqual(sidecar, journal.record)) {
      if (dedupRecord !== null) await this._rewriteRecord(dedupRecord)
      else await this._removeFile(this._recordPath(journal.record.transferId), this.layout.commits)
    }
  }

  _readJournal(id: string): Promise<AnyCommitJournal | null> {
    return readCommitJournal(id, this.layout, this.storage)
  }

  /** Every parsable v2 or v4 journal, used to explain transient duplicate names. */
  async _pendingReplacements(): Promise<Array<ReplacementJournal | DirectoryReplacementJournal>> {
    const names = await withSafeDirectoryIdentity(this.layout.journals, this.storage, () =>
      this.storage.readdir(this.layout.journals)
    )
    const pending: Array<ReplacementJournal | DirectoryReplacementJournal> = []
    for (const filename of names.filter(isCommitRecordName).sort()) {
      let journal: AnyCommitJournal | null
      try {
        journal = await this._readJournal(filename.slice(0, -'.json'.length))
      } catch (err) {
        if (err instanceof CorruptJournalError) continue
        throw err
      }
      if (isReplacementJournal(journal) || isDirectoryReplacementJournal(journal)) {
        pending.push(journal)
      }
    }
    return pending
  }

  /**
   * The transfer IDs every unfinished replacement journal owns: the artifact being replaced, the
   * one replacing it, and a history copy parked for it. Retention keeps them exactly as they are
   * while the journal exists, so a pass that runs after a failed rollback cannot take or purge
   * what recovery still has to restore or complete.
   */
  async pendingReplacementPins(): Promise<ReadonlySet<string>> {
    await this._assertLayout()
    const pins = new Set<string>()
    for (const journal of await this._pendingReplacements()) {
      pins.add(journal.record.transferId)
      pins.add(journal.oldRecord.transferId)
    }
    return pins
  }

  /**
   * Finalizes or rolls back one v2 attempt. The durable new current sidecar is
   * the linearization point: before it the old content is restored, after it
   * the new content is preserved while history metadata and cleanup converge.
   */
  async _convergeReplacement(
    id: string,
    journal: ReplacementJournal,
    sessionStore: SessionStore | null,
    { forceAbort = false }: { forceAbort?: boolean } = {}
  ): Promise<{ status: 'COMMITTED' | 'ABORTED' | 'RESUMABLE'; record: CommitRecord }> {
    const { record, name, attemptId: attempt } = journal
    const finalPath = this._finalPath(name)
    const found = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    // Returning content (A, B, A) keeps its history record at this path until the new current
    // record replaces it, so that record is the expected, unlinearized state, not a conflict.
    const returning = found !== null && this._isReturningHistoryRecord(found, journal)
    if (found && !recordsEqual(found, record) && !returning) {
      throw storageError('Commit sidecar does not match journal')
    }
    const newSidecar = returning ? null : found

    if (newSidecar) {
      const final = await this._rootPathState(name)
      if (
        !final.stat ||
        !identitiesEqual(fileIdentity(final.stat), journal.sourceStagingIdentity) ||
        !(await this._matchesRecord(finalPath, this.layout.root, record))
      ) {
        throw storageError('Linearized replacement does not own its final artifact')
      }
      await this._repairHistorySidecar(journal)
      await this._removeOwnedFile(
        this._publicationPath(journal.publicationName),
        this.layout.publications,
        journal.sourceStagingIdentity
      )
      await this._cleanupDedupHistory(journal)
      await this._cleanupReplacementLeftovers(id, journal, sessionStore)
      await this._discardJournal(id, attempt)
      return { status: 'COMMITTED', record }
    }

    if (forceAbort && journal.state === 'committing') {
      const marked = await this._markAttemptAborting(id, attempt)
      if (!isReplacementJournal(marked)) throw storageError('Commit journal changed before abort')
      journal = marked
    }
    if (!(await this._assertReplacementRetryable(id, journal, sessionStore))) {
      throw new CorruptJournalError('Replacement journal does not own verified staging')
    }
    await this._rollbackReplacement(journal)
    await this._discardJournal(id, attempt)
    return { status: journal.state === 'aborting' ? 'ABORTED' : 'RESUMABLE', record }
  }

  /**
   * Startup recovery for one v2 attempt. Revocation of a still-live session
   * aborts the attempt first so the same rollback path converges.
   */
  _recoverReplacementJournal(
    id: string,
    journal: ReplacementJournal,
    sessionStore: SessionStore,
    isAuthorized: ((ownerKey: Uint8Array) => boolean) | null
  ): Promise<{ status: 'COMMITTED' | 'ABORTED' | 'RESUMABLE'; record: CommitRecord }> {
    let forceAbort = journal.state === 'aborting'
    if (isAuthorized && journal.state === 'committing') {
      if (!sessionStore || !(sessionStore.sessions instanceof Map)) {
        throw storageError('Session store cannot validate commit journal')
      }
      const session = sessionStore.sessions.get(id)
      if (session && !isAuthorized(session.ownerKey)) forceAbort = true
    }
    return this._convergeReplacement(id, journal, sessionStore, { forceAbort })
  }

  /** Writes or drops the history sidecar for an already linearized attempt. */
  async _repairHistorySidecar(journal: ReplacementJournal): Promise<void> {
    const { oldRecord, historyName: history, finalIdentity } = journal
    const expected = historyRecord(oldRecord, history)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(oldRecord.transferId))
    if (sidecar && !recordsEqual(sidecar, expected) && !recordsEqual(sidecar, oldRecord)) {
      throw storageError('Replacement history sidecar does not match journal')
    }
    const state = await this._rootPathState(history)
    if (
      state.present &&
      (!state.stat || !identitiesEqual(fileIdentity(state.stat), finalIdentity))
    ) {
      throw storageError('Foreign artifact at replacement history name')
    }
    if (!state.present) {
      const sidecarPath = this._recordPath(oldRecord.transferId)
      if (sidecar) await this._removeFile(sidecarPath, this.layout.commits)
      return
    }
    if (!(await this._matchesRecord(this._finalPath(history), this.layout.root, expected))) {
      throw storageError('Replacement history artifact does not match its record')
    }
    if (!sidecar || !recordsEqual(sidecar, expected)) await this._rewriteRecord(expected)
  }

  async _cleanupReplacementLeftovers(
    id: string,
    journal: ReplacementJournal,
    sessionStore: SessionStore | null
  ): Promise<void> {
    const sessionFile = await this._safeFileOrAbsent(this._sessionPath(id), this.layout.sessions)
    if (sessionFile) {
      if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
        throw storageError('Session store cannot validate commit cleanup')
      }
      this._assertSessionMatchesRecord(
        await sessionStore.readVerified(b4a.from(id, 'hex')),
        journal.record,
        'Commit journal does not match verified session'
      )
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
    }
    const stagingPath = this._stagingPath(id)
    const staging = await this._safeFileOrAbsent(stagingPath, this.layout.staging)
    if (staging) {
      if (!identitiesEqual(fileIdentity(staging), journal.sourceStagingIdentity)) {
        throw storageError('Staging file does not match commit journal')
      }
      await this._removeFile(stagingPath, this.layout.staging)
    }
    await this._removeFile(this._tarStagingPath(id), this.layout.staging)
  }

  /** Proves the verified session and staging an aborted attempt must retain. */
  /**
   * Converges one directory attempt. The durable sidecar is the linearization
   * point: before it a proven renamed tree returns to staging, after it the
   * published tree is kept and only residue is removed. A destination that
   * cannot be proven is preserved and fails closed.
   */
  async _recoverDirectoryJournal(
    id: string,
    journal: DirectoryCommitJournal,
    sessionStore: SessionStore,
    isAuthorized: ((ownerKey: Uint8Array) => boolean) | null = null
  ): Promise<{ status: 'COMMITTED' | 'RESUMABLE'; record: CommitRecord }> {
    const { record, name, attemptId: attempt } = journal
    const sidecar = await this._readRecordOrAbsent(this._recordPath(id))
    if (sidecar && !recordsEqual(sidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }
    const state = await this._rootTreeState(name)
    if (state === 'UNMANAGED') throw storageError('Foreign artifact at directory destination')

    if (state === 'DIRECTORY') {
      const digested = await digestTree(this._finalPath(name), this.storage)
      if (
        digested.entryCount !== record.entryCount ||
        digested.payloadBytes !== record.size ||
        !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
      ) {
        throw storageError('Published directory does not match its journal')
      }
      if (!sidecar && isAuthorized) {
        if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
          throw storageError('Session store cannot validate recovery state')
        }
        const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
        if (!isAuthorized(session.ownerKey)) {
          await this._rollbackDirectory(journal)
          return { status: 'RESUMABLE', record }
        }
      }
      if (!sidecar) await this._writeRecord(record)
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
      await this._removeFile(this._tarStagingPath(id), this.layout.staging)
      await this._discardJournal(id, attempt)
      return { status: 'COMMITTED', record }
    }

    if (sidecar) await this._removeFile(this._recordPath(id), this.layout.commits)
    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Session store cannot validate recovery state')
    }
    const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
    this._assertSessionMatchesRecord(
      session,
      record,
      'Directory journal does not match verified session'
    )
    const treePath = this._treeStagingPath(id)
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'DIRECTORY') {
      throw new CorruptJournalError('Directory journal does not own verified staging')
    }
    await this._discardJournal(id, attempt)
    return { status: 'RESUMABLE', record }
  }

  async _assertReplacementRetryable(
    id: string,
    journal: ReplacementJournal,
    sessionStore: SessionStore | null
  ): Promise<boolean> {
    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Session store cannot validate commit journal')
    }
    const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
    this._assertSessionMatchesRecord(
      session,
      journal.record,
      'Replacement journal does not match verified session'
    )
    const stagingPath = this._stagingPath(id)
    const staging = await this._safeFileOrAbsent(stagingPath, this.layout.staging)
    if (!staging || !identitiesEqual(fileIdentity(staging), journal.sourceStagingIdentity)) {
      return false
    }
    return this._matchesRecord(stagingPath, this.layout.staging, journal.record)
  }

  async recoverJournal(
    id: string,
    sessionStore: SessionStore,
    { isAuthorized = null }: { isAuthorized?: ((ownerKey: Uint8Array) => boolean) | null } = {}
  ): Promise<{
    status: 'MISSING' | 'FILE_EXISTS' | 'COMMITTED' | 'ABORTED' | 'RESUMABLE'
    record?: CommitRecord
  }> {
    await this._assertLayout()
    if (isAuthorized !== null && typeof isAuthorized !== 'function') {
      throw storageError('Invalid recovery authorization callback')
    }
    const journal = await this._readJournal(id)
    if (!journal) return { status: 'MISSING' }
    if (isDirectoryJournal(journal)) {
      return withNameLease(this.layout.root, journal.name, () =>
        this._recoverDirectoryJournal(id, journal, sessionStore, isAuthorized)
      )
    }
    if (isDirectoryReplacementJournal(journal)) {
      return withNameLease(this.layout.root, journal.name, () =>
        this._recoverDirectoryReplacement(id, journal, sessionStore, isAuthorized)
      )
    }
    if (isReplacementJournal(journal)) {
      return withNameLease(this.layout.root, journal.name, () =>
        this._recoverReplacementJournal(id, journal, sessionStore, isAuthorized)
      )
    }
    const { record, attemptId: journalAttemptId, sourceStagingIdentity } = journal
    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      final &&
      sidecar &&
      recordsEqual(sidecar, record) &&
      identitiesEqual(fileIdentity(final), sourceStagingIdentity) &&
      (await this._matchesRecord(finalPath, this.layout.root, record))
    ) {
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
      await this._removeFile(this._stagingPath(id), this.layout.staging)
      await this._removeFile(this._tarStagingPath(id), this.layout.staging)
      await this._discardJournal(id, journalAttemptId)
      return { status: 'COMMITTED', record }
    }

    if (journal.state === 'aborting') {
      if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
        throw storageError('Session store cannot validate aborted commit journal')
      }
      const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
      if (
        session.name !== record.name ||
        session.size !== record.size ||
        toHex(session.digest) !== record.sha256 ||
        fingerprint(session.ownerKey) !== record.uploaderFingerprint
      ) {
        throw new CorruptJournalError('Revoked commit journal does not match verified session')
      }
      const staging = await assertSafeFile(this._stagingPath(id), this.storage)
      if (!identitiesEqual(fileIdentity(staging), sourceStagingIdentity)) {
        throw new CorruptJournalError('Revoked commit staging does not match journal')
      }
      await this._removeAbortedPublication(record, sourceStagingIdentity)
      await this._discardJournal(id, journalAttemptId)
      return { status: 'ABORTED', record }
    }

    if (isAuthorized) {
      if (!sessionStore || !(sessionStore.sessions instanceof Map)) {
        throw storageError('Session store cannot validate commit journal')
      }
      const authorizedSession = sessionStore.sessions.get(id)
      if (authorizedSession && !isAuthorized(authorizedSession.ownerKey)) {
        await this._markAttemptAborting(id, journalAttemptId)
        return this.recoverJournal(id, sessionStore, { isAuthorized })
      }
    }

    if (final) {
      const staging = await this._safeFileOrAbsent(this._stagingPath(id), this.layout.staging)
      const provenanced =
        identitiesEqual(fileIdentity(final), sourceStagingIdentity) ||
        (staging && identitiesEqual(fileIdentity(final), fileIdentity(staging)))
      if (!provenanced) {
        await this._discardJournal(id, journalAttemptId)
        return { status: 'FILE_EXISTS', record }
      }
      if (!(await this._matchesRecord(finalPath, this.layout.root, record))) {
        throw storageError('Final file does not match commit journal')
      }
      if (!sidecar) {
        const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
        if (
          session.name !== record.name ||
          session.size !== record.size ||
          toHex(session.digest) !== record.sha256 ||
          fingerprint(session.ownerKey) !== record.uploaderFingerprint
        ) {
          throw new CorruptJournalError('Commit journal does not match verified session')
        }
        await this._writeRecord(record)
      }
      if (sidecar && !recordsEqual(sidecar, record)) {
        throw storageError('Commit sidecar does not match journal')
      }
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
      await this._removeFile(this._stagingPath(id), this.layout.staging)
      await this._removeFile(this._tarStagingPath(id), this.layout.staging)
      await this._discardJournal(id, journalAttemptId)
      return { status: 'COMMITTED', record }
    }

    if (sidecar && !recordsEqual(sidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }
    if (sidecar) await this._removeFile(this._recordPath(id), this.layout.commits)

    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Session store cannot validate recovery state')
    }
    const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
    if (
      session.name !== record.name ||
      session.size !== record.size ||
      toHex(session.digest) !== record.sha256
    ) {
      throw storageError('Verified session does not match commit journal')
    }
    const stagingPath = this._stagingPath(id)
    const staging = await this._safeFileOrAbsent(stagingPath, this.layout.staging)
    if (!staging || !identitiesEqual(fileIdentity(staging), sourceStagingIdentity)) {
      throw new CorruptJournalError('Commit journal does not own verified staging')
    }
    if (!(await this._matchesRecord(stagingPath, this.layout.staging, record))) {
      throw storageError('Verified staging does not match commit journal')
    }
    await this._discardJournal(id, journalAttemptId)
    return { status: 'RESUMABLE', record }
  }

  async _scanRecords(): Promise<CommitRecord[]> {
    const names = await withSafeDirectoryIdentity(this.layout.commits, this.storage, () =>
      this.storage.readdir(this.layout.commits)
    )
    const records: CommitRecord[] = []
    for (const filename of names.filter(isCommitRecordName).sort()) {
      const id = filename.slice(0, -'.json'.length)
      const record = await this._readRecordOrAbsent(this._recordPath(id))
      if (!record) throw storageError('Commit record disappeared during enumeration')
      if (record.transferId !== id) throw storageError('Commit record ID does not match path')
      records.push(record)
    }
    return records
  }

  async scrubRecords(): Promise<{ records: CommitRecord[]; deleted: number }> {
    await this._assertLayout()
    const names = await withSafeDirectoryIdentity(this.layout.commits, this.storage, () =>
      this.storage.readdir(this.layout.commits)
    )
    const records: CommitRecord[] = []
    let deleted = 0
    for (const filename of names.filter(isCommitRecordName).sort()) {
      const id = filename.slice(0, -'.json'.length)
      const recordPath = this._recordPath(id)
      let record: CommitRecord | null = null
      let invalid = false
      try {
        const parsed = await readJson(recordPath, this.storage, MAX_COMMIT_METADATA_BYTES)
        try {
          record = assertRecord(parsed)
          invalid = record.transferId !== id
        } catch {
          invalid = true
        }
      } catch (err) {
        if (!(err instanceof MetadataFormatError)) throw err
        invalid = true
      }
      if (invalid) {
        await this._removeFile(recordPath, this.layout.commits)
        deleted++
        continue
      }
      if (!record) throw storageError('Commit record disappeared during scrub')
      records.push(record)
    }
    return { records: await this._resolveRecords(records), deleted }
  }

  async _resolveRecords(records: CommitRecord[]): Promise<CommitRecord[]> {
    const counts = new Map<string, number>()
    for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1)

    let pending: Array<ReplacementJournal | DirectoryReplacementJournal> | null = null
    const resolved: CommitRecord[] = []
    for (const record of records) {
      if ((counts.get(record.name) ?? 0) < 2) {
        resolved.push(record)
        continue
      }
      if (pending === null) pending = await this._pendingReplacements()
      const owner = pending.find(
        (journal) =>
          journal.name === record.name &&
          journal.oldRecord.transferId === record.transferId &&
          recordsEqual(journal.oldRecord, record)
      )
      resolved.push(owner ? historyRecord(record, owner.historyName) : record)
    }

    const seen = new Set<string>()
    for (const record of resolved) {
      if (seen.has(record.name)) throw storageError('Duplicate managed commit filename')
      seen.add(record.name)
    }
    return resolved
  }

  /**
   * A replacement makes the old sidecar the history record after its new
   * current sidecar is durable, so one name can briefly carry two records.
   * Only a journal-owned duplicate is tolerated, reported at the history name
   * that recovery will persist; anything else fails closed.
   */
  async list(): Promise<CommitRecord[]> {
    await this._assertLayout()
    return this._resolveRecords(await this._scanRecords())
  }

  /**
   * Locates the durable record a caller is deleting. A pending replacement may
   * still carry the mutable name on the sidecar the caller knows as history.
   */
  async _storedRecordFor(record: CommitRecord): Promise<CommitRecord | null> {
    const stored = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (!stored) return null
    if (recordsEqual(stored, record)) return stored
    if (
      stored.name !== record.name &&
      recordsEqual(historyRecord(stored, record.name), record) &&
      (await this._pendingReplacements()).some(
        (journal) =>
          journal.name === stored.name &&
          journal.historyName === record.name &&
          recordsEqual(journal.oldRecord, stored)
      )
    ) {
      return stored
    }
    throw storageError('Commit record changed before deletion')
  }

  /**
   * Removes proven private trash trees left by an interrupted deletion. Only a
   * `<64-hex>.tree` entry is ours; anything else in the directory is left alone.
   */
  async sweepTrash(): Promise<number> {
    await this._assertLayout()
    const names = await withSafeDirectoryIdentity(this.layout.trash, this.storage, () =>
      this.storage.readdir(this.layout.trash)
    )
    let removed = 0
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}\.tree$/.test(name)) continue
      if (await removeTree(path.join(this.layout.trash, name), this.layout.trash, this.storage)) {
        removed++
      }
    }
    return removed
  }

  /**
   * Removes a managed directory by renaming it into the private trash first, so
   * the visible name disappears atomically, and only then removing the sidecar
   * and recursively deleting the trash tree.
   */
  async _removeManagedTree(
    record: CommitRecord
  ): Promise<{ removed: boolean; preservedPath: boolean }> {
    const finalPath = this._finalPath(record.name)
    const trashPath = this._trashTreePath(record.transferId)
    const state = await this._rootTreeState(record.name)
    if (state === 'MISSING') return { removed: false, preservedPath: false }
    if (state === 'UNMANAGED') return { removed: false, preservedPath: true }
    if ((await inspectTreePath(trashPath, this.layout.trash, this.storage)) !== 'MISSING') {
      await removeTree(trashPath, this.layout.trash, this.storage)
    }
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.trash, this.storage, () =>
        this.storage.rename(finalPath, trashPath)
      )
    )
    await this._syncRoot()
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    await removeTree(trashPath, this.layout.trash, this.storage)
    return { removed: true, preservedPath: false }
  }

  async delete(record: CommitRecord): Promise<boolean> {
    await this._assertLayout()
    assertRecord(record)
    if (!(await this._storedRecordFor(record))) return false

    if (record.kind === 'directory') {
      const removed = await this._removeManagedTree(record)
      if (removed.preservedPath) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
        return true
      }
      if (!removed.removed) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
      }
      return true
    }

    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (final) await this._removeFile(finalPath, this.layout.root)
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return true
  }

  async purge(
    record: CommitRecord,
    { preservePath = false }: { preservePath?: boolean } = {}
  ): Promise<false | { purged: true; preservedPath: boolean }> {
    await this._assertLayout()
    assertRecord(record)
    if (!(await this._storedRecordFor(record))) return false

    if (record.kind === 'directory') {
      if (preservePath) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
        return { purged: true, preservedPath: true }
      }
      const removed = await this._removeManagedTree(record)
      await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
      return { purged: true, preservedPath: removed.preservedPath }
    }

    let final
    if (preservePath) {
      let preservedPath = false
      await withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
        try {
          await this.storage.lstat(this._finalPath(record.name))
          preservedPath = true
        } catch (err) {
          if (!isMissing(err)) throw err
        }
      })
      final = { removed: false, preservedPath }
    } else {
      final = await this._removeManagedFinalOrAbsent(record)
    }
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return { purged: true, preservedPath: final.preservedPath }
  }
}

export { CommitStore, CorruptJournalError, COMMIT_VERSION, MAX_COMMIT_METADATA_BYTES }
