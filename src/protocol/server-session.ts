import b4a from 'b4a'
import crypto from '#crypto'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { validateReplaceNames } from '../files.js'
import { transferId } from './transfer-id.js'
import { assertFixed32, assertSafeUint } from './validation.js'
import type { ReplacementDetails } from '../types.js'
import {
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK_ACK,
  RESULT,
  STATUS_CODE,
  RESULT_CODE,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} from './constants.js'
import { bitmapPage, chunk, chunkAck, finish, offer, ready, result, status } from './codecs.js'
import type { RetentionManager as StorageRetentionManager } from '../storage/retention.js'
import type {
  Chunk,
  Codec,
  Offer,
  ProtocolChannel,
  ProtocolMessage,
  EncodingState,
  SessionScheduler,
  TransferMessage
} from './types.js'

export const UPLOAD_PROTOCOL = 'swarm-deploy/upload/1'
export const DEFAULT_IDLE_TIMEOUT = 60_000
export const MAX_IDLE_TIMEOUT = 0x7fffffff
export const DRAIN_TIMEOUT = 5_000
export const MAX_QUEUED_CHUNKS = 4
export const RESULT_COMMITTED = RESULT_CODE.COMMITTED
export const RESULT_REJECTED = RESULT_CODE.REJECTED
const FINGERPRINT_LENGTH = 12

function protocolError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function isBenignRevocation(error: unknown): boolean {
  return (
    errorCode(error) === ERRORS.REVOKED &&
    !(error instanceof AggregateError) &&
    !(typeof error === 'object' && error !== null && 'cleanupCause' in error && error.cleanupCause)
  )
}

export function boundedEncoding<Input, Output>(
  codec: Codec<Input, Output>,
  maximum: number
): Codec<Input, Output> {
  return {
    preencode(state: EncodingState, value: Input): void {
      const start = state.end
      codec.preencode(state, value)
      if (state.end - start > maximum) throw protocolError('Message too large')
    },
    encode(state: EncodingState, value: Input): void {
      const start = state.start
      codec.encode(state, value)
      if (state.start - start > maximum) throw protocolError('Message too large')
    },
    decode(state: EncodingState): Output {
      const start = state.start
      if (state.end - start > maximum) throw protocolError('Message too large')
      const value = codec.decode(state)
      if (state.start !== state.end) throw protocolError('Invalid framed message')
      return value
    }
  }
}

function assertDuration(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_IDLE_TIMEOUT
  ) {
    throw protocolError(`Invalid ${name}`)
  }
}

function bitmapBits(verified: Set<number>, start: number, count: number): Buffer {
  const bits = b4a.alloc(Math.ceil(count / 8))
  for (let offset = 0; offset < count; offset++) {
    if (verified.has(start + offset)) bits[Math.floor(offset / 8)] |= 1 << (offset % 8)
  }
  return bits
}

function statusForError(err: unknown): number | null {
  if (errorCode(err) === ERRORS.FILE_EXISTS) return STATUS_CODE.FILE_EXISTS
  if (errorCode(err) === ERRORS.FILE_BUSY) return STATUS_CODE.FILE_BUSY
  if (
    errorCode(err) === ERRORS.INVALID_FILENAME ||
    errorCode(err) === ERRORS.STAGING_LIMIT ||
    errorCode(err) === ERRORS.DISK_RESERVE ||
    errorCode(err) === ERRORS.FILE_TOO_LARGE ||
    errorCode(err) === ERRORS.CLEANUP_FAILED
  ) {
    return STATUS_CODE.REJECTED
  }
  return null
}

interface SessionSnapshot {
  verified: Set<number>
  resumed: boolean
}

interface VerifiedSession {
  id: string
  transferId: Uint8Array
  ownerKey: Uint8Array
  name: string
  size: number
  digest: Uint8Array
  chunkSize: number
  state: string
}

export interface ServerSessionStore {
  sessions: Map<string, VerifiedSession>
  offer(ownerKey: Uint8Array, offer: Offer): Promise<SessionSnapshot>
  writeChunk(transferId: Uint8Array, chunk: Chunk): Promise<SessionSnapshot>
  finish(transferId: Uint8Array): Promise<unknown>
  retireCommitted(transferId: Uint8Array): Promise<unknown>
}

