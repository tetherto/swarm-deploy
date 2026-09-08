import DHT from 'hyperdht'
import b4a from 'b4a'
import crypto from '#crypto'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { Binary, BinaryInput, KeyPair, PublicKey, Seed, SeedInput } from './types.js'

export type { BinaryInput, KeyPair }

const CANONICAL_HEX64 = /^[0-9a-f]{64}$/

function parseCanonicalHex(
  value: string,
  code: typeof ERRORS.INVALID_SEED | typeof ERRORS.INVALID_PUBLIC_KEY
): Binary {
  if (typeof value !== 'string' || !CANONICAL_HEX64.test(value)) {
    throw new SwarmDeployError(code, `Expected lowercase 64-character hex string`)
  }
  return b4a.from(value, 'hex')
}

export function parseSeed(value: string): Seed {
  return parseCanonicalHex(value, ERRORS.INVALID_SEED)
}

export function parsePublicKey(value: string): PublicKey {
  return parseCanonicalHex(value, ERRORS.INVALID_PUBLIC_KEY)
}

export function generateSeed(): Seed {
  return b4a.from(crypto.randomBytes(32))
}

function assertValidSeed(seed: SeedInput): asserts seed is Seed {
  if (!b4a.isBuffer(seed) || seed.byteLength !== 32) {
    throw new SwarmDeployError(ERRORS.INVALID_SEED, 'Expected 32-byte seed')
  }
}

export function keyPairFromSeed(seed: SeedInput): KeyPair {
  assertValidSeed(seed)
  return DHT.keyPair(seed)
}

export function publicKeyFromSeed(seed: SeedInput): PublicKey {
  return keyPairFromSeed(seed).publicKey
}
