import b4a from 'b4a'
import * as c from 'compact-encoding'
import crypto from '#crypto'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { encodeToBinary } from './codecs.js'
import { assertBoundedChunkSize, assertFixed32, assertSafeUint, isFixed32 } from './validation.js'
import type { Binary, Codec, EncodingState, Fixed32, TransferIdInput } from './types.js'

export const TRANSFER_DOMAIN = 'swarm-deploy/transfer/v1'

interface CanonicalTransferId extends TransferIdInput {
  domain: string
}

interface DecodedTransferId extends CanonicalTransferId {
  clientPublicKey: Binary
  digest: Binary
}

const fixed32Bytes: Codec<Fixed32, Binary> = {
  preencode(state: EncodingState, value: Fixed32): void {
    if (!isFixed32(value)) throw new Error('Incorrect buffer size')
    state.end += 32
  },
  encode(state: EncodingState, value: Fixed32): void {
    state.buffer.set(b4a.from(value), state.start)
    state.start += 32
  },
  decode(state: EncodingState): Binary {
    if (state.end - state.start < 32) throw new Error('Out of bounds')
    return state.buffer.subarray(state.start, (state.start += 32))
  }
}

export const transferIdCanonical: Codec<CanonicalTransferId, DecodedTransferId> = {
  preencode(state: EncodingState, value: CanonicalTransferId): void {
    c.string.preencode(state, value.domain)
    fixed32Bytes.preencode(state, value.clientPublicKey)
    c.string.preencode(state, value.name)
    c.uint.preencode(state, value.size)
    fixed32Bytes.preencode(state, value.digest)
    c.uint.preencode(state, value.chunkSize)
  },
  encode(state: EncodingState, value: CanonicalTransferId): void {
    c.string.encode(state, value.domain)
    fixed32Bytes.encode(state, value.clientPublicKey)
    c.string.encode(state, value.name)
    c.uint.encode(state, value.size)
    fixed32Bytes.encode(state, value.digest)
    c.uint.encode(state, value.chunkSize)
  },
  decode(state: EncodingState): DecodedTransferId {
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

export function encodeTransferIdCanonical(input: TransferIdInput): Binary {
  assertFixed32(input.clientPublicKey, 'clientPublicKey')
  assertFixed32(input.digest, 'digest')
  assertSafeUint(input.size, 'size')
  assertBoundedChunkSize(input.chunkSize, 'chunkSize')
  if (typeof input.name !== 'string') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
  }

  return encodeToBinary(transferIdCanonical, {
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
}: TransferIdInput): Binary {
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
