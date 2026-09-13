import b4a from 'b4a'
import { abortError, onAbort, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import type { DirectDhtSocket } from '../direct-dht.js'
import {
  decodeAdmissionRecord,
  decodeFinalRecord,
  decodeMetadataRecord,
  encodeAdmissionRecord,
  encodeFinalRecord,
  encodeMetadataRecord,
  MAX_CONTROL_RECORD_BYTES,
  type AdmissionRecord,
  type FinalRecord,
  type MetadataRecord
} from './controls.js'
import {
  writeFramedProtocolRecord,
  writeProtocolBytes,
  type ProtocolWriteOptions
} from './lifecycle.js'

type StreamSocket = DirectDhtSocket & {
  on(event: 'data' | 'end' | 'close' | 'error', listener: (...args: never[]) => void): StreamSocket
  removeListener(
    event: 'data' | 'end' | 'close' | 'error',
    listener: (...args: never[]) => void
  ): StreamSocket
  pause?(): void
  resume?(): void
  end?(): void
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

/** Exact, bounded, phase-aware reader for a half-closed direct stream. */
export class DirectWireReader {
  private readonly socket: StreamSocket
  private readonly chunks: Buffer[] = []
  private available = 0
  private ended = false
  private failure: Error | null = null
  private wake: (() => void) | null = null
  private readonly data = (value: Buffer): void => {
    if (!b4a.isBuffer(value) || value.byteLength === 0) return
    this.chunks.push(b4a.from(value))
    this.available += value.byteLength
    this.socket.pause?.()
    this.notify()
  }
  private readonly end = (): void => {
    this.ended = true
    this.notify()
  }
  private readonly close = (): void => {
    if (!this.ended) this.failure = invalid('Direct DHT stream closed without protocol completion')
    this.notify()
  }
  private readonly error = (error: Error): void => {
    this.failure = error
    this.notify()
  }

  constructor(socket: DirectDhtSocket) {
    this.socket = socket as StreamSocket
    this.socket.on('data', this.data as never)
    this.socket.on('end', this.end as never)
    this.socket.on('close', this.close as never)
    this.socket.on('error', this.error as never)
    this.socket.pause?.()
  }
  private notify(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
  private async wait(signal: AbortSignalLike | null | undefined, timeout: number): Promise<void> {
    if (this.available > 0) return
    if (this.failure) throw this.failure
    if (this.ended) throw invalid('Truncated direct protocol phase')
    if (signal?.aborted) throw abortError()
    await new Promise<void>((resolve, reject) => {
      let remove = () => {}
      const timer = setTimeout(
        () =>
          finish(
            new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Direct protocol read timed out')
          ),
        timeout
      )
      const finish = (error: Error | null = null): void => {
        clearTimeout(timer)
        remove()
        this.wake = null
        if (error) reject(error)
        else resolve()
      }
      remove = onAbort(signal, () => finish(abortError()))
      this.wake = () => finish(this.failure)
      this.socket.resume?.()
    })
  }
  async exact(
    bytes: number,
    signal: AbortSignalLike | null | undefined,
    timeout: number
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalid('Invalid direct stream length')
    const result = b4a.alloc(bytes)
    let offset = 0
    while (offset < bytes) {
      await this.wait(signal, timeout)
      const chunk = this.chunks[0]
      const take = Math.min(bytes - offset, chunk.byteLength)
      result.set(chunk.subarray(0, take), offset)
      offset += take
      this.available -= take
      if (take === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
    }
    return result
  }
  async control<T>(
    decode: (bytes: Uint8Array) => T,
    signal: AbortSignalLike | null | undefined,
    timeout: number
  ): Promise<T> {
    const prefix = await this.exact(4, signal, timeout)
    const length = prefix[0] * 0x1000000 + prefix[1] * 0x10000 + prefix[2] * 0x100 + prefix[3]
    if (length <= 0 || length > MAX_CONTROL_RECORD_BYTES) {
      throw invalid('Invalid control frame length')
    }
    return decode(await this.exact(length, signal, timeout))
  }
  async tar(
    length: number,
    write: (bytes: Buffer) => Promise<void>,
    signal: AbortSignalLike | null | undefined,
    timeout: number
  ): Promise<void> {
    let remaining = length
    while (remaining > 0) {
      await this.wait(signal, timeout)
      const chunk = this.chunks[0]
      const take = Math.min(remaining, chunk.byteLength)
      const part = chunk.subarray(0, take)
      this.available -= take
      remaining -= take
      if (take === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
      await write(part)
    }
  }
  /** The sender's write-half close is the deterministic no-trailing boundary. */
  async requireEnd(signal: AbortSignalLike | null | undefined, timeout: number): Promise<void> {
    while (!this.ended && !this.failure) await this.wait(signal, timeout)
    if (this.failure) throw this.failure
    if (this.available !== 0) throw invalid('Trailing bytes after exact TAR payload')
  }
  closeReader(): void {
    for (const event of ['data', 'end', 'close', 'error'] as const) {
      const listener =
        event === 'data'
          ? this.data
          : event === 'end'
            ? this.end
            : event === 'close'
              ? this.close
              : this.error
      this.socket.removeListener(event, listener as never)
    }
  }
}

export function endWrite(socket: DirectDhtSocket): void {
  const stream = socket as StreamSocket
  if (typeof stream.end !== 'function') throw invalid('Direct DHT socket cannot close write half')
  stream.end()
}
export function writeMetadata(
  socket: DirectDhtSocket,
  metadata: MetadataRecord,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeFramedProtocolRecord(socket as never, encodeMetadataRecord(metadata), options)
}
export function writeAdmission(
  socket: DirectDhtSocket,
  value: AdmissionRecord,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeFramedProtocolRecord(socket as never, encodeAdmissionRecord(value), options)
}
export function writeFinal(
  socket: DirectDhtSocket,
  value: FinalRecord,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeFramedProtocolRecord(socket as never, encodeFinalRecord(value), options)
}
export function writeTar(
  socket: DirectDhtSocket,
  value: Uint8Array,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeProtocolBytes(socket as never, value, options)
}
export const decodeDirectMetadata = decodeMetadataRecord
export const decodeDirectAdmission = decodeAdmissionRecord
export const decodeDirectFinal = decodeFinalRecord
