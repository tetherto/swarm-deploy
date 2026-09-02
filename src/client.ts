import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import events from '#events'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import {
  abortError,
  createAbortController,
  onAbort,
  throwIfAborted,
  type AbortSignalLike
} from './abort.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { buildFileManifest, selectUploadPaths, type SkippedUploadReason } from './files.js'
import { keyPairFromSeed } from './identity.js'
import { ClientSession, UPLOAD_PROTOCOL } from './protocol/client-session.js'
import type { FileManifest, ProtocolChannel } from './protocol/types.js'
import { topicFromServerPublicKey } from './topic.js'
import type {
  AuthenticationEvent,
  Clock,
  Digest,
  FingerprintEvent,
  KeyPair,
  Logger,
  PublicKey,
  PublicKeyInput,
  Scheduler,
  SeedInput,
  Swarm,
  SwarmDiscovery,
  SwarmFactory,
  SwarmFactoryOptions,
  SwarmPeerInfo,
  SwarmSocket,
  Topic,
  TransferEvent,
  TransferId,
  TransferLifecycleEvent
} from './types.js'

const DEFAULT_CONNECT_TIMEOUT = 30_000
const MAX_CONNECT_TIMEOUT = 30_000
const DEFAULT_IDLE_TIMEOUT = 60_000
const MAX_IDLE_TIMEOUT = 0x7fffffff
const INITIAL_RECONNECT_DELAY = 25
const MAX_RECONNECT_DELAY = 1_000
const FINGERPRINT_LENGTH = 12
const EventEmitter = events.EventEmitter

export type ClientLogger = Logger
export type ClientClock = Clock
export type ClientSocket = SwarmSocket
export type ClientPeerInfo = SwarmPeerInfo
export type ClientDiscovery = SwarmDiscovery
export type ClientSwarm = Swarm
export type ClientSwarmOptions = SwarmFactoryOptions
export type ClientSwarmFactory = SwarmFactory

export interface ClientOptions {
  /** Required 32-byte persistent client seed. */
  seed: SeedInput
  /** Required, pinned 32-byte server public key. It must differ from the client public key. */
  serverPublicKey: PublicKeyInput
  /** Discovery/reconnect window in milliseconds; defaults to 30,000 and is at most 30,000. */
  connectTimeout?: number
  /** Per-upload idle timeout in milliseconds; defaults to 60,000. */
  idleTimeout?: number
  /** Optional HyperDHT instance passed to Hyperswarm. */
  dht?: unknown
  /** Optional timer adapter; defaults to global timers. */
  scheduler?: Scheduler
  /** Optional wall-clock adapter used for connection deadlines; defaults to Date. */
  clock?: Clock
  /** Optional Hyperswarm constructor seam; defaults to Hyperswarm. */
  swarmFactory?: SwarmFactory
  /** Optional diagnostic sink. Logger failures are ignored. */
  logger?: Logger | null
}

export type UploadStatus = 'COMMITTED' | 'ALREADY_COMMITTED'
export interface UploadResult {
  status: UploadStatus
  name: string
  size: number
  digest: Digest
  transferId: TransferId
}
export interface BatchUploadFailure {
  name: string
  status: ErrorCode
  reason?: string
}
export interface SkippedUploadEntry {
  name: string
  path: string
  reason: SkippedUploadReason
}
export interface BatchUploadResult {
  status: 'COMMITTED' | 'FAILED'
  results: Array<UploadResult | BatchUploadFailure>
  skipped: SkippedUploadEntry[]
}
export type ClientUploadResult = UploadResult | BatchUploadResult

export type { AuthenticationEvent, FingerprintEvent, TransferEvent, TransferLifecycleEvent }

