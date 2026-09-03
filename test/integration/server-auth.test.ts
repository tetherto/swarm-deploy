/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import { EventEmitter } from '#events'
import fs from '#fs'
import path from '#path'
import Hyperswarm, { type HyperswarmSocket } from 'hyperswarm'
import Protomux from 'protomux'
import {
  Server,
  keyPairFromSeed,
  transferId,
  OFFER,
  CHUNK,
  FINISH,
  STATUS_CODE,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} from '../../dist/index.js'
import type { ServerOptions } from '../../dist/server.js'
import type { Offer, Result, Status, TransferMessage } from '../../dist/protocol/types.js'
import type { ChunkAck } from '../../dist/protocol/types.js'
import type { SwarmDiscovery, Topic } from '../../dist/types.js'
import type { Testnet } from 'hyperdht/testnet'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'
import { serverInternals, watcherInternals } from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 1)
const ALLOWED_SEED = b4a.alloc(32, 2)
const UNKNOWN_SEED = b4a.alloc(32, 3)

/** Option shapes deliberately missing or out of range for validation. */
type IncompleteServerOptions = Partial<ServerOptions>

/** An injected read failure carries the errno the watcher reports. */
interface ErrnoError extends Error {
  code?: string
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

/** A Protomux message as this harness drives it: any encoded payload. */
interface HarnessMessage {
  send(value: unknown): boolean
}

interface ReceivedMessages {
  status: Status[]
  ready: TransferMessage[]
  chunkAck: ChunkAck[]
  result: Result[]
}

interface ClientChannel {
  messages: HarnessMessage[]
  received: ReceivedMessages
}

/** A scheduler handle that keeps its callback reachable for the tests. */
interface FakeTimer {
  callback: () => void
  unref(): void
}

interface TestScheduler {
  intervals: Set<FakeTimer>
  setInterval(callback: () => void): FakeTimer
  clearInterval(timer: unknown): void
  setTimeout(callback: () => void): FakeTimer
  clearTimeout(): void
}

interface StubSwarmEvent {
  type: string
  topic?: Topic
  options?: { server: boolean; client: boolean }
}

/** The swarm seam replacement: an emitter plus the two methods used. */
interface StubSwarm extends EventEmitter {
  join(topic: Topic, options: { server: boolean; client: boolean }): SwarmDiscovery
  destroy(): Promise<void>
}

interface LoggedInfo {
  message: string
  details?: Record<string, unknown>
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function fingerprint(key: Uint8Array): string {
  return b4a.toString(sha256(key), 'hex').slice(0, 12)
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

function uploadFor(ownerKey: Uint8Array): Offer {
  const data = b4a.from('authenticated upload')
  const digest = sha256(data)
  const name = 'artifact.bin'
  const size = data.byteLength
  const chunkSize = 1024 * 1024
  return {
    version: 1,
    transferId: transferId({
      clientPublicKey: ownerKey,
      name,
      size,
      digest,
      chunkSize
    }),
    name,
    size,
    digest,
    chunkSize,
    chunkCount: 1
  }
}

function openClientChannel(socket: HyperswarmSocket): ClientChannel {
  const mux = Protomux.from(socket)
  const received: ReceivedMessages = { status: [], ready: [], chunkAck: [], result: [] }
  const channel = mux.createChannel({
    protocol: 'swarm-deploy/upload/1',
    id: b4a.from('integration-upload')
  })
  const messages: HarnessMessage[] = [
    channel.addMessage({ encoding: offer }),
    channel.addMessage({ encoding: status, onmessage: (value) => received.status.push(value) }),
    channel.addMessage({ encoding: bitmapPage }),
    channel.addMessage({ encoding: ready, onmessage: (value) => received.ready.push(value) }),
    channel.addMessage({ encoding: chunk }),
    channel.addMessage({ encoding: chunkAck, onmessage: (value) => received.chunkAck.push(value) }),
    channel.addMessage({ encoding: finish }),
    channel.addMessage({ encoding: result, onmessage: (value) => received.result.push(value) })
  ]
  channel.open()
  return { messages, received }
}

function createClient(t: Assert, testnet: Testnet, seed: Buffer): Hyperswarm {
  const swarm = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(seed)
  })
  t.teardown(() => swarm.destroy())
  return swarm
}

function connect(swarm: Hyperswarm, topic: Topic): Promise<HyperswarmSocket> {
  return new Promise((resolve) => {
    swarm.once('connection', resolve)
    swarm.join(topic, { server: false, client: true })
  })
}

function createScheduler(): TestScheduler {
  const intervals = new Set<FakeTimer>()
  return {
    intervals,
    setInterval(callback) {
      const timer = { callback, unref() {} }
      intervals.add(timer)
      return timer
    },
    clearInterval(timer) {
      intervals.delete(timer as FakeTimer)
    },
    setTimeout(callback) {
      return { callback, unref() {} }
    },
    clearTimeout() {}
  }
}

function createStubSwarm(events: StubSwarmEvent[]): StubSwarm {
  const swarm = new EventEmitter() as StubSwarm
  swarm.join = (topic, options) => {
    events.push({ type: 'join', topic, options })
    return {
      async flushed() {
        events.push({ type: 'flushed' })
      }
    }
  }
  swarm.destroy = async () => {
    events.push({ type: 'destroy' })
  }
  return swarm
}

test('Server validates required upload limits', (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const options: ServerOptions = {
    seed: SERVER_SEED,
    storageDir: '/tmp/swarm-deploy-validation',
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 1024 * 1024
  }

  const invalidOptions: IncompleteServerOptions[] = [
    { ...options, seed: undefined },
    { ...options, storageDir: '' },
    { ...options, allowedKeys: undefined },
    { ...options, maxFileBytes: undefined },
    { ...options, maxStagingBytes: undefined },
    { ...options, maxFileBytes: 1.5 },
    { ...options, maxStagingBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...options, maxConnections: 0 },
    { ...options, maxActiveUploads: 1.5 },
    { ...options, idleTimeout: 0 }
  ]
  for (const invalid of invalidOptions) {
    t.exception(() => new Server(invalid as ServerOptions), {
      name: 'SwarmDeployError',
      code: 'PROTOCOL_INVALID'
    })
  }
})

test('Server firewalls unknown keys before protocol and allows authenticated uploads', async (t) => {
  const testnet = await createLocalTestnet(t)
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const unknownKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const events: unknown[] = []
  const logs: LoggedInfo[] = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    dht: testnet.createNode(),
    logger: {
      info(message, details) {
        logs.push({ message, details })
      }
    }
  })
  const internal = serverInternals(server)
  t.teardown(() => server.close())
  server.on('connection', (event: unknown) => events.push(event))
  const firewallAttempt = deferred()
  const originalFirewall = internal._firewall.bind(server)
  internal._firewall = (key) => {
    if (b4a.equals(key as Uint8Array, unknownKey)) firewallAttempt.resolve()
    return originalFirewall(key)
  }
  await server.listen()

