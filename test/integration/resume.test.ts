/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { EventEmitter } from '#events'
import Protomux from 'protomux'
import { Duplex } from 'streamx'
import { Client, Server, keyPairFromSeed, topicFromServerPublicKey } from '../../dist/index.js'
import { SwarmDeployError, ERRORS } from '../../dist/errors.js'
import { UPLOAD_PROTOCOL } from '../../dist/protocol/client-session.js'
import {
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} from '../../dist/protocol/codecs.js'
import type { Scheduler, Swarm, SwarmSocket } from '../../dist/types.js'
import { createTempDir, writeDeterministicFile, CHUNK_SIZE } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { clientInternals, destroyServerConnections, serverInternals } from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 31)
const CLIENT_SEED = b4a.alloc(32, 32)

interface Harness {
  client: Client
  server: Server
}

interface ScriptedSwarm extends Swarm {
  connect(): void
  emit(event: string, ...args: unknown[]): boolean
}

interface ImmediateTimer {
  native: ReturnType<typeof setTimeout>
  cancelled: boolean
}

function createDuplexPair(): { client: SwarmSocket; server: Duplex } {
  let left!: Duplex
  let right!: Duplex
  left = new Duplex({
    write(data, callback) {
      right.push(data)
      callback(null)
    }
  })
  right = new Duplex({
    write(data, callback) {
      left.push(data)
      callback(null)
    }
  })
  left.on('error', () => {})
  right.on('error', () => {})
  left.once('close', () => {
    if (!right.destroyed) right.destroy()
  })
  right.once('close', () => {
    if (!left.destroyed) left.destroy()
  })
  return { client: left as unknown as SwarmSocket, server: right }
}

function createFlappingSwarm(serverKey: Buffer, onOffer: () => void): ScriptedSwarm {
  const swarm = new EventEmitter() as unknown as ScriptedSwarm
  swarm.connect = () => {
    const { client, server } = createDuplexPair()
    client.remotePublicKey = serverKey
    const mux = Protomux.from(server)
    mux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => {
      const channel = mux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
      channel.addMessage({
        encoding: offer,
        onmessage() {
          onOffer()
          server.destroy()
        }
      })
      channel.addMessage({ encoding: status })
      channel.addMessage({ encoding: bitmapPage })
      channel.addMessage({ encoding: ready })
      channel.addMessage({ encoding: chunk })
      channel.addMessage({ encoding: chunkAck })
      channel.addMessage({ encoding: finish })
      channel.addMessage({ encoding: result })
      channel.open()
    })
    swarm.emit('connection', client, { publicKey: serverKey })
  }
  swarm.join = () => ({
    flushed: () => {
      swarm.connect()
      return Promise.resolve()
    }
  })
  swarm.destroy = () => {}
  return swarm
}

function createImmediateScheduler(
  now: { value: number },
  onReconnect: (() => void) | null
): Scheduler {
  return {
    setTimeout(callback, delay) {
      const timer = { native: null as unknown as ReturnType<typeof setTimeout>, cancelled: false }
      timer.native = setTimeout(() => {
        if (timer.cancelled) return
        if (delay === 30_000) now.value += delay
        if (delay <= 1_000) onReconnect?.()
        callback()
      }, 0)
      return timer
    },
    clearTimeout(handle) {
      const timer = handle as ImmediateTimer
      timer.cancelled = true
      clearTimeout(timer.native)
    }
  }
}

