/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import {
  ERRORS,
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  RESULT_CODE,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS,
  encodeBounded,
  decodeBounded,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result,
  transferId,
  encodeTransferIdCanonical,
  mergeBitmapPages,
  keyPairFromSeed,
  publicKeyFromSeed,
  type BitmapPageInput,
  type ChunkAckInput,
  type ChunkInput,
  type Codec,
  type FinishInput,
  type Fixed32,
  type OfferInput,
  type ReadyInput,
  type ResultCode,
  type ResultInput,
  type StatusCode,
  type StatusInput
} from '../../dist/index.js'
import { CHUNK_SIZE, digestBuffer } from '../helpers/files.js'

const KEY = publicKeyFromSeed(b4a.alloc(32, 7))
const DIGEST = digestBuffer(b4a.alloc(32, 9))
const NAME = 'artifact-linux-x64.tar.gz'

const TRANSFER_ID_VECTOR = {
  clientPublicKey: b4a.alloc(32, 0x07),
  name: 'artifact-linux-x64.tar.gz',
  size: 123,
  digest: b4a.alloc(32, 0x09),
  chunkSize: CHUNK_SIZE
}
const TRANSFER_ID_VECTOR_ENCODED = b4a.from(
  '18737761726d2d6465706c6f792f7472616e736665722f763107070707070707070707070707070707070707070707070707070707070707071961727469666163742d6c696e75782d7836342e7461722e677a7b0909090909090909090909090909090909090909090909090909090909090909fe00001000',
  'hex'
)
const TRANSFER_ID_VECTOR_HASH = b4a.from(
  '90c2bfe9c303fbf7b755b97e0da646d99afdfe406d8dcce2ec814305b8da7ee4',
  'hex'
)

/**
 * `clientPublicKey` only feeds transfer-ID derivation; it is not an OFFER
 * field, but overriding it stays available exactly as in the original harness.
 */
interface OfferOverrides extends Partial<OfferInput> {
  clientPublicKey?: Fixed32
}

function sampleOffer(overrides: OfferOverrides = {}): OfferInput {
  const size = overrides.size ?? CHUNK_SIZE + 17
  const chunkSize = overrides.chunkSize ?? CHUNK_SIZE
  const chunkCount = Math.ceil(size / chunkSize) || 1
  const digest = overrides.digest ?? DIGEST
  const id = transferId({
    clientPublicKey: overrides.clientPublicKey ?? KEY,
    name: overrides.name ?? NAME,
    size,
    digest,
    chunkSize
  })
  return {
    version: 1,
    transferId: id,
    name: overrides.name ?? NAME,
    size,
    digest,
    chunkSize,
    chunkCount: overrides.chunkCount ?? chunkCount,
    ...overrides
  }
}

/** STATUS and RESULT frames share the fields these mutation probes snapshot. */
interface FrameSnapshot {
  transferId: Fixed32
  code: StatusCode | ResultCode
  reason?: string
}

function snapshotValue(value: FrameSnapshot): FrameSnapshot {
  return {
    ...value,
    transferId: b4a.isBuffer(value.transferId) ? b4a.from(value.transferId) : value.transferId
  }
}

function assertCanonicalBuffer(t: Assert, value: Uint8Array, label: string): void {
  if (typeof Bare === 'undefined') {
    t.ok(Buffer.isBuffer(value), label)
    return
  }
  t.is(value.constructor, b4a.alloc(0).constructor, label)
}

function decodePlainBytes<Input, Output>(
  t: Assert,
  codec: Codec<Input, Output>,
  value: Input,
  max?: number
): Output {
  const encoded = encodeBounded(codec, value, max)
  const plain = new Uint8Array(encoded.byteLength)
  plain.set(encoded)
  const snapshot = new Uint8Array(plain)
  const decoded = decodeBounded(codec, plain, max)
  t.alike(plain, snapshot, 'plain encoded input remains unchanged')
  return decoded
}

test('message index constants follow wire order', (t) => {
  t.is(OFFER, 0)
  t.is(STATUS, 1)
  t.is(BITMAP_PAGE, 2)
  t.is(READY, 3)
  t.is(CHUNK, 4)
  t.is(CHUNK_ACK, 5)
  t.is(FINISH, 6)
  t.is(RESULT, 7)
})

test('offer codec round-trips representative data', (t) => {
  const value = sampleOffer()
  const decoded = decodeBounded(offer, encodeBounded(offer, value))
  t.alike<OfferInput>(decoded, value)
})

