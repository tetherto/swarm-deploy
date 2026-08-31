'use strict'

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const {
  SwarmDeployError,
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
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
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
  mergeBitmapPages
} = require('../..')
const { CHUNK_SIZE, digestBuffer } = require('../helpers/files')
const { keyPairFromSeed, publicKeyFromSeed } = require('../..')

const KEY = publicKeyFromSeed(b4a.alloc(32, 7))
const DIGEST = digestBuffer(b4a.alloc(32, 9))
const NAME = 'artifact-linux-x64.tar.gz'

function sampleOffer(overrides = {}) {
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
  t.alike(decoded, value)
})

test('status codec round-trips representative data', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    code: STATUS_CODE.ACCEPT
  }
  const decoded = decodeBounded(status, encodeBounded(status, value))
  t.alike(decoded, value)
})

test('status codec round-trips rejected responses with reason', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    code: STATUS_CODE.REJECTED,
    reason: 'staging limit'
  }
  const decoded = decodeBounded(status, encodeBounded(status, value))
  t.alike(decoded, value)
})

test('bitmap page codec round-trips representative data', (t) => {
  const bits = b4a.alloc(2)
  bits[0] = 0b00000101
  bits[1] = 0b10000000
  const value = {
    transferId: sampleOffer().transferId,
    start: 10,
    count: 10,
    bits
  }
  const decoded = decodeBounded(bitmapPage, encodeBounded(bitmapPage, value))
  t.alike(decoded, value)
})

test('ready, finish, and result codecs round-trip', (t) => {
  const id = sampleOffer().transferId
  t.alike(decodeBounded(ready, encodeBounded(ready, { transferId: id })), { transferId: id })
  t.alike(decodeBounded(finish, encodeBounded(finish, { transferId: id })), { transferId: id })
  t.alike(
    decodeBounded(result, encodeBounded(result, { transferId: id, code: 0, reason: '' })),
    { transferId: id, code: 0, reason: '' }
  )
})

test('chunk codec round-trips representative data with separate bound', (t) => {
  const data = b4a.alloc(1024, 3)
  const value = {
    transferId: sampleOffer().transferId,
    index: 2,
    digest: digestBuffer(data),
    data
  }
  const decoded = decodeBounded(chunk, encodeBounded(chunk, value, MAX_CHUNK_BYTES), MAX_CHUNK_BYTES)
  t.alike(decoded, value)
})

test('chunkAck codec round-trips representative data', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    index: 4
  }
  const decoded = decodeBounded(chunkAck, encodeBounded(chunkAck, value))
  t.alike(decoded, value)
})

test('fixed-width fields must be exactly 32 bytes', (t) => {
  const bad = sampleOffer({ transferId: b4a.alloc(31) })
  t.exception(() => encodeBounded(offer, bad), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })

  const encoded = encodeBounded(offer, sampleOffer())
  encoded[encoded.byteLength - 1] ^= 0xff
  t.exception(() => decodeBounded(offer, encoded), {
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

test('chunk messages larger than 1 MiB are rejected', (t) => {
  const value = {
    transferId: sampleOffer().transferId,
    index: 0,
    digest: DIGEST,
    data: b4a.alloc(MAX_CHUNK_BYTES + 1)
  }
  t.exception(() => encodeBounded(chunk, value, MAX_CHUNK_BYTES), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('file size and chunk indexes must be safe non-negative integers', (t) => {
  for (const size of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.exception(() => encodeBounded(offer, sampleOffer({ size })), {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }, `size ${String(size)}`)
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

test('chunkSize must be a positive safe integer', (t) => {
  for (const chunkSize of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.exception(() => encodeBounded(offer, sampleOffer({ chunkSize })), {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }, `chunkSize ${String(chunkSize)}`)
  }
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

test('transfer IDs are 32-byte digests of canonical compact encoding', (t) => {
  const base = {
    clientPublicKey: KEY,
    name: NAME,
    size: 123,
    digest: DIGEST,
    chunkSize: CHUNK_SIZE
  }
  const id = transferId(base)
  t.is(id.byteLength, 32)

  const tuple = c.encode(
    c.array(c.any),
    ['swarm-deploy/transfer/v1', base.clientPublicKey, base.name, base.size, base.digest, base.chunkSize]
  )
  t.alike(id, digestBuffer(tuple))
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