  const unknown = createClient(t, testnet, UNKNOWN_SEED)
  unknown.join(server.topic, { server: false, client: true })
  await firewallAttempt.promise
  t.is(events.length, 0)
  t.is(internal._connections.size, 0)
  t.is(internal._sessions.size, 0)
  t.is(internal.sessionStore.sessions.size, 0)

  const allowed = createClient(t, testnet, ALLOWED_SEED)
  const socket = await connect(allowed, server.topic)
  const channel = openClientChannel(socket)
  const upload = uploadFor(allowedKey)
  channel.messages[OFFER].send(upload)
  await waitFor(() => channel.received.ready.length === 1)

  t.is(channel.received.status[0].code, STATUS_CODE.ACCEPT)
  t.is(internal.sessionStore.sessions.size, 1)
  t.is(events.length, 1)
  const serialized = JSON.stringify({ events, logs })
  t.ok(serialized.includes(fingerprint(allowedKey)))
  t.absent(serialized.includes(b4a.toString(allowedKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(unknownKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(SERVER_SEED, 'hex')))

  channel.messages[CHUNK].send({
    transferId: upload.transferId,
    index: 0,
    digest: upload.digest,
    data: b4a.from('authenticated upload')
  })
  await waitFor(() => channel.received.chunkAck.length === 1)
  channel.messages[FINISH].send({ transferId: upload.transferId })
  await waitFor(() => channel.received.result.length === 1)

  t.is(channel.received.result[0].code, 0)
  t.is(internal.sessionStore.sessions.size, 0)
  t.alike(
    await fs.promises.readFile(path.join(internal.layout.root, upload.name)),
    b4a.from('authenticated upload')
  )
})

test('Server revocation closes sockets and deletes authenticated resumable sessions', async (t) => {
  const testnet = await createLocalTestnet(t)
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    dht: testnet.createNode()
  })
  const internal = serverInternals(server)
  t.teardown(() => server.close())
  await server.listen()

