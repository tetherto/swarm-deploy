import b4a from 'b4a'
import events from '#events'
import { createAbortController, throwIfAborted, type AbortSignalLike } from './abort.js'
import {
  DirectDhtClient,
  type DirectDhtFactory,
  type DirectDhtNode,
  type DirectDhtSocket
} from './direct-dht.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { selectUploadTarget } from './files.js'
import { keyPairFromSeed } from './identity.js'
import {
  decodeDirectAdmission,
  decodeDirectFinal,
  DirectWireReader,
  endWrite,
  writeMetadata,
  writeTar
} from './tar-protocol/direct-wire.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest,
  type TarResumeResult
} from './tar-protocol/manifest.js'
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest,
  type TreeManifest
} from './tar-protocol/tree-manifest.js'
import type { AnyMetadataRecord } from './tar-protocol/controls.js'
import { sodiumSha256 } from './tar-protocol/hash.js'
import type {
  ArtifactKind,
  Digest,
  FingerprintEvent,
  Logger,
  PublicKey,
  PublicKeyInput,
  SeedInput,
  TransferId
} from './types.js'

const EventEmitter = events.EventEmitter
const DEFAULT_CONNECT_TIMEOUT = 30_000
const MAX_CONNECT_TIMEOUT = 5 * 60_000
const DEFAULT_IDLE_TIMEOUT = 60_000
const FINGERPRINT_LENGTH = 12

export type ClientLogger = Logger
export interface ClientOptions {
  seed: SeedInput
  serverPublicKey: PublicKeyInput
  connectTimeout?: number
  idleTimeout?: number
  /**
   * Send the immediate source directory name with the offer. Defaults to
   * `true`. Set it to `false` where the staging folder name is itself
   * sensitive; uploads then keep the legacy transfer identity and cannot match
   * a server pattern that needs a parent segment.
   */
  includeSourceParent?: boolean
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
  logger?: Logger | null
}
export type UploadStatus = 'COMMITTED' | 'ALREADY_COMMITTED'
export interface UploadResult {
  status: UploadStatus
  kind: ArtifactKind
  name: string
  /** Payload bytes: the file size, or the aggregate regular-file bytes of a tree. */
  size: number
  /** The file digest, or the canonical tree digest of a directory artifact. */
  digest: Digest
  transferId: TransferId
  /** Present only for a directory artifact. */
  entryCount?: number
}
export type ClientUploadResult = UploadResult
export interface ClientOfferEvent {
  status: 'offered' | 'accepted' | 'resumed' | 'reset' | 'rejected' | 'already-committed'
  name: string
  offset?: number
  reason?: ErrorCode
}
export interface ClientProgressEvent {
  name: string
  bytesSent: number
  totalBytes: number
}
export interface ClientResultEvent {
  name: string
  kind: ArtifactKind
  status: UploadStatus | ErrorCode
  final: boolean
}
export interface ClientEventMap {
  connection: FingerprintEvent
  'connection-open': FingerprintEvent
  'connection-close': FingerprintEvent
  offer: ClientOfferEvent
  progress: ClientProgressEvent
  verification: { name: string; status: 'started' | 'succeeded' | 'failed'; reason?: string }
  commit: { name: string; status: 'succeeded' | 'failed'; reason?: string }
  result: ClientResultEvent
  failure: FingerprintEvent & { reason: ErrorCode }
  close: { status: 'closed' }
}
export type ClientEventName = keyof ClientEventMap
export type ClientEvent = ClientEventMap[ClientEventName]

function fail(code: ErrorCode, message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(code, message, cause)
}
function key(value: unknown, label: string, code: ErrorCode): Buffer {
  if (!b4a.isBuffer(value) || value.byteLength !== 32) throw fail(code, `Invalid ${label}`)
  return b4a.from(value)
}
function duration(value: unknown, label: string, fallback: number): number {
  const actual = value ?? fallback
  if (
    !Number.isSafeInteger(actual) ||
    (actual as number) <= 0 ||
    (actual as number) > MAX_CONNECT_TIMEOUT
  ) {
    throw fail(ERRORS.PROTOCOL_INVALID, `Invalid ${label}`)
  }
  return actual as number
}
function codeOf(error: unknown): ErrorCode {
  return error instanceof SwarmDeployError &&
    Object.values(ERRORS).includes(error.code as ErrorCode)
    ? (error.code as ErrorCode)
    : ERRORS.PROTOCOL_INVALID
}
function fingerprint(value: Uint8Array): string {
  return b4a.toString(sodiumSha256(value), 'hex').slice(0, FINGERPRINT_LENGTH)
}
function logger(log: Logger | null | undefined): Required<Logger> {
  const call = (method: keyof Logger, message: string, details?: Record<string, unknown>): void => {
    try {
      log?.[method]?.(message, details)
    } catch {}
  }
  return {
    info: (m, d) => call('info', m, d),
    warn: (m, d) => call('warn', m, d),
    error: (m, d) => call('error', m, d)
  }
}

