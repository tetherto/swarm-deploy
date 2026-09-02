import b4a from 'b4a'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import crypto from '#crypto'
import fs from '#fs'
import events from '#events'
import { SwarmDeployError, ERRORS, type ErrorCode } from './errors.js'
import {
  abortError,
  throwIfAborted,
  onAbort,
  createAbortController,
  type AbortSignalLike
} from './abort.js'
import { keyPairFromSeed } from './identity.js'
import { topicFromServerPublicKey } from './topic.js'
import { AllowlistWatcher } from './allowlist.js'
import { ServerSession, UPLOAD_PROTOCOL, DEFAULT_IDLE_TIMEOUT } from './protocol/server-session.js'
import type { ProtocolChannel } from './protocol/types.js'
import type {
  AuthenticationEvent,
  FingerprintEvent,
  KeyPair,
  Logger,
  PublicKey,
  PublicKeyInput,
  SeedInput,
  ServerScheduler,
  Swarm,
  SwarmDiscovery,
  SwarmFactory,
  SwarmFactoryOptions,
  SwarmPeerInfo,
  SwarmSocket,
  Topic,
  TransferEvent,
  TransferLifecycleEvent
} from './types.js'
import { initLayout, acquireStorageLock } from './storage/layout.js'
import { SessionStore } from './storage/session-store.js'
import { CommitStore } from './storage/commit-store.js'
import { prepareStorageRecovery, recoverStorage } from './storage/recovery.js'
import {
  RetentionManager,
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_RESUME_TTL,
  MAX_CLEANUP_INTERVAL
} from './storage/retention.js'
import type { StorageAdapter, StorageLayout } from './storage/types.js'

const EventEmitter = events.EventEmitter

const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_ACTIVE_UPLOADS = 8
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024
const MAX_CONNECTIONS = 1024
const MAX_ACTIVE_UPLOADS = 1024
const FINGERPRINT_LENGTH = 12

export type { AuthenticationEvent, FingerprintEvent, TransferEvent, TransferLifecycleEvent }

export type ServerLogger = Logger
export type ServerSocket = SwarmSocket
export type ServerPeerInfo = SwarmPeerInfo
export type ServerDiscovery = SwarmDiscovery
export type ServerSwarm = Swarm
export type ServerSwarmOptions = SwarmFactoryOptions
export type ServerSwarmFactory = SwarmFactory
export type { ServerScheduler }

/** A public key accepted in an allowlist: a 32-byte buffer or canonical lowercase hex. */
export type AllowlistKey = PublicKeyInput | string

export interface ServerOptions {
  /** Required 32-byte persistent server seed. */
  seed: SeedInput
  /** Trusted local directory in which final artifacts and internal state live. */
  storageDir: string
  /** Required uploader allowlist. Entries are 32-byte keys or canonical lowercase hex. */
  allowedKeys: Iterable<AllowlistKey>
  /** Required positive maximum uploaded artifact size, in bytes. */
  maxFileBytes: number
  /** Required positive aggregate resumable staging allocation, in bytes. */
  maxStagingBytes: number
  /** Maximum authenticated transport connections; defaults to 64 and is at most 1024. */
  maxConnections?: number
  /** Maximum active uploads; defaults to 8, is at most 1024, and cannot exceed maxConnections. */
  maxActiveUploads?: number
  /** Per-transport and upload idle timeout in milliseconds; defaults to 60,000. */
  idleTimeout?: number
  /** Retention cleanup interval in milliseconds; defaults to 900,000. */
  cleanupInterval?: number
  /** Partial-upload expiration in milliseconds; defaults to seven days. */
  resumeTtl?: number
  /** Bytes which must remain free before accepting a staged upload; defaults to 1 GiB. */
  minFreeBytes?: number
  /** Optional maximum age, in milliseconds, for committed managed artifacts. */
  maxAge?: number
  /** Optional aggregate committed managed-artifact limit, in bytes. */
  maxStorageBytes?: number
  /** Optional HyperDHT instance passed to Hyperswarm. */
  dht?: unknown
  /** Optional trusted filesystem adapter; defaults to fs.promises. */
  storage?: StorageAdapter
  /** Optional timer adapter; defaults to global timers. */
  scheduler?: ServerScheduler
  /** Optional Hyperswarm constructor seam; defaults to Hyperswarm. */
  swarmFactory?: SwarmFactory
  /** Optional allowlist text file to load at start and poll for revocations. */
  allowlistPath?: string
  /** Optional diagnostic sink. Logger failures are ignored. */
  logger?: Logger | null
  /** Names whose committed artifacts may be replaced by a subsequent upload. */
  replaceNames?: Iterable<string>
}

