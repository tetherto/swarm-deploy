import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { abortError, createAbortController, throwIfAborted, type AbortSignalLike } from './abort.js'
import {
  DirectDhtServer,
  type DirectDhtFactory,
  type DirectDhtNode,
  type DirectDhtSocket
} from './direct-dht.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { validateReplaceNames } from './files.js'
import {
  callbackError,
  hookError,
  invokeHook,
  snapshotHooks,
  type AfterCommitContext,
  type BeforeCommitContext,
  type HookArtifact,
  type HookFailureContext,
  type HookFailurePhase,
  type ServerHooks
} from './hooks.js'
import { keyPairFromSeed } from './identity.js'
import { ReleaseMatcher, type ReleaseCoordinates, type VersionGranularity } from './release.js'
import { CommitStore } from './storage/commit-store.js'
import { acquireStorageLock, initLayout } from './storage/layout.js'
import { recoverStorage, prepareStorageRecovery } from './storage/recovery.js'
import {
  RetentionManager,
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_RESUME_TTL
} from './storage/retention.js'
import { SessionStore } from './storage/session-store.js'
import type { TarSession } from './storage/tar-session-store.js'
import type { StorageAdapter, StorageLayout } from './storage/types.js'
import { decodeMetadataRecord } from './tar-protocol/controls.js'
import { DirectWireReader, writeAdmission, writeFinal } from './tar-protocol/direct-wire.js'
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

/**
 * How many transfers may owe a deferred post-commit retention pass at once.
 *
 * The set grows only when an `afterCommit` hook fails after a durable commit,
 * and entries are removed as soon as a retry succeeds, so reaching the bound
 * means a persistently failing hook. Capping it at the connection ceiling
 * keeps a broken deployment step from growing server memory without limit.
 */
export const MAX_OWED_POST_COMMIT_RETENTION = MAX_CONNECTIONS

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
  /** Ordered release templates; when non-empty every new offer must match one. */
  artifactPatterns?: Iterable<string>
  maxCount?: number
  maxVersions?: number
  versionGranularity?: VersionGranularity
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
  storage?: StorageAdapter
  scheduler?: ServerScheduler
  logger?: Logger | null
  replaceNames?: Iterable<string>
  /** Optional deployment lifecycle callbacks; snapshotted at construction. */
  hooks?: ServerHooks | null
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
  countDeleted?: number
  versionDeleted?: number
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

/**
 * Until the server serves trees it decodes only the exact file record. Any directory-shaped offer,
 * well formed or not, fails the exact-key check as an unknown record, so it keeps the
 * PROTOCOL_INVALID outcome it had before the directory record existed.
 */
