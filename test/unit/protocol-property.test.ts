/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import c from 'compact-encoding'
import crypto from '#crypto'
import { ERRORS, type Digest } from '../../dist/index.js'
import {
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
  MAX_CHUNK_FRAME_BYTES
} from '../../dist/protocol/constants.js'
import {
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
  mergeBitmapPages
} from '../../dist/protocol/codecs.js'
import { transferId } from '../../dist/protocol/transfer-id.js'
import type { Codec, OfferInput, ProtocolChannel } from '../../dist/protocol/types.js'
import {
  ServerSession,
  type CommitStore,
  type ServerSessionStore
} from '../../dist/protocol/server-session.js'

const OWNER = b4a.alloc(32, 0x31)
const DATA = b4a.from('deterministic protocol property payload')

/** The fields the harness reads from an error thrown by protocol code. */
interface CaughtError {
  code?: unknown
  name?: unknown
  message?: unknown
}

/** A message recorded by the fake channel, retaining its inbound handler. */
interface RecordedMessage {
  onmessage(value: unknown): unknown
  send(value: unknown): boolean
}

/**
 * The fake channel deliberately implements only the members `ServerSession`
 * exercises, so the tests keep observing the same missing-member behaviour as
 * the untyped harness.
 */
interface FakeChannel {
  drained: boolean
  _recv(type: number, state: unknown): unknown
  addMessage<Input, Output>(options: {
    encoding: Codec<Input, Output>
    onmessage: (value: Output) => unknown
  }): RecordedMessage
  open(): void
  close(): void
}

interface FakeSessionStore {
  sessions: Map<string, unknown>
  offer(): Promise<{ verified: Set<number> }>
  writeChunk(): Promise<void>
  finish(): Promise<void>
  retireCommitted(): Promise<void>
}

interface ProtocolSessionHarness {
  channel: FakeChannel
  messages: RecordedMessage[]
  destroyed: CaughtError[]
  session: ServerSession
  sessionStore: FakeSessionStore
  readonly offerCalls: number
}

interface CorpusEntry {
  name: string
  encoded: Buffer
  maximum: number
  decode(bytes: Uint8Array, maximum?: number): unknown
}

interface LengthMutationCase {
  name: string
  maximum: number
  encoded: Buffer
  lengthOffset: number
  declared: Buffer
  decode(bytes: Uint8Array, maximum?: number): unknown
}

interface TinyDeclarationCase {
  name: string
  index: number
  encoded: Buffer
  decode(bytes: Uint8Array, maximum?: number): unknown
}

function sha256(bytes: Uint8Array): Digest {
  return crypto.createHash('sha256').update(bytes).digest()
}

/** Erases a codec's input/output types so heterogeneous cases share a table. */
function decoder<Input, Output>(
  codec: Codec<Input, Output>
): (bytes: Uint8Array, maximum?: number) => Output {
  return (bytes, maximum) => decodeBounded(codec, bytes, maximum)
}

function sampleOffer(): OfferInput {
  const value = {
    version: 1,
    name: 'property.bin',
    size: DATA.byteLength,
    digest: sha256(DATA),
    chunkSize: MAX_CHUNK_BYTES,
    chunkCount: 1
  }
  return {
    ...value,
    transferId: transferId({
      clientPublicKey: OWNER,
      name: value.name,
      size: value.size,
      digest: value.digest,
      chunkSize: value.chunkSize
    })
  }
}

function corpusEntry<Input, Output>(
  name: string,
  codec: Codec<Input, Output>,
  value: Input,
  maximum: number
): CorpusEntry {
  return {
    name,
    encoded: encodeBounded(codec, value, maximum),
    maximum,
    decode: decoder(codec)
  }
}