  const allowed = createClient(t, testnet, ALLOWED_SEED)
  const socket = await connect(allowed, server.topic)
  const channel = openClientChannel(socket)
  channel.messages[OFFER].send(uploadFor(allowedKey))
  await waitFor(() => internal.sessionStore.sessions.size === 1)

  await server.reloadAllowlist([])
  await waitFor(() => socket.destroyed === true)

  t.is(internal.sessionStore.sessions.size, 0)
})

test('Server starts recovery and retention before networking and rechecks revoked connections', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const unknownKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const scheduler = createScheduler()
  const events: StubSwarmEvent[] = []
  let server!: Server
  server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    scheduler,
    swarmFactory() {
      const internal = serverInternals(server)
      t.ok(internal.sessionStore.initialized)
      t.ok(internal.retentionManager.timer)
      events.push({ type: 'swarm' })
      return createStubSwarm(events)
    }
  })
  const internal = serverInternals(server)
  t.teardown(() => server.close())
  const allowlistEvents: unknown[] = []
  server.on('allowlist', (event: unknown) => allowlistEvents.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing allowlist listener')
  })

  await server.listen()
  t.is(internal._firewall(unknownKey), true)
  t.is(internal._firewall(allowedKey), false)
  await t.exception(() => server.reloadAllowlist(['not-a-public-key']))
  t.alike(server.allowedKeys, new Set([b4a.toString(allowedKey, 'hex')]))
  await server.reloadAllowlist([])
  t.alike(allowlistEvents, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'PROTOCOL_INVALID'
    },
    { status: 'completed', appliedCount: 0, pendingCount: 0 }
  ])

  let destroyed: ErrnoError | null = null
  internal._onConnection({
    remotePublicKey: allowedKey,
    destroy(error) {
      destroyed = error as ErrnoError
    }
  })
  t.is(destroyed!.code, 'AUTH_REJECTED')
  await server.close()

  t.alike(
    events.map((event) => event.type),
    ['swarm', 'join', 'flushed', 'destroy']
  )
  t.is(scheduler.intervals.size, 0)
})