export interface ServerConnectionEvent extends FingerprintEvent {
  connections: number
}

export type ConnectionOpenEvent = ServerConnectionEvent
export type ConnectionCloseEvent = ServerConnectionEvent

export interface ServerListeningEvent {
  /** The server public-key fingerprint, despite this historical property name. */
  publicKey: string
}

export interface ServerOfferEvent extends TransferEvent, FingerprintEvent {
  status: 'accepted' | 'resumed' | 'rejected' | 'already-committed'
  resumed?: boolean
  reason?: string
}

export interface ServerProgressEvent extends TransferEvent, FingerprintEvent {
  chunkIndex: number
  chunksReceived: number
  totalChunks: number
  bytesReceived: number
  totalBytes: number
}

export type ServerTransferLifecycleEvent = TransferLifecycleEvent & FingerprintEvent

export interface RecoveryEvent {
  status:
    | 'started'
    | 'completed'
    | 'failed'
    | 'CORRUPT'
    | 'COMMITTED'
    | 'ABORTED'
    | 'RESUMABLE'
    | 'MISSING'
    | 'FILE_EXISTS'
  transfer?: string
  phase?: 'classification' | 'sessions' | 'journal'
  reason?: string
  journals?: number
  purgedSessions?: number
}

export interface ScrubEvent {
  status: 'started' | 'completed' | 'failed'
  reason?: string
  deleted?: number
  unknownCount?: number
}

export interface RetentionEvent {
  trigger: 'startup' | 'scheduled' | 'manual' | 'commit' | 'post-commit'
  status: 'completed' | 'deferred' | 'failed'
  reason?: string
  expiredSessions?: number
  scrubbed?: number
  ageDeleted?: number
  storageDeleted?: number
}

export interface CleanupEvent {
  transfer: string
  name: string | null
  reason:
    | 'delete'
    | 'revocation'
    | 'offline-revocation'
    | 'expiry'
    | 'checksum'
    | 'recovery'
    | 'corrupt-journal'
}

export interface AllowlistEvent {
  status: 'completed' | 'failed'
  appliedCount: number
  pendingCount: number
  reason?: string
}

export interface ServerCloseEvent {
  status: 'closed' | 'failed'
}

export interface ServerEventMap {
  authentication: AuthenticationEvent
  connection: ServerConnectionEvent
  'connection-open': ConnectionOpenEvent
  'connection-close': ConnectionCloseEvent
  offer: ServerOfferEvent
  progress: ServerProgressEvent
  verification: ServerTransferLifecycleEvent
  commit: ServerTransferLifecycleEvent
  recovery: RecoveryEvent
  scrub: ScrubEvent
  retention: RetentionEvent
  cleanup: CleanupEvent
  allowlist: AllowlistEvent
  revocation: FingerprintEvent
  revoked: FingerprintEvent
  listening: ServerListeningEvent
  close: ServerCloseEvent
}

export type ServerEventName = keyof ServerEventMap
export type ServerEvent = ServerEventMap[ServerEventName]

type SafeLogger = Required<Logger>

interface UploadReservation {
  id: string
}

interface Connection {
  owner: string
  ownerKey: Buffer
  sessions: Set<ServerSession>
  socket: ServerSocket
  transportTimer: unknown | null
  refreshTransport: () => void
}

interface PendingRevocation {
  transferIds: Set<string>
}

function configurationError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertPositiveSafeUint(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(`Invalid ${name}`)
  }
}

function assertOptionalSafeUint(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): void {
  if (value !== undefined) assertPositiveSafeUint(value, name, maximum)
}

function assertNonnegativeSafeUint(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw configurationError(`Invalid ${name}`)
  }
}

function assertSeed(seed: unknown): asserts seed is Uint8Array {
  if (!b4a.isBuffer(seed) || seed.byteLength !== 32) throw configurationError('Invalid seed')
}

