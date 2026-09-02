import crypto from '#crypto'
import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { PublicKeyInput, Topic } from './types.js'

const TOPIC_PREFIX = 'swarm-deploy/topic/v1\0'

export function topicFromServerPublicKey(serverPublicKey: PublicKeyInput): Topic {
  if (!b4a.isBuffer(serverPublicKey) || serverPublicKey.byteLength !== 32) {
    throw new SwarmDeployError(ERRORS.INVALID_PUBLIC_KEY, 'Expected 32-byte public key')
  }
  return b4a.from(crypto.createHash('sha256').update(TOPIC_PREFIX).update(serverPublicKey).digest())
}
