'use strict'

const test = require('brittle')
const b4a = require('b4a')
const fs = require('#fs')
const path = require('#path')
const { Client, Server, keyPairFromSeed } = require('../..')
const { createTempDir, writeDeterministicFile, CHUNK_SIZE } = require('../helpers/files')
const { createLocalTestnet } = require('../helpers/testnet')

const SERVER_SEED = b4a.alloc(32, 31)
const CLIENT_SEED = b4a.alloc(32, 32)

async function setup(t) {
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

function destroyServerConnections(server) {
  for (const socket of server._connections.keys()) socket.destroy()
}

test('Client reconnects and resumes by sending only server-missing chunks', async (t) => {
  const { client, server } = await setup(t)
  const input = path.join(await createTempDir(t), 'resume.bin')
  await writeDeterministicFile(input, 5 * CHUNK_SIZE + 11)

  const writes = []
  const writeChunk = server.sessionStore.writeChunk.bind(server.sessionStore)
  server.sessionStore.writeChunk = async (transferId, value) => {
    const snapshot = await writeChunk(transferId, value)
    writes.push(value.index)
    if (writes.length === 2) destroyServerConnections(server)
    return snapshot
  }

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(writes, [0, 1, 2, 3, 4, 5])
  t.alike(
    await fs.promises.readFile(path.join(server.layout.root, 'resume.bin')),
    await fs.promises.readFile(input)
  )
})

test('Client resolves a lost final result through ALREADY_COMMITTED', async (t) => {
  const { client, server } = await setup(t)
  const input = path.join(await createTempDir(t), 'lost-result.bin')
  await fs.promises.writeFile(input, b4a.from('durably committed before result loss'))

  const retireCommitted = server.sessionStore.retireCommitted.bind(server.sessionStore)
  let disconnected = false
  server.sessionStore.retireCommitted = async (transferId) => {
    const retired = await retireCommitted(transferId)
    if (!disconnected) {
      disconnected = true
      destroyServerConnections(server)
    }
    return retired
  }

  const result = await client.upload(input)
  t.is(result.status, 'ALREADY_COMMITTED')
  t.alike(await fs.promises.readdir(server.layout.staging), [])
  t.alike(
    await fs.promises.readFile(path.join(server.layout.root, 'lost-result.bin')),
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
  const deadlines = []
  const socket = {}
  client._ensureStarted = async () => client
  client._delay = async () => true
  client._waitForSocket = async (deadline) => {
    deadlines.push(deadline)
    if (deadlines.length === 1) return socket
    now = deadline
    throw new (require('../../lib/errors').SwarmDeployError)(
      require('../../lib/errors').ERRORS.UPLOAD_IDLE_TIMEOUT,
      'unavailable'
    )
  }
  client._startSession = async () => {
    now = 60_000
    const error = new (require('../../lib/errors').SwarmDeployError)(
      require('../../lib/errors').ERRORS.PROTOCOL_INVALID,
      'lost'
    )
    error.transport = true
    throw error
  }

  await t.exception(() => client._uploadManifest({}), {
    name: 'SwarmDeployError',
    code: 'UPLOAD_IDLE_TIMEOUT'
  })
  t.alike(deadlines, [30_000, 90_000])
})
