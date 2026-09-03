/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, Server, keyPairFromSeed } from '../../dist/index.js'
import { SwarmDeployError, ERRORS } from '../../dist/errors.js'
import { createTempDir, writeDeterministicFile, CHUNK_SIZE } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { clientInternals, destroyServerConnections, serverInternals } from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 31)
const CLIENT_SEED = b4a.alloc(32, 32)

/** A transport-loss failure carries the flag the reconnect window keys on. */
interface TransportError extends SwarmDeployError {
  transport?: boolean
}

interface Harness {
  client: Client
  server: Server
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
    serverPublicKey: server.publicKey,
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
  let now = 0
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    clock: { now: () => now }
  })
  const deadlines: number[] = []
  const socket = {}
  const internal = clientInternals(client)
  internal._ensureStarted = async () => client
  internal._delay = async () => true
  internal._waitForSocket = async (deadline) => {
    deadlines.push(deadline)
    if (deadlines.length === 1) return socket
    now = deadline
    throw new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'unavailable')
  }
  internal._startSession = async () => {
    now = 60_000
    const error: TransportError = new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'lost')
    error.transport = true
    throw error
  }

  await t.exception(() => internal._uploadManifest({}), {
    name: 'SwarmDeployError',
    code: 'UPLOAD_IDLE_TIMEOUT'
  })
  t.alike(deadlines, [30_000, 90_000])
})
