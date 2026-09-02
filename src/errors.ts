export const ERRORS = {
  AUTH_REJECTED: 'AUTH_REJECTED',
  SERVER_KEY_MISMATCH: 'SERVER_KEY_MISMATCH',
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  INVALID_FILENAME: 'INVALID_FILENAME',
  INVALID_SEED: 'INVALID_SEED',
  INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  STAGING_LIMIT: 'STAGING_LIMIT',
  DISK_RESERVE: 'DISK_RESERVE',
  FILE_EXISTS: 'FILE_EXISTS',
  FILE_BUSY: 'FILE_BUSY',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  UPLOAD_IDLE_TIMEOUT: 'UPLOAD_IDLE_TIMEOUT',
  ABORTED: 'ABORTED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REVOKED: 'REVOKED',
  COMMIT_FAILED: 'COMMIT_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED'
} as const

export type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS]

export class SwarmDeployError extends Error {
  // `declare` keeps these out of the emitted class body so instances gain own
  // properties only where the runtime assigns them, exactly as before.
  declare code: ErrorCode | string
  declare cause: unknown | null
  declare transport?: boolean

  constructor(code: ErrorCode | string, message: string, cause: unknown | null = null) {
    super(message)
    this.name = 'SwarmDeployError'
    this.code = code
    this.cause = cause
  }
}
