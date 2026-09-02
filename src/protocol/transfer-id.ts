import b4a from 'b4a'
import * as c from 'compact-encoding'
import crypto from '#crypto'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { assertBoundedChunkSize, assertFixed32, assertSafeUint, isFixed32 } from './validation.js'
import type { Codec, ProtocolState, TransferIdInput } from './types.js'

export const TRANSFER_DOMAIN = 'swarm-deploy/transfer/v1'

interface CanonicalTransferId extends TransferIdInput {
  domain: string
}

const fixed32Bytes: Codec<Uint8Array, Buffer> = {
  preencode(state: ProtocolState, value: Uint8Array): void {
    if (!isFixed32(value)) throw new Error('Incorrect buffer size')
    state.end += 32
  },
  encode(state: ProtocolState, value: Uint8Array): void {
    if (state.buffer === null) throw new Error('Missing buffer')
    state.buffer.set(b4a.from(value), state.start)
    state.start += 32
  },
  decode(state: ProtocolState): Buffer {
    if (state.end - state.start < 32 || state.buffer === null) throw new Error('Out of bounds')
    return b4a.from(state.buffer.subarray(state.start, (state.start += 32)))
  }
}

export const transferIdCanonical: Codec<CanonicalTransferId> = {
  preencode(state: ProtocolState, value: CanonicalTransferId): void {
    c.string.preencode(state, value.domain)
    fixed32Bytes.preencode(state, value.clientPublicKey)
    c.string.preencode(state, value.name)
    c.uint.preencode(state, value.size)
    fixed32Bytes.preencode(state, value.digest)
    c.uint.preencode(state, value.chunkSize)
  },
  encode(state: ProtocolState, value: CanonicalTransferId): void {
    c.string.encode(state, value.domain)
    fixed32Bytes.encode(state, value.clientPublicKey)
    c.string.encode(state, value.name)
    c.uint.encode(state, value.size)
    fixed32Bytes.encode(state, value.digest)
    c.uint.encode(state, value.chunkSize)
  },
  decode(state: ProtocolState): CanonicalTransferId {
    return {
      domain: c.string.decode(state),
      clientPublicKey: fixed32Bytes.decode(state),
      name: c.string.decode(state),
      size: c.uint.decode(state),
      digest: fixed32Bytes.decode(state),
      chunkSize: c.uint.decode(state)
    }
  }
}

export function encodeTransferIdCanonical(input: TransferIdInput): Uint8Array {
  assertFixed32(input.clientPublicKey, 'clientPublicKey')
  assertFixed32(input.digest, 'digest')
  assertSafeUint(input.size, 'size')
  assertBoundedChunkSize(input.chunkSize, 'chunkSize')
  if (typeof input.name !== 'string') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
  }

  return c.encode(transferIdCanonical, {
    domain: TRANSFER_DOMAIN,
    clientPublicKey: input.clientPublicKey,
    name: input.name,
    size: input.size,
    digest: input.digest,
    chunkSize: input.chunkSize
  })
}

export function transferId({
  clientPublicKey,
  name,
  size,
  digest,
  chunkSize
}: TransferIdInput): Buffer {
  return crypto
    .createHash('sha256')
    .update(
      encodeTransferIdCanonical({
        clientPublicKey,
        name,
        size,
        digest,
        chunkSize
      })
    )
    .digest()
}
