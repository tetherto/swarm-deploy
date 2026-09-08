import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  historyName,
  isReservedHistoryName,
  validateBasename,
  validateReplaceNames
} from '../files.js'
import { transferId } from '../protocol/transfer-id.js'
import { assertFixed32, assertSafeUint } from '../protocol/validation.js'
import {
  assertSafeDirectory,
  assertSafeFile,
  openSafeRegularFile,
  protectedDirectories,
  withSafeDirectoryIdentity
} from './layout.js'
import { readJson, writeAtomic } from './atomic-file.js'
import {
  CorruptJournalError,
  JOURNAL_VERSION,
  COMMIT_VERSION,
  REPLACEMENT_COMMIT_VERSION,
  REPLACEMENT_JOURNAL_VERSION,
  MAX_COMMIT_METADATA_BYTES,
  assertCommitRecord as assertRecord,
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
  FileIdentity,
  ReplacementJournal,
  ReplacementPhase
} from './commit-journal.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout, StorageStat } from './types.js'

interface AbortSignalLike {
  aborted: boolean
}

interface CommitSession {
  id: string
  transferId: Uint8Array
  ownerKey: Uint8Array
  name: string
  size: number
  digest: Uint8Array
  chunkSize: number
  state: string
}

interface CommitOffer {
  name: string
  size: number
  digest: Uint8Array
  transferId: Uint8Array
}

interface RetentionManager {
  run(options?: { trigger?: string }): Promise<unknown>
  afterCommit(): Promise<unknown>
  _runUnlocked(options: { incomingBytes: number; trigger: 'commit' }): Promise<unknown>
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

interface ReplacePolicy {
  replaceNames?: Iterable<string>
}

/** The visible state of one top-level path, without following symlinks. */
interface RootPathState {
  present: boolean
  /** Set only for a regular file; an unmanaged non-regular path leaves it null. */
  stat: StorageStat | null
}

type ReplacementPlan =
  | { mode: 'create' }
  | { mode: 'idempotent'; record: CommitRecord }
  | { mode: 'replace'; oldRecord: CommitRecord; finalIdentity: FileIdentity }

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function commitError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.COMMIT_FAILED, message, cause)
}

function existsError(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.FILE_EXISTS, message)
}

function assertNotAborted(signal: AbortSignalLike | null): void {
  if (signal?.aborted) throw new SwarmDeployError(ERRORS.REVOKED, 'Upload access was revoked')
}

function toHex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function isCommitRecordName(name: unknown): name is string {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
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

function attemptId(): string {
  return toHex(crypto.randomBytes(32))
}

function fingerprint(ownerKey: Uint8Array): string {
  return toHex(crypto.createHash('sha256').update(ownerKey).digest())
}

function replacementsEqual(
  left: CommitRecord['replaces'],
  right: CommitRecord['replaces']
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.name === right.name &&
    left.transferId === right.transferId &&
    left.historyName === right.historyName
  )
}

function recordsEqual(left: CommitRecord, right: CommitRecord): boolean {
  return (
    left.version === right.version &&
    left.name === right.name &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.committedAt === right.committedAt &&
    left.uploaderFingerprint === right.uploaderFingerprint &&
    left.transferId === right.transferId &&
    replacementsEqual(left.replaces, right.replaces)
  )
}

function sameContent(left: CommitRecord, right: CommitRecord): boolean {
  return left.size === right.size && left.sha256 === right.sha256
}

