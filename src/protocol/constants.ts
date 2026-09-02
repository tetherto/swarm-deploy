export const OFFER = 0
export const STATUS = 1
export const BITMAP_PAGE = 2
export const READY = 3
export const CHUNK = 4
export const CHUNK_ACK = 5
export const FINISH = 6
export const RESULT = 7

export const STATUS_CODE = {
  ACCEPT: 0,
  ALREADY_COMMITTED: 1,
  FILE_EXISTS: 2,
  FILE_BUSY: 3,
  REJECTED: 4
} as const

export const RESULT_CODE = {
  COMMITTED: 0,
  REJECTED: 1
} as const

export const PROTOCOL_VERSION = 1
export const DIGEST_BYTES = 32
export const TRANSFER_ID_BYTES = 32
export const MAX_CONTROL_BYTES = 16 * 1024
export const MAX_CHUNK_BYTES = 1024 * 1024
export const MAX_CHUNK_COUNT = 262_144
// The compact-encoding preflight for the fixed CHUNK frame evaluates to this
// deterministic value for the protocol's maximum payload.
export const MAX_CHUNK_FRAME_BYTES = 1_048_654
export const MAX_BITMAP_BITS = 65_536
