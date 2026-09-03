/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import {
  ERRORS,
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed,
  topicFromServerPublicKey
} from '../../dist/index.js'

test('identity derives stable and separate key pairs', (t) => {
  const first = b4a.alloc(32, 1)
  const second = b4a.alloc(32, 2)
  t.alike(keyPairFromSeed(first), keyPairFromSeed(first))
  t.unlike(publicKeyFromSeed(first), publicKeyFromSeed(second))
})

test('seed and public key parsers reject non-canonical values', (t) => {
  t.is(parseSeed('01'.repeat(32)).byteLength, 32)
  t.is(parsePublicKey('02'.repeat(32)).byteLength, 32)
  t.exception(() => parseSeed('01'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_SEED
  })
  t.exception(() => parseSeed('AA'.repeat(32)), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_SEED
  })
  t.exception(() => parsePublicKey('not-hex'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_PUBLIC_KEY
  })
})

test('generateSeed returns 32 bytes', (t) => {
  t.is(generateSeed().byteLength, 32)
})

test('binary seed validation throws INVALID_SEED', (t) => {
  t.exception(() => keyPairFromSeed(b4a.alloc(16)), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_SEED
  })
  t.exception(() => publicKeyFromSeed(b4a.alloc(31)), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_SEED
  })
})

test('topic is stable, domain-separated, and 32 bytes', (t) => {
  const publicKey = publicKeyFromSeed(b4a.alloc(32, 3))
  const topic = topicFromServerPublicKey(publicKey)
  t.is(topic.byteLength, 32)
  t.alike(topic, topicFromServerPublicKey(publicKey))
  t.unlike(topic, publicKey)
})

test('topic rejects invalid public key length', (t) => {
  t.exception(() => topicFromServerPublicKey(b4a.alloc(16)), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_PUBLIC_KEY
  })
})
