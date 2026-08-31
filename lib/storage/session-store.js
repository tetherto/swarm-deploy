'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { validateBasename } = require('../files')
const { MAX_CHUNK_BYTES } = require('../protocol/constants')
const { transferId } = require('../protocol/transfer-id')
const { assertFixed32, assertSafeUint, assertBoundedChunkSize } = require('../protocol/validation')
const { assertSafeDirectory, assertSafeFile } = require('./layout')
const { writeAtomic, readJson } = require('./atomic-file')

const METADATA_VERSION = 1
const RECEIVING = 'receiving'
const VERIFIED = 'verified'
const MAX_CHUNK_COUNT = 262_144

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function toHex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function fromHex(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw storageError(`Invalid ${name}`)
  }
  return b4a.from(value, 'hex')
}

function bitmapBytes(chunkCount) {
  return Math.ceil(chunkCount / 8)
}

function bitIsSet(bitmap, index) {
  return (bitmap[Math.floor(index / 8)] & (1 << (index % 8))) !== 0
}

function setBit(bitmap, index) {
  bitmap[Math.floor(index / 8)] |= 1 << (index % 8)
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw storageError(`Invalid ${name}`)
}

function assertOffer(ownerKey, offer) {
  assertFixed32(ownerKey, 'ownerKey')
  if (!offer || typeof offer !== 'object') throw storageError('Invalid offer')
  assertSafeUint(offer.version, 'version')
  if (offer.version !== 1) throw storageError('Invalid offer version')
  validateBasename(offer.name)
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

function noFollowFlag() {
  if (fs.constants?.O_NOFOLLOW !== undefined) return fs.constants.O_NOFOLLOW
  if (typeof Bare !== 'undefined') {
    const platform = require('bare-os').platform()
    if (platform === 'darwin') return 0x100
    if (platform === 'linux') return 0x20000
  }
  if (process.platform === 'darwin') return 0x100
  if (process.platform === 'linux') return 0x20000
  throw storageError('Safe file open is unsupported on this platform')
}

function openFlags(name) {
  const constants = fs.constants || {}
  const noFollow = noFollowFlag()
  if (name === 'create') {
    return (
      (constants.O_WRONLY ?? 1) |
      (constants.O_CREAT ?? 0o100) |
      (constants.O_EXCL ?? 0o200) |
      noFollow
    )
  }
  if (name === 'write') return (constants.O_RDWR ?? 2) | noFollow
  return (constants.O_RDONLY ?? 0) | noFollow
}

async function writeAll(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0)
      throw storageError('Unable to write staging bytes')
    offset += count
  }
}

async function readExactly(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) return false
    offset += count
  }
  return true
}

class SessionStore {
  constructor({
    layout,
    maxStagingBytes,
    clock = Date,
    checkpointChunks = 16,
    storage = fs.promises
  }) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    assertSafeUint(maxStagingBytes, 'maxStagingBytes')
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (!Number.isSafeInteger(checkpointChunks) || checkpointChunks <= 0) {
      throw storageError('Invalid checkpoint chunk count')
    }
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')

