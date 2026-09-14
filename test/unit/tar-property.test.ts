/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import events from '#events'
import { ERRORS } from '../../dist/errors.js'
import { encodeControlFrame, MAX_CONTROL_RECORD_BYTES } from '../../dist/tar-protocol/controls.js'
import { DirectWireReader } from '../../dist/tar-protocol/direct-wire.js'

const EventEmitter = events.EventEmitter
const SEED = 0x5a17c9e3

function random(seed = SEED): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

class PropertySocket extends EventEmitter {
  pause(): void {}
  resume(): void {}
  feed(bytes: Uint8Array): void {
    if (bytes.byteLength > 0) this.emit('data', b4a.from(bytes))
  }
  finish(): void {
    this.emit('end')
  }
}

function fragment(socket: PropertySocket, bytes: Buffer, next: () => number): void {
  for (let offset = 0; offset < bytes.byteLength;) {
    const size = 1 + (next() % Math.min(97, bytes.byteLength - offset))
    socket.feed(bytes.subarray(offset, offset + size))
    offset += size
  }
}

test('property: bounded control frames survive deterministic random fragmentation', async (t) => {
  const next = random()
  for (let iteration = 0; iteration < 200; iteration++) {
    const length = 1 + (next() % MAX_CONTROL_RECORD_BYTES)
    const body = b4a.alloc(length)
    for (let index = 0; index < body.byteLength; index++) body[index] = next() & 0xff
    const socket = new PropertySocket()
    const reader = new DirectWireReader(socket as never)
    fragment(socket, encodeControlFrame(body), next)
    t.alike(await reader.control((value) => b4a.from(value), null, 50), body)
    reader.closeReader()
  }
})

test('property: truncations and oversized declarations fail with bounded typed errors', async (t) => {
  const next = random(SEED ^ 0xffffffff)
  for (let iteration = 0; iteration < 200; iteration++) {
    const declared =
      iteration % 2 === 0
        ? 1 + (next() % MAX_CONTROL_RECORD_BYTES)
        : MAX_CONTROL_RECORD_BYTES + 1 + (next() % 0xffff)
    const prefix = b4a.from([
      (declared >>> 24) & 0xff,
      (declared >>> 16) & 0xff,
      (declared >>> 8) & 0xff,
      declared & 0xff
    ])
    const available =
      declared <= MAX_CONTROL_RECORD_BYTES ? next() % Math.max(1, declared) : next() % 32
    const arbitrary = b4a.alloc(available)
    for (let index = 0; index < arbitrary.byteLength; index++) arbitrary[index] = next() & 0xff
    const socket = new PropertySocket()
    const reader = new DirectWireReader(socket as never)
    fragment(socket, b4a.concat([prefix, arbitrary]), next)
    socket.finish()
    await t.exception(
      reader.control((value) => value, null, 50),
      {
        code: ERRORS.PROTOCOL_INVALID
      }
    )
    reader.closeReader()
  }
})
