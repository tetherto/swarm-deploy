import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

/**
 * A byte buffer accepted by identity, transport, and file APIs. Values that
 * represent keys, digests, or transfer IDs must be exactly 32 bytes.
 */
export type Binary = Buffer

/** A 32-byte seed used to derive a Hyperswarm/HyperDHT identity. */
export type Seed = Binary
/** A 32-byte HyperDHT public key. */
export type PublicKey = Binary
/** A SHA-256-derived 32-byte discovery topic. */
export type Topic = Binary
/** A SHA-256 digest. */
export type Digest = Binary
/** A SHA-256-derived transfer identifier. */
export type TransferId = Binary
/** A fixed-width 32-byte value accepted by protocol transfer-ID helpers. */
export type Fixed32 = Binary | Uint8Array

export interface KeyPair {
  publicKey: PublicKey
  secretKey: Binary
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void
  warn?(message: string, details?: Record<string, unknown>): void
  error?(message: string, details?: Record<string, unknown>): void
}

export interface Scheduler {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ServerScheduler extends Scheduler {
  setInterval(callback: () => void, delay: number): unknown
  clearInterval(handle: unknown): void
}

export interface Clock {
  now(): number
}

export interface SwarmDiscovery {
  flushed(): Promise<unknown>
  destroy?(): void | Promise<void>
}

export interface Swarm {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  join(topic: Topic, options: { server: boolean; client: boolean }): SwarmDiscovery
  destroy(): void | Promise<void>
}

export interface SwarmFactoryOptions {
  keyPair: KeyPair
  dht?: unknown
  maxPeers: number
  maxClientConnections: number
  maxServerConnections: number
  firewall?: (remotePublicKey: PublicKey) => boolean
}

export type SwarmFactory = (options: SwarmFactoryOptions) => Swarm

/**
 * The filesystem subset needed by a Server. The default is `fs.promises`;
 * adapters are primarily intended for controlled test environments.
 */
export interface StorageAdapter {
  open(...args: any[]): Promise<any>
  lstat(path: string): Promise<any>
  readdir(path: string): Promise<string[]>
  [key: string]: unknown
}

/** A public key accepted in an allowlist: a 32-byte buffer or canonical lowercase hex. */
export type AllowlistKey = PublicKey | string

export interface ServerOptions {
  /** Required 32-byte persistent server seed. */
  seed: Seed
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
}

export interface ClientOptions {
  /** Required 32-byte persistent client seed. */
  seed: Seed
  /** Required, pinned 32-byte server public key. It must differ from the client public key. */
  serverPublicKey: PublicKey
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

export interface FileSnapshot {
  size: number
  mtimeMs: number
  ino: number | bigint
}

export interface FileManifest {
  path: string
  name: string
  size: number
  digest: Digest
  chunkDigests: Digest[]
  chunkCount: number
  chunkSize: number
  stat: FileSnapshot
}

export interface BuildFileManifestOptions {
  /** Logical chunk size in bytes; defaults to 1 MiB. */
  chunkSize?: number
  signal?: AbortSignal | null
}

export interface SelectUploadPathsOptions {
  signal?: AbortSignal | null
}

export interface SelectedUploadPath {
  kind: 'selected'
  name: string
  path: string
}

export interface SkippedUploadPath {
  kind: 'skipped'
  name: string
  path: string
  reason: 'symlink' | 'directory' | 'not-regular-file' | 'invalid-filename'
}

export interface FailedUploadPath {
  kind: 'failed'
  name: string
  path: string
  reason: 'unreadable'
  code: string | null
}

export type UploadPathEntry = SelectedUploadPath | SkippedUploadPath | FailedUploadPath

export interface UploadPathSelection {
  paths: string[]
  skipped: Array<Omit<SkippedUploadPath, 'kind'>>
  failed: Array<Omit<FailedUploadPath, 'kind'>>
  entries: UploadPathEntry[]
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
  reason: 'symlink' | 'directory' | 'not-regular-file' | 'invalid-filename'
}

export interface BatchUploadResult {
  status: 'COMMITTED' | 'FAILED'
  results: Array<UploadResult | BatchUploadFailure>
  skipped: SkippedUploadEntry[]
}

export interface FingerprintEvent {
  /** First 12 lowercase hexadecimal characters of SHA-256(public key). */
  fingerprint: string
}

export interface ServerConnectionEvent extends FingerprintEvent {
  connections: number
}

export interface ServerListeningEvent {
  /** The server public-key fingerprint, despite this historical property name. */
  publicKey: string
}

export type ServerEvent = ServerConnectionEvent | FingerprintEvent | ServerListeningEvent
export type ServerEventName = 'connection' | 'revoked' | 'listening'

export interface ClientResultEvent {
  name: string
  status: UploadStatus | ErrorCode
}

export type ClientEvent = FingerprintEvent
export type ClientEventName = 'connection' | 'rejected-peer' | 'result' | 'skipped'

export class Server extends EventEmitter {
  constructor(options: ServerOptions)

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
  readonly listening: boolean
  readonly closed: boolean