export interface ClientSuccessEvent {
  name: string
  status: UploadStatus
  reason?: undefined
  final: boolean
}
export interface ClientFailureEvent {
  name: string
  status: ErrorCode
  reason?: string
  final: boolean
}
export interface ClientBatchResultEvent {
  status: 'COMMITTED' | 'FAILED'
  final: true
  files: number
  committed: number
  failed: number
  skipped: number
  reason?: undefined
}
export type ClientResultEvent = ClientSuccessEvent | ClientFailureEvent | ClientBatchResultEvent
/** Emitted for a skipped direct child during a directory upload. */
export interface ClientSkippedEvent {
  name: string
  reason: SkippedUploadReason
}
export interface ClientOfferEvent extends TransferEvent {
  status: 'offered' | 'accepted' | 'resumed' | 'rejected' | 'already-committed'
  resumedChunks?: number
  totalChunks?: number
  reason?: ErrorCode
}
export interface ClientProgressEvent extends TransferEvent {
  chunkIndex: number
  chunksSent: number
  totalChunks: number
  bytesSent: number
  totalBytes: number
}
export interface ClientCommitEvent extends TransferLifecycleEvent {
  result?: UploadStatus
}
export interface ClientCloseEvent {
  status: 'closed'
  reason?: undefined
}

export interface ClientEventMap {
  authentication: AuthenticationEvent
  connection: FingerprintEvent
  'connection-open': FingerprintEvent
  'connection-close': FingerprintEvent
  'rejected-peer': FingerprintEvent
  offer: ClientOfferEvent
  progress: ClientProgressEvent
  verification: TransferLifecycleEvent
  commit: ClientCommitEvent
  result: ClientResultEvent
  skipped: ClientSkippedEvent
  close: ClientCloseEvent
}
export type ClientEventName = keyof ClientEventMap
/** A payload emitted by any Client event. Use ClientEventMap for event-name narrowing. */
export type ClientEvent = ClientEventMap[ClientEventName]

export type SafeLogger = Required<Logger>

interface SocketWaiter {
  resolve(socket: ClientSocket): void
  reject(error: unknown): void
  timer: unknown
}

interface DelayWaiter {
  resolve(): void
  reject(error: unknown): void
  timer: unknown
}

function configurationError(
  code: ErrorCode,
  message: string,
  cause: unknown | null = null
): SwarmDeployError {
  return new SwarmDeployError(code, message, cause)
}

function assertSeed(seed: unknown): asserts seed is Uint8Array {
  if (!b4a.isBuffer(seed) || seed.byteLength !== 32) {
    throw configurationError(ERRORS.INVALID_SEED, 'Invalid client seed')
  }
}

function assertPublicKey(key: unknown): asserts key is Uint8Array {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) {
    throw configurationError(ERRORS.INVALID_PUBLIC_KEY, 'Invalid server public key')
  }
}

function assertDuration(value: unknown, name: string, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

export function fingerprint(key: unknown): string {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) return 'invalid'
  return b4a.toString(crypto.createHash('sha256').update(key).digest()).slice(0, FINGERPRINT_LENGTH)
}

export function createSafeLogger(logger: ClientLogger | null | undefined): SafeLogger {
  return {
    info(message, details) {
      if (!logger || typeof logger.info !== 'function') return
      try {
        logger.info(message, details)
      } catch {}
    },
    warn(message, details) {
      if (!logger || typeof logger.warn !== 'function') return
      try {
        logger.warn(message, details)
      } catch {}
    },
    error(message, details) {
      if (!logger || typeof logger.error !== 'function') return
      try {
        logger.error(message, details)
      } catch {}
    }
  }
}

function isTransportError(error: unknown): error is SwarmDeployError {
  return error instanceof SwarmDeployError && error.transport === true
}

function clientClosedError(): SwarmDeployError {
  return configurationError(ERRORS.PROTOCOL_INVALID, 'Client is closed')
}

function awaitAbortable<T>(promise: PromiseLike<T>, signal: AbortSignalLike | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const removeAbort = onAbort(signal, () => reject(abortError()))
    Promise.resolve(promise).then(
      (value) => {
        removeAbort()
        resolve(value)
      },
      (err) => {
        removeAbort()
        reject(err)
      }
    )
  })
}

function isProtocolChannel(value: unknown): value is ProtocolChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'open' in value &&
    typeof value.open === 'function' &&
    'close' in value &&
    typeof value.close === 'function' &&
    'addMessage' in value &&
    typeof value.addMessage === 'function'
  )
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function isErrorCode(value: string): value is ErrorCode {
  return Object.values(ERRORS).some((code) => code === value)
}

