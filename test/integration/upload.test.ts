/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import Hyperswarm from 'hyperswarm'
import { Client, Server, keyPairFromSeed, topicFromServerPublicKey } from '../../dist/index.js'
import type {
  BatchUploadResult,
  ClientOptions,
  ClientResultEvent,
  ClientUploadResult,
  UploadResult
} from '../../dist/client.js'
import type { Testnet } from 'hyperdht/testnet'
import { createTempDir, writeDeterministicFile, CHUNK_SIZE } from '../helpers/files.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'
import { clientInternals, clientSwarm, serverInternals } from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 21)
const CLIENT_A_SEED = b4a.alloc(32, 22)
const CLIENT_B_SEED = b4a.alloc(32, 23)
const ROGUE_SEED = b4a.alloc(32, 24)

/** A selection failure is injected with the errno code the client keys on. */
interface ErrnoError extends Error {
  code?: string
}

/** The `fs.promises` members replaced while injecting selection failures. */
interface PatchableFs {
  promises: {
    lstat: (filePath: string) => unknown
  }
}

/** The commit sidecar fields asserted here. */
interface CommitRecordJson {
  sha256: string
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

/** A single-file upload always resolves to an `UploadResult`. */
function asFileResult(result: ClientUploadResult): UploadResult {
  return result as UploadResult
}

/** A directory upload always resolves to a `BatchUploadResult`. */
function asBatchResult(result: ClientUploadResult): BatchUploadResult {
  return result as BatchUploadResult
}

/** Result events omit `name` only for the final batch aggregate. */
function eventName(event: ClientResultEvent): string | null {
  return ('name' in event ? event.name : '') || null
}

async function readCommitRecord(file: string): Promise<CommitRecordJson> {
  return JSON.parse(await fs.promises.readFile(file, 'utf8')) as CommitRecordJson
}

async function setupServer(t: Assert, testnet: Testnet, allowedSeeds: Buffer[]): Promise<Server> {
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: allowedSeeds.map((seed) => keyPairFromSeed(seed).publicKey),
    maxFileBytes: 8 * CHUNK_SIZE,
    maxStagingBytes: 16 * CHUNK_SIZE,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()
  return server
}

function createClient(t: Assert, testnet: Testnet, server: Server, seed: Buffer): Client {
  const client = new Client({
    seed,
    serverPublicKey: server.publicKey,
    dht: testnet.createNode(),
    connectTimeout: 5_000,
    idleTimeout: 10_000
  })
  t.teardown(() => client.close())
  return client
}

test('Client validates identities and bounded timeouts before networking', (t) => {
  const serverKey = keyPairFromSeed(SERVER_SEED).publicKey
  const options: ClientOptions = {
    seed: CLIENT_A_SEED,
    serverPublicKey: serverKey,
    connectTimeout: 5_000,
    idleTimeout: 10_000,
    swarmFactory() {
      throw new Error('network construction must not run during validation')
    }
  }

  for (const invalid of [
    { ...options, seed: b4a.alloc(31) },
    { ...options, serverPublicKey: b4a.alloc(31) },
    { ...options, seed: SERVER_SEED },
    { ...options, connectTimeout: 0 },
    { ...options, connectTimeout: 30_001 },
    { ...options, idleTimeout: 0 }
  ]) {
    t.exception(() => new Client(invalid), { name: 'SwarmDeployError' })
  }
})

test('Client close aborts pending discovery promptly', async (t) => {
  const testnet = await createLocalTestnet(t)
  const source = path.join(await createTempDir(t), 'pending.bin')
  await fs.promises.writeFile(source, b4a.from('wait for an unavailable server'))
  const client = new Client({
    seed: CLIENT_A_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    dht: testnet.createNode(),
    connectTimeout: 30_000
  })
  const uploading = client.upload(source)
  await waitFor(() => clientInternals(client).swarm !== null)
  await client.close()

  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'ABORTED' })
})

