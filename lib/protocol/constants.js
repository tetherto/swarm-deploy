'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')

const OFFER = 0
const STATUS = 1
const BITMAP_PAGE = 2
const READY = 3
const CHUNK = 4
const CHUNK_ACK = 5
const FINISH = 6
const RESULT = 7

const STATUS_CODE = {
  ACCEPT: 0,
  ALREADY_COMMITTED: 1,
  FILE_EXISTS: 2,
  FILE_BUSY: 3,
  REJECTED: 4
}

const PROTOCOL_VERSION = 1
const DIGEST_BYTES = 32
const TRANSFER_ID_BYTES = 32
const MAX_CONTROL_BYTES = 16 * 1024
const MAX_CHUNK_BYTES = 1024 * 1024
const MAX_BITMAP_BITS = 65536

function computeMaxChunkFrameBytes() {
  const chunkStruct = {
    transferId: c.fixed32,
    index: c.uint,
    digest: c.fixed32,
    data: c.buffer
  }
  const keys = Object.keys(chunkStruct)
  const state = c.state()
  const worst = {
    transferId: b4a.alloc(32),
    index: Number.MAX_SAFE_INTEGER,
    digest: b4a.alloc(32),
    data: b4a.alloc(MAX_CHUNK_BYTES)
  }
  for (const key of keys) chunkStruct[key].preencode(state, worst[key])
  return state.end
}

const MAX_CHUNK_FRAME_BYTES = computeMaxChunkFrameBytes()

module.exports = {
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  PROTOCOL_VERSION,
  DIGEST_BYTES,
  TRANSFER_ID_BYTES,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
}