/**
 * Why an upload could not be admitted. A falsy reservation keeps the historical
 * active-upload rejection; `FILE_BUSY` reports that another live transfer
 * already holds the destination name.
 */
export interface UploadRejection {
  rejected: true
  reason: typeof ERRORS.ACTIVE_UPLOAD_LIMIT | typeof ERRORS.FILE_BUSY
}

function isUploadRejection(value: unknown): value is UploadRejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rejected' in value &&
    value.rejected === true &&
    'reason' in value &&
    (value.reason === ERRORS.ACTIVE_UPLOAD_LIMIT || value.reason === ERRORS.FILE_BUSY)
  )
}

function replacementFrom(result: unknown): ReplacementDetails | null {
  if (typeof result !== 'object' || result === null || !('replaces' in result)) return null
  const replaces = result.replaces
  if (typeof replaces !== 'object' || replaces === null) return null
  if (!('name' in replaces) || !('transferId' in replaces) || !('historyName' in replaces)) {
    return null
  }
  const { name, transferId: superseded, historyName } = replaces
  if (
    typeof name !== 'string' ||
    typeof superseded !== 'string' ||
    typeof historyName !== 'string'
  ) {
    return null
  }
  return { name, transferId: superseded, historyName }
}

export interface CommitStore {
  inspect(
    name: string,
    offer: Offer,
    options?: { replaceNames?: Iterable<string> }
  ): Promise<
    | { status: 'AVAILABLE' }
    | { status: 'REPLACEABLE' }
    | { status: 'ALREADY_COMMITTED' }
    | { status: 'FILE_EXISTS' }
    | { status: 'FILE_BUSY' }
  >
  commit(
    session: VerifiedSession,
    options: {
      retentionManager: StorageRetentionManager | null
      signal: { aborted: boolean }
      replaceNames?: Iterable<string>
    }
  ): Promise<unknown>
}

export type RetentionManager = StorageRetentionManager

export interface ServerSessionOptions {
  channel: ProtocolChannel
  ownerKey: Uint8Array
  sessionStore: ServerSessionStore
  commitStore: CommitStore
  retentionManager?: RetentionManager | null
  maxFileBytes: number
  /** Names this server may replace; validated and copied on construction. */
  replaceNames?: Iterable<string>
  reserveUpload?: (transferId: Uint8Array, name: string) => unknown
  releaseUpload?: (reservation: unknown) => void
  isAuthorized?: () => boolean
  idleTimeout?: number
  scheduler?: SessionScheduler
  destroy: (error: unknown) => void
  onTerminal?: (session: ServerSession) => void
  onProgress?: (session: ServerSession) => void
  onEvent?: (payload: Record<string, unknown>) => void
}

interface DrainWaiter {
  resolve(value: boolean): void
  timer: unknown
}

export class ServerSession {
  channel: ProtocolChannel
  ownerKey: Buffer
  sessionStore: ServerSessionStore
  commitStore: CommitStore
  retentionManager: RetentionManager | null
  maxFileBytes: number
  replaceNames: Set<string>
  reserveUpload: (transferId: Uint8Array, name: string) => unknown
  releaseUpload: (reservation: unknown) => void
  isAuthorized: () => boolean
  idleTimeout: number
  scheduler: SessionScheduler
  destroy: (error: unknown) => void
  onTerminal: (session: ServerSession) => void
  onProgress: (session: ServerSession) => void
  onEvent: (payload: Record<string, unknown>) => void
  state: string
  transferId: Buffer | null
  offerValue: Offer | null
  bytesReceived: number
  reservation: unknown | null
  pending: Promise<void>
  handlerFailures: unknown[]
  queuedChunks: number
  timer: unknown | null
  timerGeneration: number
  terminalNotified: boolean
  revoked: boolean
  abortSignal: { aborted: boolean }
  drainWaiters: DrainWaiter[]
  messages: ProtocolMessage[]

