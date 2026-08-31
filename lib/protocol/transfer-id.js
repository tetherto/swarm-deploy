'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('#crypto')
const { SwarmDeployError, ERRORS } = require('../errors')
const { assertFixed32, assertSafeUint, assertBoundedChunkSize, isFixed32 } = require('./validation')

const TRANSFER_DOMAIN = 'swarm-deploy/transfer/v1'

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

const fixed32Bytes = {
  preencode(state, value) {
    if (!isFixed32(value)) throw new Error('Incorrect buffer size')
    state.end += 32
  },
  encode(state, value) {
    state.buffer.set(b4a.from(value), state.start)
    state.start += 32
  },
  decode(state) {
    if (state.end - state.start < 32) throw new Error('Out of bounds')
    return state.buffer.subarray(state.start, (state.start += 32))
  }
}

const transferIdCanonical = struct({
  domain: c.string,
  clientPublicKey: fixed32Bytes,
  name: c.string,
  size: c.uint,
  digest: fixed32Bytes,
  chunkSize: c.uint
})

function encodeTransferIdCanonical(input) {
  assertFixed32(input.clientPublicKey, 'clientPublicKey')
  assertFixed32(input.digest, 'digest')
  assertSafeUint(input.size, 'size')
  assertBoundedChunkSize(input.chunkSize, 'chunkSize')
  if (typeof input.name !== 'string') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
  }

  return c.encode(transferIdCanonical, {
    domain: TRANSFER_DOMAIN,
    clientPublicKey: input.clientPublicKey,
    name: input.name,
    size: input.size,
    digest: input.digest,
    chunkSize: input.chunkSize
  })
}

function transferId({ clientPublicKey, name, size, digest, chunkSize }) {
  return crypto
    .createHash('sha256')
    .update(
      encodeTransferIdCanonical({
        clientPublicKey,
        name,
        size,
        digest,
        chunkSize
      })
    )
    .digest()
}

module.exports = {
  TRANSFER_DOMAIN,
  transferIdCanonical,
  encodeTransferIdCanonical,
  transferId
}