export interface Client {
  on<EventName extends ClientEventName>(
    event: EventName,
    listener: (event: ClientEventMap[EventName]) => void
  ): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this
  once<EventName extends ClientEventName>(
    event: EventName,
    listener: (event: ClientEventMap[EventName]) => void
  ): this
  once(event: string | symbol, listener: (...args: unknown[]) => void): this
}

export class Client extends EventEmitter {
  private readonly _keyPair: KeyPair
  readonly publicKey: PublicKey
  readonly serverPublicKey: PublicKey
  readonly topic: Topic
  readonly connectTimeout: number
  readonly idleTimeout: number
  readonly dht: unknown
  readonly scheduler: Scheduler
  readonly clock: Clock
  readonly swarmFactory: SwarmFactory
  readonly logger: Required<Logger>
  closed: boolean
  private swarm: Swarm | null
  private discovery: SwarmDiscovery | null
  private socket: SwarmSocket | null
  private sockets: Set<SwarmSocket>
  private sessions: Set<ClientSession>
  private socketWaiters: SocketWaiter[]
  private delayWaiters: DelayWaiter[]
  private closePromise: Promise<void> | null
  private disposePromise: Promise<void> | null
  private abortDisposals: Promise<void>[]
  private abortErrors: unknown[]
  private startPromise: Promise<this> | null
  private uploadQueue: Promise<void>
  private readonly abortController: ReturnType<typeof createAbortController>
  private readonly signal: AbortSignalLike

  constructor(options: ClientOptions) {
    super()
    if (!options || typeof options !== 'object') {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid client options')
    }
    assertSeed(options.seed)
    assertPublicKey(options.serverPublicKey)
    const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    assertDuration(connectTimeout, 'connect timeout', MAX_CONNECT_TIMEOUT)
    assertDuration(idleTimeout, 'idle timeout', MAX_IDLE_TIMEOUT)
    if (options.swarmFactory !== undefined && typeof options.swarmFactory !== 'function') {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm factory')
    }
    if (
      options.scheduler &&
      (typeof options.scheduler.setTimeout !== 'function' ||
        typeof options.scheduler.clearTimeout !== 'function')
    ) {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid client scheduler')
    }

    this._keyPair = keyPairFromSeed(b4a.from(options.seed))
    this.publicKey = b4a.from(this._keyPair.publicKey)
    this.serverPublicKey = b4a.from(options.serverPublicKey)
    if (crypto.timingSafeEqual(this.publicKey, this.serverPublicKey)) {
      throw configurationError(
        ERRORS.SERVER_KEY_MISMATCH,
        'Client and pinned server identities must be different'
      )
    }
    this.topic = topicFromServerPublicKey(this.serverPublicKey)
    this.connectTimeout = connectTimeout
    this.idleTimeout = idleTimeout
    this.dht = options.dht
    this.scheduler = options.scheduler || { setTimeout, clearTimeout }
    this.clock = options.clock || { now: () => Date.now() }
    this.swarmFactory = options.swarmFactory || ((opts: ClientSwarmOptions) => new Hyperswarm(opts))
    this.logger = createSafeLogger(options.logger)
    this.swarm = null
    this.discovery = null
    this.socket = null
    this.sockets = new Set()
    this.sessions = new Set()
    this.socketWaiters = []
    this.delayWaiters = []
    this.closed = false
    this.closePromise = null
    this.disposePromise = null
    this.abortDisposals = []
    this.abortErrors = []
    this.startPromise = null
    this.uploadQueue = Promise.resolve()
    this.abortController = createAbortController()
    this.signal = this.abortController.signal
  }

  private _emitSafe(event: string, details: Record<string, unknown>): void {
    try {
      this.emit(event, details)
    } catch {}
  }

