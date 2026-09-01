'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const { SwarmDeployError, ERRORS } = require('../errors')
const { safeFileOpenFlags } = require('../storage/layout')
const { transferId } = require('./transfer-id')
const { assertFixed32, assertSafeUint, assertBoundedChunkSize } = require('./validation')
const {
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} = require('./constants')
const { offer, status, bitmapPage, ready, chunk, chunkAck, finish, result } = require('./codecs')

const UPLOAD_PROTOCOL = 'swarm-deploy/upload/1'
const DEFAULT_IDLE_TIMEOUT = 60_000
const MAX_IDLE_TIMEOUT = 0x7fffffff
const DRAIN_TIMEOUT = 5_000
const MAX_IN_FLIGHT = 4
const RESULT_COMMITTED = 0
const RESULT_REJECTED = 1

function protocolError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function transportError(cause = null) {
  const error = protocolError('Upload transport closed', cause)
  error.transport = true
  return error
}

function assertDuration(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_IDLE_TIMEOUT) {
    throw protocolError(`Invalid ${name}`)
  }
}

function boundedEncoding(codec, maximum) {
  return {
    preencode(state, value) {
      const start = state.end
      codec.preencode(state, value)
      if (state.end - start > maximum) throw protocolError('Message too large')
    },
    encode(state, value) {
      const start = state.start
      codec.encode(state, value)
      if (state.start - start > maximum) throw protocolError('Message too large')
    },
    decode(state) {
      const start = state.start
      if (state.end - start > maximum) throw protocolError('Message too large')
      const value = codec.decode(state)
      if (state.start !== state.end) throw protocolError('Invalid framed message')
      return value
    }
  }
}

function expectedChunkLength(manifest, index) {
  if (index < 0 || index >= manifest.chunkCount) throw protocolError('Chunk index out of range')
  const offset = index * manifest.chunkSize
  return Math.min(manifest.chunkSize, manifest.size - offset)
}

function assertStableStat(expected, actual) {
  if (
    !actual ||
    typeof actual.isFile !== 'function' ||
    !actual.isFile() ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ino !== actual.ino
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Source file changed after pre-hash')
  }
}

function knownErrorCode(value) {
  return Object.values(ERRORS).includes(value)
}

function statusError(value) {
  switch (value.code) {
    case STATUS_CODE.FILE_EXISTS:
      return new SwarmDeployError(ERRORS.FILE_EXISTS, 'Destination file already exists')
    case STATUS_CODE.FILE_BUSY:
      return new SwarmDeployError(ERRORS.FILE_BUSY, 'Destination file is busy')
    case STATUS_CODE.REJECTED:
      return new SwarmDeployError(
        knownErrorCode(value.reason) ? value.reason : ERRORS.PROTOCOL_INVALID,
        value.reason || 'Upload rejected'
      )
    default:
      return protocolError('Invalid terminal status')
  }
}

