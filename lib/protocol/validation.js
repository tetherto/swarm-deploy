'use strict'

const b4a = require('b4a')
const { SwarmDeployError, ERRORS } = require('../errors')
const { MAX_CHUNK_BYTES } = require('./constants')

function isFixed32(value) {
  return (b4a.isBuffer(value) || value instanceof Uint8Array) && value.byteLength === 32
}

function assertFixed32(value, name) {
  if (!isFixed32(value)) {
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

function assertBoundedChunkSize(value, name) {
  assertPositiveSafeUint(value, name)
  if (value > MAX_CHUNK_BYTES) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

module.exports = {
  isFixed32,
  assertFixed32,
  assertSafeUint,
  assertPositiveSafeUint,
  assertBoundedChunkSize
}