test('Server reports live allowlist read and parse failures then applies the next valid poll', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const nextKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const allowlistDir = await createTempDir(t)
  const allowlistPath = path.join(allowlistDir, 'private-customer-allowlist')
  await fs.promises.writeFile(allowlistPath, `${b4a.toString(allowedKey, 'hex')}\n`)
  const scheduler = createScheduler()
  let unreadable = false
  const storage = createStorage({
    beforeOperation(name, filePath) {
      if (unreadable && name === 'readFile' && filePath === allowlistPath) {
        const error: ErrnoError = new Error(`cannot read ${allowlistPath}`)
        error.code = 'EACCES'
        throw error
      }
    }
  })
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    allowlistPath,
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    minFreeBytes: 0,
    scheduler,
    storage,
    swarmFactory: () => createStubSwarm([]),
    logger: {
      warn() {
        throw new Error('throwing server logger')
      }
    }
  })
  const internal = serverInternals(server)
  const events: unknown[] = []
  server.on('allowlist', (event: unknown) => events.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing server listener')
  })
  await server.listen()
  events.length = 0
  const watcher = watcherInternals(internal.allowlistWatcher)

  await fs.promises.writeFile(allowlistPath, 'PRIVATE-CONTENT\n')
  await watcher.timer!.callback()
  t.is(internal._firewall(allowedKey), false)
  t.alike(server.allowedKeys, new Set([b4a.toString(allowedKey, 'hex')]))
  t.alike(watcher.keys, new Set([b4a.toString(allowedKey, 'hex')]))

  unreadable = true
  await watcher.timer!.callback()
  t.is(internal._firewall(allowedKey), false)

  unreadable = false
  await fs.promises.writeFile(allowlistPath, `${b4a.toString(nextKey, 'hex')}\n`)
  await watcher.timer!.callback()
  t.is(internal._firewall(allowedKey), true)
  t.is(internal._firewall(nextKey), false)
  t.alike(events, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'INVALID_PUBLIC_KEY'
    },
    { status: 'failed', appliedCount: 1, pendingCount: 0, reason: 'EACCES' },
    { status: 'completed', appliedCount: 1, pendingCount: 0 }
  ])
  const serialized = JSON.stringify(events)
  t.absent(serialized.includes(b4a.toString(allowedKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(nextKey, 'hex')))
  t.absent(serialized.includes('private-customer-allowlist'))
  t.absent(serialized.includes('PRIVATE-CONTENT'))
  await server.close()
})

test('Server initial allowlist failure emits safely and remains startup-fatal', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const allowlistDir = await createTempDir(t)
  const allowlistPath = path.join(allowlistDir, 'private-initial-allowlist')
  await fs.promises.writeFile(allowlistPath, 'PRIVATE-INITIAL-CONTENT\n')
  let swarmCreations = 0
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    allowlistPath,
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    minFreeBytes: 0,
    swarmFactory() {
      swarmCreations++
      return createStubSwarm([])
    }
  })
  const events: unknown[] = []
  server.on('allowlist', (event: unknown) => events.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing initial failure listener')
  })

  await t.exception(() => server.listen(), {
    name: 'SwarmDeployError',
    code: 'INVALID_PUBLIC_KEY'
  })
  t.is(swarmCreations, 0)
  t.alike(events, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'INVALID_PUBLIC_KEY'
    }
  ])
  const serialized = JSON.stringify(events)
  t.absent(serialized.includes('private-initial-allowlist'))
  t.absent(serialized.includes('PRIVATE-INITIAL-CONTENT'))
})

test('Server startup failure releases the storage lock', async (t) => {
  const storageDir = await createTempDir(t)
  const options: ServerOptions = {
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(ALLOWED_SEED).publicKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024
  }
  const failed = new Server({
    ...options,
    swarmFactory() {
      throw new Error('injected swarm failure')
    }
  })

  await t.exception(() => failed.listen())
  const recovered = new Server({
    ...options,
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => recovered.close())
  await recovered.listen()

  t.ok(recovered.listening)
})

test('Server reloadAllowlist revokes removed keys before listen', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => server.close())

  const events: unknown[] = []
  server.on('allowlist', (event: unknown) => events.push(event))

  const reloaded = await server.reloadAllowlist([])

  t.alike(reloaded, new Set())
  t.alike(server.allowedKeys, new Set())
  t.alike(events, [{ status: 'completed', appliedCount: 0, pendingCount: 0 }])
  t.is(serverInternals(server).pendingRevocations.size, 0)
})

test('Server contains logger failures', async (t) => {
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [keyPairFromSeed(ALLOWED_SEED).publicKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    logger: {
      info() {
        throw new Error('logger failure')
      },
      warn() {
        throw new Error('logger failure')
      },
      error() {
        throw new Error('logger failure')
      }
    },
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => server.close())

  await server.listen()
  t.is(serverInternals(server)._firewall(keyPairFromSeed(UNKNOWN_SEED).publicKey), true)
})