type AnyManifest = TarManifest | TreeManifest

function isTreeManifest(manifest: AnyManifest): manifest is TreeManifest {
  return 'kind' in manifest && manifest.kind === 'directory'
}
function manifestMetadata(manifest: AnyManifest, reset: boolean): AnyMetadataRecord {
  return isTreeManifest(manifest)
    ? treeMetadataFromManifest(manifest, reset)
    : metadataFromManifest(manifest, reset)
}
function manifestPayloadBytes(manifest: AnyManifest): number {
  return isTreeManifest(manifest) ? manifest.payloadBytes : manifest.fileSize
}
function manifestDigest(manifest: AnyManifest): Buffer {
  return isTreeManifest(manifest) ? manifest.treeSha256 : manifest.fileSha256
}
function regenerateSuffix(
  manifest: AnyManifest,
  offset: number,
  write: (chunk: Buffer) => void | Promise<void>,
  options: { signal: AbortSignalLike; expectedPrefixSha256: Uint8Array | null }
): Promise<TarResumeResult> {
  return isTreeManifest(manifest)
    ? regenerateTreeTarSuffix(manifest, offset, write, options)
    : regenerateTarSuffix(manifest, offset, write, options)
}

/** An authenticated, server-key-pinned direct HyperDHT uploader. */
export interface Client {
  on<EventName extends ClientEventName>(
    event: EventName,
    listener: (event: ClientEventMap[EventName]) => void
  ): this
  on(event: string | symbol, listener: (...args: never[]) => void): this
}
export class Client extends EventEmitter {
  readonly publicKey: PublicKey
  readonly serverPublicKey: PublicKey
  readonly connectTimeout: number
  readonly idleTimeout: number
  readonly includeSourceParent: boolean
  readonly logger: Required<Logger>
  private readonly direct: DirectDhtClient
  private readonly abort = createAbortController()
  private readonly signal: AbortSignalLike = this.abort.signal
  private queue = Promise.resolve()
  private closePromise: Promise<void> | null = null
  closed = false

  constructor(options: ClientOptions) {
    super()
    if (!options || typeof options !== 'object') {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid client options')
    }
    const keyPair = keyPairFromSeed(options.seed)
    this.serverPublicKey = key(
      options.serverPublicKey,
      'server public key',
      ERRORS.INVALID_PUBLIC_KEY
    )
    this.connectTimeout = duration(
      options.connectTimeout,
      'connect timeout',
      DEFAULT_CONNECT_TIMEOUT
    )
    this.idleTimeout = duration(options.idleTimeout, 'idle timeout', DEFAULT_IDLE_TIMEOUT)
    if (
      options.includeSourceParent !== undefined &&
      typeof options.includeSourceParent !== 'boolean'
    ) {
      throw fail(ERRORS.PROTOCOL_INVALID, 'Invalid source parent option')
    }
    this.includeSourceParent = options.includeSourceParent !== false
    this.publicKey = b4a.from(keyPair.publicKey)
    this.direct = new DirectDhtClient({
      keyPair,
      dht: options.dht,
      dhtFactory: options.dhtFactory,
      connectTimeout: this.connectTimeout
    })
    this.logger = logger(options.logger)
  }
  private emitSafe(type: string, payload: Record<string, unknown>): void {
    try {
      this.emit(type, payload)
    } catch {}
  }