/** The record the old sidecar becomes once its inode is only reachable as history. */
function historyRecord(oldRecord: CommitRecord, name: string): CommitRecord {
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
  assertSafeUint(candidate.chunkSize, 'session chunk size')
  if (candidate.id !== toHex(candidate.transferId)) throw storageError('Session ID mismatch')

  const expectedId = transferId({
    clientPublicKey: candidate.ownerKey,
    name: candidate.name,
    size: candidate.size,
    digest: candidate.digest,
    chunkSize: candidate.chunkSize
  })
  if (!b4a.equals(expectedId, candidate.transferId)) throw storageError('Noncanonical session ID')
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
  syncFirst = false
): Promise<{ digest: Buffer; identity: FileIdentity } | null> {
  return withSafeDirectoryIdentity(path.dirname(filePath), storage, async () => {
    const handle = await openSafeRegularFile(filePath, 'read', storage)
    try {
      if (syncFirst) await handle.sync()
      const before = await handle.stat()
      if (!before.isFile() || before.size !== size) return null

      const hash = crypto.createHash('sha256')
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

  /** A replacement always starts a fresh attempt; leftovers belong to recovery. */
  async _writeReplacementJournal(journal: ReplacementJournal): Promise<void> {
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
      this.logger?.warn?.('Committed artifact cleanup remains pending', {
        transferId: record.transferId,
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
    revoked: unknown
  ): Promise<never> {
    try {
      await this._markAttemptAborting(record.transferId, attemptId)
      await this._removeAbortedPublication(record, expectedIdentity)
      await this._discardJournal(record.transferId, attemptId)
    } catch (cleanupError) {
      throw new AggregateError([revoked, cleanupError], 'Unable to clean up revoked commit')
    }
    throw revoked
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
    return result !== null && b4a.equals(result.digest, b4a.from(record.sha256, 'hex'))
  }

  _recordFromSession(session: CommitSession): CommitRecord {
    assertSession(session)
    const record = {
      version: COMMIT_VERSION,
      name: session.name,
      size: session.size,
      sha256: toHex(session.digest),
      committedAt: this.clock.now(),
      uploaderFingerprint: fingerprint(session.ownerKey),
      transferId: session.id
    }
    return assertRecord(record)
  }

  async inspect(
    name: string,
    offer: CommitOffer,
    { replaceNames }: ReplacePolicy = {}
  ): Promise<
    | { status: 'AVAILABLE' }
    | { status: 'ALREADY_COMMITTED'; record: CommitRecord }
    | { status: 'REPLACEABLE'; record: CommitRecord }
    | { status: 'FILE_EXISTS' }
  > {
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
    const mutable = validateReplaceNames(replaceNames)

    return withNameLease(this.layout.root, name, () => this._inspect(name, offer, mutable))
  }

  async _inspect(
    name: string,
    offer: CommitOffer,
    mutable: Set<string>
  ): Promise<
    | { status: 'AVAILABLE' }
    | { status: 'ALREADY_COMMITTED'; record: CommitRecord }
    | { status: 'REPLACEABLE'; record: CommitRecord }
    | { status: 'FILE_EXISTS' }
  > {
    const finalPath = this._finalPath(name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (!final) return { status: 'AVAILABLE' }

    const id = toHex(offer.transferId)
    const record = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      record &&
      record.name === name &&
      record.size === offer.size &&
      record.sha256 === toHex(offer.digest) &&
      record.transferId === id &&
      (await this._matchesRecord(finalPath, this.layout.root, record))
    ) {
      return { status: 'ALREADY_COMMITTED', record }
    }
    if (!mutable.has(name)) return { status: 'FILE_EXISTS' }

    const current = await this._managedCurrent(name)
    if (!current || !identitiesEqual(current.identity, fileIdentity(final))) {
      return { status: 'FILE_EXISTS' }
    }
    if (current.record.size === offer.size && current.record.sha256 === toHex(offer.digest)) {
      return { status: 'ALREADY_COMMITTED', record: current.record }
    }
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
    const digested = await digestExactFile(finalPath, record.size, this.storage)
    if (!digested || !b4a.equals(digested.digest, b4a.from(record.sha256, 'hex'))) return null
    return { record, identity: digested.identity }
  }

  _assertSessionMatchesRecord(session: CommitSession, record: CommitRecord, message: string): void {
    assertSession(session)
    if (
      session.name !== record.name ||
      session.size !== record.size ||
      toHex(session.digest) !== record.sha256 ||
      fingerprint(session.ownerKey) !== record.uploaderFingerprint
    ) {
      throw new CorruptJournalError(message)
    }
  }

  async _inspectJournalPublication(
    journal: CommitJournal
  ): Promise<{ final: StorageStat | null; sidecar: CommitRecord | null; committed: boolean }> {
    const { record, sourceStagingIdentity } = journal
    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (
      final &&
      (!identitiesEqual(fileIdentity(final), sourceStagingIdentity) ||
        !(await this._matchesRecord(finalPath, this.layout.root, record)))
    ) {
      throw storageError('Final publication does not match commit journal')
    }
    if (sidecar && !recordsEqual(sidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }
    return { final, sidecar, committed: !!final && !!sidecar }
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

  async _cleanupCommittedAttempt(
    id: string,
    journal: CommitJournal,
    sessionStore: SessionStore
  ): Promise<{ status: 'COMMITTED'; record: CommitRecord }> {
    const leftovers = await this._validateAttemptLeftovers(id, journal, sessionStore)
    if (leftovers.sessionFile) {
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
    }
    if (leftovers.staging) {
      await this._removeFile(this._stagingPath(id), this.layout.staging)
    }
    await this._discardJournal(id, journal.attemptId)
    return { status: 'COMMITTED', record: journal.record }
  }

  async retryAbortedAttempt(
    transferId: Uint8Array,
    sessionStore: SessionStore | null
  ): Promise<false | { status: 'COMMITTED' | 'ABORTED'; record: CommitRecord }> {
    assertFixed32(transferId, 'revoked transfer ID')
    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Invalid session store for revoked attempt retry')
    }
    const id = toHex(transferId)
    const pending = await this._readJournal(id).catch((err: unknown) => {
      if (err instanceof CorruptJournalError) return null
      throw err
    })
    const leaseName = isReplacementJournal(pending) ? pending.name : null
    const run = (): Promise<false | { status: 'COMMITTED' | 'ABORTED'; record: CommitRecord }> =>
      withRootLease(this.layout.root, async () => {
        await this._assertLayout()
        const journal = await this._readJournal(id)
        if (!journal) return false
        if (isReplacementJournal(journal)) {
          const converged = await this._convergeReplacement(id, journal, sessionStore, {
            forceAbort: true
          })
          if (converged.status === 'RESUMABLE') {
            throw storageError('Replacement journal is not aborting')
          }
          return { status: converged.status, record: converged.record }
        }
        return this._retryAbortedCommit(id, journal, sessionStore)
      })
    return leaseName === null ? run() : withNameLease(this.layout.root, leaseName, run)
  }

  async _retryAbortedCommit(
    id: string,
    initial: CommitJournal,
    sessionStore: SessionStore
  ): Promise<false | { status: 'COMMITTED' | 'ABORTED'; record: CommitRecord }> {
    {
      let journal: CommitJournal = initial
      const publication = await this._inspectJournalPublication(journal)
      if (publication.committed) {
        return this._cleanupCommittedAttempt(id, journal, sessionStore)
      }
      const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
      this._assertSessionMatchesRecord(
        session,
        journal.record,
        'Revoked commit journal does not match verified session'
      )
      const stagingPath = this._stagingPath(id)
      const staging = await assertSafeFile(stagingPath, this.storage)
      if (
        !identitiesEqual(fileIdentity(staging), journal.sourceStagingIdentity) ||
        !(await this._matchesRecord(stagingPath, this.layout.staging, journal.record))
      ) {
        throw storageError('Staging file changed before revoked attempt retry')
      }
      if (journal.state === 'committing') {
        const marked = await this._markAttemptAborting(id, journal.attemptId)
        if (marked.version !== JOURNAL_VERSION) {
          throw storageError('Commit journal changed before abort')
        }
        journal = marked
      }
      if (journal.state !== 'aborting') throw storageError('Commit journal is not aborting')
      await this._removeAbortedPublication(journal.record, journal.sourceStagingIdentity)
      await this._discardJournal(id, journal.attemptId)
      return { status: 'ABORTED', record: journal.record }
    }
  }

  commit(
    session: CommitSession,
    {
      retentionManager = null,
      signal = null,
      replaceNames
    }: {
      retentionManager?: RetentionManager | null
      signal?: AbortSignalLike | null
      replaceNames?: Iterable<string>
    } = {}
  ): Promise<CommitRecord> {
    try {
      assertSession(session)
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
      const mutable = validateReplaceNames(replaceNames)
      return withNameLease(this.layout.root, session.name, () =>
        withRootLease(this.layout.root, () =>
          this._commit(session, retentionManager, signal, mutable)
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
    mutable: Set<string> = new Set()
  ): Promise<CommitRecord> {
    assertNotAborted(signal)
    await this._assertLayout()
    const record = this._recordFromSession(session)
    if (isReservedHistoryName(record.name)) {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
    }
    const stagingPath = this._stagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)

    const stagingDigest = await digestExactFile(stagingPath, record.size, this.storage, true)
    if (
      stagingDigest === null ||
      !b4a.equals(stagingDigest.digest, b4a.from(record.sha256, 'hex'))
    ) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging file checksum mismatch')
    }

    if (mutable.has(record.name)) {
      const plan = await this._planReplacement(record)
      if (plan.mode === 'idempotent') {
        await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
        await this._removeFile(stagingPath, this.layout.staging)
        return plan.record
      }
      if (plan.mode === 'replace') {
        return this._replace(record, stagingDigest.identity, plan, retentionManager, signal)
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
      assertNotAborted(signal)
      await this._discardJournal(record.transferId, journalAttemptId)
      if (retentionManager) await retentionManager._afterCommitUnlocked()
      return record
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(record, err)
        return record
      }
      if (errorCode(err) === ERRORS.REVOKED) {
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
   * Classifies a configured mutable name. Only an exact managed current record
   * whose verified content owns the visible path may be replaced; every other
   * occupied path is an existing-name conflict.
   */
  async _planReplacement(record: CommitRecord): Promise<ReplacementPlan> {
    const state = await this._rootPathState(record.name)
    if (!state.present) return { mode: 'create' }
    if (!state.stat) throw existsError('Destination already exists')
    const current = await this._managedCurrent(record.name)
    if (!current || !identitiesEqual(current.identity, fileIdentity(state.stat))) {
      throw existsError('Destination already exists')
    }
    if (sameContent(current.record, record)) return { mode: 'idempotent', record: current.record }
    return { mode: 'replace', oldRecord: current.record, finalIdentity: current.identity }
  }

  /**
   * A repeated A→B→A sequence reuses a transfer ID that already owns a history
   * artifact of identical content. The superseded duplicate is dropped inside
   * the transaction so the returning content becomes the only copy.
   */
  async _dedupHistory(
    record: CommitRecord
  ): Promise<{ name: string; identity: FileIdentity | null } | null> {
    const name = historyName(record.transferId)
    const existing = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (!existing) return null
    if (existing.name !== name || !sameContent(existing, record)) {
      throw storageError('Conflicting commit record')
    }
    const state = await this._rootPathState(name)
    if (!state.present) return { name, identity: null }
    if (!state.stat) throw existsError('History destination already exists')
    const digested = await digestExactFile(this._finalPath(name), existing.size, this.storage)
    if (!digested || !b4a.equals(digested.digest, b4a.from(existing.sha256, 'hex'))) {
      throw existsError('History destination already exists')
    }
    return { name, identity: digested.identity }
  }

  async _replace(
    record: CommitRecord,
    stagingIdentity: FileIdentity,
    plan: { oldRecord: CommitRecord; finalIdentity: FileIdentity },
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null
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
    const dedup = await this._dedupHistory(newRecord)

    if (retentionManager) {
      await retentionManager._runUnlocked({ incomingBytes: newRecord.size, trigger: 'commit' })
    }
    assertNotAborted(signal)
    const pinned = await this._rootPathState(record.name)
    if (!pinned.stat || !identitiesEqual(fileIdentity(pinned.stat), finalIdentity)) {
      throw commitError('Managed artifact changed before replacement')
    }

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
    await this._writeReplacementJournal(journal)

    let linearized = false
    try {
      assertNotAborted(signal)
      if (dedup) {
        if (dedup.identity) {
          await this._removeOwnedFile(this._finalPath(dedup.name), this.layout.root, dedup.identity)
        }
        await this._removeFile(this._recordPath(newRecord.transferId), this.layout.commits)
        journal = await this._setReplacementPhase(journal, 'deduped')
      }

      assertNotAborted(signal)
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
      await this._writeRecord(newRecord)
      linearized = true
      journal = await this._setReplacementPhase(journal, 'current-sidecar')

      await this._rewriteRecord(historyRecord(oldRecord, history))
      journal = await this._setReplacementPhase(journal, 'history-sidecar')

      await this._removeFile(this._sessionPath(newRecord.transferId), this.layout.sessions)
      await this._removeFile(stagingPath, this.layout.staging)
      await this._discardJournal(newRecord.transferId, attempt)
      if (retentionManager) await retentionManager._afterCommitUnlocked()
      return newRecord
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(newRecord, err)
        return newRecord
      }
      const revoked = errorCode(err) === ERRORS.REVOKED
      try {
        if (revoked) await this._markAttemptAborting(newRecord.transferId, attempt)
        await this._rollbackReplacement(journal)
        await this._discardJournal(newRecord.transferId, attempt)
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          revoked
            ? 'Unable to clean up revoked replacement'
            : 'Unable to roll back failed replacement'
        )
      }
      throw err
    }
  }

  /**
   * Restores the exact pinned old inode at the mutable name and removes only
   * transaction-owned history, publication, and sidecar paths. A foreign
   * destination is never overwritten or removed.
   */
  async _rollbackReplacement(journal: ReplacementJournal): Promise<void> {
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
      await this._removeFile(this._recordPath(journal.record.transferId), this.layout.commits)
    }
  }

  _readJournal(id: string): Promise<AnyCommitJournal | null> {
    return readCommitJournal(id, this.layout, this.storage)
  }

  /** Every parsable v2 journal, used to explain transient duplicate names. */
  async _pendingReplacements(): Promise<ReplacementJournal[]> {
    const names = await withSafeDirectoryIdentity(this.layout.journals, this.storage, () =>
      this.storage.readdir(this.layout.journals)
    )
    const pending: ReplacementJournal[] = []
    for (const filename of names.filter(isCommitRecordName).sort()) {
      let journal: AnyCommitJournal | null
      try {
        journal = await this._readJournal(filename.slice(0, -'.json'.length))
      } catch (err) {
        if (err instanceof CorruptJournalError) continue
        throw err
      }
      if (isReplacementJournal(journal)) pending.push(journal)
    }
    return pending
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
    const newSidecar = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (newSidecar && !recordsEqual(newSidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }

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
  }

  /** Proves the verified session and staging an aborted attempt must retain. */
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
      await this._discardJournal(id, journalAttemptId)
      return { status: 'COMMITTED', record }
    }

    if (journal.state === 'aborting') {
      if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
        throw storageError('Session store cannot validate revoked commit journal')
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

  /**
   * A replacement makes the old sidecar the history record after its new
   * current sidecar is durable, so one name can briefly carry two records.
   * Only a journal-owned duplicate is tolerated, reported at the history name
   * that recovery will persist; anything else fails closed.
   */
  async list(): Promise<CommitRecord[]> {
    await this._assertLayout()
    const records = await this._scanRecords()
    const counts = new Map<string, number>()
    for (const record of records) counts.set(record.name, (counts.get(record.name) ?? 0) + 1)

    let pending: ReplacementJournal[] | null = null
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

  async delete(record: CommitRecord): Promise<boolean> {
    await this._assertLayout()
    assertRecord(record)
    if (!(await this._storedRecordFor(record))) return false

    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (final) await this._removeFile(finalPath, this.layout.root)
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return true
  }

  async purge(record: CommitRecord): Promise<false | { purged: true; preservedPath: boolean }> {
    await this._assertLayout()
    assertRecord(record)
    if (!(await this._storedRecordFor(record))) return false

    const final = await this._removeManagedFinalOrAbsent(record)
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return { purged: true, preservedPath: final.preservedPath }
  }
}

export { CommitStore, CorruptJournalError, COMMIT_VERSION, MAX_COMMIT_METADATA_BYTES }
