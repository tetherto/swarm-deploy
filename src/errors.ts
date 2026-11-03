import { errorCode } from './error-code.js'
import type { HookResult, UploadHookResult } from './hook-result.js'

export const ERRORS = {
  AUTH_REJECTED: 'AUTH_REJECTED',
  SERVER_KEY_MISMATCH: 'SERVER_KEY_MISMATCH',
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  INVALID_FILENAME: 'INVALID_FILENAME',
  INVALID_SEED: 'INVALID_SEED',
  INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  STAGING_LIMIT: 'STAGING_LIMIT',
  ACTIVE_UPLOAD_LIMIT: 'ACTIVE_UPLOAD_LIMIT',
  DISK_RESERVE: 'DISK_RESERVE',
  FILE_EXISTS: 'FILE_EXISTS',
  FILE_BUSY: 'FILE_BUSY',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  CONNECT_TIMEOUT: 'CONNECT_TIMEOUT',
  UPLOAD_IDLE_TIMEOUT: 'UPLOAD_IDLE_TIMEOUT',
  ABORTED: 'ABORTED',
  COMMIT_FAILED: 'COMMIT_FAILED',
  LINK_CONFLICT: 'LINK_CONFLICT',
  LINK_FAILED: 'LINK_FAILED',
  LINK_NOT_ALLOWED: 'LINK_NOT_ALLOWED',
  LINK_TARGET_NOT_FOUND: 'LINK_TARGET_NOT_FOUND',
  UNSUPPORTED_STORAGE: 'UNSUPPORTED_STORAGE',
  HOOK_FAILED: 'HOOK_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  SERVER_ERROR: 'SERVER_ERROR'
} as const

export type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS]

/** The request a client failure belongs to. */
export type RequestOperation = 'upload' | 'link'
/**
 * Where in a request a client failure surfaced: `connect` is the DHT lookup, the key
 * check and the handshake; `request` is sending the offer or link request; `admission`
 * is waiting for the server's decision on an upload offer; `streaming` is sending the
 * artifact; `final` is waiting for the terminal answer (an upload's outcome or a link's result).
 */
export type RequestPhase = 'connect' | 'request' | 'admission' | 'streaming' | 'final'

/**
 * What each stable code means when a server reports it, in words that carry no server
 * text, path, environment or hook detail. A client may show them; they never come from the wire.
 */
const CODE_SUMMARIES: Record<ErrorCode, string> = {
  AUTH_REJECTED: 'the server did not accept this client key',
  SERVER_KEY_MISMATCH: 'the connected server is not the pinned server key',
  PROTOCOL_INVALID:
    'the server reported a protocol or storage-state check failure; see the server log',
  INVALID_FILENAME: 'the artifact name is not allowed by the server',
  INVALID_SEED: 'the seed is not valid',
  INVALID_PUBLIC_KEY: 'a public key is not valid',
  FILE_TOO_LARGE: 'the artifact exceeds the size the server accepts',
  STAGING_LIMIT: 'the server has no staging space left for this upload',
  ACTIVE_UPLOAD_LIMIT: 'the server is receiving its maximum number of uploads; retry later',
  DISK_RESERVE: 'the server does not have enough free disk space or quota',
  FILE_EXISTS: 'the destination name already exists on the server',
  FILE_BUSY: 'the same transfer is already in progress on the server; retry later',
  CHECKSUM_MISMATCH: 'the data the server received did not match the offered checksum',
  CONNECT_TIMEOUT: 'the server could not be reached in time',
  UPLOAD_IDLE_TIMEOUT: 'the transfer timed out waiting for the other side',
  ABORTED: 'the operation was aborted, for example because the server is shutting down',
  COMMIT_FAILED: 'the server could not write or commit the upload',
  LINK_CONFLICT: 'the link name conflicts with an existing artifact or unmanaged path',
  LINK_FAILED: 'the server could not complete the link operation',
  LINK_NOT_ALLOWED: 'the server does not allow this link',
  LINK_TARGET_NOT_FOUND: 'the link target is not a managed artifact on the server',
  UNSUPPORTED_STORAGE: 'the server storage does not support this operation',
  HOOK_FAILED: 'a server deployment hook failed; see the server log',
  CLEANUP_FAILED: 'the server could not finish its cleanup',
  SERVER_ERROR: 'the server hit an unexpected error; see the server log'
}

