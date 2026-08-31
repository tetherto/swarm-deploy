'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const { SwarmDeployError, ERRORS } = require('../errors')
const {
  STATUS_CODE,
  PROTOCOL_VERSION,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_BITMAP_BITS
} = require('./constants')

function struct(fields) {
  const keys = Object.keys(fields)
  return {
    preencode(state, obj) {
      for (const key of keys) fields[key].preencode(state, obj[key])
    },
    encode(state, obj) {
      for (const key of keys) fields[key].encode(state, obj[key])
    },
    decode(state) {
      const obj = {}
      for (const key of keys) obj[key] = fields[key].decode(state)
      return obj
    }
  }
}

function validatedCodec(raw, validate) {
  return {
    preencode(state, value) {
      validate(value)
      raw.preencode(state, value)
    },
    encode(state, value) {
      validate(value)
      raw.encode(state, value)
    },
    decode(state) {
      const value = raw.decode(state)
      validate(value)
      return value
    }
  }
}

function assertFixed32(value, name) {
  if (!b4a.isBuffer(value) || value.byteLength !== 32) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

function assertSafeUint(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

function assertPositiveSafeUint(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

function assertStatusCode(code) {
  assertSafeUint(code, 'code')
  if (
    code !== STATUS_CODE.ACCEPT &&
    code !== STATUS_CODE.ALREADY_COMMITTED &&
    code !== STATUS_CODE.FILE_EXISTS &&
    code !== STATUS_CODE.FILE_BUSY &&
    code !== STATUS_CODE.REJECTED
  ) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid status code')
  }
}

function expectedBitmapBytes(count) {
  return Math.ceil(count / 8)
}

function validateBitmapPage(value) {
  assertFixed32(value.transferId, 'transferId')
  assertSafeUint(value.start, 'start')
  assertPositiveSafeUint(value.count, 'count')
  if (value.count > MAX_BITMAP_BITS) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid bitmap page count')
  }
  if (!b4a.isBuffer(value.bits) || value.bits.byteLength !== expectedBitmapBytes(value.count)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid bitmap page bits')
  }
}

function bitIsSet(bits, offset) {
  const byteIndex = Math.floor(offset / 8)
  const bitIndex = offset % 8
  return (bits[byteIndex] & (1 << bitIndex)) !== 0
}

function mergeBitmapPages(pages, chunkCount) {
  assertSafeUint(chunkCount, 'chunkCount')
  const verified = new Set()
  const sorted = [...pages].sort((a, b) => a.start - b.start)
  let rangeEnd = 0

  for (const page of sorted) {
    validateBitmapPage(page)
    if (page.start + page.count > chunkCount) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Bitmap page out of range')
    }
    if (page.start < rangeEnd) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Overlapping bitmap pages')
    }
    rangeEnd = page.start + page.count

    for (let i = 0; i < page.count; i++) {
      if (!bitIsSet(page.bits, i)) continue
      verified.add(page.start + i)
    }
  }

  return verified
}

function protocolInvalid(cause) {
  if (cause instanceof SwarmDeployError) return cause
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid protocol message', cause)
}

function encodeBounded(codec, value, max = MAX_CONTROL_BYTES) {
  let buf
  try {
    buf = c.encode(codec, value)
  } catch (err) {
    throw protocolInvalid(err)
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }
  return buf
}

function decodeBounded(codec, buf, max = MAX_CONTROL_BYTES) {
  if (!b4a.isBuffer(buf)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid message buffer')
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }

  const state = c.state(0, buf.byteLength, buf)
  let value
  try {
    value = codec.decode(state)
  } catch (err) {
    throw protocolInvalid(err)
  }
  if (state.start !== state.end) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Trailing message bytes')
  }
  return value
}

const offer = validatedCodec(
  struct({
    version: c.uint,
    transferId: c.fixed32,
    name: c.string,
    size: c.uint,
    digest: c.fixed32,
    chunkSize: c.uint,
    chunkCount: c.uint
  }),
  (value) => {
    assertSafeUint(value.version, 'version')
    if (value.version !== PROTOCOL_VERSION) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid protocol version')
    }
    assertFixed32(value.transferId, 'transferId')
    if (typeof value.name !== 'string') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
    }
    assertSafeUint(value.size, 'size')
    assertFixed32(value.digest, 'digest')
    assertPositiveSafeUint(value.chunkSize, 'chunkSize')
    assertSafeUint(value.chunkCount, 'chunkCount')
  }
)

const status = validatedCodec(
  struct({
    transferId: c.fixed32,
    code: c.uint,
    reason: c.string
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
    assertStatusCode(value.code)
    if (value.reason === undefined) value.reason = ''
    if (typeof value.reason !== 'string') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid reason')
    }
  }
)

const bitmapPage = validatedCodec(
  struct({
    transferId: c.fixed32,
    start: c.uint,
    count: c.uint,
    bits: c.buffer
  }),
  validateBitmapPage
)

const ready = validatedCodec(
  struct({
    transferId: c.fixed32
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
  }
)

const finish = validatedCodec(
  struct({
    transferId: c.fixed32
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
  }
)

const chunk = validatedCodec(
  struct({
    transferId: c.fixed32,
    index: c.uint,
    digest: c.fixed32,
    data: c.buffer
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.index, 'index')
    assertFixed32(value.digest, 'digest')
    if (!b4a.isBuffer(value.data) || value.data.byteLength > MAX_CHUNK_BYTES) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid chunk data')
    }
  }
)

const chunkAck = validatedCodec(
  struct({
    transferId: c.fixed32,
    index: c.uint
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.index, 'index')
  }
)

const result = validatedCodec(
  struct({
    transferId: c.fixed32,
    code: c.uint,
    reason: c.string
  }),
  (value) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.code, 'code')
    if (value.reason === undefined) value.reason = ''
    if (typeof value.reason !== 'string') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid reason')
    }
  }
)

module.exports = {
  encodeBounded,
  decodeBounded,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result,
  mergeBitmapPages
}
