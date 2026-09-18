import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import sodium from 'sodium-native'
import { createAbortController, throwIfAborted, type AbortSignalLike } from './abort.js'
import {
  DirectDhtServer,
  type DirectDhtFactory,
  type DirectDhtNode,
  type DirectDhtSocket
} from './direct-dht.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { validateReplaceNames } from './files.js'
import { keyPairFromSeed } from './identity.js'
import { CommitStore } from './storage/commit-store.js'
import { acquireStorageLock, initLayout } from './storage/layout.js'
import { recoverStorage, prepareStorageRecovery } from './storage/recovery.js'
import {
  RetentionManager,
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_RESUME_TTL
} from './storage/retention.js'
import { SessionStore } from './storage/session-store.js'
import type { StorageAdapter, StorageLayout } from './storage/types.js'
import {
  decodeDirectMetadata,
  DirectWireReader,
  writeAdmission,
  writeFinal
} from './tar-protocol/direct-wire.js'
import { sodiumSha256 } from './tar-protocol/hash.js'
import { assertMetadataTransferId } from './tar-protocol/manifest.js'
import type {
  AuthenticationEvent,
  FingerprintEvent,
  Logger,
  PublicKey,
  PublicKeyInput,
  SeedInput,
  ServerScheduler,
  TransferEvent,
  TransferLifecycleEvent
} from './types.js'

const EventEmitter = events.EventEmitter
const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_ACTIVE_UPLOADS = 8
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024
const MAX_CONNECTIONS = 1024
const MAX_ACTIVE_UPLOADS = 1024
const FINGERPRINT_LENGTH = 12
const TAR_DURABILITY_BATCH_BYTES = 1024 * 1024

export type ServerLogger = Logger
export type AllowlistKey = PublicKeyInput | string

export interface ServerOptions {
  seed: SeedInput
  storageDir: string
  allowedKeys: Iterable<AllowlistKey>
  maxFileBytes: number
  maxStagingBytes: number
  maxConnections?: number
  maxActiveUploads?: number
  idleTimeout?: number
  cleanupInterval?: number
  resumeTtl?: number
  minFreeBytes?: number
  maxAge?: number
  maxStorageBytes?: number
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
  storage?: StorageAdapter
  scheduler?: ServerScheduler
  logger?: Logger | null
  replaceNames?: Iterable<string>
}