  private async uploadManifest(manifest: AnyManifest, reset = false): Promise<UploadResult> {
    throwIfAborted(this.signal)
    const socket = await this.direct.connect(this.serverPublicKey, {
      signal: this.signal,
      timeout: this.connectTimeout
    })
    const remote = socket.remotePublicKey
    this.emitSafe('connection', { fingerprint: remote ? fingerprint(remote) : 'invalid' })
    this.emitSafe('connection-open', { fingerprint: remote ? fingerprint(remote) : 'invalid' })
    socket.once('close', () =>
      this.emitSafe('connection-close', {
        fingerprint: this.serverPublicKey ? fingerprint(this.serverPublicKey) : 'invalid'
      })
    )
    const reader = new DirectWireReader(socket)
    let verificationStarted = false
    try {
      const metadata = manifestMetadata(manifest, reset)
      await writeMetadata(socket, metadata, { signal: this.signal, timeout: this.idleTimeout })
      this.emitSafe('offer', { name: manifest.name, status: 'offered' })
      const admission = await reader.control(decodeDirectAdmission, this.signal, this.idleTimeout)
      if (admission.status === 'ALREADY_COMMITTED') {
        this.emitSafe('offer', { name: manifest.name, status: 'already-committed' })
        return this.result(manifest, 'ALREADY_COMMITTED')
      }
      if (admission.status === 'REJECTED') throw fail(admission.code, 'Server rejected upload')
      if (admission.status === 'VERIFIED') {
        this.emitSafe('verification', { name: manifest.name, status: 'started' })
        verificationStarted = true
        const final = await reader.control(decodeDirectFinal, this.signal, this.idleTimeout)
        if (final.status !== 'COMMITTED') throw fail(final.code, 'Server failed verified upload')
        this.emitSafe('verification', { name: manifest.name, status: 'succeeded' })
        this.emitSafe('commit', { name: manifest.name, status: 'succeeded' })
        return this.result(manifest, 'COMMITTED')
      }
      const offset = admission.offset
      const expected =
        admission.status === 'RESUME' ? b4a.from(admission.prefixSha256, 'hex') : null
      this.emitSafe('offer', {
        name: manifest.name,
        status: admission.status === 'RESUME' ? 'resumed' : 'accepted',
        offset
      })
      let progress = offset
      const regenerated = await regenerateSuffix(
        manifest,
        offset,
        async (chunk) => {
          await writeTar(socket, chunk, { signal: this.signal, timeout: this.idleTimeout })
          progress += chunk.byteLength
          this.emitSafe('progress', {
            name: manifest.name,
            bytesSent: progress,
            totalBytes: manifest.tarSize
          })
        },
        { signal: this.signal, expectedPrefixSha256: expected }
      )
      if (regenerated.status === 'RESET_REQUIRED') {
        if (reset) throw fail(ERRORS.PROTOCOL_INVALID, 'Reset retry also mismatched')
        this.emitSafe('offer', { name: manifest.name, status: 'reset', offset: 0 })
        reader.closeReader()
        socket.destroy()
        return this.uploadManifest(manifest, true)
      }
      if (regenerated.bytesSent !== manifest.tarSize - offset) {
        throw fail(ERRORS.PROTOCOL_INVALID, 'Incomplete deterministic TAR transfer')
      }
      if (progress !== manifest.tarSize) {
        progress = manifest.tarSize
        this.emitSafe('progress', {
          name: manifest.name,
          bytesSent: progress,
          totalBytes: manifest.tarSize
        })
      }
      this.emitSafe('verification', { name: manifest.name, status: 'started' })
      verificationStarted = true
      endWrite(socket)
      const final = await reader.control(decodeDirectFinal, this.signal, this.idleTimeout)
      if (final.status !== 'COMMITTED') {
        throw fail(final.code, 'Server failed upload')
      }
      this.emitSafe('verification', { name: manifest.name, status: 'succeeded' })
      this.emitSafe('commit', { name: manifest.name, status: 'succeeded' })
      return this.result(manifest, 'COMMITTED')
    } catch (error) {
      const reason = codeOf(error)
      if (verificationStarted) {
        this.emitSafe('verification', { name: manifest.name, status: 'failed', reason })
        this.emitSafe('commit', { name: manifest.name, status: 'failed', reason })
      }
      throw error
    } finally {
      reader.closeReader()
      try {
        socket.destroy()
      } catch {}
    }
  }

  private result(manifest: AnyManifest, status: UploadStatus): UploadResult {
    const kind: ArtifactKind = isTreeManifest(manifest) ? 'directory' : 'file'
    const result: UploadResult = {
      status,
      kind,
      name: manifest.name,
      size: manifestPayloadBytes(manifest),
      digest: b4a.from(manifestDigest(manifest)),
      transferId: b4a.from(manifest.transferId),
      ...(isTreeManifest(manifest) ? { entryCount: manifest.entryCount } : {})
    }
    this.logger.info('Direct upload completed', { name: result.name, status: result.status })
    this.emitSafe('result', { name: result.name, kind, status, final: true })
    return result
  }
  private async perform(inputPath: string): Promise<UploadResult> {
    if (typeof inputPath !== 'string' || !inputPath) {
      throw fail(ERRORS.INVALID_FILENAME, 'Invalid upload path')
    }
    const target = await selectUploadTarget(inputPath, { signal: this.signal })
    const options = { signal: this.signal, includeSourceParent: this.includeSourceParent }
    return this.uploadManifest(
      target.kind === 'directory'
        ? await buildTreeManifest(target.path, this.publicKey, options)
        : await buildTarManifest(target.path, this.publicKey, options)
    )
  }
  upload(inputPath: string): Promise<UploadResult> {
    if (this.closed) return Promise.reject(fail(ERRORS.ABORTED, 'Client is closed'))
    const operation = this.queue
      .then(() => this.perform(inputPath))
      .catch((error: unknown) => {
        const reason = codeOf(error)
        this.emitSafe('failure', { fingerprint: fingerprint(this.serverPublicKey), reason })
        throw error
      })
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.abort.abort()
    this.closePromise = this.queue
      .then(() => this.direct.close())
      .then(() => this.emitSafe('close', { status: 'closed' }))
    return this.closePromise
  }
}

export {
  DEFAULT_CONNECT_TIMEOUT,
  MAX_CONNECT_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  FINGERPRINT_LENGTH,
  fingerprint
}