async function setup(t: Assert): Promise<Harness> {
  const testnet = await createLocalTestnet(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 8 * CHUNK_SIZE,
    maxStagingBytes: 16 * CHUNK_SIZE,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()
  const client = new Client({
    seed: CLIENT_SEED,
    topic: server.topic,
    dht: testnet.createNode(),
    connectTimeout: 5_000,
    idleTimeout: 10_000
  })
  t.teardown(() => client.close())
  return { client, server }
}

test('Client reconnects and resumes by sending only server-missing chunks', async (t) => {
  const { client, server } = await setup(t)
  const internal = serverInternals(server)
  const input = path.join(await createTempDir(t), 'resume.bin')
  await writeDeterministicFile(input, 5 * CHUNK_SIZE + 11)

  const writes: number[] = []
  const writeChunk = internal.sessionStore.writeChunk.bind(internal.sessionStore)
  internal.sessionStore.writeChunk = async (transferId, value) => {
    const snapshot = await writeChunk(transferId, value)
    writes.push(value.index)
    if (writes.length === 2) destroyServerConnections(server)
    return snapshot
  }

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(writes, [0, 1, 2, 3, 4, 5])
  t.alike(
    await fs.promises.readFile(path.join(internal.layout.root, 'resume.bin')),
    await fs.promises.readFile(input)
  )
})

test('Client resolves a lost final result through ALREADY_COMMITTED', async (t) => {
  const { client, server } = await setup(t)
  const internal = serverInternals(server)
  const input = path.join(await createTempDir(t), 'lost-result.bin')
  await fs.promises.writeFile(input, b4a.from('durably committed before result loss'))

  const retireCommitted = internal.sessionStore.retireCommitted.bind(internal.sessionStore)
  let disconnected = false
  internal.sessionStore.retireCommitted = async (transferId) => {
    const retired = await retireCommitted(transferId)
    if (!disconnected) {
      disconnected = true
      destroyServerConnections(server)
    }
    return retired
  }

  const result = await client.upload(input)
  t.is(result.status, 'ALREADY_COMMITTED')
  t.alike(await fs.promises.readdir(internal.layout.staging), [])
  t.alike(
    await fs.promises.readFile(path.join(internal.layout.root, 'lost-result.bin')),
    b4a.from('durably committed before result loss')
  )
})

test('Client starts a fresh reconnect window after an active transport loss', async (t) => {
  const now = { value: 0 }
  let attempts = 0
  const serverKey = keyPairFromSeed(SERVER_SEED).publicKey
  const swarm = createFlappingSwarm(serverKey, () => {
    attempts++
    now.value = 60_000
  })
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(serverKey),
    clock: { now: () => now.value },
    scheduler: createImmediateScheduler(now, null),
    swarmFactory: () => swarm
  })
  t.teardown(() => client.close())
  const source = path.join(await createTempDir(t), 'fresh-window.bin')
  await fs.promises.writeFile(source, b4a.from('fresh reconnect deadline'))

  await t.exception(() => client.upload(source), {
    name: 'SwarmDeployError',
    code: ERRORS.CONNECT_TIMEOUT
  })
  t.is(attempts, 1)
  t.is(now.value, 90_000)
})

test('Client reports CONNECT_TIMEOUT when the initial server is missing', async (t) => {
  let now = 0
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(keyPairFromSeed(SERVER_SEED).publicKey),
    clock: { now: () => now }
  })
  const internal = clientInternals(client)
  internal._ensureStarted = () => Promise.resolve(client)
  internal._waitForSocket = (deadline) => {
    now = deadline
    return Promise.reject(new SwarmDeployError(ERRORS.CONNECT_TIMEOUT, 'missing server'))
  }

  await t.exception(() => internal._uploadManifest({}), {
    name: 'SwarmDeployError',
    code: ERRORS.CONNECT_TIMEOUT
  })
})

test('Client bounds repeated transport flapping with a reconnect budget', async (t) => {
  const now = { value: 0 }
  let attempts = 0
  const serverKey = keyPairFromSeed(SERVER_SEED).publicKey
  let swarm!: ScriptedSwarm
  swarm = createFlappingSwarm(serverKey, () => {
    attempts++
  })
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(serverKey),
    maxReconnectAttempts: 2,
    clock: { now: () => now.value },
    scheduler: createImmediateScheduler(now, () => swarm.connect()),
    swarmFactory: () => swarm
  })
  t.teardown(() => client.close())
  const source = path.join(await createTempDir(t), 'flapping.bin')
  await fs.promises.writeFile(source, b4a.from('bounded flapping'))

  await t.exception(() => client.upload(source), {
    name: 'SwarmDeployError',
    code: ERRORS.CONNECT_TIMEOUT
  })
  t.is(attempts, 3)
})