class ClientSession {
  constructor({
    channel,
    clientPublicKey,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    scheduler = { setTimeout, clearTimeout },
    readChunk = null,
    destroy = null
  }) {
    if (
      !channel ||
      typeof channel.addMessage !== 'function' ||
      typeof channel.fullyOpened !== 'function' ||
      typeof channel.close !== 'function'
    ) {
      throw protocolError('Invalid protocol channel')
    }
    assertFixed32(clientPublicKey, 'clientPublicKey')
    assertDuration(idleTimeout, 'idle timeout')
    if (
      !scheduler ||
      typeof scheduler.setTimeout !== 'function' ||
      typeof scheduler.clearTimeout !== 'function'
    ) {
      throw protocolError('Invalid session scheduler')
    }
    if (readChunk !== null && typeof readChunk !== 'function')
      throw protocolError('Invalid chunk reader')
    if (destroy !== null && typeof destroy !== 'function')
      throw protocolError('Invalid connection destroyer')

    this.channel = channel
    this.clientPublicKey = b4a.from(clientPublicKey)
    this.idleTimeout = idleTimeout
    this.scheduler = scheduler
    this.readChunk = readChunk
    this.destroy =
      destroy ||
      ((error) => {
        try {
          this.channel._mux.stream.destroy(error)
        } catch {}
      })
    this.state = 'INITIAL'
    this.manifest = null
    this.transferId = null
    this.inFlight = new Set()
    this.verified = new Set()
    this.missing = []
    this.nextMissing = 0
    this.nextBitmapStart = 0
    this.pumping = false
    this.pumpAgain = false
    this.timer = null
    this.timerGeneration = 0
    this.drainWaiters = []
    this.file = null
    this.result = null
    this.resolve = null
    this.reject = null

    this.messages = [
      channel.addMessage({ encoding: boundedEncoding(offer, MAX_CONTROL_BYTES) }),
      channel.addMessage({
        encoding: boundedEncoding(status, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveStatus(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(bitmapPage, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveBitmapPage(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(ready, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveReady(value)
      }),
      channel.addMessage({ encoding: boundedEncoding(chunk, MAX_CHUNK_FRAME_BYTES) }),
      channel.addMessage({
        encoding: boundedEncoding(chunkAck, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveChunkAck(value)
      }),
      channel.addMessage({ encoding: boundedEncoding(finish, MAX_CONTROL_BYTES) }),
      channel.addMessage({
        encoding: boundedEncoding(result, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveResult(value)
      })
    ]

    const receive = channel._recv
    channel._recv = (type, state) => {
      if (type >= this.messages.length) {
        this._fail(protocolError('Unknown protocol message'))
        return null
      }
      return receive.call(channel, type, state)
    }
    const previousDrain = channel.ondrain
    channel.ondrain = () => {
      try {
        previousDrain.call(channel)
      } finally {
        this._resolveDrain()
      }
    }
    const previousClose = channel.onclose
    channel.onclose = (isRemote) => {
      try {
        previousClose.call(channel, isRemote)
      } finally {
        if (this.state !== 'TERMINAL') this._fail(transportError())
      }
    }
  }

  _validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') throw protocolError('Invalid file manifest')
    if (typeof manifest.path !== 'string' || typeof manifest.name !== 'string') {
      throw protocolError('Invalid file manifest')
    }
    assertSafeUint(manifest.size, 'manifest size')
    assertFixed32(manifest.digest, 'manifest digest')
    assertBoundedChunkSize(manifest.chunkSize, 'manifest chunk size')
    assertSafeUint(manifest.chunkCount, 'manifest chunk count')
    if (manifest.chunkCount !== Math.ceil(manifest.size / manifest.chunkSize)) {
      throw protocolError('Invalid manifest chunk count')
    }
    if (
      !Array.isArray(manifest.chunkDigests) ||
      manifest.chunkDigests.length !== manifest.chunkCount
    ) {
      throw protocolError('Invalid manifest chunk digests')
    }
    for (const digest of manifest.chunkDigests) assertFixed32(digest, 'manifest chunk digest')
    if (
      this.readChunk === null &&
      (!manifest.stat ||
        !Number.isSafeInteger(manifest.stat.size) ||
        !Number.isFinite(manifest.stat.mtimeMs) ||
        (typeof manifest.stat.ino !== 'number' && typeof manifest.stat.ino !== 'bigint'))
    ) {
      throw protocolError('Invalid manifest file snapshot')
    }
  }

  _touch() {
    if (this.state === 'TERMINAL') return
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    const generation = ++this.timerGeneration
    this.timer = this.scheduler.setTimeout(() => {
      if (generation !== this.timerGeneration || this.state === 'TERMINAL') return
      this._fail(new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Upload idle timeout'))
    }, this.idleTimeout)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  _clearTimer() {
    this.timerGeneration++
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  _waitForDrain() {
    if (this.channel.drained) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: this.scheduler.setTimeout(
          () => {
            const index = this.drainWaiters.indexOf(waiter)
            if (index !== -1) this.drainWaiters.splice(index, 1)
            resolve(false)
          },
          Math.min(this.idleTimeout, DRAIN_TIMEOUT)
        )
      }
      this.drainWaiters.push(waiter)
    })
  }

  _resolveDrain() {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.resolve(true)
    }
  }

  _assertTransfer(value) {
    if (!this.transferId || !b4a.equals(value.transferId, this.transferId)) {
      throw protocolError('Transfer ID does not match session')
    }
  }

  async _send(index, value) {
    const message = this.messages[index]
    if (!message) throw protocolError('Unable to send protocol message')
    const drained = message.send(value)
    this._touch()
    if (drained !== false) return true
    const completed = await this._waitForDrain()
    if (this.state === 'TERMINAL') return false
    if (!completed) throw new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Upload drain timed out')
    return true
  }

  async _openSource() {
    if (this.readChunk !== null || this.file) return
    let handle = null
    try {
      const before = await fs.promises.lstat(this.manifest.path)
      assertStableStat(this.manifest.stat, before)
      handle = await fs.promises.open(this.manifest.path, safeFileOpenFlags('read'))
      assertStableStat(this.manifest.stat, await handle.stat())
      this.file = handle
    } catch (err) {
      if (handle) await handle.close().catch(() => {})
      if (err instanceof SwarmDeployError) throw err
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to safely read source file', err)
    }
  }

  async _assertSourceStable() {
    if (this.readChunk !== null) return
    try {
      const pathStat = await fs.promises.lstat(this.manifest.path)
      assertStableStat(this.manifest.stat, pathStat)
      if (this.file) assertStableStat(this.manifest.stat, await this.file.stat())
    } catch (err) {
      if (err instanceof SwarmDeployError) throw err
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to verify source file stability', err)
    }
  }

  async _closeSource() {
    const handle = this.file
    this.file = null
    if (handle) await handle.close()
  }

  async _readChunk(index) {
    const expectedLength = expectedChunkLength(this.manifest, index)
    let data
    if (this.readChunk !== null) {
      data = b4a.from(await this.readChunk(this.manifest, index))
    } else {
      await this._openSource()
      data = b4a.alloc(expectedLength)
      let offset = 0
      while (offset < data.byteLength) {
        const read = await this.file.read(
          data,
          offset,
          data.byteLength - offset,
          index * this.manifest.chunkSize + offset
        )
        const bytesRead = typeof read === 'number' ? read : read.bytesRead
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Source file was truncated after pre-hash')
        }
        offset += bytesRead
      }
    }
    if (!b4a.isBuffer(data) || data.byteLength !== expectedLength) {
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Source chunk length changed after pre-hash')
    }
    const digest = crypto.createHash('sha256').update(data).digest()
    if (!b4a.equals(digest, this.manifest.chunkDigests[index])) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Source chunk changed after pre-hash')
    }
    return { transferId: this.transferId, index, digest, data }
  }

  _result(status) {
    return {
      status,
      name: this.manifest.name,
      size: this.manifest.size,
      digest: b4a.from(this.manifest.digest),
      transferId: b4a.from(this.transferId)
    }
  }

  async _complete(status) {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this._resolveDrain()
    try {
      await this._closeSource()
    } catch (err) {
      try {
        this.destroy(err)
      } catch {}
      try {
        this.channel.close()
      } catch {}
      this.reject(err)
      return
    }
    try {
      this.channel.close()
    } catch {}
    this.resolve(this._result(status))
  }

  _fail(error) {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this._resolveDrain()
    Promise.resolve()
      .then(() => this._closeSource())
      .catch(() => {})
      .then(() => {
        try {
          this.destroy(error)
        } catch {}
        try {
          this.channel.close()
        } catch {}
        this.reject(error)
      })
  }

  _receiveStatus(value) {
    try {
      if (this.state !== 'WAITING_STATUS') throw protocolError('Unexpected status')
      this._assertTransfer(value)
      this._touch()
      if (value.code === STATUS_CODE.ACCEPT) {
        this.state = 'WAITING_READY'
        this.nextBitmapStart = 0
        this.verified.clear()
        return
      }
      if (value.code === STATUS_CODE.ALREADY_COMMITTED) return this._complete('ALREADY_COMMITTED')
      this._fail(statusError(value))
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveBitmapPage(value) {
    try {
      if (this.state !== 'WAITING_READY') throw protocolError('Unexpected bitmap page')
      this._assertTransfer(value)
      if (
        value.start !== this.nextBitmapStart ||
        value.count > this.manifest.chunkCount - value.start ||
        value.count > MAX_BITMAP_BITS
      ) {
        throw protocolError('Invalid bitmap page sequence')
      }
      for (let offset = 0; offset < value.count; offset++) {
        if ((value.bits[Math.floor(offset / 8)] & (1 << (offset % 8))) !== 0) {
          this.verified.add(value.start + offset)
        }
      }
      this.nextBitmapStart += value.count
      this._touch()
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveReady(value) {
    try {
      if (this.state !== 'WAITING_READY') throw protocolError('Unexpected ready')
      this._assertTransfer(value)
      if (this.nextBitmapStart !== this.manifest.chunkCount) {
        throw protocolError('Incomplete bitmap pages')
      }
      this.missing = []
      for (let index = 0; index < this.manifest.chunkCount; index++) {
        if (!this.verified.has(index)) this.missing.push(index)
      }
      this.nextMissing = 0
      this.state = 'READY'
      this._touch()
      this._pump()
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveChunkAck(value) {
    try {
      if (this.state !== 'READY') throw protocolError('Unexpected chunk acknowledgement')
      this._assertTransfer(value)
      if (!Number.isSafeInteger(value.index) || value.index >= this.manifest.chunkCount) {
        throw protocolError('Chunk acknowledgement index out of range')
      }
      if (!this.inFlight.delete(value.index)) throw protocolError('Duplicate chunk acknowledgement')
      this._touch()
      this._pump()
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveResult(value) {
    try {
      if (this.state !== 'FINISHING') throw protocolError('Unexpected upload result')
      this._assertTransfer(value)
      this._touch()
      if (value.code === RESULT_COMMITTED) return this._complete('COMMITTED')
      if (value.code === RESULT_REJECTED) {
        this._fail(
          new SwarmDeployError(
            knownErrorCode(value.reason) ? value.reason : ERRORS.COMMIT_FAILED,
            value.reason || 'Upload commit rejected'
          )
        )
        return
      }
      throw protocolError('Invalid upload result')
    } catch (err) {
      this._fail(err)
    }
  }

  async _pump() {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        while (
          this.state === 'READY' &&
          this.inFlight.size < MAX_IN_FLIGHT &&
          this.nextMissing < this.missing.length
        ) {
          const index = this.missing[this.nextMissing++]
          const value = await this._readChunk(index)
          if (this.state !== 'READY') return
          this.inFlight.add(index)
          await this._send(CHUNK, value)
        }

        if (
          this.state === 'READY' &&
          this.nextMissing === this.missing.length &&
          this.inFlight.size === 0
        ) {
          await this._assertSourceStable()
          await this._closeSource()
          if (!this.channel.drained && !(await this._waitForDrain())) {
            throw new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Upload drain timed out')
          }
          if (this.state !== 'READY') return
          this.state = 'FINISHING'
          await this._send(FINISH, { transferId: this.transferId })
        }
      } while (this.pumpAgain && this.state === 'READY')
    } catch (err) {
      this._fail(err)
    } finally {
      this.pumping = false
      if (this.pumpAgain && this.state === 'READY') this._pump()
    }
  }

  upload(manifest) {
    if (this.state !== 'INITIAL') return Promise.reject(protocolError('Upload already started'))
    try {
      this._validateManifest(manifest)
    } catch (err) {
      return Promise.reject(err)
    }
    this.manifest = manifest
    this.transferId = transferId({
      clientPublicKey: this.clientPublicKey,
      name: manifest.name,
      size: manifest.size,
      digest: manifest.digest,
      chunkSize: manifest.chunkSize
    })
    this.state = 'OPENING'
    this._touch()
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.channel
      .fullyOpened()
      .then(async (opened) => {
        if (this.state !== 'OPENING') return
        if (!opened) throw transportError()
        this.state = 'WAITING_STATUS'
        await this._send(OFFER, {
          version: 1,
          transferId: this.transferId,
          name: manifest.name,
          size: manifest.size,
          digest: manifest.digest,
          chunkSize: manifest.chunkSize,
          chunkCount: manifest.chunkCount
        })
      })
      .catch((err) => this._fail(err))
    return this.result
  }

  close() {
    if (this.state === 'TERMINAL') return Promise.resolve()
    this._fail(transportError())
    return this.result || Promise.resolve()
  }
}

module.exports = {
  ClientSession,
  UPLOAD_PROTOCOL,
  DEFAULT_IDLE_TIMEOUT,
  MAX_IDLE_TIMEOUT,
  DRAIN_TIMEOUT,
  MAX_IN_FLIGHT,
  RESULT_COMMITTED,
  RESULT_REJECTED,
  boundedEncoding
}