export function isStableCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_SUMMARIES, code)
}

/** A fixed, safe explanation of a stable code. */
export function summarizeCode(code: ErrorCode): string {
  return CODE_SUMMARIES[code]
}

/**
 * The errno names a server may log for a raw failure, and the stable code each maps to (`null`:
 * named in the log only). A closed list: no other error text, path, or message is ever logged or
 * sent because of a failure.
 */
const SYSTEM_CODES: Record<string, ErrorCode | null> = {
  ENOSPC: ERRORS.DISK_RESERVE,
  EDQUOT: ERRORS.DISK_RESERVE,
  EXDEV: ERRORS.UNSUPPORTED_STORAGE,
  ENOSYS: ERRORS.UNSUPPORTED_STORAGE,
  ENOTSUP: ERRORS.UNSUPPORTED_STORAGE,
  EACCES: ERRORS.COMMIT_FAILED,
  EPERM: ERRORS.COMMIT_FAILED,
  EROFS: ERRORS.COMMIT_FAILED,
  EIO: ERRORS.COMMIT_FAILED,
  ENOENT: null,
  EEXIST: null,
  ENOTEMPTY: null,
  EBUSY: null,
  EMFILE: null,
  ENFILE: null,
  ENOTDIR: null,
  EISDIR: null,
  ELOOP: null,
  ENAMETOOLONG: null
}

function knownSystemCode(value: unknown): string | null {
  const code = errorCode(value)
  return code !== null && Object.prototype.hasOwnProperty.call(SYSTEM_CODES, code) ? code : null
}

/**
 * The errno name of a failure, from the error itself or from one level of its `cause`, when it
 * is one of the known ones; `null` otherwise.
 */
export function systemCodeOf(error: unknown): string | null {
  const own = knownSystemCode(error)
  if (own !== null) return own
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : null
  return knownSystemCode(cause)
}

/**
 * The stable code a server reports for a failure. An explicit `SwarmDeployError` keeps its stable
 * code, so a malformed request, and a storage layer that wraps a failure in its own
 * `PROTOCOL_INVALID` guard, both stay `PROTOCOL_INVALID`. A raw error that reaches this function
 * unwrapped and has a known errno maps to the code that names it (a full or over-quota disk,
 * storage that cannot do the operation, a write or commit that was refused), and any other raw
 * error the server did not expect is `SERVER_ERROR`.
 */
export function failureCodeOf(error: unknown): ErrorCode {
  if (error instanceof SwarmDeployError) {
    return isStableCode(error.code) ? error.code : ERRORS.SERVER_ERROR
  }
  const system = systemCodeOf(error)
  return (system === null ? null : SYSTEM_CODES[system]) ?? ERRORS.SERVER_ERROR
}

export class SwarmDeployError extends Error {
  // `declare` keeps these out of the emitted class body so instances gain own
  // properties only where the runtime assigns them, exactly as before.
  declare code: ErrorCode | string
  declare cause: unknown | null
  /**
   * True when the connection failed or closed and the server gave no reason: the code
   * then says nothing about what the server did or why.
   */
  declare transport?: boolean
  /**
   * True only on a client error built from an answer the server wrote: the code is the
   * server's own. Never set together with `transport`.
   */
  declare remote?: boolean
  /** The request this client error belongs to, when it is known. */
  declare operation?: RequestOperation
  /** Where in that request it surfaced, when it is known. */
  declare phase?: RequestPhase
  /**
   * Set on a client error only when the request asked for hook data and the
   * server's response-declared `onFailure` hook returned some with the failed
   * answer. The code above is always the primary failure's.
   */
  declare hookResult?: HookResult | UploadHookResult

  constructor(code: ErrorCode | string, message: string, cause: unknown | null = null) {
    super(message)
    this.name = 'SwarmDeployError'
    this.code = code
    this.cause = cause
  }
}