test('Client uploads empty and multi-chunk files with exact bytes and sidecars', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED])
  const layout = serverInternals(server).layout
  const client = createClient(t, testnet, server, CLIENT_A_SEED)
  let connections = 0
  server.on('connection', () => connections++)
  const source = await createTempDir(t)
  const empty = path.join(source, 'empty.bin')
  const multi = path.join(source, 'multi.bin')
  await fs.promises.writeFile(empty, b4a.alloc(0))
  await writeDeterministicFile(multi, 2 * CHUNK_SIZE + 31)

  const emptyResult = await client.upload(empty)
  const multiResult = asFileResult(await client.upload(multi))
  t.is(emptyResult.status, 'COMMITTED')
  t.is(multiResult.status, 'COMMITTED')
  t.alike(await fs.promises.readFile(path.join(layout.root, 'empty.bin')), b4a.alloc(0))
  t.alike(
    await fs.promises.readFile(path.join(layout.root, 'multi.bin')),
    await fs.promises.readFile(multi)
  )

  const record = await readCommitRecord(
    path.join(layout.commits, `${b4a.toString(multiResult.transferId, 'hex')}.json`)
  )
  t.is(record.sha256, b4a.toString(sha256(await fs.promises.readFile(multi)), 'hex'))
  t.alike(await fs.promises.readdir(layout.staging), [])
  t.alike(await fs.promises.readdir(layout.sessions), [])
  t.is(connections, 1)
})

test('Client processes directory entries sequentially, preserves skips, and continues failures', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED])
  const layout = serverInternals(server).layout
  const client = createClient(t, testnet, server, CLIENT_A_SEED)
  const resultEvents: ClientResultEvent[] = []
  client.on('result', (event: ClientResultEvent) => resultEvents.push(event))
  let connections = 0
  server.on('connection', () => connections++)
  const source = await createTempDir(t)
  const blocked = path.join(source, 'a-blocked.bin')
  const accepted = path.join(source, 'b-accepted.bin')
  await fs.promises.writeFile(blocked, b4a.from('new bytes'))
  await fs.promises.writeFile(accepted, b4a.from('accepted bytes'))
  await fs.promises.mkdir(path.join(source, 'ignored-directory'))
  await fs.promises.writeFile(path.join(layout.root, 'a-blocked.bin'), b4a.from('foreign'))

  const batch = asBatchResult(await client.upload(source))
  t.is(batch.status, 'FAILED')
  t.alike(
    batch.results.map((entry) => [entry.name, entry.status]),
    [
      ['a-blocked.bin', 'FILE_EXISTS'],
      ['b-accepted.bin', 'COMMITTED']
    ]
  )
  t.alike(
    batch.skipped.map((entry) => [entry.name, entry.reason]),
    [['ignored-directory', 'directory']]
  )
  t.alike(
    await fs.promises.readFile(path.join(layout.root, 'b-accepted.bin')),
    b4a.from('accepted bytes')
  )
  t.alike(
    resultEvents.map((event) => [eventName(event), event.status, event.final]),
    [
      ['a-blocked.bin', 'FILE_EXISTS', false],
      ['b-accepted.bin', 'COMMITTED', false],
      [null, 'FAILED', true]
    ]
  )
  t.alike(resultEvents[2], {
    status: 'FAILED',
    final: true,
    files: 2,
    committed: 1,
    failed: 1,
    skipped: 1
  })
  t.is(connections, 1)
})

