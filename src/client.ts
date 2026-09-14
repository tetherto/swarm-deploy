import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import { createAbortController, throwIfAborted, type AbortSignalLike } from './abort.js'
import {
  DirectDhtClient,
  type DirectDhtFactory,
  type DirectDhtNode,
  type DirectDhtSocket
} from './direct-dht.js'
import { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
import { selectUploadPaths, type SkippedUploadReason } from './files.js'
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
  type TarManifest
} from './tar-protocol/manifest.js'
import { sodiumSha256 } from './tar-protocol/hash.js'
import type {
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
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
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
  name?: string
  status: UploadStatus | ErrorCode | 'COMMITTED' | 'FAILED'
  final: boolean
  files?: number
  committed?: number
  failed?: number
  skipped?: number
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
  skipped: { name: string; reason: SkippedUploadReason }
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
    const seed = key(options.seed, 'client seed', ERRORS.INVALID_SEED)
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
    this.publicKey = b4a.from(keyPairFromSeed(seed).publicKey)
    this.direct = new DirectDhtClient({
      keyPair: keyPairFromSeed(seed),
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

  private async uploadManifest(
    manifest: TarManifest,
    reset = false,
    emitFinal = true
  ): Promise<UploadResult> {
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
      const metadata = metadataFromManifest(manifest, reset)
      await writeMetadata(socket, metadata, { signal: this.signal, timeout: this.idleTimeout })
      this.emitSafe('offer', { name: manifest.name, status: 'offered' })
      const admission = await reader.control(decodeDirectAdmission, this.signal, this.idleTimeout)
      if (admission.status === 'ALREADY_COMMITTED') {
        this.emitSafe('offer', { name: manifest.name, status: 'already-committed' })
        return this.result(manifest, 'ALREADY_COMMITTED', emitFinal)
      }
      if (admission.status === 'REJECTED') throw fail(admission.code, 'Server rejected upload')
      if (admission.status === 'VERIFIED') {
        this.emitSafe('verification', { name: manifest.name, status: 'started' })
        verificationStarted = true
        const final = await reader.control(decodeDirectFinal, this.signal, this.idleTimeout)
        if (final.status !== 'COMMITTED') throw fail(final.code, 'Server failed verified upload')
        this.emitSafe('verification', { name: manifest.name, status: 'succeeded' })
        this.emitSafe('commit', { name: manifest.name, status: 'succeeded' })
        return this.result(manifest, 'COMMITTED', emitFinal)
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
      const regenerated = await regenerateTarSuffix(
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
        return this.uploadManifest(manifest, true, emitFinal)
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
      return this.result(manifest, 'COMMITTED', emitFinal)
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

  private result(manifest: TarManifest, status: UploadStatus, final: boolean): UploadResult {
    const result = {
      status,
      name: manifest.name,
      size: manifest.fileSize,
      digest: b4a.from(manifest.fileSha256),
      transferId: b4a.from(manifest.transferId)
    }
    this.logger.info('Direct upload completed', { name: result.name, status: result.status })
    this.emitSafe('result', { name: result.name, status, final })
    return result
  }
  private async perform(inputPath: string): Promise<ClientUploadResult> {
    if (typeof inputPath !== 'string' || !inputPath) {
      throw fail(ERRORS.INVALID_FILENAME, 'Invalid upload path')
    }
    const root = await fs.promises.lstat(inputPath)
    const selection = await selectUploadPaths(inputPath, { signal: this.signal })
    if (!root.isDirectory()) {
      return this.uploadManifest(
        await buildTarManifest(selection.paths[0], this.publicKey, { signal: this.signal })
      )
    }
    const results: Array<UploadResult | BatchUploadFailure> = []
    for (const skipped of selection.skipped) {
      this.emitSafe('skipped', { name: skipped.name, reason: skipped.reason })
    }
    for (const entry of selection.entries) {
      if (entry.kind === 'skipped') continue
      if (entry.kind === 'failed') {
        results.push({ name: entry.name, status: ERRORS.PROTOCOL_INVALID, reason: entry.reason })
        continue
      }
      try {
        results.push(
          await this.uploadManifest(
            await buildTarManifest(entry.path, this.publicKey, { signal: this.signal }),
            false,
            false
          )
        )
      } catch (error) {
        const status = codeOf(error)
        results.push({ name: entry.name, status })
        this.emitSafe('result', { name: entry.name, status, final: false })
      }
    }
    const failed = results.some(
      (result) => result.status !== 'COMMITTED' && result.status !== 'ALREADY_COMMITTED'
    )
    const result: BatchUploadResult = {
      status: failed ? 'FAILED' : 'COMMITTED',
      results,
      skipped: selection.skipped
    }
    const committed = results.filter(
      (entry) => entry.status === 'COMMITTED' || entry.status === 'ALREADY_COMMITTED'
    ).length
    this.emitSafe('result', {
      status: result.status,
      final: true,
      files: results.length,
      committed,
      failed: results.length - committed,
      skipped: selection.skipped.length
    })
    return result
  }
  upload(inputPath: string): Promise<ClientUploadResult> {
    if (this.closed) return Promise.reject(fail(ERRORS.ABORTED, 'Client is closed'))
    const operation = this.queue
      .then(() => this.perform(inputPath))
      .catch((error: unknown) => {
        const reason = codeOf(error)
        this.emitSafe('failure', { fingerprint: fingerprint(this.serverPublicKey), reason })
        this.emitSafe('result', { status: reason, final: true })
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
