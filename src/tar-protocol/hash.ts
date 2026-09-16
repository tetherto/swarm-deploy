import b4a from 'b4a'
import sodium from 'sodium-native'

export const SHA256_BYTES = 32

export class SodiumSha256 {
  private readonly state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  private finished = false

  constructor() {
    sodium.crypto_hash_sha256_init(this.state)
  }

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error('SHA-256 state is finalized')
    sodium.crypto_hash_sha256_update(this.state, bytes)
    return this
  }

  digest(): Buffer {
    if (this.finished) throw new Error('SHA-256 state is finalized')
    this.finished = true
    const digest = b4a.alloc(SHA256_BYTES)
    sodium.crypto_hash_sha256_final(this.state, digest)
    return digest
  }
}

export function sodiumSha256(bytes: Uint8Array): Buffer {
  const digest = b4a.alloc(SHA256_BYTES)
  sodium.crypto_hash_sha256(digest, bytes)
  return digest
}

export function digestMatches(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.byteLength === SHA256_BYTES &&
    expected.byteLength === SHA256_BYTES &&
    sodium.sodium_memcmp(actual, expected)
  )
}