  constructor({
    channel,
    ownerKey,
    sessionStore,
    commitStore,
    retentionManager = null,
    maxFileBytes,
    replaceNames,
    reserveUpload = () => true,
    releaseUpload = () => {},
    isAuthorized = () => true,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    scheduler = { setTimeout, clearTimeout },
    destroy,
    onTerminal = () => {},
    onProgress = () => {},
    onEvent = () => {}
  }: ServerSessionOptions) {
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
    if (typeof onProgress !== 'function') throw protocolError('Invalid progress callback')
    if (typeof onEvent !== 'function') throw protocolError('Invalid session event callback')

    this.channel = channel
    this.ownerKey = b4a.from(ownerKey)
    this.sessionStore = sessionStore
    this.commitStore = commitStore
    this.retentionManager = retentionManager
    this.maxFileBytes = maxFileBytes
    this.replaceNames = validateReplaceNames(replaceNames)
    this.reserveUpload = reserveUpload
    this.releaseUpload = releaseUpload
    this.isAuthorized = isAuthorized
    this.idleTimeout = idleTimeout
    this.scheduler = scheduler
    this.destroy = destroy
    this.onTerminal = onTerminal
    this.onProgress = onProgress
    this.onEvent = onEvent
    this.state = 'INITIAL'
    this.transferId = null
    this.offerValue = null
    this.bytesReceived = 0
    this.reservation = null
    this.pending = Promise.resolve()
    this.handlerFailures = []
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
        onmessage: (value: Offer) => this._receiveOffer(value)
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
        onmessage: (value: Chunk) => this._receiveChunk(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(chunkAck, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      }),
      channel.addMessage({
        encoding: boundedEncoding(finish, MAX_CONTROL_BYTES),
        onmessage: (value: TransferMessage) => this._receiveFinish(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(result, MAX_CONTROL_BYTES),
        onmessage: () => this._invalidInboundMessage()
      })
    ]
    const receive = channel._recv
    channel._recv = (type: number, state: EncodingState) => {
      if (type >= this.messages.length) {
        return this._failClosed(protocolError('Unknown protocol message'))
      }
      return receive.call(channel, type, state)
    }
    channel.ondrain = () => this._resolveDrain()
    channel.open()
    this._touch()
  }

  _emit(type: string, details: Record<string, unknown> = {}): void {
    const payload: Record<string, unknown> = { type, ...details }
    if (this.transferId) {
      payload.transfer = b4a
        .toString(crypto.createHash('sha256').update(this.transferId).digest(), 'hex')
        .slice(0, FINGERPRINT_LENGTH)
    }
    if (this.offerValue) {
      payload.name = this.offerValue.name
      payload.size = this.offerValue.size
    }
    try {
      this.onEvent(payload)
    } catch {}
  }

  _receivedBytes(verified: Set<number>): number {
    let bytes = 0
    const offerValue = this._offerValue()
    for (const index of verified) {
      bytes += Math.min(offerValue.chunkSize, offerValue.size - index * offerValue.chunkSize)
    }
    return bytes
  }

  _queue(operation: () => void | Promise<void>): Promise<void> {
    const queued = this.pending.then(operation, operation)
    this.pending = queued.catch((err: unknown) => {
      this.handlerFailures.push(err)
    })
    return queued
  }

  _touch(): void {
    if (this.state === 'TERMINAL') return
    try {
      this.onProgress(this)
    } catch {}
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
    if (
      typeof this.timer === 'object' &&
      this.timer !== null &&
      'unref' in this.timer &&
      typeof this.timer.unref === 'function'
    ) {
      this.timer.unref()
    }
  }

  _clearTimer(): void {
    this.timerGeneration++
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  _resolveDrain(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.resolve(true)
    }
  }