const decodeFileOffer = decodeMetadataRecord
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
  readonly artifactPatterns: readonly string[]
  readonly maxCount: number | undefined
  readonly maxVersions: number | undefined
  readonly versionGranularity: VersionGranularity | undefined
  private readonly releaseMatcher: ReleaseMatcher
  private readonly allowedKeySnapshot: readonly Buffer[]
  readonly logger: SafeLogger
  readonly dht: DirectDhtNode | undefined
  readonly dhtFactory: DirectDhtFactory | undefined
  readonly storage: StorageAdapter
  readonly scheduler: ServerScheduler
  readonly replaceNames: ReadonlySet<string>
  readonly hooks: Readonly<ServerHooks>
  listening = false
  closed = false
  private readonly keyPair
  private readonly signal: AbortSignalLike
  private readonly abort = createAbortController()
  private readonly active = new Map<DirectDhtSocket, Active>()
  private readonly activeUploads = new Set<DirectDhtSocket>()
  /**
   * Transfer IDs this process committed but whose deferred post-commit
   * retention is still owed because `afterCommit` has not yet succeeded. Only
   * these may start a retention pass from an already-committed retry, so an
   * ordinary duplicate offer cannot be used to force repeated full passes.
   * The set is in-memory only and bounded by `MAX_OWED_POST_COMMIT_RETENTION`;
   * a restart or an eviction loses an entry, and the documented fallback is the
   * next startup, scheduled, or commit-triggered pass.
   */
  private readonly pendingAfterCommit = new Set<string>()
  /**
   * Authenticated transfer IDs a connection currently owns. One connection
   * holds at most one entry and releases it in a `finally`, so the set is
   * bounded by `maxConnections`. A second connection offering the same
   * transfer is rejected with `FILE_BUSY` rather than running the lifecycle
   * and its hooks concurrently against one staging and commit identity.
   */
  private readonly activeTransfers = new Set<string>()
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
    const patterns = options.artifactPatterns ?? []
    if (typeof (patterns as Iterable<unknown>)[Symbol.iterator] !== 'function') {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid artifact patterns')
    }
    try {
      this.artifactPatterns = Object.freeze([...patterns])
      this.releaseMatcher = new ReleaseMatcher(this.artifactPatterns)
    } catch (error) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid artifact patterns', error)
    }
    if (options.maxCount !== undefined) {
      positive(options.maxCount, 'maxCount')
      if (this.releaseMatcher.size === 0) {
        throw fail(ERRORS.PROTOCOL_INVALID, 'maxCount requires artifact patterns')
      }
    }
    if (options.maxVersions !== undefined) {
      positive(options.maxVersions, 'maxVersions')
      if (!this.releaseMatcher.hasVersionPattern) {
        throw fail(ERRORS.PROTOCOL_INVALID, 'maxVersions requires a {version} artifact pattern')
      }
      if (options.versionGranularity !== 'major' && options.versionGranularity !== 'minor') {
        throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid versionGranularity')
      }
    } else if (options.versionGranularity !== undefined) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'versionGranularity requires maxVersions')
    }
    this.maxCount = options.maxCount
    this.maxVersions = options.maxVersions
    this.versionGranularity = options.versionGranularity
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
    this.hooks = snapshotHooks(options.hooks)
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

  private async rejectOffer(
    socket: DirectDhtSocket,
    event: ReturnType<Server['transfer']>,
    owner: Uint8Array,
    reason: ErrorCode
  ): Promise<void> {
    await writeAdmission(
      socket,
      { v: 1, status: 'REJECTED', code: reason },
      { signal: this.signal, timeout: this.idleTimeout }
    )
    this.emitSafe('offer', {
      ...event,
      fingerprint: fingerprint(owner),
      status: 'rejected',
      reason
    })
  }

  private hookArtifact(
    metadata: {
      name: string
      fileSize: number
      fileSha256: string
      transferId: string
      sourceParent?: string
    },
    release: ReleaseCoordinates | null
  ): HookArtifact {
    return Object.freeze({
      name: metadata.name,
      size: metadata.fileSize,
      sha256: metadata.fileSha256,
      transferId: metadata.transferId,
      ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent }),
      ...(release === null
        ? {}
        : {
            release: Object.freeze({
              series: release.series,
              ...(release.version === undefined ? {} : { version: release.version })
            })
          })
    })
  }

  /** Runs a gating callback; only callback exceptions become HOOK_FAILED. */
  private async runHook<Context>(
    phase: 'beforeCommit' | 'afterCommit',
    hook: ((context: Context) => void | Promise<void>) | undefined,
    context: Context
  ): Promise<void> {
    if (hook === undefined) return
    throwIfAborted(this.signal)
    let outcome: 'completed' | 'aborted'
    try {
      outcome = await invokeHook(hook, context, this.signal)
    } catch (cause) {
      throw hookError(phase, cause)
    }
    if (outcome === 'aborted') throw abortError()
  }

  /** Runs onFailure once; its own failure is logged and never replaces the original. */
  private async runFailureHook(
    context: HookFailureContext,
    owner: Uint8Array | null,
    transfer: string
  ): Promise<void> {
    const hook = this.hooks.onFailure
    if (hook === undefined) return
    try {
      await invokeHook(hook, context, this.signal)
    } catch {
      this.logger.warn('Failure hook failed', {
        fingerprint: owner ? fingerprint(owner) : 'invalid',
        transfer,
        phase: context.phase,
        reason: ERRORS.HOOK_FAILED
      })
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
    let artifact: HookArtifact | null = null
    let phase: HookFailurePhase = 'offer'
    let hookPath: string | null = null
    let resumed = false
    let alreadyCommitted = false
    let hooksFinished = false
    let finalStarted = false
    let failureReported = false
    let guardedTransfer: string | null = null
    /**
     * Hands the transfer back before this connection's last await. Clearing
     * `guardedTransfer` makes the `finally` a no-op, so a late release can
     * never take ownership away from the connection that acquired it next.
     */
    const releaseTransfer = (): void => {
      if (guardedTransfer === null) return
      this.activeTransfers.delete(guardedTransfer)
      guardedTransfer = null
    }
    // Runs onFailure at most once per connection, after the client was answered.
    const reportFailure = async (error: unknown): Promise<void> => {
      if (failureReported || !event || !artifact) return
      failureReported = true
      // The guard serializes the commit lifecycle, and this connection has
      // finished its own. `onFailure` only observes, so holding the transfer
      // across a slow callback would reject the client's legitimate retry.
      releaseTransfer()
      await this.runFailureHook(
        Object.freeze({ artifact, path: hookPath, phase, resumed, alreadyCommitted, error }),
        owner,
        event.transfer
      )
    }
    const rejectEarly = async (reason: ErrorCode, message: string): Promise<void> => {
      await this.rejectOffer(socket, event!, owner, reason)
      sentAdmission = true
      await reportFailure(fail(reason, message))
    }
    try {
      const metadata = await reader.control(decodeFileOffer, this.signal, this.idleTimeout)
      // The decoded record is shape-validated but not yet authenticated; the
      // artifact context carries only its non-secret descriptive fields.
      event = this.transfer(metadata)
      artifact = this.hookArtifact(metadata, null)
      assertMetadataTransferId(owner, metadata)
      // The transfer ID is authenticated from here on, so it is safe to key
      // the single-owner guard on it.
      if (this.activeTransfers.has(metadata.transferId)) {
        await rejectEarly(ERRORS.FILE_BUSY, 'Transfer is already in progress')
        return
      }
      this.activeTransfers.add(metadata.transferId)
      guardedTransfer = metadata.transferId
      let release: ReleaseCoordinates | null = null
      if (this.releaseMatcher.size > 0) {
        release = this.releaseMatcher.match(metadata.name, metadata.sourceParent)
        if (release === null) {
          await rejectEarly(
            ERRORS.INVALID_FILENAME,
            'Artifact name does not match a configured pattern'
          )
          return
        }
        artifact = this.hookArtifact(metadata, release)
      }
      const hookArtifact = artifact
      const finish = async (verified: TarSession): Promise<void> => {
        phase = 'beforeCommit'
        hookPath = path.join(this.layout!.staging, `${metadata.transferId}.part`)
        await this.runHook<BeforeCommitContext>(
          'beforeCommit',
          this.hooks.beforeCommit,
          Object.freeze({
            artifact: hookArtifact,
            path: hookPath,
            resumed,
            alreadyCommitted: false as const
          })
        )
        phase = 'commit'
        commitStarted = true
        await this.commits!.commit(verified, {
          retentionManager: this.retention,
          signal: this.signal,
          replaceNames: this.replaceNames,
          release,
          deferPostCommitRetention: this.hooks.afterCommit !== undefined
        })
        this.emitSafe('commit', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'succeeded'
        })
        commitSucceeded = true
        hookPath = path.join(this.layout!.root, metadata.name)
        await this.retireQuietly(verified.transferId, owner)
        phase = 'afterCommit'
        if (this.hooks.afterCommit !== undefined) {
          this.owePostCommitRetention(metadata.transferId)
        }
        await this.runHook<AfterCommitContext>(
          'afterCommit',
          this.hooks.afterCommit,
          Object.freeze({
            artifact: hookArtifact,
            path: hookPath,
            resumed,
            alreadyCommitted: false
          })
        )
        hooksFinished = true
        await this.settleDeferredRetention(metadata.transferId, owner)
        finalStarted = true
        await writeFinal(
          socket,
          { v: 1, status: 'COMMITTED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
      }
      if (
        metadata.fileSize > this.maxFileBytes ||
        this.activeUploads.size >= this.maxActiveUploads
      ) {
        if (metadata.fileSize > this.maxFileBytes) {
          await rejectEarly(ERRORS.FILE_TOO_LARGE, 'File exceeds the maximum size')
        } else {
          await rejectEarly(ERRORS.ACTIVE_UPLOAD_LIMIT, 'Active upload capacity exceeded')
        }
        return
      }
      const inspected = await this.commits.inspect(
        metadata.name,
        {
          name: metadata.name,
          size: metadata.fileSize,
          digest: b4a.from(metadata.fileSha256, 'hex'),
          transferId: b4a.from(metadata.transferId, 'hex'),
          release
        },
        { replaceNames: this.replaceNames }
      )
      if (inspected.status === 'ALREADY_COMMITTED') {
        alreadyCommitted = true
        hookPath = path.join(this.layout!.root, metadata.name)
        phase = 'afterCommit'
        await this.runHook<AfterCommitContext>(
          'afterCommit',
          this.hooks.afterCommit,
          Object.freeze({
            artifact: hookArtifact,
            path: hookPath,
            resumed: false,
            alreadyCommitted: true
          })
        )
        hooksFinished = true
        // Only a transfer this process committed can still owe a deferred
        // pass; an ordinary duplicate offer never starts one.
        if (this.pendingAfterCommit.has(metadata.transferId)) {
          await this.settleDeferredRetention(metadata.transferId, owner)
        }
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
        await rejectEarly(ERRORS.ACTIVE_UPLOAD_LIMIT, 'Active upload capacity exceeded')
        return
      }
      this.activeUploads.add(socket)
      const admission = await this.sessions.admit(owner, metadata)
      current.transfer = metadata.transferId
      resumed = admission.status !== 'ACCEPT'
      if (admission.status === 'VERIFIED') {
        await writeAdmission(
          socket,
          { v: 1, status: 'VERIFIED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
        sentAdmission = true
        phase = 'verification'
        hookPath = path.join(this.layout!.staging, `${metadata.transferId}.part`)
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
        await finish(verified)
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
      phase = 'transfer'
      hookPath = path.join(this.layout!.staging, `${metadata.transferId}.tar.part`)
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
      phase = 'verification'
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
      await finish(verified)
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
        } else if (!finalStarted) {
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
      this.activeUploads.delete(socket)
      if (!hooksFinished) await reportFailure(callbackError(error))
    } finally {
      this.activeUploads.delete(socket)
      releaseTransfer()
      reader.closeReader()
    }
  }

  /**
   * Records that a transfer still owes its deferred post-commit retention
   * pass, keeping at most `MAX_OWED_POST_COMMIT_RETENTION` entries.
   *
   * `Set` preserves insertion order, so the oldest owed transfer is evicted
   * first and eviction is deterministic. An evicted transfer loses nothing
   * durable: its artifact is already committed and its rotation falls back to
   * the next startup, scheduled, or commit-triggered pass.
   */
  private owePostCommitRetention(transferId: string): void {
    if (this.pendingAfterCommit.has(transferId)) return
    if (this.pendingAfterCommit.size >= MAX_OWED_POST_COMMIT_RETENTION) {
      const oldest = this.pendingAfterCommit.values().next()
      if (!oldest.done) this.pendingAfterCommit.delete(oldest.value)
    }
    this.pendingAfterCommit.add(transferId)
  }

  /**
   * Runs the post-commit retention pass that a configured `afterCommit` hook
   * deferred, only after that hook succeeded, and then stops owing it. The
   * retention manager already reports its own failures as non-fatal, so
   * nothing here can fail the upload; the pass is attempted exactly once per
   * successful hook, which is why the transfer is cleared either way.
   */
  private async settleDeferredRetention(
    transferId: string,
    owner: Uint8Array | null
  ): Promise<void> {
    if (this.hooks.afterCommit === undefined) return
    try {
      if (this.retention) await this.retention.afterCommit()
    } catch (error) {
      this.logger.warn('Post-commit retention failed', {
        fingerprint: owner ? fingerprint(owner) : 'invalid',
        reason: codeOf(error)
      })
    } finally {
      this.pendingAfterCommit.delete(transferId)
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
        maxCount: this.maxCount,
        maxVersions: this.maxVersions,
        versionGranularity: this.versionGranularity,
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
    this.activeTransfers.clear()
    this.pendingAfterCommit.clear()
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
