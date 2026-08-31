'use strict'

const { SwarmDeployError, ERRORS } = require('./lib/errors')
const {
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed
} = require('./lib/identity')
const { topicFromServerPublicKey } = require('./lib/topic')

module.exports = {
  SwarmDeployError,
  ERRORS,
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed,
  topicFromServerPublicKey
}
