/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import events from '#events'
import { ERRORS } from '../../dist/errors.js'
import {
  decodeAnyMetadataRecord,
  encodeControlFrame,
  encodeTreeMetadataRecord,
  MAX_CONTROL_RECORD_BYTES
} from '../../dist/tar-protocol/controls.js'
import { DirectWireReader } from '../../dist/tar-protocol/direct-wire.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import {
  assertTreeMetadataTransferId,
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

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

test('property: random safe trees frame deterministically and resume at every offset', async (t) => {
  const owner = b4a.alloc(32, 44)
  const next = random(SEED ^ 0x1234abcd)
  for (let iteration = 0; iteration < 25; iteration++) {
    const root = await createTempDir(t)
    const source = `${root}/artifact`
    const spec: Record<string, string> = {}
    const files = 1 + (next() % 6)
    for (let index = 0; index < files; index++) {
      const depth = 1 + (next() % 3)
      const segments = Array.from({ length: depth }, (_value, level) => `d${level}${next() % 3}`)
      spec[`${segments.join('/')}/f${index}.bin`] = 'x'.repeat(next() % 1500)
    }
    spec[`empty${next() % 3}/`] = ''
    await writeTree(source, spec)

    const manifest = await buildTreeManifest(source, owner)
    const chunks: Buffer[] = []
    await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    const whole = b4a.concat(chunks)
    t.is(whole.byteLength, manifest.tarSize)
    t.alike(sodiumSha256(whole), manifest.tarSha256)
    const rebuilt = await buildTreeManifest(source, owner)
    t.alike(rebuilt.transferId, manifest.transferId)

    const record = treeMetadataFromManifest(manifest)
    t.alike(decodeAnyMetadataRecord(encodeTreeMetadataRecord(record)), record)
    assertTreeMetadataTransferId(owner, record)

    const offsets = new Set<number>()
    for (let offset = 0; offset <= manifest.tarSize; offset += 512) offsets.add(offset)
    for (let index = 0; index < 6; index++) offsets.add(next() % (manifest.tarSize + 1))
    for (const offset of offsets) {
      const suffix: Buffer[] = []
      const result = await regenerateTreeTarSuffix(
        manifest,
        offset,
        (chunk) => {
          suffix.push(b4a.from(chunk))
        },
        { expectedPrefixSha256: sodiumSha256(whole.subarray(0, offset)) }
      )
      t.is(result.status, 'MATCH')
      t.alike(b4a.concat(suffix), whole.subarray(offset))
    }
  }
})