  /** A fresh snapshot of the canonical lowercase hexadecimal uploader allowlist. */
  readonly allowedKeys: Set<string>

  /**
   * Initializes trusted storage, recovers journals, starts retention, joins the
   * server-only topic, and resolves with this server. Calls are coalesced.
   */
  listen(): Promise<this>
  /**
   * Atomically swaps the allowlist and revokes currently connected removed keys.
   * Resolves with a fresh canonical lowercase hexadecimal key set.
   */
  reloadAllowlist(keys: Iterable<AllowlistKey>): Promise<Set<string>>
  /**
   * Idempotently stops watching, sessions, transports, storage, and discovery.
   * May reject with AggregateError when cleanup fails.
   */
  close(): Promise<void>

  on(event: 'connection', listener: (event: ServerConnectionEvent) => void): this
  on(event: 'revoked', listener: (event: FingerprintEvent) => void): this
  on(event: 'listening', listener: (event: ServerListeningEvent) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this
  once(event: 'connection', listener: (event: ServerConnectionEvent) => void): this
  once(event: 'revoked', listener: (event: FingerprintEvent) => void): this
  once(event: 'listening', listener: (event: ServerListeningEvent) => void): this
  once(event: string | symbol, listener: (...args: any[]) => void): this
}

export class Client extends EventEmitter {
  constructor(options: ClientOptions)

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
  readonly closed: boolean

  /**
   * Uploads one file or the direct regular-file children of a directory.
   * Calls are serialized for this client identity.
   */
  upload(path: string): Promise<UploadResult | BatchUploadResult>
  /**
   * Idempotently aborts active and queued uploads, then disposes transport
   * resources. Aborted uploads reject with the ABORTED error code.
   */
  close(): Promise<void>

  on(event: 'connection' | 'rejected-peer', listener: (event: ClientEvent) => void): this
  on(event: 'result', listener: (event: ClientResultEvent) => void): this
  on(event: 'skipped', listener: (event: SkippedUploadEntry) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this
  once(event: 'connection' | 'rejected-peer', listener: (event: ClientEvent) => void): this
  once(event: 'result', listener: (event: ClientResultEvent) => void): this
  once(event: 'skipped', listener: (event: SkippedUploadEntry) => void): this
  once(event: string | symbol, listener: (...args: any[]) => void): this
}

export interface AllowlistWatcherOptions {
  filePath: string
  storage?: { readFile(path: string, encoding: string): Promise<string | Binary> }
  onReload(keys: Set<string>): void | Promise<void>
  pollInterval?: number
  scheduler?: Pick<ServerScheduler, 'setInterval' | 'clearInterval'>
  logger?: Logger | null
}

export interface AllowlistReloadedEvent {
  count: number
}

export interface AllowlistRemovedEvent {
  removed: number
}

export class AllowlistWatcher extends EventEmitter {
  constructor(options: AllowlistWatcherOptions)

  readonly filePath: string
  readonly pollInterval: number
  readonly keys: Set<string>
  readonly closed: boolean

  poll(): Promise<boolean>
  load(): Promise<boolean>
  startPolling(): void
  start(): Promise<void>
  close(): Promise<void>

