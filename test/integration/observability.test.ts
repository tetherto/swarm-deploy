/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import Hyperswarm from 'hyperswarm'
import {
  Client,
  Server,
  buildFileManifest,
  keyPairFromSeed,
  transferId,
  ERRORS
} from '../../dist/index.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { serverInternals } from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 0xa1)
const CLIENT_SEED = b4a.alloc(32, 0xa2)
const UNKNOWN_SEED = b4a.alloc(32, 0xa3)
const CHUNK_SIZE = 1024 * 1024

/** The observable fields the emitted lifecycle payloads are asserted on. */
interface EventPayload {
  status?: string
  reason?: string
  trigger?: string
  bytesReceived?: number
  bytesSent?: number
  final?: boolean
  fingerprint?: string
  [key: string]: unknown
}

interface RecordedEvent {
  name: string
  payload: EventPayload
}

/** Any emitter whose lifecycle events carry a single payload object. */
interface EventSource {
  on(name: string, listener: (payload: EventPayload) => void): unknown
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function recordEvents(emitter: EventSource, names: string[], output: RecordedEvent[]): void {
  for (const name of names) emitter.on(name, (payload) => output.push({ name, payload }))
}

function assertSubsequence(
  t: Assert,
  events: RecordedEvent[],
  expected: Array<(event: RecordedEvent) => boolean>,
  label: string
): void {
  let cursor = 0
  for (const event of events) {
    if (expected[cursor](event)) cursor++
    if (cursor === expected.length) break
  }
  t.is(cursor, expected.length, label)
}

test('typed observability covers resume reject recovery retention auth and privacy', async (t) => {
  const testnet = await createLocalTestnet(t)
  const root = await createTempDir(t)
  const sourceDir = await createTempDir(t)
  const source = path.join(sourceDir, 'resume-events.bin')
  const rejectedSource = path.join(sourceDir, 'oversized-events.bin')
  const bytes = b4a.alloc(CHUNK_SIZE + 3, 0x5a)
  await fs.promises.writeFile(source, bytes)
  await fs.promises.writeFile(rejectedSource, b4a.alloc(2 * CHUNK_SIZE + 1, 0x6b))

  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const serverEvents: RecordedEvent[] = []
  const clientEvents: RecordedEvent[] = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: root,
    allowedKeys: [ownerKey],
    maxFileBytes: 3 * CHUNK_SIZE,
    maxStagingBytes: 4 * CHUNK_SIZE,
    maxStorageBytes: 2 * CHUNK_SIZE,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const internal = serverInternals(server)
  recordEvents(
    server,
    [
      'authentication',
      'connection-open',
      'connection-close',
      'offer',
      'progress',
      'verification',
      'commit',
      'recovery',
      'scrub',
      'retention',
      'cleanup',
      'revocation'
    ],
    serverEvents
  )
  server.on('progress', () => {
    throw new Error('throwing server event listener')
  })
  await server.listen()
  t.teardown(() => server.close())

  const manifest = await buildFileManifest(source)
  const id = transferId({
    clientPublicKey: ownerKey,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize
  })
  const offer = {
    version: 1,
    transferId: id,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount
  }
  await internal.sessionStore.offer(ownerKey, offer)
  await internal.sessionStore.writeChunk(id, {
    transferId: id,
    index: 0,
    digest: manifest.chunkDigests[0],
    data: bytes.subarray(0, CHUNK_SIZE)
  })

  const client = new Client({
    seed: CLIENT_SEED,
    topic: server.topic,
    connectTimeout: 5_000,
    idleTimeout: 5_000,
    dht: testnet.createNode()
  })
  recordEvents(
    client,
    [
      'authentication',
      'connection-open',
      'connection-close',
      'offer',
      'progress',
      'verification',
      'commit',
      'result',
      'close'
    ],
    clientEvents
  )
  client.on('progress', () => {
    throw new Error('throwing client event listener')
  })
  t.teardown(() => client.close())

  const uploaded = await client.upload(source)
  t.is(uploaded.status, 'COMMITTED')
  await t.exception(() => client.upload(rejectedSource), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_TOO_LARGE
  })

  const firewallAttempt = deferred()
  const originalFirewall = internal._firewall.bind(server)
  internal._firewall = (key) => {
    if (b4a.equals(key as Uint8Array, keyPairFromSeed(UNKNOWN_SEED).publicKey)) {
      firewallAttempt.resolve()
    }
    return originalFirewall(key)
  }
  const unknown = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(UNKNOWN_SEED)
  })
  t.teardown(() => unknown.destroy())
  unknown.join(server.topic, { server: false, client: true })
  await firewallAttempt.promise

  const cleanup = await buildFileManifest(rejectedSource)
  const cleanupId = transferId({
    clientPublicKey: ownerKey,
    name: cleanup.name,
    size: cleanup.size,
    digest: cleanup.digest,
    chunkSize: cleanup.chunkSize
  })
  await internal.sessionStore.offer(ownerKey, {
    version: 1,
    transferId: cleanupId,
    name: cleanup.name,
    size: cleanup.size,
    digest: cleanup.digest,
    chunkSize: cleanup.chunkSize,
    chunkCount: cleanup.chunkCount
  })
  await server.reloadAllowlist([])
  await client.close()

  assertSubsequence(
    t,
    serverEvents,
    [
      (event) => event.name === 'recovery' && event.payload.status === 'started',
      (event) => event.name === 'scrub' && event.payload.status === 'completed',
      (event) => event.name === 'recovery' && event.payload.status === 'completed',
      (event) => event.name === 'retention' && event.payload.trigger === 'startup',
      (event) => event.name === 'authentication' && event.payload.status === 'accepted',
      (event) => event.name === 'connection-open',
      (event) => event.name === 'offer' && event.payload.status === 'resumed',
      (event) => event.name === 'progress' && event.payload.bytesReceived === manifest.size,
      (event) => event.name === 'verification' && event.payload.status === 'started',
      (event) => event.name === 'verification' && event.payload.status === 'succeeded',
      (event) => event.name === 'commit' && event.payload.status === 'started',
      (event) => event.name === 'commit' && event.payload.status === 'succeeded',
      (event) =>
        event.name === 'offer' &&
        event.payload.status === 'rejected' &&
        event.payload.reason === ERRORS.FILE_TOO_LARGE,
      (event) => event.name === 'authentication' && event.payload.status === 'rejected',
      (event) => event.name === 'connection-close',
      (event) => event.name === 'cleanup' && event.payload.reason === 'revocation',
      (event) => event.name === 'revocation'
    ],
    'server lifecycle event order'
  )
  assertSubsequence(
    t,
    clientEvents,
    [
      (event) => event.name === 'authentication' && event.payload.status === 'accepted',
      (event) => event.name === 'connection-open',
      (event) => event.name === 'offer' && event.payload.status === 'offered',
      (event) => event.name === 'offer' && event.payload.status === 'resumed',
      (event) => event.name === 'progress' && event.payload.bytesSent === manifest.size,
      (event) => event.name === 'verification' && event.payload.status === 'started',
      (event) => event.name === 'verification' && event.payload.status === 'succeeded',
      (event) => event.name === 'commit' && event.payload.status === 'succeeded',
      (event) => event.name === 'result' && event.payload.status === 'COMMITTED',
      (event) =>
        event.name === 'result' &&
        event.payload.status === ERRORS.FILE_TOO_LARGE &&
        event.payload.final === true,
      (event) => event.name === 'connection-close',
      (event) => event.name === 'close'
    ],
    'client lifecycle event order'
  )

  const serialized = JSON.stringify({ serverEvents, clientEvents })
  for (const secret of [SERVER_SEED, CLIENT_SEED, UNKNOWN_SEED, ownerKey, server.publicKey]) {
    t.absent(serialized.includes(hex(secret)), `events hide ${hex(secret).slice(0, 4)} material`)
  }
  const fingerprints = serverEvents
    .map((entry) => entry.payload.fingerprint)
    .filter((value): value is string => Boolean(value))
  for (const fingerprint of fingerprints) {
    t.ok(/^[0-9a-f]{12}$/.test(fingerprint))
  }
})
