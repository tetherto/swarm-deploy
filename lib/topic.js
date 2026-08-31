'use strict'

const crypto = require('#crypto')
const b4a = require('b4a')

const TOPIC_PREFIX = 'swarm-deploy/topic/v1\0'

function topicFromServerPublicKey(serverPublicKey) {
  return b4a.from(crypto.createHash('sha256').update(TOPIC_PREFIX).update(serverPublicKey).digest())
}

module.exports = {
  topicFromServerPublicKey
}
