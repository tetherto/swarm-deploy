'use strict'

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('#crypto')
const {
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
  MAX_CHUNK_FRAME_BYTES,
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
const { ServerSession } = require('../../lib/protocol/server-session')

const OWNER = b4a.alloc(32, 0x31)
const DATA = b4a.from('deterministic protocol property payload')

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function sampleOffer() {
  const value = {
    version: 1,
    name: 'property.bin',
    size: DATA.byteLength,
    digest: sha256(DATA),
    chunkSize: MAX_CHUNK_BYTES,
    chunkCount: 1
  }
  value.transferId = transferId({
    clientPublicKey: OWNER,
    name: value.name,
    size: value.size,
    digest: value.digest,
    chunkSize: value.chunkSize
  })
  return value
}

function corpus() {
  const offered = sampleOffer()
  return [
    ['offer', offer, offered, MAX_CONTROL_BYTES],
    [
      'status',
      status,
      { transferId: offered.transferId, code: STATUS_CODE.REJECTED, reason: 'bounded' },
      MAX_CONTROL_BYTES
    ],
    [
      'bitmap-page',
      bitmapPage,
      { transferId: offered.transferId, start: 0, count: 1, bits: b4a.from([1]) },
      MAX_CONTROL_BYTES
    ],
    ['ready', ready, { transferId: offered.transferId }, MAX_CONTROL_BYTES],
    [
      'chunk',
      chunk,
      {
        transferId: offered.transferId,
        index: 0,
        digest: sha256(DATA),
        data: DATA
      },
      MAX_CHUNK_FRAME_BYTES
    ],
    ['chunk-ack', chunkAck, { transferId: offered.transferId, index: 0 }, MAX_CONTROL_BYTES],
    ['finish', finish, { transferId: offered.transferId }, MAX_CONTROL_BYTES],
    ['result', result, { transferId: offered.transferId, code: 0, reason: '' }, MAX_CONTROL_BYTES]
  ]
}

function assertProtocolInvalid(t, operation, message) {
  t.exception(operation, { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }, message)
}

function createProtocolSession() {
  const messages = []
  const destroyed = []
  const channel = {
    drained: true,
    _recv() {},
    addMessage(options) {
      const message = { ...options, send: () => true }
      messages.push(message)
      return message
    },
    open() {},
    close() {}
  }
  const sessionStore = {
    sessions: new Map(),
    async offer() {
      return { verified: new Set() }
    },
    async writeChunk() {},
    async finish() {},
    async retireCommitted() {}
  }
  const session = new ServerSession({
    channel,
    ownerKey: OWNER,
    sessionStore,
    commitStore: {
      async inspect() {
        return { status: 'AVAILABLE' }
      },
      async commit() {}
    },
    maxFileBytes: MAX_CHUNK_BYTES,
    destroy(error) {
      destroyed.push(error)
    }
  })
  return { channel, messages, destroyed, session }
}

test('every codec rejects truncation at every byte offset with a typed error', (t) => {
  for (const [name, codec, value, maximum] of corpus()) {
    const encoded = encodeBounded(codec, value, maximum)
    for (let offset = 0; offset < encoded.byteLength; offset++) {
      assertProtocolInvalid(
        t,
        () => decodeBounded(codec, encoded.subarray(0, offset), maximum),
        `${name} truncated at ${offset}/${encoded.byteLength}`
      )
    }
  }
})

test('every codec rejects trailing bytes and oversized framed input', (t) => {
  for (const [name, codec, value, maximum] of corpus()) {
    const encoded = encodeBounded(codec, value, maximum)
    assertProtocolInvalid(
      t,
      () => decodeBounded(codec, b4a.concat([encoded, b4a.from([0])])),
      `${name} trailing byte`
    )
    assertProtocolInvalid(
      t,
      () => decodeBounded(codec, b4a.alloc(maximum + 1), maximum),
      `${name} oversized input`
    )
  }
})

test('one-bit length mutations and oversized declarations fail before allocation', (t) => {
  const offered = sampleOffer()
  const cases = [
    {
      name: 'offer string',
      codec: offer,
      maximum: MAX_CONTROL_BYTES,
      encoded: encodeBounded(offer, offered),
      lengthOffset: 33,
      declared: b4a.concat([
        c.encode(c.uint, 1),
        offered.transferId,
        c.encode(c.uint, MAX_CONTROL_BYTES + 1)
      ])
    },
    {
      name: 'status reason',
      codec: status,
      maximum: MAX_CONTROL_BYTES,
      encoded: encodeBounded(status, {
        transferId: offered.transferId,
        code: STATUS_CODE.REJECTED,
        reason: 'x'
      }),
      lengthOffset: 33,
      declared: b4a.concat([
        offered.transferId,
        c.encode(c.uint, STATUS_CODE.REJECTED),
        c.encode(c.uint, MAX_CONTROL_BYTES + 1)
      ])
    },
    {
      name: 'bitmap bits',
      codec: bitmapPage,
      maximum: MAX_CONTROL_BYTES,
      encoded: encodeBounded(bitmapPage, {
        transferId: offered.transferId,
        start: 0,
        count: 1,
        bits: b4a.from([1])
      }),
      lengthOffset: 34,
      declared: b4a.concat([
        offered.transferId,
        c.encode(c.uint, 0),
        c.encode(c.uint, 1),
        c.encode(c.uint, MAX_CONTROL_BYTES + 1)
      ])
    },
    {
      name: 'chunk data',
      codec: chunk,
      maximum: MAX_CHUNK_FRAME_BYTES,
      encoded: encodeBounded(
        chunk,
        {
          transferId: offered.transferId,
          index: 0,
          digest: sha256(DATA),
          data: DATA
        },
        MAX_CHUNK_FRAME_BYTES
      ),
      lengthOffset: 65,
      declared: b4a.concat([
        offered.transferId,
        c.encode(c.uint, 0),
        sha256(DATA),
        c.encode(c.uint, MAX_CHUNK_BYTES + 1)
      ])
    }
  ]

  for (const entry of cases) {
    const mutated = b4a.from(entry.encoded)
    mutated[entry.lengthOffset] ^= 1
    assertProtocolInvalid(
      t,
      () => decodeBounded(entry.codec, mutated, entry.maximum),
      `${entry.name} one-bit length`
    )
    assertProtocolInvalid(
      t,
      () => decodeBounded(entry.codec, entry.declared, entry.maximum),
      `${entry.name} oversized declaration`
    )
  }
})

test('unknown status and invalid bitmap padding, overlap, and ranges are typed', (t) => {
  const id = sampleOffer().transferId
  assertProtocolInvalid(
    t,
    () => decodeBounded(status, b4a.concat([id, c.encode(c.uint, 255), c.encode(c.string, '')])),
    'unknown status'
  )
  assertProtocolInvalid(
    t,
    () =>
      encodeBounded(bitmapPage, {
        transferId: id,
        start: 0,
        count: 1,
        bits: b4a.from([0b10000000])
      }),
    'bitmap padding'
  )
  assertProtocolInvalid(
    t,
    () =>
      mergeBitmapPages(
        [
          { transferId: id, start: 0, count: 2, bits: b4a.from([0b11]) },
          { transferId: id, start: 1, count: 2, bits: b4a.from([0b11]) }
        ],
        4
      ),
    'bitmap overlap'
  )
  assertProtocolInvalid(
    t,
    () =>
      mergeBitmapPages(
        [{ transferId: id, start: Number.MAX_SAFE_INTEGER, count: 1, bits: b4a.from([1]) }],
        4
      ),
    'bitmap range'
  )
})

test('one-bit digest changes remain bounded but invalidate canonical transfer identity', (t) => {
  const offered = sampleOffer()
  const mutatedDigest = b4a.from(offered.digest)
  mutatedDigest[0] ^= 1
  const decoded = decodeBounded(offer, encodeBounded(offer, { ...offered, digest: mutatedDigest }))
  const canonical = transferId({
    clientPublicKey: OWNER,
    name: decoded.name,
    size: decoded.size,
    digest: decoded.digest,
    chunkSize: decoded.chunkSize
  })
  t.unlike(canonical, decoded.transferId)
})

test('reordered, repeated, direction-invalid, and unknown messages tear down deterministically', async (t) => {
  const offered = sampleOffer()
  const reordered = createProtocolSession()
  await reordered.messages[CHUNK].onmessage({
    transferId: offered.transferId,
    index: 0,
    digest: sha256(DATA),
    data: DATA
  })
  t.is(reordered.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

  const repeated = createProtocolSession()
  const first = repeated.messages[OFFER].onmessage(offered)
  await repeated.messages[OFFER].onmessage(offered)
  await first
  await repeated.session.settle()
  t.is(repeated.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

  const inbound = [
    [STATUS, { transferId: offered.transferId, code: STATUS_CODE.ACCEPT }],
    [BITMAP_PAGE, { transferId: offered.transferId, start: 0, count: 1, bits: b4a.from([0]) }],
    [READY, { transferId: offered.transferId }],
    [CHUNK_ACK, { transferId: offered.transferId, index: 0 }],
    [RESULT, { transferId: offered.transferId, code: 0 }]
  ]
  for (const [type, value] of inbound) {
    const invalid = createProtocolSession()
    await invalid.messages[type].onmessage(value)
    t.is(invalid.destroyed[0].code, ERRORS.PROTOCOL_INVALID)
  }

  const finishBeforeOffer = createProtocolSession()
  await finishBeforeOffer.messages[FINISH].onmessage({
    transferId: offered.transferId
  })
  t.is(finishBeforeOffer.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

  const unknown = createProtocolSession()
  await unknown.channel._recv(255, {})
  t.is(unknown.destroyed[0].code, ERRORS.PROTOCOL_INVALID)
})
