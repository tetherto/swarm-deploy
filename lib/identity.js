'use strict'

const DHT = require('hyperdht')
const b4a = require('b4a')
const crypto = require('#crypto')
const { SwarmDeployError, ERRORS } = require('./errors')

const CANONICAL_HEX64 = /^[0-9a-f]{64}$/

function parseCanonicalHex(value, code) {
  if (typeof value !== 'string' || !CANONICAL_HEX64.test(value)) {
    throw new SwarmDeployError(code, `Expected lowercase 64-character hex string`)
  }
  return b4a.from(value, 'hex')
}

function parseSeed(value) {
  return parseCanonicalHex(value, ERRORS.INVALID_SEED)
}

function parsePublicKey(value) {
  return parseCanonicalHex(value, ERRORS.INVALID_PUBLIC_KEY)
}

function generateSeed() {
  return b4a.from(crypto.randomBytes(32))
}

function keyPairFromSeed(seed) {
  return DHT.keyPair(seed)
}

function publicKeyFromSeed(seed) {
  return keyPairFromSeed(seed).publicKey
}

module.exports = {
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed
}
