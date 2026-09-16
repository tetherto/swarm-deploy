import b4a from 'b4a'
import { onAbort, abortError, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { encodeControlFrame } from './controls.js'

export interface ProtocolWritable {
  write(bytes: Uint8Array): boolean
  on(event: string, listener: (...args: unknown[]) => void): this
  removeListener(event: string, listener: (...args: unknown[]) => void): this
  destroy(error?: unknown): void
}

export interface ProtocolWriteOptions {
  signal?: AbortSignalLike | null
  timeout?: number
}

const DEFAULT_WRITE_TIMEOUT = 60_000
const MAX_TIMEOUT = 0x7fffffff

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function closedBeforeDrain(): SwarmDeployError {
  const error = invalid('Protocol stream closed before drain')
  error.transport = true
  return error
}

function assertTimeout(timeout: number): void {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw invalid('Invalid protocol write timeout')
  }
}

export function writeProtocolBytes(
  stream: ProtocolWritable,
  bytes: Uint8Array,
  { signal = null, timeout = DEFAULT_WRITE_TIMEOUT }: ProtocolWriteOptions = {}
): Promise<void> {
  if (!stream || typeof stream.write !== 'function' || typeof stream.destroy !== 'function') {
    return Promise.reject(invalid('Invalid protocol stream'))
  }
  if (!b4a.isBuffer(bytes)) return Promise.reject(invalid('Invalid protocol bytes'))
  try {
    assertTimeout(timeout)
    if (signal?.aborted) throw abortError()
    if ((stream as ProtocolWritable & { readonly destroyed?: boolean }).destroyed === true) {
      throw closedBeforeDrain()
    }
    if (stream.write(bytes)) return Promise.resolve()
    if ((stream as ProtocolWritable & { readonly destroyed?: boolean }).destroyed === true) {
      throw closedBeforeDrain()
    }
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let removeAbort = () => {}
    const timer = setTimeout(
      () =>
        finish(new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Protocol write drain timed out')),
      timeout
    )

    const cleanup = (): void => {
      clearTimeout(timer)
      removeAbort()
      stream.removeListener('drain', onDrain)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
    }
    const finish = (error: unknown = null): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === null) {
        resolve()
        return
      }
      try {
        stream.destroy(error)
      } catch {}
      reject(error)
    }
    const onDrain = (): void => finish()
    const onError = (error: unknown): void =>
      finish(error instanceof Error ? error : invalid('Protocol stream failed', error))
    const onClose = (): void => finish(closedBeforeDrain())

    stream.on('drain', onDrain)
    stream.on('error', onError)
    stream.on('close', onClose)
    removeAbort = onAbort(signal, () => finish(abortError()))
    if ((stream as ProtocolWritable & { readonly destroyed?: boolean }).destroyed === true) {
      finish(closedBeforeDrain())
    }
  })
}

export function writeFramedProtocolRecord(
  stream: ProtocolWritable,
  record: Uint8Array,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeProtocolBytes(stream, encodeControlFrame(record), options)
}
