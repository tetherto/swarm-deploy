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
import { isReservedHistoryName, validateReplaceNames } from './files.js'
import {
  callbackError,
  hookError,
  hookResultOf,
  HookTurns,
  invokeHook,
  snapshotHookModes,
  snapshotHooks,
  type AfterCommitContext,
  type AfterLinkContext,
  type BeforeCommitContext,
  type FailedOutcome,
  type HookArtifact,
  type HookFailureContext,
  type HookFailurePhase,
  type HookLink,
  type HookLinkMode,
  type HookLinkStatus,
  type HookLinkTrigger,
  type HookModes,
  type HookOutcome,
  type HookTurn,
  type OperationOutcome,
  type ServerHooks
} from './hooks.js'
import {
  copyHookResult,
  copyUploadHookResult,
  type HookResult,
  type UploadHookResult,
  type UploadLinkResult
} from './hook-result.js'
import {
  DetachedHooks,
  MAX_DETACHED_HOOKS,
  OperationScope,
  type DetachedInfo,
  type DetachedProblem
} from './post-hooks.js'
import { keyPairFromSeed } from './identity.js'
import { ReleaseMatcher, type ReleaseCoordinates, type VersionGranularity } from './release.js'
import { CommitStore } from './storage/commit-store.js'
import {
  LinkStore,
  type LinkReconcileResult,
  type ManualLinkTransaction
} from './storage/link-store.js'
import {
  LEGACY_REAPPEARED_MESSAGE,
  acquireStorageLock,
  assertNoPendingStorageReset,
  diagnoseCrossMount,
  initLayout,
  legacyStatePresent
} from './storage/layout.js'
import { withNameLease, withRootLease } from './storage/root-coordinator.js'
import { recoverStorage, prepareStorageRecovery } from './storage/recovery.js'
import {
  RetentionManager,
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_RESUME_TTL
} from './storage/retention.js'
import { SessionStore } from './storage/session-store.js'
import type { TarSession } from './storage/tar-session-store.js'
import type { StorageAdapter, StorageLayout, SymlinkCapableStorage } from './storage/types.js'
import { assertSymlinkCapable } from './storage/tree-fs.js'
import {
  decodeFirstControlRecord,
  isTreeMetadata,
  type AnyMetadataRecord,
  type LinkRequestRecord
} from './tar-protocol/controls.js'
import {
  DirectWireReader,
  writeAdmission,
  writeFinal,
  writeLinkResult
} from './tar-protocol/direct-wire.js'
import { sodiumSha256 } from './tar-protocol/hash.js'
import { assertMetadataTransferId } from './tar-protocol/manifest.js'
import { assertTreeMetadataTransferId } from './tar-protocol/tree-manifest.js'
import {
  compileSymlinkRules,
  isManualSymlinkTargetAllowed,
  selectDesiredLinks,
  symlinkRuleNames,
  type CompiledSymlinkRule,
  type DesiredLink,
  type SymlinkRule
} from './symlinks.js'
import type {
  ArtifactKind,
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
import { commitRecordKind, type CommitRecord } from './storage/commit-journal.js'

const EventEmitter = events.EventEmitter
const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_ACTIVE_UPLOADS = 8
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024
const MAX_CONNECTIONS = 1024
const MAX_ACTIVE_UPLOADS = 1024
const FINGERPRINT_LENGTH = 12
const TAR_DURABILITY_BATCH_BYTES = 1024 * 1024
/** How long a connection may linger so its peer can read a `HOOK_FAILED` answer before it is destroyed. */
const ANSWER_CLOSE_GRACE = 5_000

/**
 * How many transfers may owe a deferred post-commit retention pass at once.
 *
 * The set grows only when an `afterCommit` or `afterLink` hook fails after a durable commit,
 * and entries are removed as soon as a retry succeeds, so reaching the bound
 * means a persistently failing hook. Capping it at the connection ceiling
 * keeps a broken deployment step from growing server memory without limit.
 */
export const MAX_OWED_POST_COMMIT_RETENTION = MAX_CONNECTIONS

export { MAX_DETACHED_HOOKS }

export type ServerLogger = Logger
export type AllowlistKey = PublicKeyInput | string

export interface ServerOptions {
  seed: SeedInput
  /**
   * The output root: published artifacts and managed public links only. Nothing
   * private is ever stored inside it, so it may be served by a web server.
   */
  storageDir: string
  /**
   * Absolute path of the private state directory (staging, sessions, commit and link
   * records, journals, locks, archives). It must be outside `storageDir` and on the same
   * filesystem, and is kept at mode 0700. When omitted, state lives in
   * `~/.swarm-deploy/<id>` under the home directory of the user running the server, where
   * `<id>` is derived from the real path of `storageDir`. Every instance and every
   * `reset-storage` run for one output root must use the same location. Never serve it.
   */
  stateDir?: string
  /**
   * One-time acknowledgement that starting private state that is not yet bound to
   * `storageDir` is intended. Without it the server refuses to bind new state for an output
   * root that already holds entries, or from a directory that already holds entries (state
   * migrated from `<storageDir>/.swarm-deploy`, restored, or deliberately started over after
   * its metadata was deleted). Published files are never adopted or deleted either way:
   * without their old records they stay unmanaged. State already bound to the root needs no
   * flag, so leave this unset in normal startup; keeping it would let a changed `stateDir`,
   * user, or `HOME` silently start a second, independent set of state for the same root.
   */
  initializeState?: boolean
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
  /**
   * Which post-operation hooks (`afterCommit`, `afterLink`, `onFailure`) are
   * `response` hooks, awaited before the answer. Every other post-operation hook,
   * and every hook not named here, is `detached`: it runs after the answer, and
   * nothing waits for it. Validated and frozen at construction.
   */
  hookModes?: HookModes | null
  /** Repeatable managed-symlink rules; snapshotted and validated at construction. */
  symlinks?: Iterable<SymlinkRule>
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
export interface ServerLinkEvent extends FingerprintEvent {
  target: string
  name: string
  status: 'linked' | 'unchanged' | 'rejected' | 'failed'
  reason?: ErrorCode
  /**
   * The durable link outcome when it already applied before the request
   * failed: `failed` with reason `HOOK_FAILED` means the link did change (or
   * already matched) and only its `afterLink` hook failed.
   */
  result?: 'LINKED' | 'UNCHANGED'
  /**
   * Present, and `true`, only on a failed request whose previous link and
   * ownership record were restored. `result` is then omitted, because the change
   * it would describe no longer applies.
   */
  rolledBack?: true
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
  link: ServerLinkEvent
  failure: FingerprintEvent & { reason: ErrorCode }
  listening: ServerListeningEvent
  close: ServerCloseEvent
}
export type ServerEventName = keyof ServerEventMap
export type ServerEvent = ServerEventMap[ServerEventName]

type SafeLogger = Required<Logger>
type Active = { owner: Buffer; transfer: string | null }

/**
 * A durable link decision that still owes its `afterLink` call. It holds a
 * place in its link name's hook line, so the call must either run or be released.
 */
interface PendingLinkHook {
  link: HookLink
  artifact: HookArtifact
  status: HookLinkStatus
  trigger: HookLinkTrigger
  turn: HookTurn
}

function releaseLinkHooks(pending: readonly PendingLinkHook[]): void {
  for (const item of pending) item.turn.release()
}

/** What an explicit link request has learned so far; the terminal event and `onFailure` read it. */
interface LinkRequestState {
  /** The target's commit record, once it was resolved. */
  artifact: HookArtifact | null
  /** Set once the link decision is made, so a later failure can report what the link did. */
  durable: HookLinkStatus | null
  /** The hook that was running. */
  failed: PendingLinkHook | null
  /** The hook's own failure, kept even if a failed rollback replaces the error that is returned. */
  hookError: SwarmDeployError | null
  /** True only when a failed request's previous link and record were restored. */
  rolledBack: boolean
}

function fail(code: ErrorCode, message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(code, message, cause)
}

function codeOf(error: unknown): ErrorCode {
  return error instanceof SwarmDeployError &&
    Object.values(ERRORS).includes(error.code as ErrorCode)
    ? (error.code as ErrorCode)
    : ERRORS.PROTOCOL_INVALID
}

/** What a `response` hook is told: it runs while the operation is still succeeding. */
const SUCCEEDED: OperationOutcome = Object.freeze({ status: 'succeeded' as const })

function failedOutcome(code: ErrorCode, phase: HookFailurePhase): FailedOutcome {
  return Object.freeze({ status: 'failed' as const, code, phase })
}
function frozenRelease(release: ReleaseCoordinates): ReleaseCoordinates {
  return Object.freeze({
    series: release.series,
    ...(release.version === undefined ? {} : { version: release.version })
  })
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
  /** The configured state directory, or undefined when the default under the user's home is used. */
  readonly stateDir: string | undefined
  /** Whether this start acknowledges binding new or migrated state; see `ServerOptions`. */
  readonly initializeState: boolean
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
  readonly hookModes: Readonly<HookModes>
  readonly symlinks: readonly CompiledSymlinkRule[]
  readonly linkNames: ReadonlySet<string>
  private managedLinkNamesSnapshot: ReadonlySet<string>
  private links: LinkStore | null = null
  /** Set while legacy state sits in the output root, so one alert is logged, not one per request. */
  private legacyAlerted = false
  /** Set after the first cross-mount publication failure was reported, so it is logged once. */
  private crossMountReported = false
  listening = false
  closed = false
  private readonly keyPair
  private readonly signal: AbortSignalLike
  private readonly abort = createAbortController()
  private readonly active = new Map<DirectDhtSocket, Active>()
  private readonly activeUploads = new Set<DirectDhtSocket>()
  /**
   * Transfer IDs this process committed but whose deferred post-commit
   * retention is still owed because `afterCommit` or `afterLink` has not yet succeeded. Only
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
  /**
   * One first-in, first-out line of `afterLink` calls per link name. A place is
   * reserved while the root lease orders the link decision, and the hook runs
   * after the lease is released, so a link's hooks start in decision order
   * and never overlap, while hook code never runs under the lease.
   */
  private readonly linkHookTurns = new HookTurns()
  /** The same for detached `afterCommit` calls, one line per artifact name. */
  private readonly commitHookTurns = new HookTurns()
  /** Detached post-operation callbacks: bounded, best effort, process-local. */
  private readonly detached: DetachedHooks
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
    if (
      options.stateDir !== undefined &&
      (typeof options.stateDir !== 'string' ||
        options.stateDir.length === 0 ||
        !path.isAbsolute(options.stateDir))
    ) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid state directory: it must be an absolute path')
    }
    this.stateDir = options.stateDir
    if (options.initializeState !== undefined && typeof options.initializeState !== 'boolean') {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid initializeState')
    }
    this.initializeState = options.initializeState === true
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
    this.hookModes = snapshotHookModes(options.hookModes, this.hooks)
    this.symlinks = compileSymlinkRules(options.symlinks)
    this.linkNames = symlinkRuleNames(this.symlinks)
    this.managedLinkNamesSnapshot = new Set(this.linkNames)
    if (this.symlinks.length > 0) assertSymlinkCapable(this.storage)
    this.logger = safeLogger(options.logger)
    this.signal = this.abort.signal
    this.detached = new DetachedHooks(this.signal, (problem, info) =>
      this.reportDetached(problem, info)
    )
  }

  /** Whether a post-operation hook is configured and declared `response`, so the answer waits for it. */
  private responds(name: 'afterCommit' | 'afterLink' | 'onFailure'): boolean {
    return this.hooks[name] !== undefined && this.hookModes[name] === 'response'
  }

  /** Whether a post-operation hook is configured and left (or declared) `detached`. */
  private detaches(name: 'afterCommit' | 'afterLink' | 'onFailure'): boolean {
    return this.hooks[name] !== undefined && this.hookModes[name] !== 'response'
  }

  /** A detached run that did not complete: logged with fixed text and the job's own non-secret fields. */
  private reportDetached(problem: DetachedProblem, info: DetachedInfo): void {
    this.logger.warn(`Detached hook ${problem}`, {
      hook: info.hook,
      ...info.fields,
      reason:
        problem === 'failed' ? ERRORS.HOOK_FAILED : problem === 'dropped' ? 'capacity' : 'shutdown'
    })
  }

  private artifactKind(metadata: AnyMetadataRecord): ArtifactKind {
    return isTreeMetadata(metadata) ? 'directory' : 'file'
  }

  private payloadBytes(metadata: AnyMetadataRecord): number {
    return isTreeMetadata(metadata) ? metadata.payloadBytes : metadata.fileSize
  }

  private payloadDigest(metadata: AnyMetadataRecord): string {
    return isTreeMetadata(metadata) ? metadata.treeSha256 : metadata.fileSha256
  }

  private emitSafe(type: string, payload: Record<string, unknown>): void {
    try {
      this.emit(type, payload)
    } catch {}
  }
  /** Logs, once, that publication was refused across a filesystem or mount boundary. */
  private reportCrossMount(): void {
    if (this.crossMountReported) return
    this.crossMountReported = true
    this.logger.error('Storage operation refused across a filesystem or mount boundary', {
      reason: 'EXDEV',
      hint: 'Place the private state directory on the same filesystem and mount as the output root (--state-dir)'
    })
  }

  /**
   * Whether legacy private state is in the output root now: an older release or another
   * writer recreated it after startup. New work is refused while it is there, and one alert
   * is logged for as long as it stays. It names no path.
   */
  private legacyStateReappeared(): boolean {
    const present = this.layout !== null && legacyStatePresent(this.layout.root)
    if (present && !this.legacyAlerted) {
      this.logger.error('Legacy private state reappeared in the output root; new work is refused', {
        reason: ERRORS.PROTOCOL_INVALID
      })
    }
    this.legacyAlerted = present
    return present
  }

  private allowed(owner: Uint8Array | null): owner is Buffer {
    if (!owner || !b4a.isBuffer(owner) || owner.byteLength !== 32) return false
    let accepted = false
    for (const allowed of this.allowedKeySnapshot) {
      accepted = sodium.sodium_memcmp(owner, allowed) || accepted
    }
    return accepted
  }
  private transfer(metadata: AnyMetadataRecord) {
    return {
      transfer: fingerprint(b4a.from(metadata.transferId, 'hex')),
      name: metadata.name,
      kind: this.artifactKind(metadata),
      size: this.payloadBytes(metadata)
    }
  }

  private async rejectOffer(
    socket: DirectDhtSocket,
    event: ReturnType<Server['transfer']>,
    owner: Uint8Array,
    reason: ErrorCode,
    hookResult?: UploadHookResult
  ): Promise<void> {
    await writeAdmission(
      socket,
      hookResult === undefined
        ? { v: 1, status: 'REJECTED', code: reason }
        : { v: 1, status: 'REJECTED', code: reason, hookResult },
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
    metadata: AnyMetadataRecord,
    release: ReleaseCoordinates | null
  ): HookArtifact {
    return Object.freeze({
      name: metadata.name,
      kind: this.artifactKind(metadata),
      size: this.payloadBytes(metadata),
      sha256: this.payloadDigest(metadata),
      transferId: metadata.transferId,
      ...(isTreeMetadata(metadata) ? { entryCount: metadata.entryCount } : {}),
      ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent }),
      ...(release === null ? {} : { release: frozenRelease(release) })
    })
  }

  /** Describes a durably committed artifact from its commit record, as a link hook sees it. */
  private recordArtifact(record: CommitRecord): HookArtifact {
    return Object.freeze({
      name: record.name,
      kind: commitRecordKind(record),
      size: record.size,
      sha256: record.sha256,
      transferId: record.transferId,
      ...(record.entryCount === undefined ? {} : { entryCount: record.entryCount }),
      ...(record.release === undefined ? {} : { release: frozenRelease(record.release) })
    })
  }

  private hookLink(link: DesiredLink, mode: HookLinkMode): HookLink {
    return Object.freeze({
      name: link.name,
      target: link.target,
      mode,
      path: path.join(this.layout!.root, link.name),
      targetPath: path.join(this.layout!.root, link.target)
    })
  }

  /**
   * Computes and converges the desired links from durable commit records.
   * Called with the root lease already held.
   */
  private async convergeLinksUnlocked(records: CommitRecord[]): Promise<{
    pins: ReadonlySet<string>
    desired: DesiredLink[]
    result: LinkReconcileResult | null
  }> {
    const desired = selectDesiredLinks(this.symlinks, records)
    if (!this.links) {
      const pins = new Set(desired.map((link) => link.transferId))
      this.pinDetachedHooks(pins)
      return { pins, desired, result: null }
    }
    const result = await this.links.reconcile(desired, this.linkNames, {
      managedArtifactNames: new Set(records.map((record) => record.name))
    })
    const ledger = await this.links.list()
    this.setManagedLinkNames(ledger)
    const pins = new Set(desired.map((link) => link.transferId))
    for (const link of ledger) {
      if (link.mode !== 'manual') continue
      const target = records.find((record) => record.name === link.target)
      if (target) pins.add(target.transferId)
      else pins.add(link.transferId)
    }
    await this.pinPendingRollbacks(records, pins)
    this.pinDetachedHooks(pins)
    return { pins, desired, result }
  }

  /**
   * Pins the artifact of every queued or running detached call, from the moment
   * it was registered until it finishes, so retention cannot remove what the
   * callback is about to read. The set lives in memory only.
   */
  private pinDetachedHooks(pins: Set<string>): void {
    for (const transferId of this.detached.pins()) pins.add(transferId)
  }

  private async reconcileLinksUnlocked(records: CommitRecord[]): Promise<ReadonlySet<string>> {
    return (await this.convergeLinksUnlocked(records)).pins
  }

  /** Pins link targets when reconciliation fails but retention must continue. */
  private async linkPinsFallbackUnlocked(records: CommitRecord[]): Promise<ReadonlySet<string>> {
    const pins = new Set(selectDesiredLinks(this.symlinks, records).map((link) => link.transferId))
    if (!this.links) {
      this.pinDetachedHooks(pins)
      return pins
    }
    for (const ledger of await this.links.list()) {
      pins.add(ledger.transferId)
      const target = records.find((record) => record.name === ledger.target)
      if (target) pins.add(target.transferId)
    }
    await this.pinPendingRollbacks(records, pins)
    this.pinDetachedHooks(pins)
    return pins
  }

  /**
   * While a rollback journal exists, a request's outcome is unknown, so both the
   * attempted and the previous link keep their artifacts: the journal's own
   * transfer IDs, plus the current artifact whose name equals the attempted
   * target or the previous record's target, and the one an adopted previous
   * symlink names. That symlink's text is untrusted and is only ever compared as
   * a string, never resolved or used to build a path: it counts as naming an
   * artifact when it is exactly that artifact's name, `./name`, or the absolute
   * `<storage root>/name` (the root being this server's own), each optionally
   * followed by one `/`. Any other spelling, including a path to the same file
   * through a different route, is not recognized and pins nothing.
   */
  private async pinPendingRollbacks(records: CommitRecord[], pins: Set<string>): Promise<void> {
    if (!this.links) return
    const pending = await this.links.pendingRollbacks()
    if (pending.length === 0) return
    // Every spelling is built from this server's own root and a stored record name, so
    // an untrusted symlink text can only be equal to one of them, never produce one.
    const root = this.layout!.root
    const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`
    const byName = new Map(records.map((record) => [record.name, record]))
    const spelled = new Map<string, CommitRecord>()
    for (const record of records) {
      for (const spelling of [record.name, `./${record.name}`, `${base}${record.name}`]) {
        spelled.set(spelling, record)
        spelled.set(`${spelling}/`, record)
      }
    }
    for (const entry of pending) {
      pins.add(entry.transferId)
      if (entry.priorRecord) pins.add(entry.priorRecord.transferId)
      const named = [byName.get(entry.target), byName.get(entry.priorRecord?.target ?? '')]
      if (entry.priorLiteral !== null) named.push(spelled.get(entry.priorLiteral))
      for (const record of named) {
        if (record) pins.add(record.transferId)
      }
    }
  }

  /** Start-up: restore every link whose request an earlier process never finished. */
  private async recoverLinkRollbacks(): Promise<void> {
    if (!this.links) return
    const recovery = await withRootLease(this.layout!.root, async () => {
      const result = await this.links!.recoverRollbacks()
      await this.refreshManagedLinkNames()
      return result
    })
    for (const name of recovery.restored) {
      this.logger.warn('Restored a managed link after an unfinished request', { name })
    }
    for (const name of recovery.blocked) {
      this.logger.warn('Managed link rollback is blocked by a change made since', { name })
    }
  }

  /**
   * Reconciles after a durable commit; this is the only caller that leases the
   * root for it. When an `afterLink` hook is configured it also returns one
   * pending call for every automatic link that now designates `artifact`,
   * whether this reconcile changed it or an earlier attempt already had, so a
   * retry re-runs a hook that failed. The caller owns the returned places in
   * the hook lines and must release them.
   */
  private async reconcileAfterCommit(artifact: HookArtifact): Promise<PendingLinkHook[]> {
    if (!this.links || !this.commits) return []
    try {
      return await withRootLease(this.layout!.root, async () => {
        const { desired, result } = await this.convergeLinksUnlocked(await this.commits!.list())
        if (this.hooks.afterLink === undefined) return []
        const unchanged = new Set(result?.unchanged)
        const pending = desired
          .filter((link) => link.transferId === artifact.transferId)
          .map((link) => ({
            link: this.hookLink(link, 'automatic'),
            artifact,
            status: unchanged.has(link.name) ? ('UNCHANGED' as const) : ('LINKED' as const),
            trigger: 'upload' as const
          }))
        // Reserved last and without a failure point after it, so no place can leak.
        return pending.map((item) => ({
          ...item,
          turn: this.linkHookTurns.reserve(item.link.name)
        }))
      })
    } catch (error) {
      if (error instanceof SwarmDeployError && error.code === ERRORS.LINK_CONFLICT) throw error
      throw new SwarmDeployError(ERRORS.LINK_FAILED, 'Unable to reconcile managed symlinks', error)
    }
  }

  /**
   * Runs pending `response` `afterLink` calls one after another, each once every
   * earlier hook for its link has finished. No storage lease is held while hook
   * code runs. `begin` is told which call is starting so a caller can attribute a
   * failure. The first failure stops the rest; the caller releases the places.
   *
   * What a response hook returns is always read and checked, whether or not the
   * client asked for the data: it comes back as a checked copy per call
   * (`undefined` for a hook that finished with nothing), and a value that is not a
   * valid result fails that call like a throw. Whether the data is sent is a
   * separate decision of the caller.
   */
  private async runLinkHooks(
    pending: readonly PendingLinkHook[],
    owner: Uint8Array | null,
    begin: (item: PendingLinkHook) => void
  ): Promise<Array<HookResult | undefined>> {
    const results: Array<HookResult | undefined> = []
    for (const item of pending) {
      begin(item)
      if ((await item.turn.ready(this.signal)) === 'aborted') throw abortError()
      try {
        const returned = await this.runHook<AfterLinkContext>(
          'afterLink',
          this.hooks.afterLink,
          Object.freeze({
            link: item.link,
            artifact: item.artifact,
            status: item.status,
            trigger: item.trigger,
            outcome: SUCCEEDED
          })
        )
        results.push(hookResultOf(returned, 'afterLink'))
      } catch (error) {
        if (error instanceof SwarmDeployError && error.code === ERRORS.HOOK_FAILED) {
          this.logger.warn('Link hook failed', {
            publicKeyId: owner ? fingerprint(owner) : 'invalid',
            name: item.link.name,
            target: item.link.target,
            trigger: item.trigger,
            status: item.status,
            reason: ERRORS.HOOK_FAILED
          })
        }
        throw error
      }
      item.turn.release()
    }
    return results
  }

  /**
   * Hands one durable link decision to the detached `afterLink` hook. The place in
   * the link's hook line was reserved, in decision order, by the caller and is now
   * the job's. The call starts only once `scope` has settled, which is after the
   * answer was attempted, and it is told how the operation ended.
   */
  private detachLink(item: PendingLinkHook, scope: OperationScope, owner: Uint8Array | null): void {
    const hook = this.hooks.afterLink
    if (hook === undefined) {
      item.turn.release()
      return
    }
    const context: Omit<AfterLinkContext, 'outcome'> = Object.freeze({
      link: item.link,
      artifact: item.artifact,
      status: item.status,
      trigger: item.trigger
    })
    this.detached.start<Omit<AfterLinkContext, 'outcome'>>({
      hook: 'afterLink',
      callback: hook,
      context,
      outcome: scope,
      turn: item.turn,
      pin: item.artifact.transferId,
      fields: {
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
        name: item.link.name,
        target: item.link.target,
        trigger: item.trigger,
        status: item.status
      }
    })
  }

  /**
   * The same for the detached `afterCommit` hook, ordered per artifact name. `pin`
   * is the durable commit record's transfer ID, which for an already-committed
   * mutable name can belong to another upload than the one that offered it.
   */
  private detachCommit(
    context: Omit<AfterCommitContext, 'outcome'>,
    scope: OperationScope,
    owner: Uint8Array | null,
    pin: string
  ): void {
    const hook = this.hooks.afterCommit
    if (hook === undefined) return
    this.detached.start<Omit<AfterCommitContext, 'outcome'>>({
      hook: 'afterCommit',
      callback: hook,
      context,
      outcome: scope,
      turn: this.commitHookTurns.reserve(context.artifact.name),
      pin,
      fields: {
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
        name: context.artifact.name,
        transfer: fingerprint(b4a.from(context.artifact.transferId, 'hex')),
        alreadyCommitted: context.alreadyCommitted
      }
    })
  }

  /**
   * A `response` `onFailure` hook, awaited before the failed answer is written. It
   * returns the checked data it finished with, or `undefined`: it never throws,
   * and a throw, an unusable value, or a closing server leaves the failure being
   * reported exactly as it was. It is never called for its own failure.
   *
   * What comes back is already known to fit the answer it will ride on. An upload
   * wraps it as `{ onFailure }`, which is a few bytes larger than the data alone, so
   * the data is bounded together with that wrapper here, before any record is built:
   * data that fits alone but not wrapped is dropped (and logged) like any other
   * unusable value, and the answer that is written still carries the original code.
   */
  private async awaitFailureHook(
    context: HookFailureContext,
    owner: Uint8Array | null,
    transfer: string,
    wrappedForUpload = false
  ): Promise<HookResult | undefined> {
    const hook = this.hooks.onFailure
    if (hook === undefined || !this.responds('onFailure')) return undefined
    try {
      const outcome = await invokeHook(hook, context, this.signal)
      if (outcome.status === 'aborted' || outcome.value === undefined) return undefined
      const data = copyHookResult(outcome.value)
      if (wrappedForUpload) copyUploadHookResult({ onFailure: data })
      return data
    } catch {
      this.logger.warn('Failure hook failed', {
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
        transfer,
        phase: context.phase,
        reason: ERRORS.HOOK_FAILED
      })
      return undefined
    }
  }

  /**
   * A `detached` `onFailure` hook: registered once the failed answer was attempted,
   * never awaited. `pin` is the transfer ID of the durable artifact the failure
   * concerns, taken from the durable commit record where there is one, or `null`
   * when nothing durable exists (an early failure): nothing is pinned for an
   * unverified offer or a staging path.
   */
  private detachFailureHook(
    context: HookFailureContext,
    owner: Uint8Array | null,
    transfer: string,
    pin: string | null
  ): void {
    const hook = this.hooks.onFailure
    if (hook === undefined || this.responds('onFailure')) return
    this.detached.start<HookFailureContext>({
      hook: 'onFailure',
      callback: hook,
      context,
      outcome: context.outcome,
      turn: null,
      pin,
      fields: {
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
        transfer,
        phase: context.phase
      }
    })
  }

  private setManagedLinkNames(records: readonly { name: string }[]): void {
    this.managedLinkNamesSnapshot = new Set([
      ...this.linkNames,
      ...records.map((record) => record.name)
    ])
  }

  private async refreshManagedLinkNames(): Promise<void> {
    if (!this.links) {
      this.managedLinkNamesSnapshot = new Set(this.linkNames)
      return
    }
    this.setManagedLinkNames(await this.links.list())
  }

  /**
   * What `onFailure` is told about a failed link request: the target when it was
   * resolved (never made up when it was not), a path only for a failed `afterLink`
   * hook, and the primary failure's code and phase.
   */
  private linkFailureContext(
    request: LinkRequestRecord,
    state: LinkRequestState,
    error: unknown,
    code: ErrorCode
  ): HookFailureContext {
    const hookFailed = state.hookError !== null && state.failed !== null ? state.failed : null
    const phase: HookFailurePhase = hookFailed === null ? 'link' : 'afterLink'
    return Object.freeze({
      operation: 'link' as const,
      artifact: state.artifact,
      path: hookFailed === null ? null : hookFailed.link.path,
      phase,
      resumed: false,
      alreadyCommitted: state.artifact !== null,
      error: callbackError(
        state.hookError !== null && hookFailed !== null ? state.hookError : error
      ),
      request: Object.freeze({ name: request.name, target: request.target }),
      ...(hookFailed === null ? {} : { link: hookFailed.link }),
      outcome: failedOutcome(code, phase)
    })
  }

  private async receiveLink(
    socket: DirectDhtSocket,
    reader: DirectWireReader,
    owner: Uint8Array,
    request: LinkRequestRecord,
    scope: OperationScope
  ): Promise<void> {
    let emitted = false
    let resultWriteStarted = false
    // Set only when this request was refused because legacy state is in the output root. That
    // refusal changes nothing, so its answer is delivered the way a failed hook's is.
    let refusedForLegacyState = false
    // Held in an object because closures set it.
    const state: LinkRequestState = {
      artifact: null,
      durable: null,
      failed: null,
      hookError: null,
      rolledBack: false
    }
    const emitTerminal = (
      status: ServerLinkEvent['status'],
      reason?: ErrorCode,
      result?: ServerLinkEvent['result'],
      rolledBack = false
    ): void => {
      if (emitted) return
      emitted = true
      this.emitSafe('link', {
        fingerprint: fingerprint(owner),
        target: request.target,
        name: request.name,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(result === undefined ? {} : { result }),
        ...(rolledBack ? { rolledBack: true } : {})
      })
    }
    try {
      // A link request has no payload: EOF is the required no-trailing-data boundary.
      await reader.requireEnd(this.signal, this.idleTimeout)
      if (this.legacyStateReappeared()) {
        refusedForLegacyState = true
        throw fail(ERRORS.LINK_FAILED, LEGACY_REAPPEARED_MESSAGE)
      }
      if (request.target === request.name) {
        throw fail(ERRORS.LINK_NOT_ALLOWED, 'Manual link cannot target itself')
      }
      if (!isManualSymlinkTargetAllowed(this.symlinks, request.target)) {
        throw fail(ERRORS.LINK_NOT_ALLOWED, 'Manual link target is not allowed')
      }
      if (this.linkNames.has(request.name)) {
        throw fail(ERRORS.LINK_NOT_ALLOWED, 'Manual link name is reserved by an automatic rule')
      }
      // Every explicit request for one link runs one at a time, from its decision through its
      // hook to its commit or rollback, so a request never decides against another's unfinished
      // change. The key is case-folded because a case-insensitive volume has one entry for both
      // spellings. It is held without the root lease: commits, retention, uploads, and links
      // with other names carry on while a hook runs.
      const published = await withNameLease(
        this.layout!.root,
        `link:${request.name.toLowerCase()}`,
        () => this.publishLink(owner, request, state, scope)
      )
      resultWriteStarted = true
      // A response hook's data was read and checked above whatever the client asked; the
      // request decides only whether it is sent back.
      const hookResult = request.hookResult === true ? published.hookResult : undefined
      await writeLinkResult(
        socket,
        hookResult === undefined
          ? { v: 1, status: published.status }
          : { v: 1, status: published.status, hookResult },
        { signal: this.signal, timeout: this.idleTimeout }
      )
      emitTerminal(published.status === 'LINKED' ? 'linked' : 'unchanged')
      // The answer was attempted and the link is final: a detached `afterLink` may start.
      scope.settle(SUCCEEDED)
    } catch (error) {
      let reason =
        error instanceof SwarmDeployError &&
        (error.code === ERRORS.LINK_NOT_ALLOWED ||
          error.code === ERRORS.LINK_TARGET_NOT_FOUND ||
          error.code === ERRORS.LINK_CONFLICT ||
          error.code === ERRORS.LINK_FAILED ||
          error.code === ERRORS.HOOK_FAILED)
          ? error.code
          : ERRORS.LINK_FAILED
      const rejected =
        reason === ERRORS.LINK_NOT_ALLOWED ||
        reason === ERRORS.LINK_TARGET_NOT_FOUND ||
        reason === ERRORS.LINK_CONFLICT
      // The failed-operation hook sees every failure of the request itself, including ones
      // before any link exists. A failure after the answer began is delivery, not the
      // operation's failure, so it has no hook call.
      const failure = resultWriteStarted
        ? null
        : this.linkFailureContext(request, state, error, reason)
      const transfer =
        state.artifact === null ? 'none' : fingerprint(b4a.from(state.artifact.transferId, 'hex'))
      // Declared `response`, the hook is awaited before the answer and may add data to it. It
      // can neither replace the code being reported nor fail the request a second time.
      const receipt =
        failure === null ? undefined : await this.awaitFailureHook(failure, owner, transfer)
      let answered = false
      if (!resultWriteStarted) {
        resultWriteStarted = true
        try {
          await writeLinkResult(
            socket,
            receipt !== undefined && request.hookResult === true
              ? { v: 1, status: 'FAILED', code: reason, hookResult: receipt }
              : { v: 1, status: 'FAILED', code: reason },
            { timeout: this.idleTimeout }
          )
          answered = true
        } catch {
          // A failed hook stays observable here even when the client cannot be told.
          if (reason !== ERRORS.HOOK_FAILED) reason = ERRORS.LINK_FAILED
        }
      } else {
        reason = ERRORS.LINK_FAILED
      }
      this.logger.warn('Direct link failed', { publicKeyId: fingerprint(owner), reason })
      this.emitSafe('failure', { fingerprint: fingerprint(owner), reason })
      // A restored request has no durable outcome to report; `rolledBack` says so instead.
      emitTerminal(
        rejected && reason !== ERRORS.LINK_FAILED ? 'rejected' : 'failed',
        reason,
        reason === ERRORS.HOOK_FAILED && state.durable !== null && !state.rolledBack
          ? state.durable
          : undefined,
        state.rolledBack
      )
      if (answered && (reason === ERRORS.HOOK_FAILED || refusedForLegacyState)) {
        this.closeAfterAnswer(socket)
      } else {
        try {
          socket.destroy()
        } catch {}
      }
      // The client has been answered and the link is restored or final, with no lease held. A
      // detached onFailure starts now and nothing waits for it; it runs for the hook's own
      // failure even when a failed rollback is what the client was told.
      // The target's commit record is the durable artifact it concerns, so that is what stays
      // pinned until the call ends; a request that never resolved a target pins nothing.
      if (failure !== null) {
        this.detachFailureHook(
          failure,
          owner,
          transfer,
          state.artifact === null ? null : state.artifact.transferId
        )
      }
      // A detached `afterLink` registered after the link was decided still stands: it learns
      // the request ended in failure only when a later awaited step failed it, and a failed
      // answer write after a final link is delivery, not outcome.
      scope.settle(
        state.durable !== null && failure === null
          ? SUCCEEDED
          : failedOutcome(reason, state.failed !== null ? 'afterLink' : 'link')
      )
    }
  }

  /**
   * One explicit link request, run under the link's name lease: decide (and, when
   * a failed hook is to roll back, journal) under the root lease, release it, wait
   * for the hook, then finalize or restore under the root lease again. A hook
   * that fails, returns an unusable result, or is aborted by a closing server
   * restores the previous link and ownership record before the error is
   * returned; a restore that cannot be proven or fails turns the answer into
   * `LINK_FAILED` and leaves the journal for the next request or start-up. A hook
   * that succeeded is final before the answer is written, so a failed write
   * never undoes it.
   *
   * That is the `response` hook. A `detached` `afterLink` hook (the default) is
   * not awaited and cannot fail the request, so nothing is journaled and there is
   * nothing to restore: the decision is final and the hook is handed to the
   * detached queue, where it starts after the answer was attempted. The
   * request's `hookFailure` policy has no effect without a response hook.
   */
  private async publishLink(
    owner: Uint8Array,
    request: LinkRequestRecord,
    state: LinkRequestState,
    scope: OperationScope
  ): Promise<{ status: HookLinkStatus; hookResult: HookResult | undefined }> {
    // A request that waited for the lease may find the server closing; it changes nothing then.
    throwIfAborted(this.signal)
    const open: { transaction: ManualLinkTransaction | null } = { transaction: null }
    const respond = this.responds('afterLink')
    try {
      const decided = await withRootLease(this.layout!.root, async () => {
        const records = await this.commits!.list()
        const target = records.find(
          (record) => record.name === request.target && !isReservedHistoryName(record.name)
        )
        if (!target) throw fail(ERRORS.LINK_TARGET_NOT_FOUND, 'Manual link target was not found')
        state.artifact = this.recordArtifact(target)
        const artifacts = new Set(records.map((record) => record.name))
        if (artifacts.has(request.name)) {
          throw fail(ERRORS.LINK_CONFLICT, 'Manual link name conflicts with an artifact')
        }
        if (!this.links) throw fail(ERRORS.LINK_FAILED, 'Managed link storage is unavailable')
        const link: DesiredLink = {
          name: request.name,
          target: target.name,
          transferId: target.transferId,
          targetKind: commitRecordKind(target)
        }
        const options = { managedArtifactNames: artifacts, automaticLinkNames: this.linkNames }
        let status: HookLinkStatus
        if (request.hookFailure !== 'keep' && respond) {
          // Only a request whose hook is awaited can fail on it, so only that is journaled.
          const begun = await this.links.beginManual(link, options)
          open.transaction = begun.transaction
          status = begun.status
        } else {
          status = (await this.links.linkManual(link, options)).status
        }
        await this.refreshManagedLinkNames()
        // The link is durable here. Its hook runs after this lease is released, so a
        // slow or failing hook never blocks commits, retention, or other links.
        const pending: PendingLinkHook | null =
          this.hooks.afterLink === undefined
            ? null
            : {
                link: this.hookLink(link, 'manual'),
                artifact: this.recordArtifact(target),
                status,
                trigger: 'request',
                turn: this.linkHookTurns.reserve(link.name)
              }
        return { status, pending }
      })
      state.durable = decided.status
      let hookResult: HookResult | undefined
      if (decided.pending !== null) {
        const pending = decided.pending
        if (respond) {
          try {
            ;[hookResult] = await this.runLinkHooks([pending], owner, (item) => {
              state.failed = item
            })
          } finally {
            pending.turn.release()
          }
        } else {
          // Registered here, in decision order and before the answer, but it starts only once
          // the answer was attempted. It cannot undo the decision.
          this.detachLink(pending, scope, owner)
        }
      }
      if (open.transaction !== null) {
        const transaction = open.transaction
        await this.settleLink((links) => links.commitManual(transaction))
        // Final: the journal is gone, so no later failure may try to undo the link.
        open.transaction = null
        await this.refreshAfterSettle(request.name)
      }
      return { status: decided.status, hookResult }
    } catch (error) {
      if (
        error instanceof SwarmDeployError &&
        error.code === ERRORS.HOOK_FAILED &&
        state.failed !== null
      ) {
        state.hookError = error
      }
      if (open.transaction !== null) {
        const transaction = open.transaction
        try {
          await this.settleLink((links) => links.rollbackManual(transaction))
        } catch (rollbackError) {
          this.logger.warn('Managed link rollback failed', {
            publicKeyId: fingerprint(owner),
            name: request.name,
            reason: codeOf(rollbackError)
          })
          throw fail(ERRORS.LINK_FAILED, 'Unable to restore the previous managed link', error)
        }
        // Restored and journal removed: from here the request is a clean failure.
        open.transaction = null
        state.rolledBack = true
        await this.refreshAfterSettle(request.name)
      }
      throw error
    }
  }

  /** Finalizes or restores a journaled link under the root lease. */
  private settleLink(operation: (links: LinkStore) => Promise<void>): Promise<void> {
    return withRootLease(this.layout!.root, async () => {
      if (!this.links) throw fail(ERRORS.LINK_FAILED, 'Managed link storage is unavailable')
      await operation(this.links)
    })
  }

  /**
   * Refreshes the managed-name snapshot once a link was finalized or restored. The
   * outcome is already durable, so a failure here is only logged and never changes
   * it. The snapshot then keeps what it had and adds this name, so admission stays at
   * least as protective as before until the next reconcile replaces it.
   */
  private async refreshAfterSettle(name: string): Promise<void> {
    try {
      await withRootLease(this.layout!.root, () => this.refreshManagedLinkNames())
    } catch (error: unknown) {
      this.managedLinkNamesSnapshot = new Set([...this.managedLinkNamesSnapshot, name])
      this.logger.warn('Managed link names could not be refreshed', {
        name,
        reason: codeOf(error)
      })
    }
  }

  /**
   * Closes a connection after an answer whose code the caller must be able to read: a
   * `HOOK_FAILED` answer, and the refusal of a link request while legacy state is in the
   * output root. Destroying the stream right behind the write can reset it before the peer has
   * read the record, so the caller would see a reset instead of the stable code. The write
   * side is ended first and the connection is destroyed once the peer closes it, or after a
   * grace period if it never does. In both cases the work that failed is already durable or
   * was never started, so lingering costs only the connection. Every other failure still
   * destroys the stream at once.
   */
  private closeAfterAnswer(socket: DirectDhtSocket): void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const destroy = (): void => {
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {}
    }
    try {
      ;(socket as DirectDhtSocket & { end?(): void }).end?.()
    } catch {
      destroy()
      return
    }
    socket.once('close', () => clearTimeout(timer))
    timer = setTimeout(destroy, ANSWER_CLOSE_GRACE)
    // A lingering answer must never keep the process alive on its own.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  /**
   * Runs a gating callback; only callback exceptions become HOOK_FAILED. Returns
   * what the callback returned, for the one caller that reads it.
   */
  private async runHook<Context>(
    phase: 'beforeCommit' | 'afterCommit' | 'afterLink',
    hook: ((context: Context) => unknown) | undefined,
    context: Context
  ): Promise<unknown> {
    if (hook === undefined) return undefined
    throwIfAborted(this.signal)
    let outcome: HookOutcome
    try {
      outcome = await invokeHook(hook, context, this.signal)
    } catch (cause) {
      throw hookError(phase, cause)
    }
    if (outcome.status === 'aborted') throw abortError()
    return outcome.value
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
    let failedLink: HookLink | null = null
    let resumed = false
    let alreadyCommitted = false
    let hooksFinished = false
    let finalStarted = false
    let failureReported = false
    // Whether the offer asked for hook data. It decides only what the answer carries.
    let receiptRequested = false
    // The code the upload failed with, for detached hooks that outlive its awaited steps.
    let failedWith: ErrorCode = ERRORS.PROTOCOL_INVALID
    // The transfer ID of the durable commit record this connection concerns, once there is
    // one: what a detached call pins. It comes from the record, not from the offer, because an
    // already-committed mutable name can be another upload's. `null` before anything is durable.
    let durableId: string | null = null
    let guardedTransfer: string | null = null
    // Settled once, after the answer was attempted; detached hooks of this operation wait for it.
    const scope = new OperationScope()
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
    // What the failed-operation hook is told, at most once per connection: only when the offer
    // was decoded (so there is an artifact to describe) and no awaited step has finished the
    // operation. The path is whatever exists at this phase and is never made up, so it is
    // `null` for every failure before a staging or committed path exists.
    const failureContext = (error: unknown, code: ErrorCode): HookFailureContext | null => {
      if (failureReported || hooksFinished || !event || !artifact) return null
      failureReported = true
      // The guard serializes the commit lifecycle, and this connection has finished its
      // own. `onFailure` only observes (or answers), so holding the transfer across a slow
      // callback would reject the client's legitimate retry.
      releaseTransfer()
      return Object.freeze({
        operation: 'upload' as const,
        artifact,
        path: hookPath,
        phase,
        resumed,
        alreadyCommitted,
        error,
        ...(phase === 'afterLink' && failedLink !== null ? { link: failedLink } : {}),
        outcome: failedOutcome(code, phase)
      })
    }
    // Attributes an `afterLink` failure to the link whose hook was starting.
    const beginLinkHook = (item: PendingLinkHook): void => {
      phase = 'afterLink'
      failedLink = item.link
      hookPath = item.link.path
    }
    const rejectEarly = async (reason: ErrorCode, message: string): Promise<void> => {
      const failed = failureContext(fail(reason, message), reason)
      // A `response` onFailure is awaited before the rejection and may add data to it, already
      // bounded together with the `{ onFailure }` wrapper it will be sent in.
      const receipt =
        failed === null
          ? undefined
          : await this.awaitFailureHook(failed, owner, event!.transfer, true)
      try {
        await this.rejectOffer(
          socket,
          event!,
          owner,
          reason,
          receiptRequested && receipt !== undefined ? { onFailure: receipt } : undefined
        )
        sentAdmission = true
      } finally {
        // Scheduled exactly once, when the answer was attempted, whether or not it could be
        // written: the context is already taken, so the connection's own failure path will not
        // schedule it again. A detached call holds no slot, guard, or lease.
        if (failed !== null) this.detachFailureHook(failed, owner, event!.transfer, durableId)
      }
    }
    try {
      const first = await reader.control(decodeFirstControlRecord, this.signal, this.idleTimeout)
      if ('kind' in first && first.kind === 'link') {
        await this.receiveLink(socket, reader, owner, first, scope)
        return
      }
      const metadata = first as AnyMetadataRecord
      receiptRequested = metadata.hookResult === true
      // The decoded record is shape-validated but not yet authenticated; the
      // artifact context carries only its non-secret descriptive fields.
      event = this.transfer(metadata)
      artifact = this.hookArtifact(metadata, null)
      if (isTreeMetadata(metadata)) assertTreeMetadataTransferId(owner, metadata)
      else assertMetadataTransferId(owner, metadata)
      // Legacy state reappearing in the output root means another writer is using it.
      if (this.legacyStateReappeared()) {
        await rejectEarly(ERRORS.PROTOCOL_INVALID, LEGACY_REAPPEARED_MESSAGE)
        return
      }
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
      if (this.managedLinkNamesSnapshot.has(metadata.name)) {
        await rejectEarly(ERRORS.INVALID_FILENAME, 'Artifact name is a configured symlink name')
        return
      }
      const hookArtifact = artifact
      const stagingHookPath = isTreeMetadata(metadata)
        ? path.join(this.layout!.staging, `${metadata.transferId}.tree`)
        : path.join(this.layout!.staging, `${metadata.transferId}.part`)
      /**
       * The hooks that follow a durable artifact, shared by a fresh commit and an
       * already-committed retry. Detached hooks are registered first, as soon as there is
       * something durable, so a later awaited failure still reaches them (with a failed
       * outcome); they do not start until the answer was attempted. `response` hooks are
       * awaited in order, `afterCommit` then each automatic link's `afterLink`, and their
       * data is read, checked and bounded as one receipt whatever the offer asked for.
       */
      const runPostCommit = async (
        alreadyDurable: boolean
      ): Promise<UploadHookResult | undefined> => {
        const commitContext = Object.freeze({
          artifact: hookArtifact,
          path: path.join(this.layout!.root, metadata.name),
          resumed: alreadyDurable ? false : resumed,
          alreadyCommitted: alreadyDurable
        })
        if (this.detaches('afterCommit')) {
          this.detachCommit(
            commitContext,
            scope,
            owner,
            durableId ?? commitContext.artifact.transferId
          )
        }
        const linkHooks = await this.reconcileAfterCommit(hookArtifact)
        // The places in the link hook lines this call still owns: all of them for a response
        // hook, none once each has been handed to its detached job.
        let owned = linkHooks
        if (this.detaches('afterLink')) {
          owned = []
          for (const item of linkHooks) this.detachLink(item, scope, owner)
        }
        let commitResult: HookResult | undefined
        let linkResults: Array<HookResult | undefined> = []
        try {
          phase = 'afterCommit'
          if (!alreadyDurable && this.defersPostCommitRetention()) {
            this.owePostCommitRetention(metadata.transferId)
          }
          if (this.responds('afterCommit')) {
            commitResult = hookResultOf(
              await this.runHook<AfterCommitContext>(
                'afterCommit',
                this.hooks.afterCommit,
                Object.freeze({ ...commitContext, outcome: SUCCEEDED })
              ),
              'afterCommit'
            )
          }
          if (this.responds('afterLink')) {
            linkResults = await this.runLinkHooks(owned, owner, beginLinkHook)
          }
          const links: UploadLinkResult[] = []
          owned.forEach((item, index) => {
            const result = linkResults[index]
            if (result !== undefined) {
              links.push({ name: item.link.name, target: item.link.target, result })
            }
          })
          if (commitResult === undefined && links.length === 0) return undefined
          try {
            return copyUploadHookResult({
              ...(commitResult === undefined ? {} : { afterCommit: commitResult }),
              ...(links.length === 0 ? {} : { afterLink: links })
            })
          } catch (cause) {
            // Too large together, though each part was fine: the response hooks' answer is unusable.
            throw hookError(links.length === 0 ? 'afterCommit' : 'afterLink', cause)
          }
        } finally {
          releaseLinkHooks(owned)
        }
      }
      const finish = async (verified: TarSession): Promise<void> => {
        phase = 'beforeCommit'
        hookPath = stagingHookPath
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
          deferPostCommitRetention: this.defersPostCommitRetention()
        })
        this.emitSafe('commit', {
          ...event,
          fingerprint: fingerprint(owner),
          status: 'succeeded'
        })
        commitSucceeded = true
        // The record this commit just wrote carries the authenticated transfer ID.
        durableId = metadata.transferId
        hookPath = path.join(this.layout!.root, metadata.name)
        await this.retireQuietly(verified.transferId, owner)
        const receipt = await runPostCommit(false)
        hooksFinished = true
        await this.settleDeferredRetention(metadata.transferId, owner)
        finalStarted = true
        // The data goes out only when the offer asked for it. Awaiting a response hook never
        // depended on that.
        await writeFinal(
          socket,
          receiptRequested && receipt !== undefined
            ? { v: 1, status: 'COMMITTED', hookResult: receipt }
            : { v: 1, status: 'COMMITTED' },
          { signal: this.signal, timeout: this.idleTimeout }
        )
      }
      const payloadBytes = this.payloadBytes(metadata)
      if (payloadBytes > this.maxFileBytes || this.activeUploads.size >= this.maxActiveUploads) {
        if (payloadBytes > this.maxFileBytes) {
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
          kind: this.artifactKind(metadata),
          size: payloadBytes,
          digest: b4a.from(this.payloadDigest(metadata), 'hex'),
          ...(isTreeMetadata(metadata) ? { entryCount: metadata.entryCount } : {}),
          transferId: b4a.from(metadata.transferId, 'hex'),
          release
        },
        { replaceNames: this.replaceNames }
      )
      if (inspected.status === 'ALREADY_COMMITTED') {
        alreadyCommitted = true
        // The durable record decides, not the offer: for a mutable name that already holds
        // identical content it can be another upload's record, with another transfer ID.
        durableId = inspected.record.transferId
        hookPath = path.join(this.layout!.root, metadata.name)
        const receipt = await runPostCommit(true)
        hooksFinished = true
        // Only a transfer this process committed can still owe a deferred
        // pass; an ordinary duplicate offer never starts one.
        if (this.pendingAfterCommit.has(metadata.transferId)) {
          await this.settleDeferredRetention(metadata.transferId, owner)
        }
        await writeAdmission(
          socket,
          receiptRequested && receipt !== undefined
            ? { v: 1, status: 'ALREADY_COMMITTED', hookResult: receipt }
            : { v: 1, status: 'ALREADY_COMMITTED' },
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
        await rejectEarly(ERRORS.FILE_EXISTS, 'Destination already exists')
        return
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
        hookPath = stagingHookPath
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
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
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
      failedWith = reason
      // The failed-operation hook sees the primary failure. Declared `response`, it is awaited
      // before the answer and may add data to it; it can change neither the code reported
      // nor whether the operation failed, and it is never called for its own failure.
      const failed = failureContext(callbackError(error), reason)
      const receipt =
        failed === null
          ? undefined
          : await this.awaitFailureHook(failed, owner, event!.transfer, true)
      const failureReceipt: UploadHookResult | undefined =
        receiptRequested && receipt !== undefined ? { onFailure: receipt } : undefined
      let answered = false
      try {
        if (!sentAdmission) {
          await writeAdmission(
            socket,
            failureReceipt === undefined
              ? { v: 1, status: 'REJECTED', code: reason }
              : { v: 1, status: 'REJECTED', code: reason, hookResult: failureReceipt },
            { timeout: this.idleTimeout }
          )
          answered = true
        } else if (!finalStarted) {
          await writeFinal(
            socket,
            failureReceipt === undefined
              ? { v: 1, status: 'FAILED', code: reason }
              : { v: 1, status: 'FAILED', code: reason, hookResult: failureReceipt },
            { timeout: this.idleTimeout }
          )
          answered = true
        }
      } catch {}
      if (answered && reason === ERRORS.HOOK_FAILED) {
        this.closeAfterAnswer(socket)
      } else {
        try {
          socket.destroy()
        } catch {}
      }
      this.activeUploads.delete(socket)
      // A detached onFailure starts now, after the answer, and nothing waits for it. It pins
      // the durable artifact the failure concerns, if the upload got that far.
      if (failed !== null) this.detachFailureHook(failed, owner, event!.transfer, durableId)
    } finally {
      this.activeUploads.delete(socket)
      releaseTransfer()
      reader.closeReader()
      // The answer was attempted. Detached `afterCommit` and `afterLink` calls of this upload
      // start now and are told how it ended: a failure of a later awaited step is `failed`,
      // while a failed answer write after every awaited step finished is delivery, not outcome.
      scope.settle(hooksFinished ? SUCCEEDED : failedOutcome(failedWith, phase))
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
   * Whether the post-commit retention pass waits for the hooks that follow a
   * commit. Either one defers it: `afterCommit` so its callback still finds
   * the artifact, and `afterLink` so this commit's own link reconciliation runs
   * before this commit's retention pass does. That narrows, but does not remove,
   * the chance that the link already moved: another commit's retention or
   * reconciliation can do it first, and the hook then sees `UNCHANGED`.
   */
  private defersPostCommitRetention(): boolean {
    return this.hooks.afterCommit !== undefined || this.hooks.afterLink !== undefined
  }

  /**
   * Runs the post-commit retention pass that configured `afterCommit` or
   * `afterLink` hooks deferred, only after they succeeded, and then stops
   * owing it. The retention manager already reports its own failures as
   * non-fatal, so nothing here can fail the upload; the pass is attempted
   * exactly once per successful hook run, which is why the transfer is cleared
   * either way.
   */
  private async settleDeferredRetention(
    transferId: string,
    owner: Uint8Array | null
  ): Promise<void> {
    if (!this.defersPostCommitRetention()) return
    try {
      if (this.retention) await this.retention.afterCommit()
    } catch (error) {
      this.logger.warn('Post-commit retention failed', {
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
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
        publicKeyId: owner ? fingerprint(owner) : 'invalid',
        reason: codeOf(error)
      })
    }
  }

  private async start(): Promise<this> {
    try {
      this.layout = initLayout(this.storageDir, this.stateDir, {
        initializeState: this.initializeState
      })
      this.releaseLock = await acquireStorageLock(this.layout, { storage: this.storage })
      // The stores see the same adapter, except that a rename or link refused with EXDEV is
      // reported once with the way out (the state directory must share the root's mount).
      const storage = diagnoseCrossMount(this.storage, () => this.reportCrossMount())
      await assertNoPendingStorageReset(this.layout, storage)
      this.sessions = new SessionStore({
        layout: this.layout,
        maxStagingBytes: this.maxStagingBytes,
        minFreeBytes: this.minFreeBytes,
        resumeTtl: this.resumeTtl,
        storage,
        isSessionActive: (session) =>
          [...this.active.values()].some(
            (active) => active.transfer === (session as { id: string }).id
          )
      })
      this.commits = new CommitStore({
        layout: this.layout,
        storage,
        logger: this.logger
      })
      if (
        this.symlinks.length > 0 ||
        (typeof this.storage.symlink === 'function' && typeof this.storage.readlink === 'function')
      ) {
        this.links = new LinkStore({
          layout: this.layout,
          storage: storage as SymlinkCapableStorage
        })
      }
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
      // A link request that never finished is undone before retention can run or any
      // client connects: its outcome is unknown, and the caller never heard success.
      await this.recoverLinkRollbacks()
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
        storage,
        scheduler: this.scheduler,
        isSessionActive: (session) =>
          [...this.active.values()].some(
            (active) => active.transfer === (session as unknown as { id: string }).id
          ),
        hasActiveUploads: () => this.activeUploads.size > 0,
        isPinned: (record) => this.replaceNames.has(record.name),
        managedLinkNames: () => this.managedLinkNamesSnapshot,
        reconcileLinks: (records) => this.reconcileLinksUnlocked(records),
        linkPinsFallback: (records) => this.linkPinsFallbackUnlocked(records),
        logger: this.logger,
        onEvent: ({ type, ...event }) => this.emitSafe(type, event)
      })
      await this.refreshManagedLinkNames()
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
      this.logger.info('Direct DHT server listening', { publicKeyId: fingerprint(this.publicKey) })
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
    // The signal is already aborted, so queued detached calls are dropped and a running one
    // is abandoned (its callback keeps running detached); this waits for neither hook code
    // nor anything that could hang.
    await this.detached.drain()
    this.active.clear()
    this.activeTransfers.clear()
    this.pendingAfterCommit.clear()
    await this.retention?.stop().catch(() => {})
    this.retention = null
    this.links = null
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