  private async _start(): Promise<this> {
    try {
      this.swarm = this.swarmFactory({
        keyPair: this._keyPair,
        dht: this.dht,
        maxPeers: 4,
        maxClientConnections: 4,
        maxServerConnections: 0
      })
      if (
        !this.swarm ||
        typeof this.swarm.on !== 'function' ||
        typeof this.swarm.join !== 'function' ||
        typeof this.swarm.destroy !== 'function'
      ) {
        throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm')
      }
      this.swarm.on('connection', (socket, peerInfo) => this._onConnection(socket, peerInfo))
      this.discovery = this.swarm.join(this.topic, { server: false, client: true })
      if (!this.discovery || typeof this.discovery.flushed !== 'function') {
        throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm discovery')
      }
      await awaitAbortable(this.discovery.flushed(), this.signal)
      throwIfAborted(this.signal)
      return this
    } catch (err) {
      await this._dispose()
      throw err
    }
  }

  private _ensureStarted(): Promise<this> {
    if (this.closed) return Promise.reject(clientClosedError())
    if (!this.startPromise) this.startPromise = this._start()
    return this.startPromise
  }

  private _resolveSocketWaiters(socket: SwarmSocket): void {
    const waiters = this.socketWaiters
    this.socketWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.resolve(socket)
    }
  }

  private _rejectSocketWaiters(error: unknown): void {
    const waiters = this.socketWaiters
    this.socketWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private _onConnection(socket: SwarmSocket, peerInfo: SwarmPeerInfo | null = null): void {
    if (socket && typeof socket.on === 'function') socket.on('error', () => {})
    const peerKey = peerInfo?.publicKey || socket?.remotePublicKey
    if (
      this.closed ||
      !b4a.isBuffer(peerKey) ||
      peerKey.byteLength !== 32 ||
      !crypto.timingSafeEqual(peerKey, this.serverPublicKey)
    ) {
      try {
        socket.destroy(
          configurationError(ERRORS.SERVER_KEY_MISMATCH, 'Peer did not match pinned server key')
        )
      } catch {}
      const details = {
        status: 'rejected',
        fingerprint: fingerprint(peerKey),
        reason: ERRORS.SERVER_KEY_MISMATCH
      }
      this.logger.warn('Rejected unpinned server connection', details)
      this._emitSafe('authentication', details)
      this._emitSafe('rejected-peer', { fingerprint: details.fingerprint })
      return
    }

    if (this.socket && this.socket !== socket && !this.socket.destroyed) {
      try {
        this.socket.destroy()
      } catch {}
    }
    this.socket = socket
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      if (this.socket === socket) this.socket = null
      this._emitSafe('connection-close', { fingerprint: fingerprint(peerKey) })
    })
    const details = { fingerprint: fingerprint(peerKey) }
    this._emitSafe('authentication', { status: 'accepted', fingerprint: details.fingerprint })
    this.logger.info('Pinned server connected', details)
    this._emitSafe('connection', details)
    this._emitSafe('connection-open', details)
    this._resolveSocketWaiters(socket)
  }

  private _waitForSocket(deadline: number): Promise<SwarmSocket> {
    if (this.closed || this.signal.aborted) return Promise.reject(abortError())
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    const remaining = deadline - this.clock.now()
    if (remaining <= 0) {
      return Promise.reject(
        new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Timed out waiting for pinned server')
      )
    }
    return new Promise((resolve, reject) => {
      let removeAbort = () => {}
      const finish = <T>(callback: (value: T) => void, value: T) => {
        removeAbort()
        this.scheduler.clearTimeout(waiter.timer)
        const index = this.socketWaiters.indexOf(waiter)
        if (index !== -1) this.socketWaiters.splice(index, 1)
        callback(value)
      }
      const waiter: SocketWaiter = {
        resolve: (socket: ClientSocket) => finish(resolve, socket),
        reject: (error: unknown) => finish(reject, error),
        timer: this.scheduler.setTimeout(() => {
          finish(
            reject,
            new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Timed out waiting for pinned server')
          )
        }, remaining)
      }
      this.socketWaiters.push(waiter)
      removeAbort = onAbort(this.signal, () => waiter.reject(abortError()))
    })
  }

  private _delay(timeout: number, signal: AbortSignalLike | null = this.signal): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let removeAbort = () => {}
      const settle = <T>(callback: (value: T) => void, value: T) => {
        removeAbort()
        this.scheduler.clearTimeout(waiter.timer)
        const index = this.delayWaiters.indexOf(waiter)
        if (index !== -1) this.delayWaiters.splice(index, 1)
        callback(value)
      }
      const waiter: DelayWaiter = {
        resolve: () => settle(resolve, true),
        reject: (error: unknown) => settle(reject, error),
        timer: this.scheduler.setTimeout(() => {
          waiter.resolve()
        }, timeout)
      }
      this.delayWaiters.push(waiter)
      removeAbort = onAbort(signal, () => waiter.reject(abortError()))
    })
  }

  private _rejectDelays(error: unknown): void {
    const waiters = this.delayWaiters
    this.delayWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private async _startSession(socket: SwarmSocket, manifest: FileManifest): Promise<UploadResult> {
    if (this.closed || socket !== this.socket || socket.destroyed) throw transportError()
    const mux = Protomux.from(socket)
    const channel = mux.createChannel({
      protocol: UPLOAD_PROTOCOL,
      id: crypto.randomBytes(16)
    })
    if (!isProtocolChannel(channel)) throw transportError()
    const session = new ClientSession({
      channel,
      clientPublicKey: this.publicKey,
      idleTimeout: this.idleTimeout,
      scheduler: this.scheduler,
      signal: this.signal,
      destroy: (error: unknown) => {
        try {
          socket.destroy(error)
        } catch {}
      },
      onEvent: (event) => {
        const type = event.type
        if (typeof type !== 'string') return
        const details = { ...event }
        delete details.type
        this._emitSafe(type, details)
      }
    })
    this.sessions.add(session)
    try {
      channel.open()
      return await session.upload(manifest)
    } finally {
      this.sessions.delete(session)
    }
  }

  private async _uploadManifest(manifest: FileManifest): Promise<UploadResult> {
    await this._ensureStarted()
    let deadline = this.clock.now() + this.connectTimeout
    let delay = INITIAL_RECONNECT_DELAY
    let lastTransportError = null

    while (!this.closed && !this.signal.aborted && this.clock.now() < deadline) {
      let socket = null
      try {
        socket = await this._waitForSocket(deadline)
        return await this._startSession(socket, manifest)
      } catch (err) {
        if (!isTransportError(err)) throw err
        lastTransportError = err
        if (socket && this.socket === socket) this.socket = null
        try {
          socket?.destroy()
        } catch {}
        deadline = this.clock.now() + this.connectTimeout
        const remaining = deadline - this.clock.now()
        if (remaining <= 0) break
        if (!(await this._delay(Math.min(delay, remaining)))) break
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY)
      }
    }

    if (this.closed || this.signal.aborted) throw abortError()
    throw (
      lastTransportError ||
      new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Reconnect window expired')
    )
  }

  private _reportResult(result: UploadResult, final = true): UploadResult {
    const details = { name: result.name, status: result.status, final }
    this.logger.info('Upload completed', details)
    this._emitSafe('result', details)
    return result
  }

  private async _upload(inputPath: string): Promise<ClientUploadResult> {
    throwIfAborted(this.signal)
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      throw configurationError(ERRORS.INVALID_FILENAME, 'Invalid upload path')
    }
    const rootStat = await fs.promises.lstat(inputPath)
    const selection = await selectUploadPaths(inputPath, { signal: this.signal })
    if (!rootStat.isDirectory()) {
      const manifest = await buildFileManifest(selection.paths[0], { signal: this.signal })
      return this._reportResult(await this._uploadManifest(manifest))
    }

    const results: Array<UploadResult | BatchUploadFailure> = []
    for (const skipped of selection.skipped) {
      const details = { name: skipped.name, reason: skipped.reason }
      this.logger.info('Skipped input entry', details)
      this._emitSafe('skipped', details)
    }
    for (const entry of selection.entries) {
      if (entry.kind === 'skipped') continue
      throwIfAborted(this.signal)
      const name = entry.name
      if (entry.kind === 'failed') {
        const failed = { name, status: ERRORS.PROTOCOL_INVALID, reason: entry.reason }
        results.push(failed)
        this.logger.warn('Input entry failed', failed)
        this._emitSafe('result', { ...failed, final: false })
        continue
      }
      try {
        const manifest = await buildFileManifest(entry.path, { signal: this.signal })
        results.push(this._reportResult(await this._uploadManifest(manifest), false))
      } catch (err) {
        if (this.signal.aborted || errorCode(err) === ERRORS.ABORTED) throw err
        const code = errorCode(err)
        const status: ErrorCode =
          code !== null && isErrorCode(code) ? code : ERRORS.PROTOCOL_INVALID
        const failed = { name, status }
        results.push(failed)
        this.logger.warn('Upload failed', failed)
        this._emitSafe('result', { ...failed, final: false })
      }
    }
    const failed = results.some(
      (entry) => entry.status !== 'COMMITTED' && entry.status !== 'ALREADY_COMMITTED'
    )
    const batch: BatchUploadResult = {
      status: failed ? 'FAILED' : 'COMMITTED',
      results,
      skipped: selection.skipped
    }
    const committed =
      results.length -
      results.filter(
        (entry) => entry.status !== 'COMMITTED' && entry.status !== 'ALREADY_COMMITTED'
      ).length
    this._emitSafe('result', {
      status: batch.status,
      final: true,
      files: results.length,
      committed,
      failed: results.length - committed,
      skipped: selection.skipped.length
    })
    return batch
  }

  upload(inputPath: string): Promise<UploadResult | BatchUploadResult> {
    if (this.closed || this.signal.aborted) return Promise.reject(abortError())
    const operation = this.uploadQueue.then(
      () => this._upload(inputPath),
      () => this._upload(inputPath)
    )
    const pending = operation.catch((err) => {
      this._emitSafe('result', {
        name: typeof inputPath === 'string' ? inputPath.split(/[\\/]/).pop() || 'upload' : 'upload',
        status: err instanceof SwarmDeployError ? err.code : ERRORS.PROTOCOL_INVALID,
        final: true
      })
      throw err
    })
    this.uploadQueue = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private _abortResources(): void {
    const error = abortError()
    this._rejectSocketWaiters(error)
    this._rejectDelays(error)
    for (const session of [...this.sessions]) {
      this.abortDisposals.push(
        Promise.resolve(session.close()).then(
          () => undefined,
          () => undefined
        )
      )
    }
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
    const discovery = this.discovery
    const swarm = this.swarm
    this.discovery = null
    this.swarm = null
    if (discovery && typeof discovery.destroy === 'function') {
      try {
        this.abortDisposals.push(Promise.resolve(discovery.destroy()))
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
    if (swarm) {
      try {
        this.abortDisposals.push(Promise.resolve(swarm.destroy()))
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
  }

  private _dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this._disposeResources()
    return this.disposePromise
  }

  private async _disposeResources(): Promise<void> {
    const errors = [...this.abortErrors]
    this._rejectSocketWaiters(clientClosedError())
    this._rejectDelays(clientClosedError())
    const disposalResults = await Promise.allSettled(this.abortDisposals)
    for (const disposal of disposalResults) {
      if (disposal.status === 'rejected') errors.push(disposal.reason)
    }
    for (const session of [...this.sessions]) {
      try {
        await session.close()
      } catch {}
    }
    this.sessions.clear()
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this.sockets.clear()
    this.socket = null
    if (this.swarm) {
      try {
        await this.swarm.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this.swarm = null
    this.discovery = null
    if (errors.length) throw new AggregateError(errors, 'Client cleanup failed')
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.abortController.abort()
    this._abortResources()
    this.closePromise = (async () => {
      await this.uploadQueue
      await this._dispose()
      this._emitSafe('close', { status: 'closed' })
    })()
    return this.closePromise
  }
}

function transportError(): SwarmDeployError {
  const error = new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Upload transport closed')
  error.transport = true
  return error
}

export {
  DEFAULT_CONNECT_TIMEOUT,
  MAX_CONNECT_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  MAX_IDLE_TIMEOUT,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY,
  FINGERPRINT_LENGTH
}