    this.layout = layout
    this.maxStagingBytes = maxStagingBytes
    this.clock = clock
    this.checkpointChunks = checkpointChunks
    this.storage = storage
    this.sessions = new Map()
    this.reservedBytes = 0
    this.initialized = false
    this.closed = false
    this.pending = Promise.resolve()
  }

  _serialize(session) {
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

  _snapshot(session, resumed = false, duplicate = false) {
    return {
      transferId: b4a.from(session.transferId),
      state: session.state,
      resumed,
      duplicate,
      verified: new Set(session.verified)
    }
  }

  _stagingPath(id) {
    return path.join(this.layout.staging, `${id}.part`)
  }

  _sessionPath(id) {
    return path.join(this.layout.sessions, `${id}.json`)
  }

  _run(operation) {
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

  _assertReady() {
    if (!this.initialized || this.closed) throw storageError('Session store is not available')
  }

  _sessionFromMetadata(id, metadata) {
    if (!metadata || metadata.version !== METADATA_VERSION)
      throw storageError('Invalid session metadata')
    if (metadata.transferId !== id) throw storageError('Session ID does not match metadata path')
    const transferIdBytes = fromHex(metadata.transferId, 'transfer ID')
    const ownerKey = fromHex(metadata.ownerKey, 'owner key')
    validateBasename(metadata.name)
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
    if (metadata.state !== RECEIVING && metadata.state !== VERIFIED) {
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
      if ((bitmap[bitmap.byteLength - 1] & ~mask) !== 0)
        throw storageError('Invalid session bitmap padding')
    }
    if (
      !Array.isArray(metadata.chunkDigests) ||
      metadata.chunkDigests.length !== metadata.chunkCount
    ) {
      throw storageError('Invalid session chunk digests')
    }

    const chunkDigests = []
    const verified = new Set()
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

    const canonicalId = transferId({
      clientPublicKey: ownerKey,
      name: metadata.name,
      size: metadata.size,
      digest,
      chunkSize: metadata.chunkSize
    })
    if (!b4a.equals(canonicalId, transferIdBytes))
      throw storageError('Noncanonical stored transfer ID')

    return {
      id,
      transferId: transferIdBytes,
      ownerKey,
      name: metadata.name,
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
      state: metadata.state,
      pendingChunks: 0
    }
  }

  _expectedChunkLength(session, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunkCount) {
      throw storageError('Invalid chunk index')
    }
    return Math.min(session.chunkSize, session.size - index * session.chunkSize)
  }

  async _verifyStaging(session) {
    const stagingPath = this._stagingPath(session.id)
    await assertSafeFile(stagingPath, this.storage)
    const handle = await this.storage.open(stagingPath, openFlags('read'))
    try {
      for (const index of session.verified) {
        const bytes = b4a.alloc(this._expectedChunkLength(session, index))
        if (!(await readExactly(handle, bytes, index * session.chunkSize))) {
          throw storageError('Stored chunk is truncated')
        }
        if (!b4a.equals(sha256(bytes), session.chunkDigests[index])) {
          throw storageError('Stored chunk digest mismatch')
        }
      }
    } finally {
      await handle.close()
    }
  }

  async _verifyWholeStaging(session) {
    const stagingPath = this._stagingPath(session.id)
    await assertSafeFile(stagingPath, this.storage)
    const handle = await this.storage.open(stagingPath, openFlags('read'))
    try {
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
    } finally {
      await handle.close()
    }
  }

  async _writeSession(session) {
    const encoded = b4a.from(JSON.stringify(this._serialize(session)))
    await writeAtomic(this._sessionPath(session.id), encoded, this.storage)
  }

  async _checkpoint(session) {
    const stagingPath = this._stagingPath(session.id)
    await assertSafeFile(stagingPath, this.storage)
    const handle = await this.storage.open(stagingPath, openFlags('read'))
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    session.checkpointedAt = this.clock.now()
    await this._writeSession(session)
    session.pendingChunks = 0
  }

  async _removeFile(filePath) {
    try {
      await assertSafeFile(filePath, this.storage)
    } catch (err) {
      if (err.cause?.code === 'ENOENT') return
      throw err
    }
    await this.storage.unlink(filePath)
  }

  async _deleteSession(session) {
    await this._removeFile(this._sessionPath(session.id))
    await this._removeFile(this._stagingPath(session.id))
    this.sessions.delete(session.id)
    this.reservedBytes -= session.size
  }

  async _destinationExists(name) {
    const destination = path.join(this.layout.root, name)
    try {
      await this.storage.lstat(destination)
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
  }

  async _createStaging(session) {
    const stagingPath = this._stagingPath(session.id)
    let handle
    try {
      handle = await this.storage.open(stagingPath, openFlags('create'), 0o600)
      await handle.sync()
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'ELOOP') throw err
      await assertSafeFile(stagingPath, this.storage)
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Staging path is already in use')
    } finally {
      if (handle) await handle.close()
    }
  }

  async init() {
    return this._run(async () => {
      if (this.initialized) return
      if (this.closed) throw storageError('Session store is closed')
      await this._assertLayout()

      const names = await this.storage.readdir(this.layout.sessions)
      const loaded = []
      for (const name of names) {
        if (typeof name !== 'string' || !/^[0-9a-f]{64}\.json$/.test(name)) {
          throw storageError('Invalid session metadata path')
        }
        const id = name.slice(0, -'.json'.length)
        const metadataPath = path.join(this.layout.sessions, name)
        await assertSafeFile(metadataPath, this.storage)
        const session = this._sessionFromMetadata(id, await readJson(metadataPath, this.storage))
        await this._verifyStaging(session)
        loaded.push(session)
      }

      const stagingNames = await this.storage.readdir(this.layout.staging)
      const expectedStaging = new Set(loaded.map((session) => `${session.id}.part`))
      for (const name of stagingNames) {
        const stagingPath = path.join(this.layout.staging, name)
        await assertSafeFile(stagingPath, this.storage)
        if (!expectedStaging.has(name)) throw storageError('Orphaned staging file')
      }

      let reserved = 0
      for (const session of loaded) {
        if (reserved > this.maxStagingBytes - session.size) {
          throw new SwarmDeployError(
            ERRORS.STAGING_LIMIT,
            'Recovered sessions exceed staging limit'
          )
        }
        for (const existing of this.sessions.values()) {
          if (existing.name === session.name) throw storageError('Conflicting stored session names')
        }
        reserved += session.size
        this.sessions.set(session.id, session)
      }
      this.reservedBytes = reserved
      this.initialized = true
    })
  }

  async offer(ownerKey, offer) {
    return this._run(async () => {
      this._assertReady()
      await this._assertLayout()
      assertOffer(ownerKey, offer)
      const id = toHex(offer.transferId)
      const existing = this.sessions.get(id)
      if (existing) return this._snapshot(existing, true)
      for (const session of this.sessions.values()) {
        if (session.name === offer.name) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Destination has an active session')
        }
      }
      if (await this._destinationExists(offer.name)) {
        throw new SwarmDeployError(ERRORS.FILE_EXISTS, 'Destination already exists')
      }
      if (this.reservedBytes > this.maxStagingBytes - offer.size) {
        throw new SwarmDeployError(ERRORS.STAGING_LIMIT, 'Staging capacity exceeded')
      }

      const now = this.clock.now()
      const session = {
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
        await this._removeFile(this._stagingPath(id)).catch(() => {})
        throw err
      }
      this.sessions.set(id, session)
      this.reservedBytes += session.size
      return this._snapshot(session)
    })
  }

  async writeChunk(transferId, chunk) {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      if (!chunk || typeof chunk !== 'object') throw storageError('Invalid chunk')
      assertSafeUint(chunk.index, 'chunk index')
      assertFixed32(chunk.digest, 'chunk digest')
      if (!(b4a.isBuffer(chunk.data) || chunk.data instanceof Uint8Array)) {
        throw storageError('Invalid chunk bytes')
      }

      const id = toHex(transferId)
      const session = this.sessions.get(id)
      if (!session || session.state !== RECEIVING) throw storageError('Unknown or closed session')
      const expectedLength = this._expectedChunkLength(session, chunk.index)
      if (chunk.data.byteLength !== expectedLength) throw storageError('Invalid chunk length')

      const computed = sha256(chunk.data)
      if (!b4a.equals(computed, chunk.digest)) {
        await this._deleteSession(session)
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Chunk digest mismatch')
      }
      if (session.verified.has(chunk.index)) {
        if (b4a.equals(session.chunkDigests[chunk.index], chunk.digest)) {
          return this._snapshot(session, false, true)
        }
        await this._deleteSession(session)
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Conflicting duplicate chunk')
      }

      const stagingPath = this._stagingPath(id)
      await assertSafeFile(stagingPath, this.storage)
      const handle = await this.storage.open(stagingPath, openFlags('write'))
      try {
        await writeAll(handle, chunk.data, chunk.index * session.chunkSize)
      } finally {
        await handle.close()
      }

      setBit(session.bitmap, chunk.index)
      session.chunkDigests[chunk.index] = b4a.from(chunk.digest)
      session.verified.add(chunk.index)
      session.updatedAt = this.clock.now()
      session.pendingChunks++
      if (session.pendingChunks >= this.checkpointChunks) await this._checkpoint(session)
      return this._snapshot(session)
    })
  }

  async checkpoint(transferId) {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const session = this.sessions.get(toHex(transferId))
      if (!session) throw storageError('Unknown session')
      await this._checkpoint(session)
      return this._snapshot(session)
    })
  }

  async finish(transferId) {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const session = this.sessions.get(toHex(transferId))
      if (!session || session.state !== RECEIVING) throw storageError('Unknown or closed session')
      if (session.verified.size !== session.chunkCount) throw storageError('Missing chunks')
      if (!(await this._verifyWholeStaging(session))) {
        await this._deleteSession(session)
        throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging file checksum mismatch')
      }

      const previousState = session.state
      const previousUpdatedAt = session.updatedAt
      const previousCheckpointedAt = session.checkpointedAt
      session.state = VERIFIED
      session.updatedAt = this.clock.now()
      try {
        await this._checkpoint(session)
      } catch (err) {
        session.state = previousState
        session.updatedAt = previousUpdatedAt
        session.checkpointedAt = previousCheckpointedAt
        throw err
      }
      return this._snapshot(session)
    })
  }

  async delete(transferId) {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(transferId, 'transferId')
      const session = this.sessions.get(toHex(transferId))
      if (!session) return false
      await this._deleteSession(session)
      return true
    })
  }

  async deleteByOwner(ownerKey) {
    return this._run(async () => {
      this._assertReady()
      assertFixed32(ownerKey, 'ownerKey')
      let deleted = 0
      for (const session of [...this.sessions.values()]) {
        if (!b4a.equals(session.ownerKey, ownerKey)) continue
        await this._deleteSession(session)
        deleted++
      }
      return deleted
    })
  }

  async expire(ttl) {
    return this._run(async () => {
      this._assertReady()
      assertSafeUint(ttl, 'session ttl')
      const now = this.clock.now()
      let deleted = 0
      for (const session of [...this.sessions.values()]) {
        if (now - session.updatedAt < ttl) continue
        await this._deleteSession(session)
        deleted++
      }
      return deleted
    })
  }

  async close() {
    return this._run(async () => {
      if (this.closed) return
      for (const session of this.sessions.values()) {
        if (session.pendingChunks > 0) await this._checkpoint(session)
      }
      this.closed = true
    })
  }
}

module.exports = {
  SessionStore
}
