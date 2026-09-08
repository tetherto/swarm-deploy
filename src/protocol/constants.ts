import b4a from 'b4a'
import * as c from 'compact-encoding'

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

export type StatusCode = (typeof STATUS_CODE)[keyof typeof STATUS_CODE]

export const RESULT_CODE = {
  COMMITTED: 0,
  REJECTED: 1
} as const

export type ResultCode = (typeof RESULT_CODE)[keyof typeof RESULT_CODE]

export const PROTOCOL_VERSION = 1
export const DIGEST_BYTES = 32
export const TRANSFER_ID_BYTES = 32
export const MAX_CONTROL_BYTES = 16 * 1024
/** 1 MiB, spelled as a literal so the public declaration keeps its exact value. */
export const MAX_CHUNK_BYTES = 1_048_576
export const MAX_CHUNK_COUNT = 262_144

function computeMaxChunkFrameBytes(): number {
  const state = c.state()
  c.fixed32.preencode(state, b4a.alloc(32))
  c.uint.preencode(state, Number.MAX_SAFE_INTEGER)
  c.fixed32.preencode(state, b4a.alloc(32))
  c.buffer.preencode(state, b4a.alloc(MAX_CHUNK_BYTES))
  return state.end
}

export const MAX_CHUNK_FRAME_BYTES = computeMaxChunkFrameBytes()
export const MAX_BITMAP_BITS = 65_536
