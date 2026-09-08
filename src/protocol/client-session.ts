import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import { abortError, onAbort, throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { safeFileOpenFlags } from '../storage/layout.js'
import { transferId } from './transfer-id.js'
import { assertBoundedChunkSize, assertFixed32, assertSafeUint } from './validation.js'
import {
  OFFER,
  CHUNK,
  FINISH,
  STATUS_CODE,
  RESULT_CODE,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} from './constants.js'
import { bitmapPage, chunk, chunkAck, finish, offer, ready, result, status } from './codecs.js'
import type {
  BitmapPage,
  Chunk,
  ChunkAck,
  FileManifest,
  Offer,
  ProtocolChannel,
  ProtocolMessage,
  Codec,
  EncodingState,
  Result,
  SessionScheduler,
  Status,
  TransferMessage
} from './types.js'

export const UPLOAD_PROTOCOL = 'swarm-deploy/upload/1'
export const DEFAULT_IDLE_TIMEOUT = 60_000
export const MAX_IDLE_TIMEOUT = 0x7fffffff
export const DRAIN_TIMEOUT = 5_000
export const MAX_IN_FLIGHT = 4
export const RESULT_COMMITTED = RESULT_CODE.COMMITTED
export const RESULT_REJECTED = RESULT_CODE.REJECTED
const FINGERPRINT_LENGTH = 12

export interface ClientSessionResult {
  status: 'COMMITTED' | 'ALREADY_COMMITTED'
  name: string
  size: number
  digest: Buffer
  transferId: Buffer
}

function protocolError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function transportError(cause: unknown | null = null): SwarmDeployError {
  const error = protocolError('Upload transport closed', cause)
  error.transport = true
  return error
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

function expectedChunkLength(manifest: FileManifest, index: number): number {
  if (index < 0 || index >= manifest.chunkCount) throw protocolError('Chunk index out of range')
  const offset = index * manifest.chunkSize
  return Math.min(manifest.chunkSize, manifest.size - offset)
}

function assertStableStat(
  expected: NonNullable<FileManifest['stat']>,
  actual: fs.Stats | null
): void {
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

function knownErrorCode(value: unknown): value is string {
  return typeof value === 'string' && Object.values(ERRORS).some((code) => code === value)
}

function unrefTimer(timer: unknown): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref()
  }
}

function statusError(value: Status): SwarmDeployError {
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

export interface ClientSessionOptions {
  channel: ProtocolChannel
  clientPublicKey: Uint8Array
  idleTimeout?: number
  scheduler?: SessionScheduler
  readChunk?: ((manifest: FileManifest, index: number) => Uint8Array | Promise<Uint8Array>) | null
  openSource?: (filePath: string, flags: string | number) => Promise<fs.promises.FileHandle>
  destroy?: ((error: unknown) => void) | null
  signal?: AbortSignalLike | null
  onEvent?: (payload: Record<string, unknown>) => void
}

interface DrainWaiter {
  resolve(value: boolean): void
  timer: unknown
}

export class ClientSession {
  channel: ProtocolChannel
  clientPublicKey: Buffer
  idleTimeout: number
  scheduler: SessionScheduler
  readChunk: ((manifest: FileManifest, index: number) => Uint8Array | Promise<Uint8Array>) | null
  openSource: (filePath: string, flags: string | number) => Promise<fs.promises.FileHandle>
  signal: AbortSignalLike | null
  onEvent: (payload: Record<string, unknown>) => void
  removeAbort: () => void
  destroy: (error: unknown) => void
  state: string
  manifest: FileManifest | null
  transferId: Buffer | null
  inFlight: Set<number>
  verified: Set<number>
  missing: number[]
  nextMissing: number
  nextBitmapStart: number
  pumping: boolean
  pumpAgain: boolean
  timer: unknown | null
  timerGeneration: number
  drainWaiters: DrainWaiter[]
  file: fs.promises.FileHandle | null
  result: Promise<ClientSessionResult> | null
  resolve: (value: ClientSessionResult) => void
  reject: (reason: unknown) => void
  messages: ProtocolMessage[]

  constructor({
    channel,
    clientPublicKey,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    scheduler = { setTimeout, clearTimeout },
    readChunk = null,
    openSource = (filePath, flags) => fs.promises.open(filePath, flags),
    destroy = null,
    signal = null,
    onEvent = () => {}
  }: ClientSessionOptions) {
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
    if (readChunk !== null && typeof readChunk !== 'function') {
      throw protocolError('Invalid chunk reader')
    }
    if (typeof openSource !== 'function') throw protocolError('Invalid source opener')
    if (destroy !== null && typeof destroy !== 'function') {
      throw protocolError('Invalid connection destroyer')
    }
    if (typeof onEvent !== 'function') throw protocolError('Invalid session event callback')

    this.channel = channel
    this.clientPublicKey = b4a.from(clientPublicKey)
    this.idleTimeout = idleTimeout
    this.scheduler = scheduler
    this.readChunk = readChunk
    this.openSource = openSource
    this.signal = signal
    this.onEvent = onEvent
    this.removeAbort = () => {}
    this.destroy =
      destroy ||
      ((error: unknown) => {
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
    this.resolve = () => {}
    this.reject = () => {}

    this.messages = [
      channel.addMessage({
        encoding: boundedEncoding(offer, MAX_CONTROL_BYTES),
        onmessage: () => this._fail(protocolError('Unexpected protocol message'))
      }),
      channel.addMessage({
        encoding: boundedEncoding(status, MAX_CONTROL_BYTES),
        onmessage: (value: Status) => this._receiveStatus(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(bitmapPage, MAX_CONTROL_BYTES),
        onmessage: (value: BitmapPage) => this._receiveBitmapPage(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(ready, MAX_CONTROL_BYTES),
        onmessage: (value: TransferMessage) => this._receiveReady(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(chunk, MAX_CHUNK_FRAME_BYTES),
        onmessage: () => this._fail(protocolError('Unexpected protocol message'))
      }),
      channel.addMessage({
        encoding: boundedEncoding(chunkAck, MAX_CONTROL_BYTES),
        onmessage: (value: ChunkAck) => this._receiveChunkAck(value)
      }),
      channel.addMessage({
        encoding: boundedEncoding(finish, MAX_CONTROL_BYTES),
        onmessage: () => this._fail(protocolError('Unexpected protocol message'))
      }),
      channel.addMessage({
        encoding: boundedEncoding(result, MAX_CONTROL_BYTES),
        onmessage: (value: Result) => this._receiveResult(value)
      })
    ]

    const receive = channel._recv
    channel._recv = (type: number, state: EncodingState) => {
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
    channel.onclose = (isRemote: boolean) => {
      try {
        previousClose.call(channel, isRemote)
      } finally {
        if (this.state !== 'TERMINAL') this._fail(transportError())
      }
    }
  }

  _emit(type: string, details: Record<string, unknown> = {}): void {
    const payload: Record<string, unknown> = { type, ...details }
    if (this.transferId) {
      payload.transfer = b4a
        .toString(crypto.createHash('sha256').update(this.transferId).digest(), 'hex')
        .slice(0, FINGERPRINT_LENGTH)
    }
    if (this.manifest) {
      payload.name = this.manifest.name
      payload.size = this.manifest.size
    }
    try {
      this.onEvent(payload)
    } catch {}
  }

  _verifiedBytes(): number {
    let bytes = 0
    const manifest = this._manifest()
    for (const index of this.verified) {
      bytes += expectedChunkLength(manifest, index)
    }
    return bytes
  }

  _validateManifest(manifest: FileManifest): void {
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
    unrefTimer(this.timer)
  }

  _clearTimer() {
    this.timerGeneration++
    if (this.timer) this.scheduler.clearTimeout(this.timer)
    this.timer = null
  }

  _waitForDrain(): Promise<boolean> {
    if (this.channel.drained) return Promise.resolve(true)
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

  _resolveDrain(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.resolve(true)
    }
  }

  _manifest(): FileManifest {
    if (this.manifest === null) throw protocolError('Invalid file manifest')
    return this.manifest
  }

  _sourceManifest(): FileManifest & { stat: NonNullable<FileManifest['stat']> } {
    const manifest = this._manifest()
    if (!manifest.stat) throw protocolError('Invalid manifest file snapshot')
    return { ...manifest, stat: manifest.stat }
  }

  _transferId(): Buffer {
    if (this.transferId === null) throw protocolError('Transfer ID does not match session')
    return this.transferId
  }

  _assertTransfer(value: TransferMessage): void {
    if (!this.transferId || !b4a.equals(value.transferId, this.transferId)) {
      throw protocolError('Transfer ID does not match session')
    }
  }

  async _send(index: number, value: unknown): Promise<boolean> {
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

  async _openSource(): Promise<void> {
    if (this.readChunk !== null || this.file) return
    let handle = null
    try {
      const manifest = this._sourceManifest()
      const before = await fs.promises.lstat(manifest.path)
      assertStableStat(manifest.stat, before)
      handle = await this.openSource(manifest.path, safeFileOpenFlags('read'))
      assertStableStat(manifest.stat, await handle.stat())
      this.file = handle
    } catch (err) {
      if (handle) await handle.close().catch(() => {})
      if (err instanceof SwarmDeployError) throw err
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to safely read source file', err)
    }
  }

  async _assertSourceStable(): Promise<void> {
    if (this.readChunk !== null) return
    try {
      const manifest = this._sourceManifest()
      const pathStat = await fs.promises.lstat(manifest.path)
      assertStableStat(manifest.stat, pathStat)
      if (this.file) assertStableStat(manifest.stat, await this.file.stat())
    } catch (err) {
      if (err instanceof SwarmDeployError) throw err
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to verify source file stability', err)
    }
  }

  async _closeSource(): Promise<void> {
    const handle = this.file
    this.file = null
    if (handle) await handle.close()
  }

  async _readChunk(index: number): Promise<Chunk> {
    throwIfAborted(this.signal)
    const manifest = this._manifest()
    const expectedLength = expectedChunkLength(manifest, index)
    let data
    if (this.readChunk !== null) {
      data = b4a.from(await this.readChunk(manifest, index))
    } else {
      await this._openSource()
      data = b4a.alloc(expectedLength)
      let offset = 0
      while (offset < data.byteLength) {
        throwIfAborted(this.signal)
        const file = this.file
        if (file === null) throw protocolError('Unable to safely read source file')
        const read = await file.read(
          data,
          offset,
          data.byteLength - offset,
          index * manifest.chunkSize + offset
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
    if (!b4a.equals(digest, manifest.chunkDigests[index])) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Source chunk changed after pre-hash')
    }
    return { transferId: this._transferId(), index, digest, data }
  }

  _result(status: 'COMMITTED' | 'ALREADY_COMMITTED'): ClientSessionResult {
    return {
      status,
      name: this._manifest().name,
      size: this._manifest().size,
      digest: b4a.from(this._manifest().digest),
      transferId: b4a.from(this._transferId())
    }
  }

  async _complete(status: 'COMMITTED' | 'ALREADY_COMMITTED'): Promise<void> {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this.removeAbort()
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

  _fail(error: unknown, fatal = true): void {
    if (this.state === 'TERMINAL') return
    this.state = 'TERMINAL'
    this._clearTimer()
    this.removeAbort()
    this._resolveDrain()
    Promise.resolve()
      .then(() => this._closeSource())
      .catch(() => {})
      .then(() => {
        if (fatal) {
          try {
            this.destroy(error)
          } catch {}
        }
        try {
          this.channel.close()
        } catch {}
        this.reject(error)
      })
  }

  _receiveStatus(value: Status): void | Promise<void> {
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
      if (value.code === STATUS_CODE.ALREADY_COMMITTED) {
        this._emit('offer', { status: 'already-committed' })
        this._emit('commit', { status: 'succeeded', result: 'ALREADY_COMMITTED' })
        return this._complete('ALREADY_COMMITTED')
      }
      this._emit('offer', {
        status: 'rejected',
        reason: knownErrorCode(value.reason) ? value.reason : ERRORS.PROTOCOL_INVALID
      })
      this._fail(statusError(value), false)
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveBitmapPage(value: BitmapPage): void {
    try {
      if (this.state !== 'WAITING_READY') throw protocolError('Unexpected bitmap page')
      this._assertTransfer(value)
      if (
        value.start !== this.nextBitmapStart ||
        value.count > this._manifest().chunkCount - value.start ||
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

  _receiveReady(value: TransferMessage): void {
    try {
      if (this.state !== 'WAITING_READY') throw protocolError('Unexpected ready')
      this._assertTransfer(value)
      if (this.nextBitmapStart !== this._manifest().chunkCount) {
        throw protocolError('Incomplete bitmap pages')
      }
      this.missing = []
      for (let index = 0; index < this._manifest().chunkCount; index++) {
        if (!this.verified.has(index)) this.missing.push(index)
      }
      this.nextMissing = 0
      this.state = 'READY'
      this._emit('offer', {
        status: this.verified.size > 0 ? 'resumed' : 'accepted',
        resumedChunks: this.verified.size,
        totalChunks: this._manifest().chunkCount
      })
      this._touch()
      this._pump()
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveChunkAck(value: ChunkAck): void {
    try {
      if (this.state !== 'READY') throw protocolError('Unexpected chunk acknowledgement')
      this._assertTransfer(value)
      if (!Number.isSafeInteger(value.index) || value.index >= this._manifest().chunkCount) {
        throw protocolError('Chunk acknowledgement index out of range')
      }
      if (!this.inFlight.delete(value.index)) throw protocolError('Duplicate chunk acknowledgement')
      this.verified.add(value.index)
      this._emit('progress', {
        chunkIndex: value.index,
        chunksSent: this.verified.size,
        totalChunks: this._manifest().chunkCount,
        bytesSent: this._verifiedBytes(),
        totalBytes: this._manifest().size
      })
      this._touch()
      this._pump()
    } catch (err) {
      this._fail(err)
    }
  }

  _receiveResult(value: Result): void | Promise<void> {
    try {
      if (this.state !== 'FINISHING') throw protocolError('Unexpected upload result')
      this._assertTransfer(value)
      this._touch()
      if (value.code === RESULT_COMMITTED) {
        this._emit('verification', { status: 'succeeded' })
        this._emit('commit', { status: 'succeeded', result: 'COMMITTED' })
        return this._complete('COMMITTED')
      }
      if (value.code === RESULT_REJECTED) {
        const reason = knownErrorCode(value.reason) ? value.reason : ERRORS.COMMIT_FAILED
        this._emit('verification', { status: 'failed', reason })
        this._emit('commit', { status: 'failed', reason })
        this._fail(
          new SwarmDeployError(
            knownErrorCode(value.reason) ? value.reason : ERRORS.COMMIT_FAILED,
            value.reason || 'Upload commit rejected'
          ),
          false
        )
        return
      }
      throw protocolError('Invalid upload result')
    } catch (err) {
      this._fail(err)
    }
  }

  async _pump(): Promise<void> {
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
          throwIfAborted(this.signal)
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
          this._emit('verification', { status: 'started' })
          this._emit('commit', { status: 'started' })
          await this._send(FINISH, { transferId: this._transferId() })
        }
      } while (this.pumpAgain && this.state === 'READY')
    } catch (err) {
      this._fail(err)
    } finally {
      this.pumping = false
      if (this.pumpAgain && this.state === 'READY') this._pump()
    }
  }

  upload(manifest: FileManifest): Promise<ClientSessionResult> {
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
    this.removeAbort = onAbort(this.signal, () => this._fail(abortError()))
    try {
      throwIfAborted(this.signal)
    } catch (err) {
      this._fail(err)
      return this.result
    }
    this.channel
      .fullyOpened()
      .then(async (opened) => {
        if (this.state !== 'OPENING') return
        if (!opened) throw transportError()
        this.state = 'WAITING_STATUS'
        this._emit('offer', { status: 'offered' })
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

  close(): Promise<ClientSessionResult | void> {
    if (this.state === 'TERMINAL') return Promise.resolve()
    this._fail(transportError())
    return this.result || Promise.resolve()
  }
}
