/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, ERRORS, keyPairFromSeed, Server } from '../../dist/index.js'
import { DirectDhtClient } from '../../dist/direct-dht.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 0xc1)
const CLIENT_SEED = b4a.alloc(32, 0xc2)

test('public events and loggers contain failures while forwarding private lifecycle data', async (t) => {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const source = await createTempDir(t)
  const input = path.join(source, 'observed.txt')
  await fs.promises.writeFile(input, 'observability payload')
  const clientKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const serverEvents: Array<Record<string, unknown>> = []
  const clientEvents: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  const throwingLogger = {
    info(message: string, details?: Record<string, unknown>) {
      logs.push({ level: 'info', message, ...details })
      throw new Error('throwing info logger')
    },
    warn(message: string, details?: Record<string, unknown>) {
      logs.push({ level: 'warn', message, ...details })
      throw new Error('throwing warn logger')
    },
    error(message: string, details?: Record<string, unknown>) {
      logs.push({ level: 'error', message, ...details })
      throw new Error('throwing error logger')
    }
  }
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [clientKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    idleTimeout: 100,
    dht: testnet.createNode(),
    logger: throwingLogger
  })
  for (const name of ['recovery', 'retention', 'failure'] as const) {
    server.on(name, (event) => serverEvents.push({ type: name, ...event }))
    server.on(name, () => {
      throw new Error(`throwing ${name} listener`)
    })
  }
  server.on('progress', (event) => serverEvents.push({ type: 'progress', ...event }))
  server.on('progress', () => {
    throw new Error('throwing server progress listener')
  })
  await server.listen()

  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 1_000,
    dht: testnet.createNode(),
    logger: throwingLogger
  })
  client.on('progress', (event) => clientEvents.push({ type: 'progress', ...event }))
  client.on('progress', () => {
    throw new Error('throwing client progress listener')
  })
  client.on('result', (event) => clientEvents.push({ type: 'result', ...event }))
  client.on('failure', (event) => clientEvents.push({ type: 'failure', ...event }))
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  const uploaded = await client.upload(input)
  t.is(uploaded.status, 'COMMITTED')

  const idle = new DirectDhtClient({
    keyPair: keyPairFromSeed(CLIENT_SEED),
    dht: testnet.createNode(),
    connectTimeout: 5_000
  })
  t.teardown(() => idle.close())
  await idle.connect(server.publicKey)
  await waitFor(() =>
    serverEvents.some(
      (event) => event.type === 'failure' && event.reason === ERRORS.UPLOAD_IDLE_TIMEOUT
    )
  )

  t.ok(serverEvents.some((event) => event.type === 'recovery' && event.status === 'started'))
  t.ok(serverEvents.some((event) => event.type === 'recovery' && event.status === 'completed'))
  t.ok(
    serverEvents.some(
      (event) =>
        event.type === 'retention' &&
        event.trigger === 'startup' &&
        event.status === 'completed' &&
        event.countDeleted === 0 &&
        event.versionDeleted === 0
    )
  )
  t.ok(serverEvents.some((event) => event.type === 'progress'))
  t.ok(clientEvents.some((event) => event.type === 'progress'))
  t.ok(clientEvents.some((event) => event.type === 'result' && event.status === 'COMMITTED'))
  t.ok(logs.some((entry) => entry.level === 'warn'))

  const serialized = JSON.stringify({ serverEvents, clientEvents, logs })
  for (const value of [
    SERVER_SEED,
    CLIENT_SEED,
    server.publicKey,
    clientKey,
    keyPairFromSeed(SERVER_SEED).secretKey,
    keyPairFromSeed(CLIENT_SEED).secretKey
  ]) {
    t.absent(serialized.includes(b4a.toString(value, 'hex')))
  }
  for (const event of [...serverEvents, ...clientEvents]) {
    if (typeof event.fingerprint === 'string') t.ok(/^[0-9a-f]{12}$/.test(event.fingerprint))
  }
})

test('count and version rotation counters reach retention events and rejected offers stay observable', async (t) => {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const source = await createTempDir(t)
  const clientKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const retention: Array<Record<string, unknown>> = []
  const offers: Array<Record<string, unknown>> = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [clientKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    artifactPatterns: ['{series}-{version}.bin'],
    maxCount: 5,
    maxVersions: 1,
    versionGranularity: 'major'
  })
  server.on('retention', (event) => retention.push({ ...event }))
  server.on('offer', (event) => offers.push({ ...event }))
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 1_000,
    dht: testnet.createNode()
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))
  await server.listen()

  for (const name of ['api-1.0.0.bin', 'api-2.0.0.bin']) {
    const input = path.join(source, name)
    await fs.promises.writeFile(input, name)
    t.is((await client.upload(input)).status, 'COMMITTED')
  }
  const unmatched = path.join(source, 'unmatched.txt')
  await fs.promises.writeFile(unmatched, 'unmatched')
  await t.exception(client.upload(unmatched), { code: ERRORS.INVALID_FILENAME })

  const completed = retention.filter((event) => event.status === 'completed')
  t.ok(completed.every((event) => event.countDeleted === 0))
  t.is(
    completed.reduce((total, event) => total + (event.versionDeleted as number), 0),
    1
  )
  t.ok(completed.some((event) => event.trigger === 'post-commit' && event.versionDeleted === 1))
  t.ok(
    offers.some((event) => event.status === 'rejected' && event.reason === ERRORS.INVALID_FILENAME)
  )
  t.alike(
    (await fs.promises.readdir(storage)).filter((name) => name.endsWith('.bin')),
    ['api-2.0.0.bin']
  )
})
