import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename, validateReplaceNames } from '../files.js'
import { MAX_CHUNK_BYTES, MAX_CHUNK_COUNT } from '../protocol/constants.js'
import { transferId } from '../protocol/transfer-id.js'
import type { Chunk, Offer, TransferIdInput } from '../protocol/types.js'
import { assertBoundedChunkSize, assertFixed32, assertSafeUint } from '../protocol/validation.js'
import {
  assertSafeDirectory,
  assertSafeFile,
  openSafeRegularFile,
  withSafeDirectoryIdentity
} from './layout.js'
import {
  writeAtomic,
  readJson,
  MAX_SESSION_METADATA_BYTES,
  atomicWriteRenamed
} from './atomic-file.js'
import { fileIdentity, identitiesEqual, readCommitJournal } from './commit-journal.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout, StorageStat } from './types.js'

const METADATA_VERSION = 1
const RECEIVING = 'receiving'
const VERIFIED = 'verified'
const DELETING = 'deleting'
const FINGERPRINT_LENGTH = 12

type SessionState = typeof RECEIVING | typeof VERIFIED | typeof DELETING
type SessionEventType = 'cleanup'
type SessionEventDetails = { reason?: string }

interface Clock {
  now(): number
}

interface PersistedSession {
  bitmap: Buffer
  chunkDigests: Array<Buffer | null>
  verified: Set<number>
  createdAt: number
  updatedAt: number
  checkpointedAt: number
  state: SessionState
  pendingChunks: number
}

interface Session {
  id: string
  transferId: Buffer
  ownerKey: Buffer
  name: string
  size: number
  digest: Buffer
  chunkSize: number
  chunkCount: number
  bitmap: Buffer
  chunkDigests: Array<Buffer | null>
  verified: Set<number>
  createdAt: number
  updatedAt: number
  checkpointedAt: number
  state: SessionState
  pendingChunks: number
  persisted?: PersistedSession
}

interface SessionMetadata {
  version: number
  transferId: string
  ownerKey: string
  name: string
  size: number
  digest: string
  chunkSize: number
  chunkCount: number
  bitmap: string
  chunkDigests: Array<string | null>
  createdAt: number
  updatedAt: number
  checkpointedAt: number
  state: SessionState
}

interface SessionSnapshot {
  transferId: Buffer
  state: SessionState
  resumed: boolean
  duplicate: boolean
  verified: Set<number>
}

interface SessionStoreOptions {
  layout: StorageLayout
  maxStagingBytes: number
  minFreeBytes?: number
  clock?: Clock
  resumeTtl?: number
  isSessionActive?: (session: Session) => boolean
  checkpointChunks?: number
  storage?: StorageAdapter
  /** Exact names whose occupied destinations may be staged for replacement. */
  replaceNames?: Iterable<string>
  onEvent?:
    | ((
        payload: { type: SessionEventType; transfer: string; name: string } & SessionEventDetails
      ) => void)
    | null
}

function isBytes(value: unknown): value is Uint8Array {
  return b4a.isBuffer(value) || value instanceof Uint8Array
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function cleanupStorageError(
  message: string,
  cause: unknown,
  cleanupCause: unknown
): SwarmDeployError & { cleanupCause: unknown } {
  const error = storageError(message, cause)
  return Object.assign(error, { cleanupCause })
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function toHex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function fromHex(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw storageError(`Invalid ${name}`)
  }
  return b4a.from(value, 'hex')
}

function bitmapBytes(chunkCount: number): number {
  return Math.ceil(chunkCount / 8)
}

function bitIsSet(bitmap: Uint8Array, index: number): boolean {
  return (bitmap[Math.floor(index / 8)] & (1 << (index % 8))) !== 0
}

function setBit(bitmap: Uint8Array, index: number): void {
  bitmap[Math.floor(index / 8)] |= 1 << (index % 8)
}

function assertTimestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw storageError(`Invalid ${name}`)
  }
}