function corpus(): CorpusEntry[] {
  const offered = sampleOffer()
  return [
    corpusEntry('offer', offer, offered, MAX_CONTROL_BYTES),
    corpusEntry(
      'status',
      status,
      { transferId: offered.transferId, code: STATUS_CODE.REJECTED, reason: 'bounded' },
      MAX_CONTROL_BYTES
    ),
    corpusEntry(
      'bitmap-page',
      bitmapPage,
      { transferId: offered.transferId, start: 0, count: 1, bits: b4a.from([1]) },
      MAX_CONTROL_BYTES
    ),
    corpusEntry('ready', ready, { transferId: offered.transferId }, MAX_CONTROL_BYTES),
    corpusEntry(
      'chunk',
      chunk,
      {
        transferId: offered.transferId,
        index: 0,
        digest: sha256(DATA),
        data: DATA
      },
      MAX_CHUNK_FRAME_BYTES
    ),
    corpusEntry(
      'chunk-ack',
      chunkAck,
      { transferId: offered.transferId, index: 0 },
      MAX_CONTROL_BYTES
    ),
    corpusEntry('finish', finish, { transferId: offered.transferId }, MAX_CONTROL_BYTES),
    corpusEntry(
      'result',
      result,
      { transferId: offered.transferId, code: 0, reason: '' },
      MAX_CONTROL_BYTES
    )
  ]
}

function assertProtocolInvalid(t: Assert, operation: () => unknown, message: string): void {
  t.exception(operation, { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }, message)
}

