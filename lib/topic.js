'use strict'

const crypto = require('#crypto')
const b4a = require('b4a')
const { SwarmDeployError, ERRORS } = require('./errors')

const TOPIC_PREFIX = 'swarm-deploy/topic/v1\0'

function topicFromServerPublicKey(serverPublicKey) {
  if (!b4a.isBuffer(serverPublicKey) || serverPublicKey.byteLength !== 32) {
    throw new SwarmDeployError(ERRORS.INVALID_PUBLIC_KEY, 'Expected 32-byte public key')
  }
  return b4a.from(crypto.createHash('sha256').update(TOPIC_PREFIX).update(serverPublicKey).digest())
}

module.exports = {
  topicFromServerPublicKey
}