function assertOffer(ownerKey: Uint8Array, offer: Offer): void {
  assertFixed32(ownerKey, 'ownerKey')
  if (!offer || typeof offer !== 'object') throw storageError('Invalid offer')
  assertSafeUint(offer.version, 'version')
  if (offer.version !== 1) throw storageError('Invalid offer version')
  validateBasename(offer.name)
  if (isReservedHistoryName(offer.name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
  }
  assertSafeUint(offer.size, 'size')
  assertFixed32(offer.digest, 'digest')
  assertBoundedChunkSize(offer.chunkSize, 'chunkSize')
  if (offer.chunkSize !== MAX_CHUNK_BYTES) throw storageError('Unsupported protocol chunk size')
  assertSafeUint(offer.chunkCount, 'chunkCount')
  assertFixed32(offer.transferId, 'transferId')

  const expectedChunkCount = Math.ceil(offer.size / offer.chunkSize)
  if (offer.chunkCount !== expectedChunkCount || offer.chunkCount > MAX_CHUNK_COUNT) {
    throw storageError('Invalid offer chunk count')
  }

  const expectedTransferId = transferId({
    clientPublicKey: ownerKey,
    name: offer.name,
    size: offer.size,
    digest: offer.digest,
    chunkSize: offer.chunkSize
  })
  if (!b4a.equals(expectedTransferId, offer.transferId)) {
    throw storageError('Noncanonical transfer ID')
  }
}

async function writeAll(
  handle: StorageFileHandle,
  bytes: Uint8Array,
  position: number
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write staging bytes')
    }
    offset += count
  }
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

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

class SessionStore {
  layout: StorageLayout
  maxStagingBytes: number
  minFreeBytes: number
  clock: Clock
  resumeTtl: number | undefined
  isSessionActive: (session: Session) => boolean
  checkpointChunks: number
  storage: StorageAdapter
  replaceNames: Set<string>
  onEvent: SessionStoreOptions['onEvent']
  sessions: Map<string, Session>
  recoveryReservations: Map<string, number>
  reservedBytes: number
  initialized: boolean
  closed: boolean
  pending: Promise<unknown>

  constructor({
    layout,
    maxStagingBytes,
    minFreeBytes = 0,
    clock = Date,
    resumeTtl,
    isSessionActive = () => false,
    checkpointChunks = 16,
    storage = fs.promises,
    replaceNames,
    onEvent = null
  }: SessionStoreOptions) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    assertSafeUint(maxStagingBytes, 'maxStagingBytes')
    assertSafeUint(minFreeBytes, 'minFreeBytes')
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (resumeTtl !== undefined) {
      assertSafeUint(resumeTtl, 'resumeTtl')
      if (resumeTtl === 0) throw storageError('Invalid resumeTtl')
    }
    if (typeof isSessionActive !== 'function') {
      throw storageError('Invalid session activity predicate')
    }
    if (!Number.isSafeInteger(checkpointChunks) || checkpointChunks <= 0) {
      throw storageError('Invalid checkpoint chunk count')
    }
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')
    if (onEvent !== null && typeof onEvent !== 'function') {
      throw storageError('Invalid session event callback')
    }

