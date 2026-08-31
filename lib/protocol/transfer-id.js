'use strict'

const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('#crypto')
const { SwarmDeployError, ERRORS } = require('../errors')

const TRANSFER_DOMAIN = 'swarm-deploy/transfer/v1'
const transferTuple = c.array(c.any)

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

function transferId({ clientPublicKey, name, size, digest, chunkSize }) {
  assertFixed32(clientPublicKey, 'clientPublicKey')
  assertFixed32(digest, 'digest')
  assertSafeUint(size, 'size')
  assertPositiveSafeUint(chunkSize, 'chunkSize')
  if (typeof name !== 'string') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
  }

  const tuple = [TRANSFER_DOMAIN, clientPublicKey, name, size, digest, chunkSize]
  return crypto.createHash('sha256').update(c.encode(transferTuple, tuple)).digest()
}

module.exports = {
  transferId
}