  on(event: 'reloaded', listener: (event: AllowlistReloadedEvent) => void): this
  on(event: 'removed', listener: (event: AllowlistRemovedEvent) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this
  once(event: 'reloaded', listener: (event: AllowlistReloadedEvent) => void): this
  once(event: 'removed', listener: (event: AllowlistRemovedEvent) => void): this
  once(event: string | symbol, listener: (...args: any[]) => void): this
}

export interface Offer {
  version: number
  transferId: Fixed32
  name: string
  size: number
  digest: Fixed32
  chunkSize: number
  chunkCount: number
}

export interface Status {
  transferId: Fixed32
  code: StatusCode
  reason?: string
}

export interface BitmapPage {
  transferId: Fixed32
  start: number
  count: number
  bits: Binary
}

export interface Ready {
  transferId: Fixed32
}

export interface Chunk {
  transferId: Fixed32
  index: number
  digest: Fixed32
  data: Binary
}

export interface ChunkAck {
  transferId: Fixed32
  index: number
}

export interface Finish {
  transferId: Fixed32
}

export interface Result {
  transferId: Fixed32
  code: ResultCode
  reason?: string
}

export interface EncodingState {
  start: number
  end: number
  buffer: Binary
}

export interface Codec<T> {
  preencode(state: EncodingState, value: T): void
  encode(state: EncodingState, value: T): void
  decode(state: EncodingState): T
}

export interface TransferIdInput {
  clientPublicKey: Fixed32
  name: string
  size: number
  digest: Fixed32
  chunkSize: number
}

export const ERRORS: {
  readonly AUTH_REJECTED: 'AUTH_REJECTED'
  readonly SERVER_KEY_MISMATCH: 'SERVER_KEY_MISMATCH'
  readonly PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED'
  readonly PROTOCOL_INVALID: 'PROTOCOL_INVALID'
  readonly INVALID_FILENAME: 'INVALID_FILENAME'
  readonly INVALID_SEED: 'INVALID_SEED'
  readonly INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY'
  readonly FILE_TOO_LARGE: 'FILE_TOO_LARGE'
  readonly STAGING_LIMIT: 'STAGING_LIMIT'
  readonly DISK_RESERVE: 'DISK_RESERVE'
  readonly FILE_EXISTS: 'FILE_EXISTS'
  readonly FILE_BUSY: 'FILE_BUSY'
  readonly CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH'
  readonly UPLOAD_IDLE_TIMEOUT: 'UPLOAD_IDLE_TIMEOUT'
  readonly ABORTED: 'ABORTED'
  readonly SESSION_EXPIRED: 'SESSION_EXPIRED'
  readonly REVOKED: 'REVOKED'
  readonly COMMIT_FAILED: 'COMMIT_FAILED'
  readonly CLEANUP_FAILED: 'CLEANUP_FAILED'
}

export type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS]

export class SwarmDeployError extends Error {
  constructor(code: ErrorCode | string, message: string, cause?: unknown | null)
  code: ErrorCode | string
  cause: unknown | null
}

export const OFFER: 0
export const STATUS: 1
export const BITMAP_PAGE: 2
export const READY: 3
export const CHUNK: 4
export const CHUNK_ACK: 5
export const FINISH: 6
export const RESULT: 7

export const STATUS_CODE: {
  readonly ACCEPT: 0
  readonly ALREADY_COMMITTED: 1
  readonly FILE_EXISTS: 2
  readonly FILE_BUSY: 3
  readonly REJECTED: 4
}

export type StatusCode = (typeof STATUS_CODE)[keyof typeof STATUS_CODE]

export const RESULT_CODE: {
  readonly COMMITTED: 0
  readonly REJECTED: 1
}

export type ResultCode = (typeof RESULT_CODE)[keyof typeof RESULT_CODE]

export const PROTOCOL_VERSION: 1
export const DIGEST_BYTES: 32
export const TRANSFER_ID_BYTES: 32
export const MAX_CONTROL_BYTES: number
export const MAX_CHUNK_BYTES: 1048576
export const MAX_CHUNK_FRAME_BYTES: number
export const MAX_BITMAP_BITS: 65536

/** Parses a canonical lowercase 64-character seed and returns its 32-byte buffer. */
export function parseSeed(value: string): Seed
/** Parses a canonical lowercase 64-character public key and returns its 32-byte buffer. */
export function parsePublicKey(value: string): PublicKey
/** Generates a cryptographically random 32-byte seed. */
export function generateSeed(): Seed
/** Derives the HyperDHT key pair for a 32-byte seed. */
export function keyPairFromSeed(seed: Seed): KeyPair
/** Derives the 32-byte HyperDHT public key for a 32-byte seed. */
export function publicKeyFromSeed(seed: Seed): PublicKey
/** Derives the SHA-256 discovery topic for a pinned server public key. */
export function topicFromServerPublicKey(serverPublicKey: PublicKey): Topic

/** Returns a valid artifact basename or throws INVALID_FILENAME. */
export function validateBasename(name: string): string
/** Selects one regular file or sorted direct regular-file children for upload. */
export function selectUploadPaths(
  inputPath: string,
  options?: SelectUploadPathsOptions
): Promise<UploadPathSelection>
/** Builds a stable SHA-256 manifest and per-chunk SHA-256 digests for one regular file. */
export function buildFileManifest(
  filePath: string,
  options?: BuildFileManifestOptions
): Promise<FileManifest>

export function encodeBounded<T>(codec: Codec<T>, value: T, max?: number): Binary
export function decodeBounded<T>(codec: Codec<T>, buffer: Binary, max?: number): T
export const offer: Codec<Offer>
export const status: Codec<Status>
export const bitmapPage: Codec<BitmapPage>
export const ready: Codec<Ready>
export const chunk: Codec<Chunk>
export const chunkAck: Codec<ChunkAck>
export const finish: Codec<Finish>
export const result: Codec<Result>
export function mergeBitmapPages(pages: Iterable<BitmapPage>, chunkCount: number): Set<number>

export function transferId(input: TransferIdInput): TransferId
export function encodeTransferIdCanonical(input: TransferIdInput): Binary

/** Parses allowlist text into canonical lowercase public-key strings. */
export function parseAllowlist(text: string): Set<string>