test('status codec round-trips representative data', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    code: STATUS_CODE.ACCEPT
  }
  const decoded = decodeBounded(status, encodeBounded(status, value))
  t.alike<StatusInput>(decoded, { ...value, reason: '' })
})

test('status codec round-trips rejected responses with reason', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    code: STATUS_CODE.REJECTED,
    reason: 'staging limit'
  }
  const decoded = decodeBounded(status, encodeBounded(status, value))
  t.alike<StatusInput>(decoded, value)
})

test('status and result encoders do not mutate caller values', (t) => {
  const statusValue: StatusInput = {
    transferId: sampleOffer().transferId,
    code: STATUS_CODE.ACCEPT
  }
  const statusSnapshot = snapshotValue(statusValue)
  encodeBounded(status, statusValue)
  t.alike<FrameSnapshot>(statusValue, statusSnapshot)
  t.is(statusValue.reason, undefined)

  const resultValue: ResultInput = {
    transferId: sampleOffer().transferId,
    code: RESULT_CODE.COMMITTED
  }
  const resultSnapshot = snapshotValue(resultValue)
  encodeBounded(result, resultValue)
  t.alike<FrameSnapshot>(resultValue, resultSnapshot)
  t.is(resultValue.reason, undefined)
})

test('bitmap page codec round-trips representative data', (t) => {
  const bits = b4a.alloc(2)
  bits[0] = 0b00000101
  bits[1] = 0b00000011
  const value = {
    transferId: sampleOffer().transferId,
    start: 10,
    count: 10,
    bits
  }
  const decoded = decodeBounded(bitmapPage, encodeBounded(bitmapPage, value))
  t.alike<BitmapPageInput>(decoded, value)
})