test('Client directory results have one accurate final aggregate for success and selection failure', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED])

  const successfulSource = await createTempDir(t)
  await fs.promises.writeFile(path.join(successfulSource, 'a.bin'), b4a.from('a'))
  await fs.promises.writeFile(path.join(successfulSource, 'b.bin'), b4a.from('b'))
  const successful = createClient(t, testnet, server, CLIENT_A_SEED)
  const successfulEvents: ClientResultEvent[] = []
  successful.on('result', (event: ClientResultEvent) => successfulEvents.push(event))
  const successfulBatch = await successful.upload(successfulSource)

  t.is(successfulBatch.status, 'COMMITTED')
  t.alike(
    successfulEvents.map((event) => [eventName(event), event.status, event.final]),
    [
      ['a.bin', 'COMMITTED', false],
      ['b.bin', 'COMMITTED', false],
      [null, 'COMMITTED', true]
    ]
  )
  t.alike(successfulEvents[2], {
    status: 'COMMITTED',
    final: true,
    files: 2,
    committed: 2,
    failed: 0,
    skipped: 0
  })

  const failedSource = await createTempDir(t)
  const missing = path.join(failedSource, 'a-missing.bin')
  await fs.promises.writeFile(missing, b4a.from('vanish during selection'))
  const selectionFailure = createClient(t, testnet, server, CLIENT_A_SEED)
  const failureEvents: ClientResultEvent[] = []
  selectionFailure.on('result', (event: ClientResultEvent) => failureEvents.push(event))
  const patchable = fs as unknown as PatchableFs
  const originalLstat = patchable.promises.lstat
  patchable.promises.lstat = (filePath) => {
    if (filePath === missing) {
      const error: ErrnoError = new Error('Injected selection failure')
      error.code = 'ENOENT'
      throw error
    }
    return originalLstat(filePath)
  }
  let failedBatch: BatchUploadResult
  try {
    failedBatch = asBatchResult(await selectionFailure.upload(failedSource))
  } finally {
    patchable.promises.lstat = originalLstat
  }

  t.is(failedBatch.status, 'FAILED')
  t.alike(
    failureEvents.map((event) => [eventName(event), event.status, event.final]),
    [
      ['a-missing.bin', 'PROTOCOL_INVALID', false],
      [null, 'FAILED', true]
    ]
  )
  t.alike(failureEvents[1], {
    status: 'FAILED',
    final: true,
    files: 1,
    committed: 0,
    failed: 1,
    skipped: 0
  })
})

test('Client pins the expected server before Protomux metadata and continues past rogue peers', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED])
  const client = createClient(t, testnet, server, CLIENT_A_SEED)
  const rogue = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(ROGUE_SEED),
    maxClientConnections: 0
  })
  const roguePayloads: Buffer[] = []
  let rogueConnections = 0
  rogue.on('connection', (socket) => {
    rogueConnections++
    socket.on('data', (data) => roguePayloads.push(b4a.from(data)))
    socket.on('error', () => {})
  })
  t.teardown(() => rogue.destroy())
  const discovery = rogue.join(topicFromServerPublicKey(server.publicKey), {
    server: true,
    client: false
  })
  await discovery.flushed()
  await clientInternals(client)._ensureStarted()
  clientSwarm(client).joinPeer(rogue.keyPair.publicKey)
  await waitFor(() => rogueConnections === 1)

  const source = path.join(await createTempDir(t), 'pinned.bin')
  await fs.promises.writeFile(source, b4a.from('pinned-server'))
  const result = await client.upload(source)

  t.is(result.status, 'COMMITTED')
  t.is(roguePayloads.length, 0)
})

test('two different client identities upload concurrently', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED, CLIENT_B_SEED])
  const layout = serverInternals(server).layout
  const first = createClient(t, testnet, server, CLIENT_A_SEED)
  const second = createClient(t, testnet, server, CLIENT_B_SEED)
  const source = await createTempDir(t)
  const firstPath = path.join(source, 'first.bin')
  const secondPath = path.join(source, 'second.bin')
  await writeDeterministicFile(firstPath, CHUNK_SIZE + 5)
  await writeDeterministicFile(secondPath, CHUNK_SIZE + 7)

  const [firstResult, secondResult] = await Promise.all([
    first.upload(firstPath),
    second.upload(secondPath)
  ])
  t.is(firstResult.status, 'COMMITTED')
  t.is(secondResult.status, 'COMMITTED')
  t.alike(
    await fs.promises.readFile(path.join(layout.root, 'first.bin')),
    await fs.promises.readFile(firstPath)
  )
  t.alike(
    await fs.promises.readFile(path.join(layout.root, 'second.bin')),
    await fs.promises.readFile(secondPath)
  )
})

test('shared client identities retain one Hyperswarm transport deterministically', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = await setupServer(t, testnet, [CLIENT_A_SEED])
  const internal = serverInternals(server)
  const first = createClient(t, testnet, server, CLIENT_A_SEED)
  const second = createClient(t, testnet, server, CLIENT_A_SEED)

  await Promise.all([
    clientInternals(first)._ensureStarted(),
    clientInternals(second)._ensureStarted()
  ])
  await waitFor(() => internal._connections.size === 1)
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100)
  })
  t.alike(first.publicKey, second.publicKey)
  t.is(internal._connections.size, 1)
})