export interface ServerConnectionEvent extends FingerprintEvent {
  connections: number
}
export interface ServerListeningEvent {
  fingerprint: string
}
export interface ServerOfferEvent extends TransferEvent, FingerprintEvent {
  status: 'accepted' | 'resumed' | 'reset' | 'rejected' | 'already-committed'
  offset?: number
  reason?: ErrorCode
}
export interface ServerProgressEvent extends TransferEvent, FingerprintEvent {
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
export interface RetentionEvent {
  trigger: 'startup' | 'scheduled' | 'manual' | 'commit' | 'post-commit'
  status: 'completed' | 'deferred' | 'failed'
  reason?: string
  expiredSessions?: number
  scrubbed?: number
  ageDeleted?: number
  storageDeleted?: number
}
export interface ServerCloseEvent {
  status: 'closed' | 'failed'
}
export interface ServerEventMap {
  authentication: AuthenticationEvent
  connection: ServerConnectionEvent
  'connection-open': ServerConnectionEvent
  'connection-close': ServerConnectionEvent
  offer: ServerOfferEvent
  progress: ServerProgressEvent
  verification: ServerTransferLifecycleEvent
  commit: ServerTransferLifecycleEvent
  recovery: RecoveryEvent
  retention: RetentionEvent
  failure: FingerprintEvent & { reason: ErrorCode }
  listening: ServerListeningEvent
  close: ServerCloseEvent
}
export type ServerEventName = keyof ServerEventMap
export type ServerEvent = ServerEventMap[ServerEventName]

type SafeLogger = Required<Logger>
type Active = { owner: Buffer; transfer: string | null }

function fail(code: ErrorCode, message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(code, message, cause)
}
function codeOf(error: unknown): ErrorCode {
  return error instanceof SwarmDeployError &&
    Object.values(ERRORS).includes(error.code as ErrorCode)
    ? (error.code as ErrorCode)
    : ERRORS.PROTOCOL_INVALID
}
function positive(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw fail(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
  return value as number
}
function key(value: unknown, label: string): Buffer {
  if (typeof value === 'string') {
    if (!/^[0-9a-f]{64}$/.test(value)) throw fail(ERRORS.INVALID_PUBLIC_KEY, `Invalid ${label}`)
    return b4a.from(value, 'hex')
  }
  if (!b4a.isBuffer(value) || value.byteLength !== 32) {
    throw fail(ERRORS.INVALID_PUBLIC_KEY, `Invalid ${label}`)
  }
  return b4a.from(value)
}
function fingerprint(value: Uint8Array): string {
  return b4a.toString(sodiumSha256(value), 'hex').slice(0, FINGERPRINT_LENGTH)
}
function safeLogger(logger: Logger | null | undefined): SafeLogger {
  const call = (method: keyof Logger, message: string, details?: Record<string, unknown>): void => {
    try {
      logger?.[method]?.(message, details)
    } catch {}
  }
  return {
    info: (m, d) => call('info', m, d),
    warn: (m, d) => call('warn', m, d),
    error: (m, d) => call('error', m, d)
  }
}

/** A static-allowlist direct HyperDHT artifact receiver. */
export interface Server {
  on<EventName extends ServerEventName>(
    event: EventName,
    listener: (event: ServerEventMap[EventName]) => void
  ): this
  on(event: string | symbol, listener: (...args: never[]) => void): this
}
export class Server extends EventEmitter {
  readonly publicKey: PublicKey
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
  private readonly allowedKeySnapshot: readonly Buffer[]
  readonly logger: SafeLogger
  readonly dht: DirectDhtNode | undefined
  readonly dhtFactory: DirectDhtFactory | undefined
  readonly storage: StorageAdapter
  readonly scheduler: ServerScheduler
  readonly replaceNames: ReadonlySet<string>
  listening = false
  closed = false
  private readonly keyPair
  private readonly signal: AbortSignalLike
  private readonly abort = createAbortController()
  private readonly active = new Map<DirectDhtSocket, Active>()
  private readonly activeUploads = new Set<DirectDhtSocket>()
  private readonly receives = new Set<Promise<void>>()
  private layout: StorageLayout | null = null
  private sessions: SessionStore | null = null
  private commits: CommitStore | null = null
  private retention: RetentionManager | null = null
  private transport: DirectDhtServer | null = null
  private releaseLock: (() => Promise<void>) | null = null
  private listenPromise: Promise<this> | null = null
  private closePromise: Promise<void> | null = null

  constructor(options: ServerOptions) {
    super()
    if (!options || typeof options !== 'object') {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid server options')
    }
    this.keyPair = keyPairFromSeed(options.seed)
    this.publicKey = b4a.from(this.keyPair.publicKey)
    this.storageDir =
      typeof options.storageDir === 'string' && options.storageDir
        ? options.storageDir
        : (() => {
            throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid storage directory')
          })()
    this.maxFileBytes = positive(options.maxFileBytes, 'maxFileBytes')
    this.maxStagingBytes = positive(options.maxStagingBytes, 'maxStagingBytes')
    this.maxConnections = positive(
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      'maxConnections',
      MAX_CONNECTIONS
    )
    this.maxActiveUploads = positive(
      options.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS,
      'maxActiveUploads',
      MAX_ACTIVE_UPLOADS
    )
    if (this.maxActiveUploads > this.maxConnections) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'maxActiveUploads exceeds maxConnections')
    }
    this.idleTimeout = positive(options.idleTimeout ?? 60_000, 'idleTimeout', 0x7fffffff)
    this.cleanupInterval = positive(
      options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL,
      'cleanupInterval',
      0x7fffffff
    )
    this.resumeTtl = positive(options.resumeTtl ?? DEFAULT_RESUME_TTL, 'resumeTtl')
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES
    if (!Number.isSafeInteger(this.minFreeBytes) || this.minFreeBytes < 0) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid minFreeBytes')
    }
    if (options.maxAge !== undefined) {
      positive(options.maxAge, 'maxAge')
    }
    if (options.maxStorageBytes !== undefined) {
      positive(options.maxStorageBytes, 'maxStorageBytes')
    }
    this.maxAge = options.maxAge
    this.maxStorageBytes = options.maxStorageBytes
    const allow: Buffer[] = []
    if (
      !options.allowedKeys ||
      typeof (options.allowedKeys as Iterable<unknown>)[Symbol.iterator] !== 'function'
    ) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid allowed keys')
    }
    for (const candidate of options.allowedKeys) {
      const candidateKey = key(candidate, 'allowed key')
      if (allow.some((allowed) => sodium.sodium_memcmp(allowed, candidateKey))) {
        throw fail(ERRORS.PROTOCOL_INVALID, 'Duplicate allowed key')
      }
      allow.push(candidateKey)
    }
    this.allowedKeySnapshot = allow.map((candidate) => b4a.from(candidate))
    this.dht = options.dht
    this.dhtFactory = options.dhtFactory
    this.storage = options.storage || fs.promises
    this.scheduler = options.scheduler || { setTimeout, clearTimeout, setInterval, clearInterval }
    this.replaceNames = validateReplaceNames(options.replaceNames)
    this.logger = safeLogger(options.logger)
    this.signal = this.abort.signal
  }

  private emitSafe(type: string, payload: Record<string, unknown>): void {
    try {
      this.emit(type, payload)
    } catch {}
  }
  private allowed(owner: Uint8Array | null): owner is Buffer {
    if (!owner || !b4a.isBuffer(owner) || owner.byteLength !== 32) return false
    let accepted = false
    for (const allowed of this.allowedKeySnapshot) {
      accepted = sodium.sodium_memcmp(owner, allowed) || accepted
    }
    return accepted
  }
  private transfer(metadata: { transferId: string; name: string; fileSize: number }) {
    return {
      transfer: fingerprint(b4a.from(metadata.transferId, 'hex')),
      name: metadata.name,
      size: metadata.fileSize
    }
  }

  private async receive(socket: DirectDhtSocket): Promise<void> {
    const owner = socket.remotePublicKey
    if (this.closed || !this.allowed(owner) || !this.sessions || !this.commits) {
      try {
        socket.destroy(fail(ERRORS.AUTH_REJECTED, 'Unauthorised direct connection'))
      } catch {}
      return
    }
    if (this.active.size >= this.maxConnections) {
      try {
        socket.destroy(fail(ERRORS.FILE_BUSY, 'Connection capacity exceeded'))
      } catch {}
      return
    }
    const current: Active = { owner: b4a.from(owner), transfer: null }
    this.active.set(socket, current)
    socket.on('error', () => {})
    socket.once('close', () => {
      this.active.delete(socket)
      this.emitSafe('connection-close', {
        fingerprint: fingerprint(owner),
        connections: this.active.size
      })
    })
    this.emitSafe('authentication', { status: 'accepted', fingerprint: fingerprint(owner) })
    this.emitSafe('connection', { fingerprint: fingerprint(owner), connections: this.active.size })
    this.emitSafe('connection-open', {
      fingerprint: fingerprint(owner),
      connections: this.active.size
    })
    const reader = new DirectWireReader(socket)
    let sentAdmission = false
    let event: ReturnType<Server['transfer']> | null = null
    let verificationStarted = false
    let verificationSucceeded = false
    let commitStarted = false
    let commitSucceeded = false
    try {
      const metadata = await reader.control(decodeDirectMetadata, this.signal, this.idleTimeout)
      assertMetadataTransferId(owner, metadata)
      event = this.transfer(metadata)
      if (
        metadata.fileSize > this.maxFileBytes ||
        this.activeUploads.size >= this.maxActiveUploads
      ) {
        const reason =
          metadata.fileSize > this.maxFileBytes ? ERRORS.FILE_TOO_LARGE : ERRORS.ACTIVE_UPLOAD_LIMIT
        await writeAdmission(
          socket,
          { v: 1, status: 'REJECTED', code: reason },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        sentAdmission = true
        this.emitSafe('offer', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'rejected',
          reason
        })
        return
      }
      const inspected = await this.commits.inspect(
        metadata.name,
        {
          name: metadata.name,
          size: metadata.fileSize,
          digest: b4a.from(metadata.fileSha256, 'hex'),
          transferId: b4a.from(metadata.transferId, 'hex')
        },
        { replaceNames: this.replaceNames }
      )
      if (inspected.status === 'ALREADY_COMMITTED') {
        await writeAdmission(
          socket,
          { v: 1, status: 'ALREADY_COMMITTED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        sentAdmission = true
        this.emitSafe('offer', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'already-committed'
        })
        return
      }
      if (inspected.status === 'FILE_EXISTS') {
        throw fail(ERRORS.FILE_EXISTS, 'Destination already exists')
      }
      if (this.activeUploads.size >= this.maxActiveUploads) {
        await writeAdmission(
          socket,
          { v: 1, status: 'REJECTED', code: ERRORS.ACTIVE_UPLOAD_LIMIT },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        sentAdmission = true
        this.emitSafe('offer', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'rejected',
          reason: ERRORS.ACTIVE_UPLOAD_LIMIT
        })
        return
      }
      this.activeUploads.add(socket)
      const admission = await this.sessions.admit(owner, metadata)
      current.transfer = metadata.transferId
      if (admission.status === 'VERIFIED') {
        await writeAdmission(
          socket,
          { v: 1, status: 'VERIFIED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        sentAdmission = true
        this.emitSafe('verification', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'started'
        })
        verificationStarted = true
        const verified = await this.sessions.readVerified(b4a.from(metadata.transferId, 'hex'))
        this.emitSafe('verification', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'succeeded'
        })
        verificationSucceeded = true
        commitStarted = true
        await this.commits.commit(verified, {
          retentionManager: this.retention,
          signal: this.signal,
          replaceNames: this.replaceNames
        })
        this.emitSafe('commit', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'succeeded'
        })
        commitSucceeded = true
        await this.retireQuietly(b4a.from(metadata.transferId, 'hex'), owner)
        await writeFinal(
          socket,
          { v: 1, status: 'COMMITTED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        return
      }
      await writeAdmission(
        socket,
        admission.status === 'ACCEPT'
          ? { v: 1, status: 'ACCEPT', offset: 0 }
          : {
              v: 1,
              status: 'RESUME',
              offset: admission.offset,
              prefixSha256: b4a.toString(admission.prefixSha256, 'hex')
            },
        { signal: this.signal, timeout: this.idleTimeout }
      )
      sentAdmission = true
      this.emitSafe('offer', {
        ...event,
        fingerprint: fingerprint(owner),
        status: metadata.reset ? 'reset' : admission.status === 'ACCEPT' ? 'accepted' : 'resumed',
        offset: admission.offset
      })
      let offset = admission.offset
      const batch = b4a.allocUnsafe(TAR_DURABILITY_BATCH_BYTES)
      let bufferedBytes = 0
      const append = async (chunk: Buffer): Promise<void> => {
        offset = await this.sessions!.append(owner, metadata, offset, chunk)
        this.emitSafe('progress', {
          ...event,
          fingerprint: fingerprint(owner),
          bytesReceived: offset,
          totalBytes: metadata.tarSize
        })
      }
      const flush = async (): Promise<void> => {
        if (bufferedBytes === 0) return
        const bytes = batch.subarray(0, bufferedBytes)
        await append(bytes)
        bufferedBytes = 0
      }
      await reader.tar(
        metadata.tarSize - offset,
        async (chunk) => {
          let position = 0
          while (position < chunk.byteLength) {
            const take = Math.min(
              TAR_DURABILITY_BATCH_BYTES - bufferedBytes,
              chunk.byteLength - position
            )
            batch.set(chunk.subarray(position, position + take), bufferedBytes)
            bufferedBytes += take
            position += take
            if (bufferedBytes === TAR_DURABILITY_BATCH_BYTES) await flush()
          }
        },
        this.signal,
        this.idleTimeout
      )
      await flush()
      await reader.requireEnd(this.signal, this.idleTimeout)
      this.emitSafe('verification', {
        ...event,
        fingerprint: fingerprint(owner),
        status: 'started'
      })
      verificationStarted = true
      const verified = await this.sessions.verify(owner, metadata)
      this.emitSafe('verification', {
        ...event,
        fingerprint: fingerprint(owner),
        status: 'succeeded'
      })
      verificationSucceeded = true
      commitStarted = true
      await this.commits.commit(verified, {
        retentionManager: this.retention,
        signal: this.signal,
        replaceNames: this.replaceNames
      })
      this.emitSafe('commit', {
        ...event,
        fingerprint: fingerprint(owner),
        status: 'succeeded'
      })
      commitSucceeded = true
      await this.retireQuietly(verified.transferId, owner)
      await writeFinal(
        socket,
        { v: 1, status: 'COMMITTED' },
        { signal: this.signal, timeout: this.idleTimeout }
      )
    } catch (error) {
      const reason = codeOf(error)
      this.logger.warn('Direct upload failed', {
        fingerprint: owner ? fingerprint(owner) : 'invalid',
        reason
      })
      this.emitSafe('failure', { fingerprint: owner ? fingerprint(owner) : 'invalid', reason })
      if (event && verificationStarted && !verificationSucceeded) {
        this.emitSafe('verification', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'failed',
          reason
        })
      }
      if (event && commitStarted && !commitSucceeded) {
        this.emitSafe('commit', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'failed',
          reason
        })
      }
      try {
        if (!sentAdmission) {
          await writeAdmission(
            socket,
            { v: 1, status: 'REJECTED', code: reason },
            { timeout: this.idleTimeout }
          )
        } else if (!commitSucceeded) {
          await writeFinal(
            socket,
            { v: 1, status: 'FAILED', code: reason },
            { timeout: this.idleTimeout }
          )
        }
      } catch {}
      try {
        socket.destroy()
      } catch {}
    } finally {
      this.activeUploads.delete(socket)
      reader.closeReader()
    }
  }

  /**
   * Retires a committed session without letting cleanup undo a durable commit.
   *
   * The artifact is already published at this point, so a failure to unlink the
   * session leaves recoverable residue that `init()` purges on the next start.
   * Propagating it here would abort before the terminal record and tell the
   * client its upload failed after it had in fact succeeded.
   */
  private async retireQuietly(transferId: Uint8Array, owner: Uint8Array | null): Promise<void> {
    try {
      await this.sessions!.retireCommitted(transferId)
    } catch (error) {
      this.logger.warn('Committed session cleanup failed', {
        fingerprint: owner ? fingerprint(owner) : 'invalid',
        reason: codeOf(error)
      })
    }
  }

  private async start(): Promise<this> {
    try {
      this.layout = initLayout(this.storageDir)
      this.releaseLock = await acquireStorageLock(this.layout, { storage: this.storage })
      this.sessions = new SessionStore({
        layout: this.layout,
        maxStagingBytes: this.maxStagingBytes,
        minFreeBytes: this.minFreeBytes,
        resumeTtl: this.resumeTtl,
        storage: this.storage,
        isSessionActive: (session) =>
          [...this.active.values()].some(
            (active) => active.transfer === (session as { id: string }).id
          )
      })
      this.commits = new CommitStore({
        layout: this.layout,
        storage: this.storage,
        logger: this.logger
      })
      this.emitSafe('recovery', { status: 'started' })
      await prepareStorageRecovery({
        layout: this.layout,
        commitStore: this.commits,
        logger: this.logger,
        onEvent: ({ type, ...event }) => this.emitSafe(type, event)
      })
      await this.sessions.init()
      const recovered = await recoverStorage({
        layout: this.layout,
        sessionStore: this.sessions,
        commitStore: this.commits,
        logger: this.logger,
        isAuthorized: (owner) => this.allowed(owner),
        onEvent: ({ type, ...event }) => this.emitSafe(type, event)
      })
      this.emitSafe('recovery', {
        status: 'completed',
        journals: recovered.length,
        purgedSessions: this.sessions.purgedSessions
      })
      this.logger.info('Storage recovery completed', {
        journals: recovered.length,
        purgedSessions: this.sessions.purgedSessions
      })
      this.retention = new RetentionManager({
        layout: this.layout,
        sessionStore: this.sessions,
        commitStore: this.commits,
        maxAge: this.maxAge,
        maxStorageBytes: this.maxStorageBytes,
        resumeTtl: this.resumeTtl,
        cleanupInterval: this.cleanupInterval,
        storage: this.storage,
        scheduler: this.scheduler,
        isSessionActive: (session) =>
          [...this.active.values()].some(
            (active) => active.transfer === (session as unknown as { id: string }).id
          ),
        hasActiveUploads: () => this.activeUploads.size > 0,
        isPinned: (record) => this.replaceNames.has(record.name),
        logger: this.logger,
        onEvent: ({ type, ...event }) => this.emitSafe(type, event)
      })
      await this.retention.start()
      throwIfAborted(this.signal)
      this.transport = new DirectDhtServer({
        keyPair: this.keyPair,
        allowedClientPublicKeys: this.allowedKeySnapshot.map((value) => b4a.from(value)),
        dht: this.dht,
        dhtFactory: this.dhtFactory,
        onConnection: (socket) => {
          const receive = this.receive(socket)
          this.receives.add(receive)
          const settled = (): void => {
            this.receives.delete(receive)
          }
          receive.then(settled, settled)
        }
      })
      await this.transport.listen()
      this.listening = true
      this.emitSafe('listening', { fingerprint: fingerprint(this.publicKey) })
      this.logger.info('Direct DHT server listening', { fingerprint: fingerprint(this.publicKey) })
      return this
    } catch (error) {
      await this.dispose()
      throw error
    }
  }
  listen(): Promise<this> {
    if (this.closed) return Promise.reject(fail(ERRORS.ABORTED, 'Server is closed'))
    return (this.listenPromise ||= this.start())
  }
  private async dispose(): Promise<void> {
    for (const socket of this.active.keys()) {
      try {
        socket.destroy()
      } catch {}
    }
    await this.transport?.close().catch(() => {})
    this.transport = null
    await Promise.allSettled([...this.receives])
    this.active.clear()
    await this.retention?.stop().catch(() => {})
    this.retention = null
    await this.sessions?.close().catch(() => {})
    this.sessions = null
    if (this.releaseLock) await this.releaseLock().catch(() => {})
    this.releaseLock = null
    this.listening = false
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.abort.abort()
    this.closePromise = (async () => {
      await this.listenPromise?.catch(() => {})
      await this.dispose()
      this.emitSafe('close', { status: 'closed' })
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
  fingerprint
}