function createProtocolSession(t: Assert): ProtocolSessionHarness {
  const messages: RecordedMessage[] = []
  const destroyed: CaughtError[] = []
  let offerCalls = 0
  const channel: FakeChannel = {
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
  const sessionStore: FakeSessionStore = {
    sessions: new Map(),
    offer() {
      offerCalls++
      return Promise.resolve({ verified: new Set<number>() })
    },
    writeChunk: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    retireCommitted: () => Promise.resolve()
  }
  const session = new ServerSession({
    channel: channel as unknown as ProtocolChannel,
    ownerKey: OWNER,
    sessionStore: sessionStore as unknown as ServerSessionStore,
    commitStore: {
      inspect() {
        return Promise.resolve({ status: 'AVAILABLE' })
      },
      commit: () => Promise.resolve()
    } as unknown as CommitStore,
    maxFileBytes: MAX_CHUNK_BYTES,
    destroy(error) {
      destroyed.push(error as CaughtError)
    }
  })
  t.teardown(() => session.close())
  return {
    channel,
    messages,
    destroyed,
    session,
    sessionStore,
    get offerCalls() {
      return offerCalls
    }
  }
}

async function closeProtocolSession(
  t: Assert,
  created: ProtocolSessionHarness,
  label: string
): Promise<void> {
  await created.session.close()
  await created.session.settle()
  t.is(created.session.timer, null, `${label} timer cleared`)
  t.is(created.session.drainWaiters.length, 0, `${label} drain waiters cleared`)
}

test('every codec rejects truncation at every byte offset with a typed error', (t) => {
  for (const { name, encoded, maximum, decode } of corpus()) {
    for (let offset = 0; offset < encoded.byteLength; offset++) {
      assertProtocolInvalid(
        t,
        () => decode(encoded.subarray(0, offset), maximum),
        `${name} truncated at ${offset}/${encoded.byteLength}`
      )
    }
  }
})

test('every codec rejects trailing bytes and oversized framed input', (t) => {
  for (const { name, encoded, maximum, decode } of corpus()) {
    assertProtocolInvalid(
      t,
      () => decode(b4a.concat([encoded, b4a.from([0])])),
      `${name} trailing byte`
    )
    assertProtocolInvalid(
      t,
      () => decode(b4a.alloc(maximum + 1), maximum),
      `${name} oversized input`
    )
  }
})

test('one-bit length mutations and oversized declarations fail before allocation', (t) => {
  const offered = sampleOffer()
  const cases: LengthMutationCase[] = [
    {
      name: 'offer string',
      decode: decoder(offer),
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
      decode: decoder(status),
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
      decode: decoder(bitmapPage),
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
      decode: decoder(chunk),
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
      () => entry.decode(mutated, entry.maximum),
      `${entry.name} one-bit length`
    )
    assertProtocolInvalid(
      t,
      () => entry.decode(entry.declared, entry.maximum),
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

test('huge tiny declarations fail before reaching storage-backed state', async (t) => {
  const offered = sampleOffer()
  const huge = Number.MAX_SAFE_INTEGER
  const cases: TinyDeclarationCase[] = [
    {
      name: 'offer name length',
      index: OFFER,
      decode: decoder(offer),
      encoded: b4a.concat([c.encode(c.uint, 1), offered.transferId, c.encode(c.uint, huge)])
    },
    {
      name: 'offer chunk count',
      index: OFFER,
      decode: decoder(offer),
      encoded: b4a.concat([
        c.encode(c.uint, 1),
        offered.transferId,
        c.encode(c.string, offered.name),
        c.encode(c.uint, offered.size),
        offered.digest,
        c.encode(c.uint, offered.chunkSize),
        c.encode(c.uint, huge)
      ])
    },
    {
      name: 'bitmap declared count',
      index: BITMAP_PAGE,
      decode: decoder(bitmapPage),
      encoded: b4a.concat([
        offered.transferId,
        c.encode(c.uint, 0),
        c.encode(c.uint, huge),
        c.encode(c.uint, 0)
      ])
    },
    {
      name: 'chunk data length',
      index: CHUNK,
      decode: decoder(chunk),
      encoded: b4a.concat([
        offered.transferId,
        c.encode(c.uint, 0),
        sha256(DATA),
        c.encode(c.uint, huge)
      ])
    }
  ]

  for (const entry of cases) {
    const created = createProtocolSession(t)
    try {
      t.ok(entry.encoded.byteLength < 128, `${entry.name} input remains tiny`)
      let decodingError: CaughtError | null = null
      try {
        entry.decode(entry.encoded, MAX_CHUNK_FRAME_BYTES)
      } catch (err) {
        decodingError = err as CaughtError
      }
      t.is(decodingError?.code, ERRORS.PROTOCOL_INVALID, entry.name)
      t.is(created.destroyed.length, 0, `${entry.name} rejected before session dispatch`)
      t.is(created.offerCalls, 0, `${entry.name} bypasses SessionStore.offer`)
      t.is(created.sessionStore.sessions.size, 0, `${entry.name} creates no session state`)
    } finally {
      await closeProtocolSession(t, created, entry.name)
    }
  }
})

test('one-bit digest mutation reaches real session validation and tears down typed', async (t) => {
  const offered = sampleOffer()
  const mutatedDigest = b4a.from(offered.digest)
  mutatedDigest[0] ^= 1
  const created = createProtocolSession(t)
  try {
    await created.messages[OFFER].onmessage(
      decodeBounded(offer, encodeBounded(offer, { ...offered, digest: mutatedDigest }))
    )
    await created.session.settle()
    t.is(created.destroyed[0].code, ERRORS.PROTOCOL_INVALID)
    t.is(created.offerCalls, 0)
    t.is(created.sessionStore.sessions.size, 0)
  } finally {
    await closeProtocolSession(t, created, 'digest mutation')
  }
})

test('reordered, repeated, direction-invalid, and unknown messages tear down deterministically', async (t) => {
  const offered = sampleOffer()
  const created: ProtocolSessionHarness[] = []
  const makeSession = (): ProtocolSessionHarness => {
    const session = createProtocolSession(t)
    created.push(session)
    return session
  }
  try {
    const reordered = makeSession()
    await reordered.messages[CHUNK].onmessage({
      transferId: offered.transferId,
      index: 0,
      digest: sha256(DATA),
      data: DATA
    })
    t.is(reordered.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

    const repeated = makeSession()
    const first = repeated.messages[OFFER].onmessage(offered)
    await repeated.messages[OFFER].onmessage(offered)
    await first
    await repeated.session.settle()
    t.is(repeated.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

    const inbound: Array<[number, unknown]> = [
      [STATUS, { transferId: offered.transferId, code: STATUS_CODE.ACCEPT }],
      [BITMAP_PAGE, { transferId: offered.transferId, start: 0, count: 1, bits: b4a.from([0]) }],
      [READY, { transferId: offered.transferId }],
      [CHUNK_ACK, { transferId: offered.transferId, index: 0 }],
      [RESULT, { transferId: offered.transferId, code: 0 }]
    ]
    for (const [type, value] of inbound) {
      const invalid = makeSession()
      await invalid.messages[type].onmessage(value)
      t.is(invalid.destroyed[0].code, ERRORS.PROTOCOL_INVALID)
    }

    const finishBeforeOffer = makeSession()
    await finishBeforeOffer.messages[FINISH].onmessage({
      transferId: offered.transferId
    })
    t.is(finishBeforeOffer.destroyed[0].code, ERRORS.PROTOCOL_INVALID)

    const unknown = makeSession()
    await unknown.channel._recv(255, {})
    t.is(unknown.destroyed[0].code, ERRORS.PROTOCOL_INVALID)
  } finally {
    for (let index = 0; index < created.length; index++) {
      await closeProtocolSession(t, created[index], `state session ${index}`)
    }
  }
})
