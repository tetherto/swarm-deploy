'use strict'

const b4a = require('b4a')
const { SwarmDeployError, ERRORS } = require('../errors')
const { transferId } = require('./transfer-id')
const { assertFixed32, assertSafeUint } = require('./validation')
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
const MAX_QUEUED_CHUNKS = 4
const RESULT_COMMITTED = 0
const RESULT_REJECTED = 1

function protocolError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
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

function bitmapBits(verified, start, count) {
  const bits = b4a.alloc(Math.ceil(count / 8))
  for (let offset = 0; offset < count; offset++) {
    if (verified.has(start + offset)) bits[Math.floor(offset / 8)] |= 1 << (offset % 8)
  }
  return bits
}

function statusForError(err) {
  if (err?.code === ERRORS.FILE_EXISTS) return STATUS_CODE.FILE_EXISTS
  if (err?.code === ERRORS.FILE_BUSY) return STATUS_CODE.FILE_BUSY
  if (err?.code === ERRORS.STAGING_LIMIT || err?.code === ERRORS.FILE_TOO_LARGE) {
    return STATUS_CODE.REJECTED
  }
  return null
}

class ServerSession {
  constructor({
    channel,
    ownerKey,
    sessionStore,
    commitStore,
    retentionManager = null,
    maxFileBytes,
    reserveUpload = () => true,
    releaseUpload = () => {},
    isAuthorized = () => true,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    scheduler = { setTimeout, clearTimeout },
    destroy,
    onTerminal = () => {}
  }) {
    if (
      !channel ||
      typeof channel.addMessage !== 'function' ||
      typeof channel.open !== 'function' ||
      typeof channel.close !== 'function'
    ) {
      throw protocolError('Invalid protocol channel')
    }
    assertFixed32(ownerKey, 'ownerKey')
    if (
      !sessionStore ||
      typeof sessionStore.offer !== 'function' ||
      typeof sessionStore.writeChunk !== 'function' ||
      typeof sessionStore.finish !== 'function' ||
      typeof sessionStore.retireCommitted !== 'function' ||
      !(sessionStore.sessions instanceof Map)
    ) {
      throw protocolError('Invalid session store')
    }
    if (
      !commitStore ||
      typeof commitStore.inspect !== 'function' ||
      typeof commitStore.commit !== 'function'
    ) {
      throw protocolError('Invalid commit store')
    }
    assertSafeUint(maxFileBytes, 'maxFileBytes')
    if (maxFileBytes === 0) throw protocolError('Invalid maxFileBytes')
    if (typeof reserveUpload !== 'function' || typeof releaseUpload !== 'function') {
      throw protocolError('Invalid upload reservation callbacks')
    }
    if (typeof isAuthorized !== 'function') throw protocolError('Invalid authorization callback')
    assertDuration(idleTimeout, 'idle timeout')
    if (
      !scheduler ||
      typeof scheduler.setTimeout !== 'function' ||
      typeof scheduler.clearTimeout !== 'function'
    ) {
      throw protocolError('Invalid session scheduler')
    }
    if (typeof destroy !== 'function') throw protocolError('Invalid connection destroy callback')
    if (typeof onTerminal !== 'function') throw protocolError('Invalid terminal callback')

    this.channel = channel
    this.ownerKey = b4a.from(ownerKey)
    this.sessionStore = sessionStore
    this.commitStore = commitStore
    this.retentionManager = retentionManager
    this.maxFileBytes = maxFileBytes
    this.reserveUpload = reserveUpload
    this.releaseUpload = releaseUpload
    this.isAuthorized = isAuthorized
    this.idleTimeout = idleTimeout
    this.scheduler = scheduler
    this.destroy = destroy
    this.onTerminal = onTerminal
    this.state = 'INITIAL'
    this.transferId = null
    this.reservation = null
    this.pending = Promise.resolve()
    this.queuedChunks = 0
    this.timer = null
    this.timerGeneration = 0
    this.terminalNotified = false
    this.revoked = false
    this.abortSignal = { aborted: false }
    this.drainWaiters = []

    this.messages = [
      channel.addMessage({
        encoding: boundedEncoding(offer, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveOffer(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(status, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      }),
      channel.addMessage({
        encoding: boundedEncoding(bitmapPage, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      }),
      channel.addMessage({
        encoding: boundedEncoding(ready, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      }),
      channel.addMessage({
        encoding: boundedEncoding(chunk, MAX_CHUNK_FRAME_BYTES),
        onmessage: (value) => this._receiveChunk(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(chunkAck, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      }),
      channel.addMessage({
        encoding: boundedEncoding(finish, MAX_CONTROL_BYTES),
        onmessage: (value) => this._receiveFinish(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(result, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      })
    ]
    const receive = channel._recv
    channel._recv = (type, state) => {
      if (type >= this.messages.length) {
        return this._failClosed(protocolError('Unknown protocol message'))
      }
      return receive.call(channel, type, state)
    }
    channel.ondrain = () => this._resolveDrain()
    channel.open()
    this._touch()
  }

  _queue(operation) {
    const queued = this.pending.then(operation, operation)
    this.pending = queued.catch(() => {})
    return queued
  }

  _touch() {
    if (this.state === 'TERMINAL') return
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    const generation = ++this.timerGeneration
    this.timer = this.scheduler.setTimeout(() => {
      if (generation !== this.timerGeneration || this.state === 'TERMINAL') return
      this._queue(() => {
        if (generation !== this.timerGeneration || this.state === 'TERMINAL') return
        return this._failClosed(
          new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Upload idle timeout')
        )
      })
    }, this.idleTimeout)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  _clearTimer() {
    this.timerGeneration++
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  _resolveDrain() {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  _waitForDrain() {
    if (this.channel.drained) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  async _send(index, value) {
    const message = this.messages[index]
    if (!message) throw protocolError('Unable to send protocol response')
    if (message.send(value) === false) await this._waitForDrain()
  }

  _releaseReservation() {
    if (this.reservation === null) return
    const reservation = this.reservation
    this.reservation = null
    try {
      this.releaseUpload(reservation)
    } catch {}
  }

  _notifyTerminal() {
    if (this.terminalNotified) return
    this.terminalNotified = true
    try {
      this.onTerminal(this)
    } catch {}
  }

  _closeChannel() {
    try {
      this.channel.close()
    } catch {}
  }

  async _terminal() {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this._releaseReservation()
    this._notifyTerminal()
    this._resolveDrain()
    this._closeChannel()
  }

  async _failClosed(error) {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this._releaseReservation()
    this._notifyTerminal()
    this._resolveDrain()
    try {
      this.destroy(error)
    } catch {}
  }

  _invalidInboundMessage() {
    return this._failClosed(protocolError('Unexpected protocol message'))
  }

  _receiveOffer(value) {
    if (this.state !== 'INITIAL') return this._failClosed(protocolError('Unexpected offer'))
    this.state = 'OFFERING'
    return this._queue(() => this._handleOffer(value))
  }

  _receiveChunk(value) {
    if (this.state !== 'READY')
      return this._failClosed(protocolError('Chunk received before ready'))
    if (this.queuedChunks >= MAX_QUEUED_CHUNKS) {
      return this._failClosed(protocolError('Too many queued chunks'))
    }
    this.queuedChunks++
    return this._queue(async () => {
      try {
        await this._handleChunk(value)
      } finally {
        this.queuedChunks--
      }
    })
  }

  _receiveFinish(value) {
    if (this.state !== 'READY')
      return this._failClosed(protocolError('Finish received before ready'))
    this.state = 'FINISHING'
    return this._queue(() => this._handleFinish(value))
  }

  _assertTransfer(value) {
    if (!this.transferId || !b4a.equals(value.transferId, this.transferId)) {
      throw protocolError('Transfer ID does not match session')
    }
  }

  _canContinue() {
    if (this.revoked || this.state === 'TERMINAL' || !this.isAuthorized()) return false
    return true
  }

  async _sendBitmapPages(offerValue, verified) {
    for (let start = 0; start < offerValue.chunkCount; start += MAX_BITMAP_BITS) {
      const count = Math.min(MAX_BITMAP_BITS, offerValue.chunkCount - start)
      await this._send(BITMAP_PAGE, {
        transferId: this.transferId,
        start,
        count,
        bits: bitmapBits(verified, start, count)
      })
    }
  }

  async _rejectOffer(code, reason) {
    await this._send(STATUS, { transferId: this.transferId, code, reason })
    await this._terminal()
  }

  async _handleOffer(value) {
    try {
      if (!this._canContinue()) return
      const expected = transferId({
        clientPublicKey: this.ownerKey,
        name: value.name,
        size: value.size,
        digest: value.digest,
        chunkSize: value.chunkSize
      })
      if (!b4a.equals(expected, value.transferId)) throw protocolError('Noncanonical transfer ID')
      this.transferId = b4a.from(value.transferId)

      if (value.size > this.maxFileBytes) {
        await this._rejectOffer(STATUS_CODE.REJECTED, ERRORS.FILE_TOO_LARGE)
        return
      }

      const inspection = await this.commitStore.inspect(value.name, value)
      if (inspection.status === 'ALREADY_COMMITTED') {
        await this._rejectOffer(STATUS_CODE.ALREADY_COMMITTED, inspection.status)
        return
      }
      if (inspection.status === 'FILE_EXISTS') {
        await this._rejectOffer(STATUS_CODE.FILE_EXISTS, inspection.status)
        return
      }
      if (inspection.status === 'FILE_BUSY') {
        await this._rejectOffer(STATUS_CODE.FILE_BUSY, inspection.status)
        return
      }
      if (inspection.status !== 'AVAILABLE') throw protocolError('Invalid commit inspection status')

      const reservation = this.reserveUpload(this.transferId)
      if (!reservation) {
        await this._rejectOffer(STATUS_CODE.REJECTED, 'ACTIVE_UPLOAD_LIMIT')
        return
      }
      this.reservation = reservation

      const snapshot = await this.sessionStore.offer(this.ownerKey, value)
      await this._send(STATUS, { transferId: this.transferId, code: STATUS_CODE.ACCEPT })
      await this._sendBitmapPages(value, snapshot.verified)
      await this._send(READY, { transferId: this.transferId })
      this.state = 'READY'
      this._touch()
    } catch (err) {
      const code = statusForError(err)
      if (code !== null && this.transferId) {
        try {
          await this._rejectOffer(code, err.code)
          return
        } catch (sendError) {
          await this._failClosed(sendError)
          return
        }
      }
      await this._failClosed(err)
    }
  }

  async _handleChunk(value) {
    try {
      if (!this._canContinue()) return
      this._assertTransfer(value)
      await this.sessionStore.writeChunk(this.transferId, value)
      if (!this._canContinue()) return
      await this._send(CHUNK_ACK, { transferId: this.transferId, index: value.index })
      this._touch()
    } catch (err) {
      await this._failClosed(err)
    }
  }

  async _handleFinish(value) {
    try {
      if (!this._canContinue()) return
      this._assertTransfer(value)
      await this.sessionStore.finish(this.transferId)
      if (!this._canContinue()) return
      const session = this.sessionStore.sessions.get(b4a.toString(this.transferId, 'hex'))
      if (!session || session.state !== 'verified') throw protocolError('Missing verified session')
      await this.commitStore.commit(session, {
        retentionManager: this.retentionManager,
        signal: this.abortSignal
      })
      await this.sessionStore.retireCommitted(this.transferId)
      if (this.revoked) return
      await this._send(RESULT, { transferId: this.transferId, code: RESULT_COMMITTED })
      await this._terminal()
    } catch (err) {
      if (this.transferId && this.state !== 'TERMINAL') {
        try {
          await this._send(RESULT, {
            transferId: this.transferId,
            code: RESULT_REJECTED,
            reason: err?.code || ERRORS.COMMIT_FAILED
          })
          await this._terminal()
          return
        } catch {}
      }
      await this._failClosed(err)
    }
  }

  async close() {
    await this._terminal()
    await this.pending
  }

  revoke() {
    if (this.state === 'TERMINAL') return
    this.revoked = true
    this.abortSignal.aborted = true
    this.state = 'TERMINAL'
    this._clearTimer()
    this._releaseReservation()
    this._notifyTerminal()
    this._resolveDrain()
  }

  settle() {
    return this.pending
  }
}

module.exports = {
  ServerSession,
  UPLOAD_PROTOCOL,
  DEFAULT_IDLE_TIMEOUT,
  MAX_IDLE_TIMEOUT,
  MAX_QUEUED_CHUNKS,
  RESULT_COMMITTED,
  RESULT_REJECTED,
  boundedEncoding
}
