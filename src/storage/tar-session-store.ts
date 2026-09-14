import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  type MetadataRecord,
  encodeMetadataRecord,
  decodeMetadataRecord
} from '../tar-protocol/controls.js'
import { validateAndExtractTar } from '../tar-protocol/extract.js'
import { assertMetadataTransferId } from '../tar-protocol/manifest.js'
import { atomicWriteRenamed, readJson, writeAtomic } from './atomic-file.js'
import { readCommitJournal } from './commit-journal.js'
import { assertSafeFile, openSafeRegularFile, withSafeDirectoryIdentity } from './layout.js'
import type { StorageAdapter, StorageFileHandle, StorageLayout } from './types.js'
import type { Clock } from '../types.js'
import { assertSafeUint } from '../validation.js'

const VERSION = 2
const RECEIVING = 'receiving'
const VERIFIED = 'verified'
const DELETING = 'deleting'
const READ_BYTES = 64 * 1024

type State = typeof RECEIVING | typeof VERIFIED | typeof DELETING

export interface TarSession {
  id: string
  transferId: Buffer
  ownerKey: Buffer
  name: string
  size: number
  digest: Buffer
  tarSize: number
  tarDigest: Buffer
  tarPath: string
  state: State
  createdAt: number
  updatedAt: number
  partialTarSize: number
}

export type TarAdmission =
  | { status: 'ACCEPT'; offset: 0 }
  | { status: 'RESUME'; offset: number; prefixSha256: Buffer }
  | { status: 'VERIFIED' }

interface PersistedTarSession {
  version: number
  transferId: string
  ownerKey: string
  name: string
  fileSize: number
  fileSha256: string
  tarSize: number
  tarSha256: string
  partialTar: { path: string; size: number }
  createdAt: number
  updatedAt: number
  state: State
}

export interface TarSessionStoreOptions {
  layout: StorageLayout
  maxStagingBytes: number
  minFreeBytes?: number
  clock?: Clock
  resumeTtl?: number
  isSessionActive?: (session: TarSession) => boolean
  storage?: StorageAdapter
}

function problem(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function bytes(value: unknown, name: string): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw problem(`Invalid ${name}`)
  return b4a.from(value, 'hex')
}

function uint(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw problem(`Invalid ${name}`)
  }
}

function key(value: Uint8Array, name: string): void {
  if (!b4a.isBuffer(value) || value.byteLength !== 32) throw problem(`Invalid ${name}`)
}

function sameMetadata(session: TarSession, metadata: MetadataRecord, owner: Uint8Array): boolean {
  return (
    sodium.sodium_memcmp(session.ownerKey, owner) &&
    session.name === metadata.name &&
    session.size === metadata.fileSize &&
    session.tarSize === metadata.tarSize &&
    sodium.sodium_memcmp(session.digest, b4a.from(metadata.fileSha256, 'hex')) &&
    sodium.sodium_memcmp(session.tarDigest, b4a.from(metadata.tarSha256, 'hex'))
  )
}

async function writeAll(
  handle: StorageFileHandle,
  value: Uint8Array,
  position: number
): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset, value.byteLength - offset, position + offset)
    const written = typeof result === 'number' ? result : result.bytesWritten
    if (!Number.isSafeInteger(written) || written <= 0) throw problem('Unable to write TAR staging')
    offset += written
  }
}