  _waitForDrain(): Promise<boolean | void> {
    if (this.channel.drained) return Promise.resolve()
    return new Promise<boolean>((resolve) => {
      const waiter: DrainWaiter = {
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

  async _send(
    index: number,
    value: unknown,
    { drain = false }: { drain?: boolean } = {}
  ): Promise<void> {
    if (!this._canContinue()) {
      throw new SwarmDeployError(ERRORS.REVOKED, 'Upload access was revoked')
    }
    const message = this.messages[index]
    if (!message) throw protocolError('Unable to send protocol response')
    if (message.send(value) === false) {
      const drained = this._waitForDrain()
      if (!drain) return
      const completed = await drained
      if (!this._canContinue()) {
        throw new SwarmDeployError(ERRORS.REVOKED, 'Upload access was revoked')
      }
      if (!completed) throw protocolError('Upload response drain timed out')
    }
  }

  _releaseReservation(): void {
    if (this.reservation === null) return
    const reservation = this.reservation
    this.reservation = null
    try {
      this.releaseUpload(reservation)
    } catch {}
  }

  _notifyTerminal(): void {
    if (this.terminalNotified) return
    this.terminalNotified = true
    try {
      this.onTerminal(this)
    } catch {}
  }

  _recordFailure(error: unknown): void {
    if (!isBenignRevocation(error)) this.handlerFailures.push(error)
  }

  _closeChannel(): void {
    try {
      this.channel.close()
    } catch {}
  }

  _terminal(): Promise<void> {
    try {
      if (this.state === 'TERMINAL') return Promise.resolve()
      this.state = 'TERMINAL'
      this._clearTimer()
      this._releaseReservation()
      this._notifyTerminal()
      this._resolveDrain()
      this._closeChannel()
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  _failClosed(error: unknown): Promise<void> {
    try {
      if (this.state === 'TERMINAL') {
        this._recordFailure(error)
        return Promise.resolve()
      }
      this.state = 'TERMINAL'
      this._clearTimer()
      this._releaseReservation()
      this._notifyTerminal()
      this._resolveDrain()
      try {
        this.destroy(error)
      } catch {}
      return Promise.resolve()
    } catch (failure) {
      return Promise.reject(failure)
    }
  }

  _invalidInboundMessage(): Promise<void> {
    return this._failClosed(protocolError('Unexpected protocol message'))
  }

  _receiveOffer(value: Offer): Promise<void> {
    if (this.state !== 'INITIAL') return this._failClosed(protocolError('Unexpected offer'))
    this.state = 'OFFERING'
    return this._queue(() => this._handleOffer(value))
  }

  _receiveChunk(value: Chunk): Promise<void> {
    if (this.state !== 'READY') {
      return this._failClosed(protocolError('Chunk received before ready'))
    }
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

  _receiveFinish(value: TransferMessage): Promise<void> {
    if (this.state !== 'READY') {
      return this._failClosed(protocolError('Finish received before ready'))
    }
    this.state = 'FINISHING'
    return this._queue(() => this._handleFinish(value))
  }

  _assertTransfer(value: TransferMessage): void {
    if (!this.transferId || !b4a.equals(value.transferId, this.transferId)) {
      throw protocolError('Transfer ID does not match session')
    }
  }

  _transferId(): Buffer {
    if (this.transferId === null) throw protocolError('Transfer ID does not match session')
    return this.transferId
  }

  _offerValue(): Offer {
    if (this.offerValue === null) throw protocolError('Invalid offer')
    return this.offerValue
  }

  _canContinue(): boolean {
    if (this.revoked || this.state === 'TERMINAL' || !this.isAuthorized()) return false
    return true
  }

  async _sendBitmapPages(offerValue: Offer, verified: Set<number>): Promise<void> {
    for (let start = 0; start < offerValue.chunkCount; start += MAX_BITMAP_BITS) {
      const count = Math.min(MAX_BITMAP_BITS, offerValue.chunkCount - start)
      await this._send(BITMAP_PAGE, {
        transferId: this._transferId(),
        start,
        count,
        bits: bitmapBits(verified, start, count)
      })
    }
  }

  async _rejectOffer(code: number, reason: string): Promise<void> {
    this._emit('offer', {
      status: code === STATUS_CODE.ALREADY_COMMITTED ? 'already-committed' : 'rejected',
      reason
    })
    await this._send(STATUS, { transferId: this._transferId(), code, reason })
    await this._terminal()
  }

  async _handleOffer(value: Offer): Promise<void> {
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
      this.offerValue = value

      if (value.size > this.maxFileBytes) {
        await this._rejectOffer(STATUS_CODE.REJECTED, ERRORS.FILE_TOO_LARGE)
        return
      }

      const reservation = this.reserveUpload(this.transferId, value.name)
      if (isUploadRejection(reservation)) {
        await this._rejectOffer(
          reservation.reason === ERRORS.FILE_BUSY ? STATUS_CODE.FILE_BUSY : STATUS_CODE.REJECTED,
          reservation.reason
        )
        return
      }
      if (!reservation) {
        await this._rejectOffer(STATUS_CODE.REJECTED, ERRORS.ACTIVE_UPLOAD_LIMIT)
        return
      }
      this.reservation = reservation

      const inspection = await this.commitStore.inspect(value.name, value, {
        replaceNames: this.replaceNames
      })
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
      if (inspection.status !== 'AVAILABLE' && inspection.status !== 'REPLACEABLE') {
        throw protocolError('Invalid commit inspection status')
      }

      if (this.retentionManager && typeof this.retentionManager.admit === 'function') {
        await this.retentionManager.admit(value.size)
      }
      const snapshot = await this.sessionStore.offer(this.ownerKey, value)
      this.bytesReceived = this._receivedBytes(snapshot.verified)
      this._emit('offer', {
        status: snapshot.resumed ? 'resumed' : 'accepted',
        resumed: snapshot.resumed
      })
      await this._send(STATUS, { transferId: this.transferId, code: STATUS_CODE.ACCEPT })
      await this._sendBitmapPages(value, snapshot.verified)
      await this._send(READY, { transferId: this.transferId })
      this.state = 'READY'
      this._touch()
    } catch (err) {
      const code = statusForError(err)
      const reason = errorCode(err)
      if (code !== null && this.transferId && reason !== null) {
        try {
          await this._rejectOffer(code, reason)
          return
        } catch (sendError) {
          await this._failClosed(sendError)
          return
        }
      }
      await this._failClosed(err)
    }
  }

  async _handleChunk(value: Chunk): Promise<void> {
    try {
      if (!this._canContinue()) return
      this._assertTransfer(value)
      const snapshot = await this.sessionStore.writeChunk(this._transferId(), value)
      if (!this._canContinue()) return
      this.bytesReceived = this._receivedBytes(snapshot.verified)
      this._emit('progress', {
        chunkIndex: value.index,
        chunksReceived: snapshot.verified.size,
        totalChunks: this._offerValue().chunkCount,
        bytesReceived: this.bytesReceived,
        totalBytes: this._offerValue().size
      })
      await this._send(CHUNK_ACK, { transferId: this._transferId(), index: value.index })
      this._touch()
    } catch (err) {
      await this._failClosed(err)
    }
  }

  async _handleFinish(value: TransferMessage): Promise<void> {
    let committed = false
    let verificationStarted = false
    let commitStarted = false
    try {
      if (!this._canContinue()) return
      this._assertTransfer(value)
      verificationStarted = true
      this._emit('verification', { status: 'started' })
      await this.sessionStore.finish(this._transferId())
      this._emit('verification', { status: 'succeeded' })
      if (!this._canContinue()) return
      const session = this.sessionStore.sessions.get(b4a.toString(this._transferId(), 'hex'))
      if (!session || session.state !== 'verified') throw protocolError('Missing verified session')
      commitStarted = true
      this._emit('commit', { status: 'started' })
      const committedRecord = await this.commitStore.commit(session, {
        retentionManager: this.retentionManager,
        signal: this.abortSignal,
        replaceNames: this.replaceNames
      })
      committed = true
      const replaced = replacementFrom(committedRecord)
      this._emit('commit', {
        status: 'succeeded',
        ...(replaced ? { replaced } : {})
      })
      await this.sessionStore.retireCommitted(this._transferId())
      if (this.revoked) return
      await this._send(RESULT, { transferId: this._transferId(), code: RESULT_COMMITTED })
      await this._terminal()
    } catch (err) {
      const reason = errorCode(err) ?? ERRORS.COMMIT_FAILED
      if (commitStarted && !committed) this._emit('commit', { status: 'failed', reason })
      else if (verificationStarted) this._emit('verification', { status: 'failed', reason })
      if (committed) {
        await this._failClosed(err)
        return
      }
      if (this.transferId && this.state !== 'TERMINAL') {
        try {
          await this._send(RESULT, {
            transferId: this.transferId,
            code: RESULT_REJECTED,
            reason
          })
          await this._terminal()
          return
        } catch {}
      }
      await this._failClosed(err)
    }
  }

  async close(): Promise<void> {
    await this._terminal()
    await this.settle()
  }

  revoke(): void {
    if (this.state === 'TERMINAL') return
    this.revoked = true
    this.abortSignal.aborted = true
    this.state = 'TERMINAL'
    this._clearTimer()
    this._releaseReservation()
    this._notifyTerminal()
    this._resolveDrain()
    this._closeChannel()
    try {
      this.destroy(new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
    } catch {}
  }

  settle(): Promise<void> {
    return this.pending.then(() => {
      if (this.handlerFailures.length) {
        throw new AggregateError(this.handlerFailures, 'Server session handler cleanup failed')
      }
    })
  }
}