test('ready, finish, and result codecs round-trip', (t) => {
  const id = sampleOffer().transferId
  t.alike<ReadyInput>(decodeBounded(ready, encodeBounded(ready, { transferId: id })), {
    transferId: id
  })
  t.alike<FinishInput>(decodeBounded(finish, encodeBounded(finish, { transferId: id })), {
    transferId: id
  })
  t.alike<ResultInput>(
    decodeBounded(
      result,
      encodeBounded(result, { transferId: id, code: RESULT_CODE.COMMITTED, reason: '' })
    ),
    {
      transferId: id,
      code: RESULT_CODE.COMMITTED,
      reason: ''
    }
  )
  t.exception(() => encodeBounded(result, { transferId: id, code: 2 as ResultCode }), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('chunk frame bound includes header overhead for full 1 MiB payload', (t) => {
  const data = b4a.alloc(MAX_CHUNK_BYTES, 3)
  const value = {
    transferId: sampleOffer().transferId,
    index: 0,
    digest: digestBuffer(data),
    data
  }
  const encoded = encodeBounded(chunk, value, MAX_CHUNK_FRAME_BYTES)
  t.ok(encoded.byteLength <= MAX_CHUNK_FRAME_BYTES)
  t.alike<ChunkInput>(decodeBounded(chunk, encoded, MAX_CHUNK_FRAME_BYTES), value)

  const worstCase = {
    transferId: b4a.alloc(32),
    index: Number.MAX_SAFE_INTEGER,
    digest: b4a.alloc(32),
    data: b4a.alloc(MAX_CHUNK_BYTES)
  }
  t.is(encodeBounded(chunk, worstCase, MAX_CHUNK_FRAME_BYTES).byteLength, MAX_CHUNK_FRAME_BYTES)
})

test('chunk codec rejects data larger than 1 MiB', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    index: 0,
    digest: DIGEST,
    data: b4a.alloc(MAX_CHUNK_BYTES + 1)
  }
  t.exception(() => encodeBounded(chunk, value, MAX_CHUNK_FRAME_BYTES), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('chunkAck codec round-trips representative data', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    index: 4
  }
  const decoded = decodeBounded(chunkAck, encodeBounded(chunkAck, value))
  t.alike<ChunkAckInput>(decoded, value)
})

test('decodeBounded canonicalizes plain Uint8Array codec outputs', (t) => {
  const id = b4a.alloc(32, 1)
  const digest = b4a.alloc(32, 2)
  const decodedOffer = decodePlainBytes(t, offer, sampleOffer({ transferId: id, digest }))
  assertCanonicalBuffer(t, decodedOffer.transferId, 'offer transfer ID')
  assertCanonicalBuffer(t, decodedOffer.digest, 'offer digest')

  const decodedBitmapPage = decodePlainBytes(t, bitmapPage, {
    transferId: id,
    start: 0,
    count: 1,
    bits: b4a.from([1])
  })
  assertCanonicalBuffer(t, decodedBitmapPage.transferId, 'bitmap transfer ID')
  assertCanonicalBuffer(t, decodedBitmapPage.bits, 'bitmap bits')

  const decodedChunk = decodePlainBytes(t, chunk, {
    transferId: id,
    index: 0,
    digest,
    data: b4a.from([1, 2, 3])
  })
  assertCanonicalBuffer(t, decodedChunk.transferId, 'chunk transfer ID')
  assertCanonicalBuffer(t, decodedChunk.digest, 'chunk digest')
  assertCanonicalBuffer(t, decodedChunk.data, 'chunk data')

  const decodedAck = decodePlainBytes(t, chunkAck, { transferId: id, index: 0 })
  const decodedFinish = decodePlainBytes(t, finish, { transferId: id })
  const decodedResult = decodePlainBytes(t, result, {
    transferId: id,
    code: RESULT_CODE.COMMITTED
  })
  assertCanonicalBuffer(t, decodedAck.transferId, 'ACK transfer ID')
  assertCanonicalBuffer(t, decodedFinish.transferId, 'finish transfer ID')
  assertCanonicalBuffer(t, decodedResult.transferId, 'result transfer ID')
})

test('fixed32 semantic validation rejects short transfer ID fields on decode', (t) => {
  const encoded = encodeBounded(chunkAck, {
    transferId: sampleOffer().transferId,
    index: 0
  })
  t.exception(() => decodeBounded(chunkAck, encoded.subarray(0, 31)), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('fixed-width fields must be exactly 32 bytes on encode', (t) => {
  const bad = sampleOffer({ transferId: b4a.alloc(31) })
  t.exception(() => encodeBounded(offer, bad), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('control messages larger than 16 KiB are rejected', (t) => {
  const huge = sampleOffer({ name: 'a'.repeat(20_000) })
  t.exception(() => encodeBounded(offer, huge), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('file size and chunk indexes must be safe non-negative integers', (t) => {
  for (const size of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.exception(
      () => encodeBounded(offer, sampleOffer({ size })),
      {
        name: 'SwarmDeployError',
        code: ERRORS.PROTOCOL_INVALID
      },
      `size ${String(size)}`
    )
  }

  for (const index of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.exception(
      () =>
        encodeBounded(chunkAck, {
          transferId: sampleOffer().transferId,
          index
        }),
      {
        name: 'SwarmDeployError',
        code: ERRORS.PROTOCOL_INVALID
      },
      `index ${String(index)}`
    )
  }
})

test('chunkSize must be a positive safe integer bounded by MAX_CHUNK_BYTES', (t) => {
  for (const chunkSize of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, MAX_CHUNK_BYTES + 1]) {
    t.exception(
      () => encodeBounded(offer, sampleOffer({ chunkSize })),
      {
        name: 'SwarmDeployError',
        code: ERRORS.PROTOCOL_INVALID
      },
      `chunkSize ${String(chunkSize)}`
    )
  }
})

test('transferId rejects chunkSize above MAX_CHUNK_BYTES', (t) => {
  t.exception(
    () =>
      transferId({
        clientPublicKey: KEY,
        name: NAME,
        size: 1,
        digest: DIGEST,
        chunkSize: MAX_CHUNK_BYTES + 1
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('bitmap pages cover at most 65536 chunk bits', (t) => {
  const id = sampleOffer().transferId
  t.exception(
    () =>
      encodeBounded(bitmapPage, {
        transferId: id,
        start: 0,
        count: MAX_BITMAP_BITS + 1,
        bits: b4a.alloc(Math.ceil((MAX_BITMAP_BITS + 1) / 8))
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('bitmap pages reject malformed bit lengths and out-of-range spans', (t) => {
  const id = sampleOffer().transferId
  t.exception(
    () =>
      encodeBounded(bitmapPage, {
        transferId: id,
        start: 0,
        count: 9,
        bits: b4a.alloc(1)
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )

  t.exception(
    () =>
      mergeBitmapPages(
        [
          {
            transferId: id,
            start: 0,
            count: 4,
            bits: b4a.from([0b1111])
          }
        ],
        3
      ),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('bitmap pages reject nonzero unused padding bits', (t) => {
  t.exception(
    () =>
      encodeBounded(bitmapPage, {
        transferId: sampleOffer().transferId,
        start: 0,
        count: 10,
        bits: b4a.from([0b00000101, 0b10000000])
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('bitmap pages reconstruct arbitrarily fragmented state', (t) => {
  const id = sampleOffer().transferId
  const pages = [
    {
      transferId: id,
      start: 0,
      count: 3,
      bits: b4a.from([0b101])
    },
    {
      transferId: id,
      start: 5,
      count: 4,
      bits: b4a.from([0b0110])
    },
    {
      transferId: id,
      start: 100,
      count: 2,
      bits: b4a.from([0b01])
    }
  ]

  const verified = mergeBitmapPages(pages, 102)
  t.alike(verified, new Set([0, 2, 6, 7, 100]))
})

test('bitmap pages reject overlapping ranges', (t) => {
  const id = sampleOffer().transferId
  t.exception(
    () =>
      mergeBitmapPages(
        [
          { transferId: id, start: 0, count: 4, bits: b4a.from([0b1111]) },
          { transferId: id, start: 2, count: 2, bits: b4a.from([0b11]) }
        ],
        8
      ),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('mergeBitmapPages rejects mixed transfer IDs', (t) => {
  const id1 = sampleOffer().transferId
  const id2 = transferId({
    clientPublicKey: keyPairFromSeed(b4a.alloc(32, 8)).publicKey,
    name: NAME,
    size: 123,
    digest: DIGEST,
    chunkSize: CHUNK_SIZE
  })

  t.exception(
    () =>
      mergeBitmapPages(
        [
          { transferId: id1, start: 0, count: 2, bits: b4a.from([0b11]) },
          { transferId: id2, start: 2, count: 2, bits: b4a.from([0b11]) }
        ],
        4
      ),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('chunkAck validates transfer ID width and chunk index', (t) => {
  t.exception(
    () =>
      encodeBounded(chunkAck, {
        transferId: b4a.alloc(16),
        index: 0
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )

  const encoded = encodeBounded(chunkAck, {
    transferId: sampleOffer().transferId,
    index: 0
  })
  t.exception(() => decodeBounded(chunkAck, encoded.subarray(0, encoded.byteLength - 1)), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('decodeBounded rejects trailing bytes', (t) => {
  const encoded = encodeBounded(finish, { transferId: sampleOffer().transferId })
  const trailing = b4a.concat([encoded, b4a.from([0x00])])
  t.exception(() => decodeBounded(finish, trailing), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('decodeBounded rejects inputs larger than bound before decoding', (t) => {
  const encoded = encodeBounded(ready, { transferId: sampleOffer().transferId })
  t.exception(() => decodeBounded(ready, encoded, encoded.byteLength - 1), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('transfer ID canonical encoding matches pinned known vector', (t) => {
  t.alike(encodeTransferIdCanonical(TRANSFER_ID_VECTOR), TRANSFER_ID_VECTOR_ENCODED)
  t.alike(transferId(TRANSFER_ID_VECTOR), TRANSFER_ID_VECTOR_HASH)
})

test('transfer ID canonical encoding accepts Uint8Array fixed fields', (t) => {
  const input = {
    clientPublicKey: new Uint8Array(b4a.alloc(32, 0x07)),
    name: TRANSFER_ID_VECTOR.name,
    size: TRANSFER_ID_VECTOR.size,
    digest: new Uint8Array(b4a.alloc(32, 0x09)),
    chunkSize: TRANSFER_ID_VECTOR.chunkSize
  }
  t.alike(encodeTransferIdCanonical(input), TRANSFER_ID_VECTOR_ENCODED)
  t.alike(transferId(input), TRANSFER_ID_VECTOR_HASH)
})

test('transfer IDs change when identity, name, size, digest, or chunk size changes', (t) => {
  const base = {
    clientPublicKey: KEY,
    name: NAME,
    size: 123,
    digest: DIGEST,
    chunkSize: CHUNK_SIZE
  }
  const original = transferId(base)
  const otherKey = keyPairFromSeed(b4a.alloc(32, 8)).publicKey

  t.unlike(original, transferId({ ...base, clientPublicKey: otherKey }))
  t.unlike(original, transferId({ ...base, name: 'other.bin' }))
  t.unlike(original, transferId({ ...base, size: 124 }))
  t.unlike(original, transferId({ ...base, digest: digestBuffer(b4a.alloc(1, 1)) }))
  t.unlike(original, transferId({ ...base, chunkSize: CHUNK_SIZE / 2 }))
})