async function readAll(handle: StorageFileHandle, size: number, position: number): Promise<Buffer> {
  const value = b4a.alloc(size)
  let offset = 0
  while (offset < size) {
    const result = await handle.read(value, offset, size - offset, position + offset)
    const read = typeof result === 'number' ? result : result.bytesRead
    if (!Number.isSafeInteger(read) || read <= 0) throw problem('Truncated TAR staging')
    offset += read
  }
  return value
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Durable direct-TAR session authority. */
export class TarSessionStore {
  readonly layout: StorageLayout
  readonly maxStagingBytes: number
  readonly minFreeBytes: number
  readonly clock: Clock
  readonly resumeTtl: number | undefined
  readonly isSessionActive: (session: TarSession) => boolean
  readonly storage: StorageAdapter
  readonly sessions = new Map<string, TarSession>()
  reservedBytes = 0
  initialized = false
  closed = false
  private pending: Promise<unknown> = Promise.resolve()

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation)
    this.pending = result.catch(() => {})
    return result
  }

  constructor({
    layout,
    maxStagingBytes,
    minFreeBytes = 0,
    clock = Date,
    resumeTtl,
    isSessionActive = () => false,
    storage = fs.promises
  }: TarSessionStoreOptions) {
    if (!layout || typeof layout !== 'object') throw problem('Invalid storage layout')
    assertSafeUint(maxStagingBytes, 'maxStagingBytes')
    assertSafeUint(minFreeBytes, 'minFreeBytes')
    if (!clock || typeof clock.now !== 'function') throw problem('Invalid clock')
    if (resumeTtl !== undefined) {
      assertSafeUint(resumeTtl, 'resumeTtl')
      if (resumeTtl === 0) throw problem('Invalid resumeTtl')
    }
    if (typeof isSessionActive !== 'function') throw problem('Invalid session activity predicate')
    if (!storage || typeof storage !== 'object') throw problem('Invalid storage adapter')
    this.layout = layout
    this.maxStagingBytes = maxStagingBytes
    this.minFreeBytes = minFreeBytes
    this.clock = clock
    this.resumeTtl = resumeTtl
    this.isSessionActive = isSessionActive
    this.storage = storage
  }

  private sessionPath(id: string): string {
    return path.join(this.layout.sessions, `${id}.json`)
  }

  private tarPath(id: string): string {
    return path.join(this.layout.staging, `${id}.tar.part`)
  }

  private filePath(id: string): string {
    return path.join(this.layout.staging, `${id}.part`)
  }

  private reserve(session: TarSession): number {
    return session.tarSize + session.size
  }

  private assertReady(): void {
    if (!this.initialized || this.closed) throw problem('Session store is not available')
  }

  private metadata(metadata: MetadataRecord): MetadataRecord {
    return decodeMetadataRecord(encodeMetadataRecord(metadata))
  }

  private fromDisk(id: string, record: Record<string, unknown>): TarSession {
    const persisted = record as unknown as PersistedTarSession
    if (persisted.version !== VERSION || persisted.transferId !== id) {
      throw problem('Invalid TAR session')
    }
    const ownerKey = bytes(persisted.ownerKey, 'owner key')
    const transferId = bytes(persisted.transferId, 'transfer ID')
    uint(persisted.fileSize, 'file size')
    uint(persisted.tarSize, 'TAR size')
    uint(persisted.createdAt, 'creation time')
    uint(persisted.updatedAt, 'update time')
    if (
      !persisted.partialTar ||
      persisted.partialTar.path !== `${id}.tar.part` ||
      ![RECEIVING, VERIFIED, DELETING].includes(persisted.state)
    ) {
      throw problem('Invalid TAR session metadata')
    }
    uint(persisted.partialTar.size, 'partial TAR size')
    if (persisted.partialTar.size > persisted.tarSize) {
      throw problem('Oversized partial TAR')
    }
    const metadata = this.metadata({
      v: 1,
      name: persisted.name,
      fileSize: persisted.fileSize,
      fileSha256: hex(bytes(persisted.fileSha256, 'file digest')),
      tarSize: persisted.tarSize,
      tarSha256: hex(bytes(persisted.tarSha256, 'TAR digest')),
      transferId: id,
      reset: false
    })
    assertMetadataTransferId(ownerKey, metadata)
    return {
      id,
      transferId,
      ownerKey,
      name: metadata.name,
      size: metadata.fileSize,
      digest: b4a.from(metadata.fileSha256, 'hex'),
      tarSize: metadata.tarSize,
      tarDigest: b4a.from(metadata.tarSha256, 'hex'),
      tarPath: this.tarPath(id),
      partialTarSize: persisted.partialTar.size,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      state: persisted.state
    }
  }

  private serialize(session: TarSession): PersistedTarSession {
    return {
      version: VERSION,
      transferId: session.id,
      ownerKey: hex(session.ownerKey),
      name: session.name,
      fileSize: session.size,
      fileSha256: hex(session.digest),
      tarSize: session.tarSize,
      tarSha256: hex(session.tarDigest),
      partialTar: { path: `${session.id}.tar.part`, size: session.partialTarSize },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      state: session.state
    }
  }

  private async writeSession(session: TarSession): Promise<void> {
    await writeAtomic(
      this.sessionPath(session.id),
      b4a.from(JSON.stringify(this.serialize(session))),
      this.storage
    )
  }

  private async remove(filePath: string, directory: string): Promise<void> {
    await withSafeDirectoryIdentity(directory, this.storage, async () => {
      try {
        await assertSafeFile(filePath, this.storage)
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'cause' in error &&
          (error.cause as { code?: string }).code === 'ENOENT'
        ) {
          return
        }
        throw error
      }
      await this.storage.unlink(filePath)
    })
    await withSafeDirectoryIdentity(directory, this.storage, () =>
      syncDirectory(directory, this.storage)
    )
  }

  private hashPrefix(session: TarSession): Promise<Buffer> {
    return withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
      const handle = await openSafeRegularFile(session.tarPath, 'read', this.storage)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size !== session.partialTarSize) {
          throw problem('Partial TAR size changed')
        }
        const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
        sodium.crypto_hash_sha256_init(state)
        for (let position = 0; position < session.partialTarSize;) {
          const chunk = await readAll(
            handle,
            Math.min(READ_BYTES, session.partialTarSize - position),
            position
          )
          sodium.crypto_hash_sha256_update(state, chunk)
          position += chunk.byteLength
        }
        const digest = b4a.alloc(32)
        sodium.crypto_hash_sha256_final(state, digest)
        return digest
      } finally {
        await handle.close()
      }
    })
  }

  private ensureTarLength(session: TarSession): Promise<boolean> {
    return withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
      const handle = await openSafeRegularFile(session.tarPath, 'write', this.storage)
      try {
        const stat = await handle.stat()
        if (stat.size < session.partialTarSize) return false
        if (stat.size > session.tarSize) {
          throw problem('Oversized partial TAR')
        }
        if (stat.size > session.partialTarSize) {
          await (
            handle as StorageFileHandle & { truncate(length: number): Promise<void> }
          ).truncate(session.partialTarSize)
          await handle.sync()
        }
        return true
      } finally {
        await handle.close()
      }
    })
  }

  private async diskReserve(incoming: number): Promise<void> {
    if (this.minFreeBytes === 0) return
    if (typeof this.storage.statfs !== 'function') {
      throw new SwarmDeployError(ERRORS.DISK_RESERVE, 'Free-disk reserve is unavailable')
    }
    const stat = await this.storage.statfs(this.layout.staging)
    const available = BigInt(stat.bavail) * BigInt(stat.bsize)
    if (available < BigInt(this.minFreeBytes) + BigInt(this.reservedBytes) + BigInt(incoming)) {
      throw new SwarmDeployError(ERRORS.DISK_RESERVE, 'Minimum free-disk reserve exceeded')
    }
  }

  init(): Promise<void> {
    return this.run(async () => {
      if (this.initialized) return
      for (const directory of [
        this.layout.root,
        this.layout.internal,
        this.layout.staging,
        this.layout.sessions
      ]) {
        await withSafeDirectoryIdentity(directory, this.storage, () => undefined)
      }
      const names = await this.storage.readdir(this.layout.sessions)
      for (const name of names.sort()) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) throw problem('Invalid session metadata path')
        const id = name.slice(0, -5)
        const record = await readJson(this.sessionPath(id), this.storage, 16 * 1024)
        if (record.version === 1) {
          await this.remove(this.sessionPath(id), this.layout.sessions)
          const oldStaging = this.filePath(id)
          const journal = await readCommitJournal(id, this.layout, this.storage)
          if (!journal) await this.remove(oldStaging, this.layout.staging)
          continue
        }
        const session = this.fromDisk(id, record)
        if (session.state === DELETING) {
          await this.remove(session.tarPath, this.layout.staging)
          await this.remove(this.filePath(id), this.layout.staging)
          await this.remove(this.sessionPath(id), this.layout.sessions)
          continue
        }
        if (session.state === RECEIVING) {
          if (!(await this.ensureTarLength(session))) {
            session.partialTarSize = 0
            session.updatedAt = this.clock.now()
            await this.writeSession(session)
          }
        } else {
          await assertSafeFile(this.filePath(id), this.storage)
        }
        this.sessions.set(id, session)
        this.reservedBytes += this.reserve(session)
        if (this.reservedBytes > this.maxStagingBytes) {
          throw new SwarmDeployError(
            ERRORS.STAGING_LIMIT,
            'Recovered TAR sessions exceed staging limit'
          )
        }
      }
      const expected = new Set<string>()
      for (const session of this.sessions.values()) {
        expected.add(`${session.id}.tar.part`)
        if (session.state === VERIFIED) expected.add(`${session.id}.part`)
      }
      for (const name of await this.storage.readdir(this.layout.staging)) {
        if (expected.has(name)) continue
        const staged = /^([0-9a-f]{64})\.(?:part|tar\.part)$/.exec(name)
        if (staged) {
          const journal = await readCommitJournal(staged[1], this.layout, this.storage)
          if (journal) continue
          await this.remove(path.join(this.layout.staging, name), this.layout.staging)
          continue
        }
        throw problem('Unknown staging path')
      }
      this.initialized = true
    })
  }

  admit(ownerKey: Uint8Array, input: MetadataRecord): Promise<TarAdmission> {
    return this.run(async () => {
      this.assertReady()
      key(ownerKey, 'owner key')
      const metadata = this.metadata(input)
      assertMetadataTransferId(ownerKey, metadata)
      const id = metadata.transferId
      if (this.resumeTtl !== undefined) await this.expireUnlocked(this.resumeTtl)
      let session = this.sessions.get(id)
      if (session) {
        if (!sameMetadata(session, metadata, ownerKey)) {
          throw new SwarmDeployError(
            ERRORS.FILE_BUSY,
            'Transfer ID belongs to different immutable metadata'
          )
        }
        if (session.state === DELETING) throw problem('TAR session is quarantined')
        if (session.state === VERIFIED) {
          if (metadata.reset) throw problem('Cannot reset verified TAR session')
          return { status: 'VERIFIED' }
        }
        if (metadata.reset && session.state === RECEIVING) {
          await this.resetUnlocked(session)
          return { status: 'ACCEPT', offset: 0 }
        }
        if (session.state !== RECEIVING || session.partialTarSize === 0) {
          return { status: 'ACCEPT', offset: 0 }
        }
        return {
          status: 'RESUME',
          offset: session.partialTarSize,
          prefixSha256: await this.hashPrefix(session)
        }
      }
      for (const candidate of this.sessions.values()) {
        if (candidate.name === metadata.name) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Destination has an active session')
        }
      }
      const reservation = metadata.tarSize + metadata.fileSize
      if (this.reservedBytes > this.maxStagingBytes - reservation) {
        throw new SwarmDeployError(ERRORS.STAGING_LIMIT, 'Staging capacity exceeded')
      }
      await this.diskReserve(reservation)
      const now = this.clock.now()
      session = {
        id,
        transferId: b4a.from(id, 'hex'),
        ownerKey: b4a.from(ownerKey),
        name: metadata.name,
        size: metadata.fileSize,
        digest: b4a.from(metadata.fileSha256, 'hex'),
        tarSize: metadata.tarSize,
        tarDigest: b4a.from(metadata.tarSha256, 'hex'),
        tarPath: this.tarPath(id),
        partialTarSize: 0,
        createdAt: now,
        updatedAt: now,
        state: RECEIVING
      }
      await withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
        const handle = await openSafeRegularFile(session!.tarPath, 'create', this.storage)
        await handle.sync()
        await handle.close()
        await syncDirectory(this.layout.staging, this.storage)
      })
      await this.writeSession(session)
      this.sessions.set(id, session)
      this.reservedBytes += reservation
      return { status: 'ACCEPT', offset: 0 }
    })
  }

  append(
    ownerKey: Uint8Array,
    input: MetadataRecord,
    offset: number,
    data: Uint8Array
  ): Promise<number> {
    return this.run(async () => {
      this.assertReady()
      key(ownerKey, 'owner key')
      const metadata = this.metadata(input)
      const session = this.sessions.get(metadata.transferId)
      if (!session || !sameMetadata(session, metadata, ownerKey)) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unknown or mismatched TAR session')
      }
      if (session.state !== RECEIVING) throw problem('Cannot append to verified TAR session')
      if (
        !Number.isSafeInteger(offset) ||
        offset !== session.partialTarSize ||
        !b4a.isBuffer(data)
      ) {
        throw problem('TAR append offset does not match durable progress')
      }
      if (data.byteLength > session.tarSize - offset) {
        throw problem('TAR append exceeds deterministic length')
      }
      if (data.byteLength === 0) throw problem('TAR append must make positive progress')
      const previous = session.partialTarSize
      try {
        await withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
          const handle = await openSafeRegularFile(session.tarPath, 'write', this.storage)
          try {
            await writeAll(handle, data, offset)
            await handle.sync()
          } finally {
            await handle.close()
          }
        })
      } catch (cause) {
        await this.rollbackOrQuarantine(session, previous, cause)
        throw cause
      }
      session.partialTarSize += data.byteLength
      session.updatedAt = this.clock.now()
      try {
        await this.writeSession(session)
      } catch (error) {
        if (!atomicWriteRenamed(error)) {
          await this.rollbackOrQuarantine(session, previous, error)
          session.partialTarSize = previous
        }
        throw error
      }
      return session.partialTarSize
    })
  }

  private async rollbackTar(session: TarSession, length: number): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
      const handle = await openSafeRegularFile(session.tarPath, 'write', this.storage)
      try {
        await (handle as StorageFileHandle & { truncate(length: number): Promise<void> }).truncate(
          length
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  private async rollbackOrQuarantine(
    session: TarSession,
    length: number,
    cause: unknown
  ): Promise<void> {
    try {
      await this.rollbackTar(session, length)
    } catch (cleanupCause) {
      session.state = DELETING
      try {
        await this.writeSession(session)
      } catch (quarantineCause) {
        throw Object.assign(problem('TAR append rollback and quarantine failed', cause), {
          cleanupCause,
          quarantineCause
        })
      }
      throw Object.assign(problem('TAR append and rollback failed', cause), { cleanupCause })
    }
  }

  private async resetUnlocked(session: TarSession): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
      const handle = await openSafeRegularFile(session.tarPath, 'write', this.storage)
      try {
        await (handle as StorageFileHandle & { truncate(length: number): Promise<void> }).truncate(
          0
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    session.partialTarSize = 0
    session.updatedAt = this.clock.now()
    await this.writeSession(session)
  }

  verify(ownerKey: Uint8Array, input: MetadataRecord): Promise<TarSession> {
    return this.run(async () => {
      this.assertReady()
      key(ownerKey, 'owner key')
      const metadata = this.metadata(input)
      const session = this.sessions.get(metadata.transferId)
      if (!session || session.state !== RECEIVING || !sameMetadata(session, metadata, ownerKey)) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unknown or mismatched TAR session')
      }
      if (session.partialTarSize !== session.tarSize) throw problem('TAR transfer is incomplete')
      let file: StorageFileHandle | null = null
      let fileOffset = 0
      try {
        file = await openSafeRegularFile(this.filePath(session.id), 'create', this.storage)
        const source = this.readTar(session)
        await validateAndExtractTar(source, metadata, {
          writeTar: () => {},
          writeFile: async (chunk) => {
            await writeAll(file!, chunk, fileOffset)
            fileOffset += chunk.byteLength
          },
          complete: async () => {
            await file!.sync()
          },
          abort: async () => {
            await file?.close().catch(() => {})
            file = null
            await this.remove(this.filePath(session.id), this.layout.staging).catch(() => {})
          }
        })
        await file.close()
        file = null
        await withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
          syncDirectory(this.layout.staging, this.storage)
        )
        session.state = VERIFIED
        session.updatedAt = this.clock.now()
        await this.writeSession(session)
        return session
      } catch (error) {
        if (file) await file.close().catch(() => {})
        throw error
      }
    })
  }

  private async *readTar(session: TarSession): AsyncGenerator<Buffer> {
    const handle = await openSafeRegularFile(session.tarPath, 'read', this.storage)
    try {
      for (let position = 0; position < session.tarSize;) {
        const chunk = await readAll(
          handle,
          Math.min(READ_BYTES, session.tarSize - position),
          position
        )
        position += chunk.byteLength
        yield chunk
      }
    } finally {
      await handle.close()
    }
  }

  readVerified(transferId: Uint8Array): Promise<TarSession> {
    return this.run(async () => {
      this.assertReady()
      key(transferId, 'transfer ID')
      const session = this.sessions.get(hex(transferId))
      if (!session || session.state !== VERIFIED) throw problem('Session is not verified')
      await assertSafeFile(this.filePath(session.id), this.storage)
      return session
    })
  }

  private async removeSession(session: TarSession): Promise<void> {
    session.state = DELETING
    session.updatedAt = this.clock.now()
    await this.writeSession(session)
    await this.remove(session.tarPath, this.layout.staging)
    await this.remove(this.filePath(session.id), this.layout.staging)
    await this.remove(this.sessionPath(session.id), this.layout.sessions)
    this.sessions.delete(session.id)
    this.reservedBytes -= this.reserve(session)
  }

  delete(transferId: Uint8Array): Promise<boolean> {
    return this.run(async () => {
      this.assertReady()
      key(transferId, 'transfer ID')
      const session = this.sessions.get(hex(transferId))
      if (!session) return false
      await this.removeSession(session)
      return true
    })
  }

  deleteByOwner(owner: Uint8Array): Promise<number> {
    return this.run(async () => {
      this.assertReady()
      key(owner, 'owner key')
      let removed = 0
      for (const session of [...this.sessions.values()]) {
        if (!sodium.sodium_memcmp(session.ownerKey, owner)) continue
        await this.removeSession(session)
        removed++
      }
      return removed
    })
  }

  deleteUnauthorized(predicate: (ownerKey: Uint8Array) => boolean): Promise<number> {
    return this.run(async () => {
      this.assertReady()
      if (typeof predicate !== 'function') throw problem('Invalid session authorization predicate')
      let removed = 0
      for (const session of [...this.sessions.values()]) {
        if (predicate(session.ownerKey)) continue
        await this.removeSession(session)
        removed++
      }
      return removed
    })
  }

  private async expireUnlocked(
    ttl: number,
    predicate: (session: TarSession) => boolean = () => true
  ): Promise<number> {
    let removed = 0
    for (const session of [...this.sessions.values()]) {
      if (
        this.clock.now() - session.updatedAt <= ttl ||
        !predicate(session) ||
        this.isSessionActive(session)
      ) {
        continue
      }
      await this.removeSession(session)
      removed++
    }
    return removed
  }

  expire(ttl: number, predicate: (session: TarSession) => boolean = () => true): Promise<number> {
    return this.run(() => {
      this.assertReady()
      return this.expireUnlocked(ttl, predicate)
    })
  }

  retireCommitted(transferId: Uint8Array): Promise<boolean> {
    return this.delete(transferId)
  }

  close(): Promise<void> {
    return this.run(() => {
      this.closed = true
      return Promise.resolve()
    })
  }
}