    this.layout = layout
    this.maxStagingBytes = maxStagingBytes
    this.minFreeBytes = minFreeBytes
    this.clock = clock
    this.resumeTtl = resumeTtl
    this.isSessionActive = isSessionActive
    this.checkpointChunks = checkpointChunks
    this.storage = storage
    this.replaceNames = validateReplaceNames(replaceNames)
    this.onEvent = onEvent
    this.sessions = new Map()
    this.recoveryReservations = new Map()
    this.reservedBytes = 0
    this.initialized = false
    this.closed = false
    this.pending = Promise.resolve()
  }

  _serialize(session: Session): SessionMetadata {
    return {
      version: METADATA_VERSION,
      transferId: session.id,
      ownerKey: toHex(session.ownerKey),
      name: session.name,
      size: session.size,
      digest: toHex(session.digest),
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      bitmap: toHex(session.bitmap) === '' ? '' : b4a.toString(session.bitmap, 'base64'),
      chunkDigests: session.chunkDigests.map((digest) => (digest ? toHex(digest) : null)),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      checkpointedAt: session.checkpointedAt,
      state: session.state
    }
  }

  _snapshot(session: Session, resumed = false, duplicate = false): SessionSnapshot {
    return {
      transferId: b4a.from(session.transferId),
      state: session.state,
      resumed,
      duplicate,
      verified: new Set(session.verified)
    }
  }

  _emit(type: SessionEventType, session: Session, details: SessionEventDetails = {}): void {
    if (!this.onEvent) return
    const payload = {
      type,
      transfer: toHex(sha256(session.transferId)).slice(0, FINGERPRINT_LENGTH),
      name: session.name,
      ...details
    }
    try {
      this.onEvent(payload)
    } catch {}
  }

  _stagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.part`)
  }

  _sessionPath(id: string): string {
    return path.join(this.layout.sessions, `${id}.json`)
  }

  _run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.catch(() => {})
    return result
  }

  async _assertLayout() {
    for (const directory of [
      this.layout.root,
      this.layout.internal,
      this.layout.staging,
      this.layout.sessions
    ]) {
      await assertSafeDirectory(directory, this.storage)
    }
  }

  _markPersisted(session: Session): void {
    session.persisted = {
      bitmap: b4a.from(session.bitmap),
      chunkDigests: session.chunkDigests.map((digest) => (digest ? b4a.from(digest) : null)),
      verified: new Set(session.verified),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      checkpointedAt: session.checkpointedAt,
      state: session.state,
      pendingChunks: 0
    }
  }

  _restorePersisted(session: Session): void {
    if (!session.persisted) throw storageError('Missing persisted session state')
    const persisted = session.persisted
    session.bitmap = b4a.from(persisted.bitmap)
    session.chunkDigests = persisted.chunkDigests.map((digest) =>
      digest ? b4a.from(digest) : null
    )
    session.verified = new Set(persisted.verified)
    session.createdAt = persisted.createdAt
    session.updatedAt = persisted.updatedAt
    session.checkpointedAt = persisted.checkpointedAt
    session.state = persisted.state
    session.pendingChunks = persisted.pendingChunks
  }

  _withStagingParent<T>(operation: () => Promise<T> | T): Promise<T> {
    return withSafeDirectoryIdentity(this.layout.staging, this.storage, operation)
  }

  _withStagingFile<T>(
    session: Session,
    access: 'create' | 'write' | 'read',
    operation: (handle: StorageFileHandle) => Promise<T> | T
  ): Promise<T> {
    return this._withStagingParent(async () => {
      const handle = await openSafeRegularFile(this._stagingPath(session.id), access, this.storage)
      try {
        return await operation(handle)
      } finally {
        await handle.close()
      }
    })
  }

  _assertReady() {
    if (!this.initialized || this.closed) throw storageError('Session store is not available')
  }

  _sessionFromMetadata(id: string, metadata: Record<string, unknown>): Session {
    if (!metadata || metadata.version !== METADATA_VERSION) {
      throw storageError('Invalid session metadata')
    }
    if (metadata.transferId !== id) throw storageError('Session ID does not match metadata path')
    const transferIdBytes = fromHex(metadata.transferId, 'transfer ID')
    const ownerKey = fromHex(metadata.ownerKey, 'owner key')
    if (typeof metadata.name !== 'string') throw storageError('Invalid filename')
    const name = validateBasename(metadata.name)
    assertSafeUint(metadata.size, 'session size')
    const digest = fromHex(metadata.digest, 'session digest')
    assertBoundedChunkSize(metadata.chunkSize, 'session chunk size')
    assertSafeUint(metadata.chunkCount, 'session chunk count')
    if (
      metadata.chunkSize !== MAX_CHUNK_BYTES ||
      metadata.chunkCount !== Math.ceil(metadata.size / metadata.chunkSize) ||
      metadata.chunkCount > MAX_CHUNK_COUNT
    ) {
      throw storageError('Invalid session chunk count')
    }
    if (
      metadata.state !== RECEIVING &&
      metadata.state !== VERIFIED &&
      metadata.state !== DELETING
    ) {
      throw storageError('Invalid session state')
    }
    assertTimestamp(metadata.createdAt, 'session creation time')
    assertTimestamp(metadata.updatedAt, 'session update time')
    assertTimestamp(metadata.checkpointedAt, 'session checkpoint time')
    if (typeof metadata.bitmap !== 'string') throw storageError('Invalid session bitmap')

    const bitmap = b4a.from(metadata.bitmap, 'base64')
    if (
      bitmap.byteLength !== bitmapBytes(metadata.chunkCount) ||
      b4a.toString(bitmap, 'base64') !== metadata.bitmap
    ) {
      throw storageError('Invalid session bitmap')
    }
    if (metadata.chunkCount % 8 !== 0 && bitmap.byteLength > 0) {
      const mask = (1 << (metadata.chunkCount % 8)) - 1
      if ((bitmap[bitmap.byteLength - 1] & ~mask) !== 0) {
        throw storageError('Invalid session bitmap padding')
      }
    }
    if (
      !Array.isArray(metadata.chunkDigests) ||
      metadata.chunkDigests.length !== metadata.chunkCount
    ) {
      throw storageError('Invalid session chunk digests')
    }

    const chunkDigests: Array<Buffer | null> = []
    const verified = new Set<number>()
    for (let index = 0; index < metadata.chunkCount; index++) {
      const isVerified = bitIsSet(bitmap, index)
      const slot = metadata.chunkDigests[index]
      if (isVerified) {
        chunkDigests.push(fromHex(slot, `chunk digest ${index}`))
        verified.add(index)
      } else {
        if (slot !== null) throw storageError(`Unexpected chunk digest ${index}`)
        chunkDigests.push(null)
      }
    }
    if (metadata.state === VERIFIED && verified.size !== metadata.chunkCount) {
      throw storageError('Verified session is missing chunks')
    }

    const state: SessionState = metadata.state
    const canonicalInput: TransferIdInput = {
      clientPublicKey: ownerKey,
      name,
      size: metadata.size,
      digest,
      chunkSize: metadata.chunkSize
    }
    const canonicalId = transferId(canonicalInput)
    if (!b4a.equals(canonicalId, transferIdBytes)) {
      throw storageError('Noncanonical stored transfer ID')
    }

    const loaded: Session = {
      id,
      transferId: transferIdBytes,
      ownerKey,
      name,
      size: metadata.size,
      digest,
      chunkSize: metadata.chunkSize,
      chunkCount: metadata.chunkCount,
      bitmap,
      chunkDigests,
      verified,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      checkpointedAt: metadata.checkpointedAt,
      state,
      pendingChunks: 0
    }
    this._markPersisted(loaded)
    return loaded
  }

  _expectedChunkLength(session: Session, index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) {
      throw storageError('Invalid chunk index')
    }
    return Math.min(session.chunkSize, session.size - index * session.chunkSize)
  }

  async _verifyStaging(session: Session): Promise<void> {
    await this._withStagingFile(session, 'read', async (handle) => {
      const stat = await handle.stat()
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > session.size ||
        (session.state === VERIFIED && stat.size !== session.size)
      ) {
        throw storageError('Invalid staging file size')
      }
      for (const index of session.verified) {
        const bytes = b4a.alloc(this._expectedChunkLength(session, index))
        if (!(await readExactly(handle, bytes, index * session.chunkSize))) {
          throw storageError('Stored chunk is truncated')
        }
        const expectedDigest = session.chunkDigests[index]
        if (expectedDigest === null || !b4a.equals(sha256(bytes), expectedDigest)) {
          throw storageError('Stored chunk digest mismatch')
        }
      }
    })
  }

  _verifyWholeStaging(session: Session): Promise<boolean> {
    return this._withStagingFile(session, 'read', async (handle) => {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== session.size) return false

      const hash = crypto.createHash('sha256')
      let position = 0
      while (position < session.size) {
        const bytes = b4a.alloc(Math.min(64 * 1024, session.size - position))
        if (!(await readExactly(handle, bytes, position))) return false
        hash.update(bytes)
        position += bytes.byteLength
      }

      const after = await handle.stat()
      return (
        after.isFile() && after.size === session.size && b4a.equals(hash.digest(), session.digest)
      )
    })
  }

  async _writeSession(session: Session, checkpointedAt = session.checkpointedAt): Promise<void> {
    const metadata = this._serialize(session)
    metadata.checkpointedAt = checkpointedAt
    const encoded = b4a.from(JSON.stringify(metadata))
    await writeAtomic(this._sessionPath(session.id), encoded, this.storage)
  }

  async _checkpoint(session: Session): Promise<void> {
    let checkpointedAt = null
    try {
      await this._withStagingFile(session, 'read', (handle) => handle.sync())
      checkpointedAt = this.clock.now()
      await this._writeSession(session, checkpointedAt)
      session.checkpointedAt = checkpointedAt
      session.pendingChunks = 0
      this._markPersisted(session)
    } catch (err) {
      if (checkpointedAt !== null && atomicWriteRenamed(err)) {
        session.checkpointedAt = checkpointedAt
        session.pendingChunks = 0
        this._markPersisted(session)
      } else {
        this._restorePersisted(session)
      }
      throw err
    }
  }

  async _removeFile(filePath: string, directory: string, ensureSynced = false): Promise<void> {
    let removed = false
    await withSafeDirectoryIdentity(directory, this.storage, async () => {
      try {
        await assertSafeFile(filePath, this.storage)
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'cause' in err &&
          errorCode(err.cause) === 'ENOENT'
        ) {
          return
        }
        throw err
      }
      await this.storage.unlink(filePath)
      removed = true
    })
    if (removed || ensureSynced) {
      await withSafeDirectoryIdentity(directory, this.storage, () =>
        syncDirectory(directory, this.storage)
      )
    }
  }

  async _syncDirectory(directory: string): Promise<void> {
    await withSafeDirectoryIdentity(directory, this.storage, () =>
      syncDirectory(directory, this.storage)
    )
  }

  async _cleanupOfferStaging(session: Session, cause: unknown): Promise<never> {
    try {
      await this._removeFile(this._stagingPath(session.id), this.layout.staging)
    } catch (cleanupCause) {
      throw cleanupStorageError('Unable to clean up failed session offer', cause, cleanupCause)
    }
    throw cause
  }

  _admitSession(session: Session): void {
    this._markPersisted(session)
    this.sessions.set(session.id, session)
    this.reservedBytes += session.size
  }

  async _deleteSession(session: Session, reason = 'delete'): Promise<void> {
    if (session.state !== DELETING) {
      const previousState = session.state
      const previousUpdatedAt = session.updatedAt
      session.state = DELETING
      session.updatedAt = this.clock.now()
      try {
        await this._writeSession(session)
        this._markPersisted(session)
      } catch (err) {
        if (!atomicWriteRenamed(err)) {
          session.state = previousState
          session.updatedAt = previousUpdatedAt
          throw err
        }
        this._markPersisted(session)
        throw err
      }
    } else {
      await this._syncDirectory(this.layout.sessions)
    }
    await this._removeFile(this._stagingPath(session.id), this.layout.staging, true)
    await this._removeFile(this._sessionPath(session.id), this.layout.sessions, true)
    this.sessions.delete(session.id)
    this.reservedBytes -= session.size
    this._emit('cleanup', session, { reason })
  }

  async _destinationExists(name: string): Promise<boolean> {
    const destination = path.join(this.layout.root, name)
    try {
      await this.storage.lstat(destination)
      return true
    } catch (err: unknown) {
      if (errorCode(err) === 'ENOENT') return false
      throw err
    }
  }

  async _journalOwnsStaging(id: string, staging: StorageStat): Promise<boolean> {
    let journal
    try {
      journal = await readCommitJournal(id, this.layout, this.storage)
    } catch (err) {
      throw storageError('Invalid journal-owned staging file', err)
    }
    if (!journal) return false
    if (
      journal.state !== 'committing' ||
      journal.record.transferId !== id ||
      journal.record.size !== staging.size ||
      !identitiesEqual(journal.sourceStagingIdentity, fileIdentity(staging))
    ) {
      throw storageError('Commit journal does not own staging file')
    }
    return true
  }

  async _assertDiskReserve(incomingBytes: number): Promise<void> {
    if (this.minFreeBytes === 0) return
    if (typeof this.storage.statfs !== 'function') {
      throw new SwarmDeployError(ERRORS.DISK_RESERVE, 'Free-disk reserve is unavailable')
    }
    const stat = await this.storage.statfs(this.layout.staging)
    const availableBlocks = stat?.bavail
    const blockSize = stat?.bsize
    const validCount = (value: unknown): value is number | bigint =>
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === 'bigint' && value >= 0n)
    if (!validCount(availableBlocks) || !validCount(blockSize)) {
      throw storageError('Invalid free-disk statistics')
    }
    const available = BigInt(availableBlocks) * BigInt(blockSize)
    const required = BigInt(this.minFreeBytes) + BigInt(incomingBytes)
    if (available < required) {
      throw new SwarmDeployError(ERRORS.DISK_RESERVE, 'Minimum free-disk reserve exceeded')
    }
  }

  async _createStaging(session: Session): Promise<void> {
    const stagingPath = this._stagingPath(session.id)
    let created = false
    try {
      await this._withStagingFile(session, 'create', async (handle) => {
        created = true
        await handle.sync()
      })
      await this._withStagingParent(() => syncDirectory(this.layout.staging, this.storage))
    } catch (err: unknown) {
      if (created) await this._cleanupOfferStaging(session, err)
      if (
        errorCode(err) !== 'EEXIST' &&
        errorCode(err) !== 'ELOOP' &&
        !(
          typeof err === 'object' &&
          err !== null &&
          'cause' in err &&
          errorCode(err.cause) === 'EEXIST'
        )
      ) {
        throw err
      }
      await assertSafeFile(stagingPath, this.storage)
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging path is already in use')
    }
  }

  init(): Promise<void> {
    return this._run(async () => {
      if (this.initialized) return
      if (this.closed) throw storageError('Session store is closed')
      await this._assertLayout()

      const names = await withSafeDirectoryIdentity(this.layout.sessions, this.storage, () =>
        this.storage.readdir(this.layout.sessions)
      )
      const loaded = []
      const deleting = []
      for (const name of names) {
        if (typeof name !== 'string' || !/^[0-9a-f]{64}\.json$/.test(name)) {
          throw storageError('Invalid session metadata path')
        }
        const id = name.slice(0, -'.json'.length)
        const metadataPath = path.join(this.layout.sessions, name)
        await assertSafeFile(metadataPath, this.storage)
        const session = this._sessionFromMetadata(
          id,
          await readJson(metadataPath, this.storage, MAX_SESSION_METADATA_BYTES)
        )
        if (session.state === DELETING) {
          deleting.push(session)
          continue
        }
        await this._verifyStaging(session)
        loaded.push(session)
      }

      if (deleting.length > 0) await this._syncDirectory(this.layout.sessions)
      for (const session of deleting) {
        await this._removeFile(this._stagingPath(session.id), this.layout.staging, true)
        await this._removeFile(this._sessionPath(session.id), this.layout.sessions, true)
        this._emit('cleanup', session, { reason: 'recovery' })
      }

      const stagingNames = await withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
        this.storage.readdir(this.layout.staging)
      )
      const expectedStaging = new Set(loaded.map((session) => `${session.id}.part`))
      const recoveryReservations = []
      for (const name of stagingNames) {
        const stagingPath = path.join(this.layout.staging, name)
        const staging = await assertSafeFile(stagingPath, this.storage)
        if (expectedStaging.has(name)) continue
        const match = /^([0-9a-f]{64})\.part$/.exec(name)
        if (!match || !(await this._journalOwnsStaging(match[1], staging))) {
          throw storageError('Orphaned staging file')
        }
        recoveryReservations.push({ id: match[1], size: staging.size })
      }

      let reserved = 0
      const namesSeen = new Set()
      for (const session of loaded) {
        if (reserved > this.maxStagingBytes - session.size) {
          throw new SwarmDeployError(
            ERRORS.STAGING_LIMIT,
            'Recovered sessions exceed staging limit'
          )
        }
        if (namesSeen.has(session.name)) throw storageError('Conflicting stored session names')
        namesSeen.add(session.name)
        reserved += session.size
      }
      for (const recovery of recoveryReservations) {
        if (reserved > this.maxStagingBytes - recovery.size) {
          throw new SwarmDeployError(
            ERRORS.STAGING_LIMIT,
            'Recovered staging exceeds staging limit'
          )
        }
        reserved += recovery.size
      }
      for (const session of loaded) this.sessions.set(session.id, session)
      for (const recovery of recoveryReservations) {
        this.recoveryReservations.set(recovery.id, recovery.size)
      }
      this.reservedBytes = reserved
      this.initialized = true
    })
  }

  readVerified(transferId: Uint8Array): Promise<Session> {
    return this._run(async () => {
      assertFixed32(transferId, 'transferId')
      await this._assertLayout()
      const id = toHex(transferId)
      const metadata = await readJson(
        this._sessionPath(id),
        this.storage,
        MAX_SESSION_METADATA_BYTES
      )
      const session = this._sessionFromMetadata(id, metadata)
      if (session.state !== VERIFIED) throw storageError('Session is not verified')
      await this._verifyStaging(session)
      return session
    })
  }

  offer(ownerKey: Uint8Array, offer: Offer): Promise<SessionSnapshot> {
    return this._run(async () => {
      this._assertReady()
      await this._assertLayout()
      assertOffer(ownerKey, offer)
      if (this.resumeTtl !== undefined) {
        await this._expireUnlocked(this.resumeTtl, (session) => !this.isSessionActive(session))
      }
      const id = toHex(offer.transferId)
      const existing = this.sessions.get(id)
      if (existing) return this._snapshot(existing, true)
      for (const session of this.sessions.values()) {
        if (session.name === offer.name) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Destination has an active session')
        }
      }
      if (!this.replaceNames.has(offer.name) && (await this._destinationExists(offer.name))) {
        throw new SwarmDeployError(ERRORS.FILE_EXISTS, 'Destination already exists')
      }
      if (this.reservedBytes > this.maxStagingBytes - offer.size) {
        throw new SwarmDeployError(ERRORS.STAGING_LIMIT, 'Staging capacity exceeded')
      }
      await this._assertDiskReserve(offer.size)

      const now = this.clock.now()
      const session: Session = {
        id,
        transferId: b4a.from(offer.transferId),
        ownerKey: b4a.from(ownerKey),
        name: offer.name,
        size: offer.size,
        digest: b4a.from(offer.digest),
        chunkSize: offer.chunkSize,
        chunkCount: offer.chunkCount,
        bitmap: b4a.alloc(bitmapBytes(offer.chunkCount)),
        chunkDigests: Array(offer.chunkCount).fill(null),
        verified: new Set(),
        createdAt: now,
        updatedAt: now,
        checkpointedAt: now,
        state: RECEIVING,
        pendingChunks: 0
      }
      await this._createStaging(session)
      try {
        await this._writeSession(session)
      } catch (err) {
        if (atomicWriteRenamed(err)) {
          this._admitSession(session)
          throw err
        }
        await this._cleanupOfferStaging(session, err)
      }
      this._admitSession(session)
      return this._snapshot(session)
    })
  }

  writeChunk(transferId: Uint8Array, chunk: Chunk): Promise<SessionSnapshot> {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      if (!chunk || typeof chunk !== 'object') throw storageError('Invalid chunk')
      assertSafeUint(chunk.index, 'chunk index')
      assertFixed32(chunk.digest, 'chunk digest')
      if (!isBytes(chunk.data)) throw storageError('Invalid chunk bytes')

      const id = toHex(transferId)
      const session = this.sessions.get(id)
      if (!session || session.state !== RECEIVING) throw storageError('Unknown or closed session')
      const expectedLength = this._expectedChunkLength(session, chunk.index)
      if (chunk.data.byteLength !== expectedLength) throw storageError('Invalid chunk length')

      const computed = sha256(chunk.data)
      if (!b4a.equals(computed, chunk.digest)) {
        await this._deleteSession(session, 'checksum')
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Chunk digest mismatch')
      }
      if (session.verified.has(chunk.index)) {
        const existingDigest = session.chunkDigests[chunk.index]
        if (existingDigest !== null && b4a.equals(existingDigest, chunk.digest)) {
          return this._snapshot(session, false, true)
        }
        await this._deleteSession(session, 'checksum')
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Conflicting duplicate chunk')
      }

      await this._withStagingFile(session, 'write', (handle) =>
        writeAll(handle, chunk.data, chunk.index * session.chunkSize)
      )

      setBit(session.bitmap, chunk.index)
      session.chunkDigests[chunk.index] = b4a.from(chunk.digest)
      session.verified.add(chunk.index)
      session.updatedAt = this.clock.now()
      session.pendingChunks++
      if (session.pendingChunks >= this.checkpointChunks) await this._checkpoint(session)
      return this._snapshot(session)
    })
  }

  checkpoint(transferId: Uint8Array): Promise<SessionSnapshot> {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const session = this.sessions.get(toHex(transferId))
      if (!session) throw storageError('Unknown session')
      await this._checkpoint(session)
      return this._snapshot(session)
    })
  }

  finish(transferId: Uint8Array): Promise<SessionSnapshot> {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const session = this.sessions.get(toHex(transferId))
      if (!session) throw storageError('Unknown or closed session')
      if (session.state === VERIFIED) return this._snapshot(session)
      if (session.state !== RECEIVING) throw storageError('Unknown or closed session')
      if (session.verified.size !== session.chunkCount) throw storageError('Missing chunks')
      if (!(await this._verifyWholeStaging(session))) {
        await this._deleteSession(session, 'checksum')
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging file checksum mismatch')
      }

      session.state = VERIFIED
      session.updatedAt = this.clock.now()
      await this._checkpoint(session)
      return this._snapshot(session)
    })
  }

  retireCommitted(transferId: Uint8Array): Promise<boolean> {
    return this._run(() => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const id = toHex(transferId)
      const session = this.sessions.get(id)
      if (!session) return Promise.resolve(false)
      if (session.state !== VERIFIED) throw storageError('Session is not verified')
      this.sessions.delete(id)
      this.reservedBytes -= session.size
      return Promise.resolve(true)
    })
  }

  delete(transferId: Uint8Array): Promise<boolean> {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const id = toHex(transferId)
      const session = this.sessions.get(id)
      if (!session) {
        const recoveryBytes = this.recoveryReservations.get(id)
        if (recoveryBytes === undefined) return false
        this.recoveryReservations.delete(id)
        this.reservedBytes -= recoveryBytes
        return true
      }
      await this._deleteSession(session, 'delete')
      return true
    })
  }

  deleteByOwner(ownerKey: Uint8Array): Promise<number> {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(ownerKey, 'ownerKey')
      let deleted = 0
      for (const session of [...this.sessions.values()]) {
        if (!b4a.equals(session.ownerKey, ownerKey)) continue
        await this._deleteSession(session, 'revocation')
        deleted++
      }
      return deleted
    })
  }

  deleteUnauthorized(isAuthorized: (ownerKey: Uint8Array) => boolean): Promise<number> {
    return this._run(async () => {
      this._assertReady()
      if (typeof isAuthorized !== 'function') {
        throw storageError('Invalid session authorization predicate')
      }
      let deleted = 0
      for (const session of [...this.sessions.values()]) {
        if (isAuthorized(session.ownerKey)) continue
        await this._deleteSession(session, 'offline-revocation')
        deleted++
      }
      return deleted
    })
  }

  expire(ttl: number, shouldExpire: (session: Session) => boolean = () => true): Promise<number> {
    return this._run(() => {
      this._assertReady()
      assertSafeUint(ttl, 'session ttl')
      if (typeof shouldExpire !== 'function') {
        throw storageError('Invalid session expiration predicate')
      }
      return this._expireUnlocked(ttl, shouldExpire)
    })
  }

  async _expireUnlocked(ttl: number, shouldExpire: (session: Session) => boolean): Promise<number> {
    const now = this.clock.now()
    let deleted = 0
    for (const session of [...this.sessions.values()]) {
      if (now - session.updatedAt <= ttl) continue
      if (!shouldExpire(session)) continue
      await this._deleteSession(session, 'expiry')
      deleted++
    }
    return deleted
  }

  close(): Promise<void> {
    return this._run(async () => {
      if (this.closed) return
      for (const session of this.sessions.values()) {
        if (session.state !== DELETING && session.pendingChunks > 0) {
          await this._checkpoint(session)
        }
      }
      this.closed = true
    })
  }
}

export { SessionStore }