function keyHex(key: Uint8Array): string {
  return b4a.toString(key, 'hex')
}

function assertPublicKey(key: unknown): asserts key is Uint8Array {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw configurationError('Invalid allowed key')
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  )
}

function normalizeAllowlist(keys: unknown): Set<string> {
  if (!isIterable(keys)) {
    throw configurationError('Invalid allowed keys')
  }
  const normalized = new Set<string>()
  for (const key of keys) {
    if (typeof key === 'string') {
      if (!/^[0-9a-f]{64}$/.test(key)) throw configurationError('Invalid allowed key')
      normalized.add(key)
      continue
    }
    assertPublicKey(key)
    normalized.add(keyHex(key))
  }
  return normalized
}

function fingerprint(key: unknown): string {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) return 'invalid'
  return keyHex(crypto.createHash('sha256').update(key).digest()).slice(0, FINGERPRINT_LENGTH)
}

function eventFailureReason(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('code' in err)) return ERRORS.PROTOCOL_INVALID
  return typeof err.code === 'string' && err.code.length > 0 ? err.code : ERRORS.PROTOCOL_INVALID
}

export function createSafeLogger(logger: ServerLogger | null | undefined): SafeLogger {
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

function awaitAbortable<T>(promise: PromiseLike<T>, signal: AbortSignalLike): Promise<T> {
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

export interface Server {
  on<EventName extends ServerEventName>(
    event: EventName,
    listener: (event: ServerEventMap[EventName]) => void
  ): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this
  once<EventName extends ServerEventName>(
    event: EventName,
    listener: (event: ServerEventMap[EventName]) => void
  ): this
  once(event: string | symbol, listener: (...args: unknown[]) => void): this
}

export class Server extends EventEmitter {
  private readonly _keyPair: KeyPair
  readonly publicKey: PublicKey
  readonly topic: Topic
  readonly storageDir: string
  readonly maxFileBytes: number
  readonly maxStagingBytes: number
  readonly maxConnections: number
  readonly maxActiveUploads: number
  readonly idleTimeout: number
  readonly cleanupInterval: number
  readonly resumeTtl: number
  readonly minFreeBytes: number
  readonly maxAge: number | undefined
  readonly maxStorageBytes: number | undefined
  readonly dht: unknown
  readonly storage: StorageAdapter
  readonly scheduler: ServerScheduler
  readonly swarmFactory: SwarmFactory
  readonly allowlistPath: string | undefined
  readonly logger: Required<Logger>
  listening: boolean
  closed: boolean
  private _allowlist: Set<string>
  private _connections: Map<SwarmSocket, Connection>
  private _sockets: Map<string, Set<SwarmSocket>>
  private _sessions: Set<ServerSession>
  private _activeUploads: Map<string, { references: number }>
  private layout: StorageLayout | null
  private sessionStore: SessionStore | null
  private commitStore: CommitStore | null
  private retentionManager: RetentionManager | null
  private allowlistWatcher: AllowlistWatcher | null
  private swarm: Swarm | null
  private discovery: SwarmDiscovery | null
  private releaseStorageLock: (() => Promise<void>) | null
  private listenPromise: Promise<this> | null
  private closePromise: Promise<void> | null
  private reloadPromise: Promise<unknown>
  private pendingRevocations: Map<string, PendingRevocation>
  private readonly abortController: ReturnType<typeof createAbortController>
  private readonly signal: AbortSignalLike
  private abortDisposals: Promise<void>[]
  private abortErrors: unknown[]
  private disposePromise: Promise<void> | null

  constructor(options: ServerOptions) {
    super()
    if (!options || typeof options !== 'object') throw configurationError('Invalid server options')
    assertSeed(options.seed)
    if (typeof options.storageDir !== 'string' || options.storageDir.length === 0) {
      throw configurationError('Invalid storageDir')
    }
    const allowlist = normalizeAllowlist(options.allowedKeys)
    assertPositiveSafeUint(options.maxFileBytes, 'maxFileBytes')
    assertPositiveSafeUint(options.maxStagingBytes, 'maxStagingBytes')

    const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    const maxActiveUploads = options.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    const cleanupInterval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL
    const resumeTtl = options.resumeTtl ?? DEFAULT_RESUME_TTL
    const minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES
    assertPositiveSafeUint(maxConnections, 'maxConnections', MAX_CONNECTIONS)
    assertPositiveSafeUint(maxActiveUploads, 'maxActiveUploads', MAX_ACTIVE_UPLOADS)
    assertPositiveSafeUint(idleTimeout, 'idleTimeout', MAX_CLEANUP_INTERVAL)
    assertPositiveSafeUint(cleanupInterval, 'cleanupInterval', MAX_CLEANUP_INTERVAL)
    assertPositiveSafeUint(resumeTtl, 'resumeTtl')
    assertNonnegativeSafeUint(minFreeBytes, 'minFreeBytes')
    assertOptionalSafeUint(options.maxAge, 'maxAge')
    assertOptionalSafeUint(options.maxStorageBytes, 'maxStorageBytes')
    if (maxActiveUploads > maxConnections) {
      throw configurationError('maxActiveUploads exceeds maxConnections')
    }
    if (
      options.scheduler &&
      (typeof options.scheduler.setTimeout !== 'function' ||
        typeof options.scheduler.clearTimeout !== 'function' ||
        typeof options.scheduler.setInterval !== 'function' ||
        typeof options.scheduler.clearInterval !== 'function')
    ) {
      throw configurationError('Invalid server scheduler')
    }
    if (
      options.storage &&
      (typeof options.storage.open !== 'function' ||
        typeof options.storage.lstat !== 'function' ||
        typeof options.storage.readdir !== 'function')
    ) {
      throw configurationError('Invalid storage adapter')
    }
    if (options.swarmFactory !== undefined && typeof options.swarmFactory !== 'function') {
      throw configurationError('Invalid swarm factory')
    }
    if (options.allowlistPath !== undefined && typeof options.allowlistPath !== 'string') {
      throw configurationError('Invalid allowlist path')
    }

    this._keyPair = keyPairFromSeed(b4a.from(options.seed))
    this.publicKey = b4a.from(this._keyPair.publicKey)
    this.topic = topicFromServerPublicKey(this.publicKey)
    this.storageDir = options.storageDir
    this.maxFileBytes = options.maxFileBytes
    this.maxStagingBytes = options.maxStagingBytes
    this.maxConnections = maxConnections
    this.maxActiveUploads = maxActiveUploads
    this.idleTimeout = idleTimeout
    this.cleanupInterval = cleanupInterval
    this.resumeTtl = resumeTtl
    this.minFreeBytes = minFreeBytes
    this.maxAge = options.maxAge
    this.maxStorageBytes = options.maxStorageBytes
    this.dht = options.dht
    this.storage = options.storage || fs.promises
    this.scheduler = options.scheduler || { setTimeout, clearTimeout, setInterval, clearInterval }
    this.swarmFactory = options.swarmFactory || ((opts: ServerSwarmOptions) => new Hyperswarm(opts))
    this.allowlistPath = options.allowlistPath
    this.logger = createSafeLogger(options.logger)
    this._allowlist = allowlist
    this._connections = new Map()
    this._sockets = new Map()
    this._sessions = new Set()
    this._activeUploads = new Map()
    this.layout = null
    this.sessionStore = null
    this.commitStore = null
    this.retentionManager = null
    this.allowlistWatcher = null
    this.swarm = null
    this.discovery = null
    this.releaseStorageLock = null
    this.listening = false
    this.closed = false
    this.listenPromise = null
    this.closePromise = null
    this.reloadPromise = Promise.resolve()
    this.pendingRevocations = new Map()
    this.abortController = createAbortController()
    this.signal = this.abortController.signal
    this.abortDisposals = []
    this.abortErrors = []
    this.disposePromise = null
  }

  get allowedKeys() {
    return new Set(this._allowlist)
  }

  private _isAllowed(key: unknown): key is Uint8Array {
    return b4a.isBuffer(key) && key.byteLength === 32 && this._allowlist.has(keyHex(key))
  }

  private _emitSafe(event: string, details: Record<string, unknown>): void {
    try {
      this.emit(event, details)
    } catch {}
  }

  private _assertStarting() {
    if (this.closed) throw abortError()
    throwIfAborted(this.signal)
  }

  private _firewall(key: unknown): boolean {
    const rejected = !this._isAllowed(key)
    if (rejected) {
      const details = {
        status: 'rejected',
        fingerprint: fingerprint(key),
        reason: ERRORS.AUTH_REJECTED
      }
      this.logger.warn('Rejected unauthorised connection', details)
      this._emitSafe('authentication', details)
    }
    return rejected
  }

  private _reserveUpload(transferId: Uint8Array): UploadReservation | null {
    const id = keyHex(transferId)
    if (this._activeUploads.has(id)) return null
    if (this._activeUploads.size >= this.maxActiveUploads) return null
    this._activeUploads.set(id, { references: 1 })
    return { id }
  }

  private _releaseUpload(reservation: unknown): void {
    if (
      typeof reservation !== 'object' ||
      reservation === null ||
      !('id' in reservation) ||
      typeof reservation.id !== 'string'
    ) {
      return
    }
    const active = this._activeUploads.get(reservation.id)
    if (!active) return
    active.references--
    if (active.references <= 0) this._activeUploads.delete(reservation.id)
  }

  private _isSessionActive(session: unknown): boolean {
    return (
      typeof session === 'object' &&
      session !== null &&
      'id' in session &&
      typeof session.id === 'string' &&
      this._activeUploads.has(session.id)
    )
  }

  private _destroySocket(socket: SwarmSocket, error?: unknown): void {
    try {
      socket.destroy(error)
    } catch {}
  }

  private _removeConnection(socket: SwarmSocket, connection: Connection): void {
    if (connection.transportTimer) this.scheduler.clearTimeout(connection.transportTimer)
    this._connections.delete(socket)
    const sockets = this._sockets.get(connection.owner)
    if (!sockets) return
    sockets.delete(socket)
    if (sockets.size === 0) this._sockets.delete(connection.owner)
  }

  private _onSessionTerminal(session: ServerSession, connection: Connection): void {
    connection.sessions.delete(session)
    this._sessions.delete(session)
  }

  private _onPair(
    mux: { createChannel(options: { protocol: string; id: Uint8Array }): unknown },
    socket: ServerSocket,
    connection: Connection,
    id: Uint8Array
  ): void {
    if (connection.sessions.size > 0 || !this._isAllowed(connection.ownerKey)) {
      this._destroySocket(socket, new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
      return
    }
    const candidate = mux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    if (!isProtocolChannel(candidate)) {
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid upload channel')
      )
      return
    }
    if (!this.sessionStore || !this.commitStore) {
      this._destroySocket(socket, new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Server not ready'))
      return
    }
    let session: ServerSession
    session = new ServerSession({
      channel: candidate,
      ownerKey: connection.ownerKey,
      sessionStore: this.sessionStore,
      commitStore: this.commitStore,
      retentionManager: this.retentionManager,
      maxFileBytes: this.maxFileBytes,
      reserveUpload: (transferId) => this._reserveUpload(transferId),
      releaseUpload: (reservation) => this._releaseUpload(reservation),
      isAuthorized: () => this._isAllowed(connection.ownerKey),
      idleTimeout: this.idleTimeout,
      scheduler: this.scheduler,
      destroy: (err) => this._destroySocket(socket, err),
      onTerminal: () => this._onSessionTerminal(session, connection),
      onProgress: () => connection.refreshTransport(),
      onEvent: (event: Record<string, unknown>) => {
        const { type, ...details } = event
        if (typeof type === 'string') {
          this._emitSafe(type, { fingerprint: fingerprint(connection.ownerKey), ...details })
        }
      }
    })
    connection.sessions.add(session)
    this._sessions.add(session)
  }

  private _onConnection(socket: SwarmSocket, peerInfo: SwarmPeerInfo | null = null): void {
    if (socket && typeof socket.on === 'function') socket.on('error', () => {})
    const ownerKey = socket?.remotePublicKey || peerInfo?.publicKey
    if (this.closed || !this._isAllowed(ownerKey)) {
      this._emitSafe('authentication', {
        status: 'rejected',
        fingerprint: fingerprint(ownerKey),
        reason: ERRORS.AUTH_REJECTED
      })
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.AUTH_REJECTED, 'Unauthorised uploader')
      )
      return
    }
    if (this._connections.size >= this.maxConnections) {
      this._emitSafe('authentication', {
        status: 'rejected',
        fingerprint: fingerprint(ownerKey),
        reason: ERRORS.FILE_BUSY
      })
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.FILE_BUSY, 'Connection capacity exceeded')
      )
      return
    }

    const owner = keyHex(ownerKey)
    const connection: Connection = {
      owner,
      ownerKey: b4a.from(ownerKey),
      sessions: new Set(),
      socket,
      transportTimer: null,
      refreshTransport: () => {}
    }
    connection.refreshTransport = () => {
      if (connection.transportTimer) this.scheduler.clearTimeout(connection.transportTimer)
      connection.transportTimer = this.scheduler.setTimeout(() => {
        this._destroySocket(
          socket,
          new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Transport idle timeout')
        )
      }, this.idleTimeout)
      if (
        typeof connection.transportTimer === 'object' &&
        connection.transportTimer !== null &&
        'unref' in connection.transportTimer &&
        typeof connection.transportTimer.unref === 'function'
      ) {
        connection.transportTimer.unref()
      }
    }
    connection.refreshTransport()
    this._connections.set(socket, connection)
    let sockets = this._sockets.get(owner)
    if (!sockets) this._sockets.set(owner, (sockets = new Set()))
    sockets.add(socket)
    socket.once('close', () => {
      this._removeConnection(socket, connection)
      for (const session of [...connection.sessions]) {
        session.close().catch(() => {})
      }
      this._emitSafe('connection-close', {
        fingerprint: fingerprint(connection.ownerKey),
        connections: this._connections.size
      })
    })

    const mux = Protomux.from(socket)
    mux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => this._onPair(mux, socket, connection, id))
    const details = { fingerprint: fingerprint(ownerKey), connections: this._connections.size }
    this._emitSafe('authentication', { status: 'accepted', fingerprint: details.fingerprint })
    this.logger.info('Authenticated uploader connected', details)
    this._emitSafe('connection', details)
    this._emitSafe('connection-open', details)
  }

  async reloadAllowlist(keys: Iterable<AllowlistKey>): Promise<Set<string>> {
    let next
    try {
      next = normalizeAllowlist(keys)
    } catch (err) {
      this._emitSafe('allowlist', {
        status: 'failed',
        appliedCount: this._allowlist.size,
        pendingCount: this.pendingRevocations.size,
        reason: eventFailureReason(err)
      })
      throw err
    }
    const run = this.reloadPromise.then(
      () => this._applyAllowlist(next),
      () => this._applyAllowlist(next)
    )
    this.reloadPromise = run.catch(() => {})
    return run
  }

  private async _applyAllowlist(next: Set<string>): Promise<Set<string>> {
    let swapped = false
    try {
      for (const key of this.pendingRevocations.keys()) {
        await this._revokeOwner(key)
      }
      const previous = this._allowlist
      const removed = []
      for (const key of previous) {
        if (!next.has(key)) removed.push(key)
      }
      this._allowlist = next
      swapped = true
      for (const key of removed) await this._revokeOwner(key)
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null) Object.assign(err, { allowlistApplied: swapped })
      this._emitSafe('allowlist', {
        status: 'failed',
        appliedCount: this._allowlist.size,
        pendingCount: this.pendingRevocations.size,
        reason: eventFailureReason(err)
      })
      throw err
    }
    this._emitSafe('allowlist', {
      status: 'completed',
      appliedCount: this._allowlist.size,
      pendingCount: this.pendingRevocations.size
    })
    return new Set(this._allowlist)
  }

  private async _revokeOwner(key: string): Promise<void> {
    let pending = this.pendingRevocations.get(key)
    if (!pending) {
      pending = { transferIds: new Set() }
      this.pendingRevocations.set(key, pending)
    }
    const sockets = this._sockets.get(key)
    const sessions = new Set<ServerSession>()
    const errors: unknown[] = []
    if (sockets) {
      for (const socket of [...sockets]) {
        const connection = this._connections.get(socket)
        if (connection) {
          for (const session of connection.sessions) {
            if (session.transferId) pending.transferIds.add(keyHex(session.transferId))
            try {
              session.revoke()
            } catch (err) {
              errors.push(err)
            }
            sessions.add(session)
          }
        }
        try {
          socket.destroy(new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
        } catch (err) {
          errors.push(err)
        }
      }
    }
    const settled = await Promise.allSettled([...sessions].map((session) => session.settle()))
    for (const result of settled) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    for (const id of pending.transferIds) {
      try {
        const commitStore = this.commitStore
        if (!commitStore) {
          throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Server storage is not ready')
        }
        await commitStore.retryAbortedAttempt(b4a.from(id, 'hex'), this.sessionStore)
      } catch (err) {
        errors.push(err)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    try {
      const sessionStore = this.sessionStore
      if (sessionStore) await sessionStore.deleteByOwner(b4a.from(key, 'hex'))
    } catch (err) {
      errors.push(err)
    }
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    this.pendingRevocations.delete(key)
    const details = { fingerprint: fingerprint(b4a.from(key, 'hex')) }
    this.logger.info('Uploader access revoked', details)
    this._emitSafe('revoked', details)
    this._emitSafe('revocation', details)
  }

  private async _start(): Promise<this> {
    try {
      this._assertStarting()
      this.layout = initLayout(this.storageDir)
      this.releaseStorageLock = await acquireStorageLock(this.layout, { storage: this.storage })
      this._assertStarting()
      this.sessionStore = new SessionStore({
        layout: this.layout,
        maxStagingBytes: this.maxStagingBytes,
        minFreeBytes: this.minFreeBytes,
        storage: this.storage,
        onEvent: (event: { type: string } & Record<string, unknown>) => {
          const { type, ...details } = event
          this._emitSafe(type, details)
        }
      })
      this.commitStore = new CommitStore({
        layout: this.layout,
        storage: this.storage,
        logger: this.logger
      })
      this._emitSafe('recovery', { status: 'started' })
      await prepareStorageRecovery({
        layout: this.layout,
        commitStore: this.commitStore,
        logger: this.logger,
        onEvent: (event: { type: string } & Record<string, unknown>) => {
          const { type, ...details } = event
          this._emitSafe(type, details)
        }
      })
      try {
        await this.sessionStore.init()
      } catch (err) {
        this._emitSafe('recovery', {
          status: 'failed',
          phase: 'sessions',
          reason: eventFailureReason(err)
        })
        throw err
      }
      this._assertStarting()
      if (this.allowlistPath) {
        let initialLoad = true
        this.allowlistWatcher = new AllowlistWatcher({
          filePath: this.allowlistPath,
          storage: this.storage,
          onReload: (keys: Set<string>) => {
            if (initialLoad) {
              this._allowlist = normalizeAllowlist(keys)
              this._emitSafe('allowlist', {
                status: 'completed',
                appliedCount: this._allowlist.size,
                pendingCount: this.pendingRevocations.size
              })
              return
            }
            return this.reloadAllowlist(keys).then(() => undefined)
          },
          onFailure: ({ reason }: { reason: string }) => {
            this._emitSafe('allowlist', {
              status: 'failed',
              appliedCount: this._allowlist.size,
              pendingCount: this.pendingRevocations.size,
              reason
            })
          },
          scheduler: this.scheduler,
          logger: this.logger
        })
        await this.allowlistWatcher.load()
        initialLoad = false
        this._assertStarting()
      }
      const recovered = await recoverStorage({
        layout: this.layout,
        sessionStore: this.sessionStore,
        commitStore: this.commitStore,
        logger: this.logger,
        isAuthorized: (key: Uint8Array) => this._isAllowed(key),
        onEvent: (event: { type: string } & Record<string, unknown>) => {
          const { type, ...details } = event
          this._emitSafe(type, details)
        }
      })
      this._assertStarting()
      const purged = await this.sessionStore.deleteUnauthorized((key) => this._isAllowed(key))
      this._emitSafe('recovery', {
        status: 'completed',
        journals: recovered.length,
        purgedSessions: purged
      })
      this._assertStarting()
      this.retentionManager = new RetentionManager({
        layout: this.layout,
        sessionStore: this.sessionStore,
        commitStore: this.commitStore,
        maxAge: this.maxAge,
        maxStorageBytes: this.maxStorageBytes,
        resumeTtl: this.resumeTtl,
        cleanupInterval: this.cleanupInterval,
        storage: this.storage,
        isSessionActive: (session) => this._isSessionActive(session),
        hasActiveUploads: () => this._activeUploads.size > 0,
        logger: this.logger,
        scheduler: this.scheduler,
        onEvent: (event: { type: string } & Record<string, unknown>) => {
          const { type, ...details } = event
          this._emitSafe(type, details)
        }
      })
      await this.retentionManager.start()
      this._assertStarting()
      if (this.allowlistWatcher) this.allowlistWatcher.startPolling()

      this._assertStarting()
      this.swarm = this.swarmFactory({
        keyPair: this._keyPair,
        dht: this.dht,
        maxPeers: this.maxConnections,
        maxServerConnections: this.maxConnections,
        maxClientConnections: 0,
        firewall: (key: Uint8Array) => this._firewall(key)
      })
      if (
        !this.swarm ||
        typeof this.swarm.on !== 'function' ||
        typeof this.swarm.join !== 'function' ||
        typeof this.swarm.destroy !== 'function'
      ) {
        throw configurationError('Invalid swarm')
      }
      this._assertStarting()
      this.swarm.on('connection', (socket: ServerSocket, peerInfo?: ServerPeerInfo) =>
        this._onConnection(socket, peerInfo ?? null)
      )
      this.discovery = this.swarm.join(this.topic, { server: true, client: false })
      if (!this.discovery || typeof this.discovery.flushed !== 'function') {
        throw configurationError('Invalid swarm discovery')
      }
      await awaitAbortable(this.discovery.flushed(), this.signal)
      this._assertStarting()
      this.listening = true
      this.logger.info('Server listening', { publicKey: fingerprint(this.publicKey) })
      this._emitSafe('listening', { publicKey: fingerprint(this.publicKey) })
      return this
    } catch (err) {
      await this._dispose()
      throw err
    }
  }

  listen(): Promise<this> {
    if (this.closed) return Promise.reject(configurationError('Server is closed'))
    if (this.listenPromise) return this.listenPromise
    this.listenPromise = this._start()
    return this.listenPromise
  }

  private _abortStartupResources(): void {
    this.abortController.abort()
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
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation()
      } catch (err) {
        errors.push(err)
      }
    }

    const aborted = await Promise.allSettled(this.abortDisposals)
    for (const result of aborted) {
      if (result.status === 'rejected') errors.push(result.reason)
    }

    const allowlistWatcher = this.allowlistWatcher
    if (allowlistWatcher) await attempt(() => allowlistWatcher.close())
    this.allowlistWatcher = null
    const retentionManager = this.retentionManager
    if (retentionManager) await attempt(() => retentionManager.stop())
    this.retentionManager = null

    for (const session of [...this._sessions]) await attempt(() => session.close())
    this._sessions.clear()
    for (const socket of this._connections.keys()) {
      try {
        socket.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this._connections.clear()
    this._sockets.clear()
    this._activeUploads.clear()

    const swarm = this.swarm
    if (swarm) await attempt(() => swarm.destroy())
    this.swarm = null
    this.discovery = null
    const sessionStore = this.sessionStore
    if (sessionStore) await attempt(() => sessionStore.close())
    this.sessionStore = null
    this.commitStore = null
    const releaseStorageLock = this.releaseStorageLock
    if (releaseStorageLock) await attempt(() => releaseStorageLock())
    this.releaseStorageLock = null
    this.listening = false
    if (errors.length > 0) throw new AggregateError(errors, 'Server cleanup failed')
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this._abortStartupResources()
    this.closePromise = (async () => {
      const errors = []
      if (this.listenPromise) {
        try {
          await this.listenPromise
        } catch (err: unknown) {
          if (eventFailureReason(err) !== ERRORS.ABORTED) errors.push(err)
        }
      }
      try {
        await this._dispose()
      } catch (err: unknown) {
        if (err instanceof AggregateError) errors.push(...err.errors)
        else errors.push(err)
      }
      this._emitSafe('close', { status: errors.length === 0 ? 'closed' : 'failed' })
      if (errors.length > 0) throw new AggregateError(errors, 'Server close failed')
    })()
    return this.closePromise
  }
}

export {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_ACTIVE_UPLOADS,
  DEFAULT_MIN_FREE_BYTES,
  MAX_CONNECTIONS,
  MAX_ACTIVE_UPLOADS,
  FINGERPRINT_LENGTH,
  fingerprint,
  normalizeAllowlist
}
