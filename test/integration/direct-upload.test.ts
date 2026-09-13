/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, Server, keyPairFromSeed } from '../../dist/index.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix
} from '../../dist/tar-protocol/manifest.js'
import type { SessionStore } from '../../dist/storage/session-store.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'

test('direct server-key upload commits only after an explicit final result', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 91)
  const clientSeed = b4a.alloc(32, 92)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'direct TAR payload')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const serverEvents: string[] = []
  const clientEvents: string[] = []
  server.on('offer', () => serverEvents.push('offer'))
  server.on('progress', () => {
    if (serverEvents.at(-1) !== 'progress') serverEvents.push('progress')
  })
  server.on('verification', (event) => serverEvents.push(`verification:${event.status}`))
  server.on('commit', (event) => serverEvents.push(`commit:${event.status}`))
  client.on('offer', () => clientEvents.push('offer'))
  client.on('progress', () => {
    if (clientEvents.at(-1) !== 'progress') clientEvents.push('progress')
  })
  client.on('verification', (event) => clientEvents.push(`verification:${event.status}`))
  client.on('commit', (event) => clientEvents.push(`commit:${event.status}`))
  client.on('result', (event) => {
    if (event.final) clientEvents.push('result')
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(storage, 'artifact.txt'), 'utf8'), 'direct TAR payload')
  t.alike(serverEvents, [
    'offer',
    'progress',
    'verification:started',
    'verification:succeeded',
    'commit:succeeded'
  ])
  t.alike(clientEvents, [
    'offer',
    'offer',
    'progress',
    'verification:started',
    'verification:succeeded',
    'commit:succeeded',
    'result'
  ])
})

test('terminal delivery failure never contradicts durable lifecycle events', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 111)
  const clientSeed = b4a.alloc(32, 112)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'delivery.txt')
  await fs.promises.writeFile(input, 'durably committed before terminal delivery fails')
  const serverNode = testnet.createNode()
  const dht = {
    get destroyed() {
      return serverNode.destroyed
    },
    createServer(
      options: Parameters<typeof serverNode.createServer>[0],
      handler: Parameters<typeof serverNode.createServer>[1]
    ) {
      return serverNode.createServer(options, (socket) => {
        const stream = socket as unknown as { write(bytes: Buffer): boolean }
        const write = stream.write.bind(stream)
        stream.write = (bytes) =>
          b4a.toString(bytes).includes('"COMMITTED"') ? false : write(bytes)
        handler(socket)
      })
    },
    connect: serverNode.connect.bind(serverNode),
    on: serverNode.on.bind(serverNode),
    destroy: serverNode.destroy.bind(serverNode)
  }
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    idleTimeout: 20,
    dht
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 1_000,
    dht: testnet.createNode()
  })
  const phases: string[] = []
  server.on('verification', (event) => phases.push(`verification:${event.status}`))
  server.on('commit', (event) => phases.push(`commit:${event.status}`))
  server.on('failure', () => phases.push('failure'))
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  await t.exception(client.upload(input))
  t.is(
    await fs.promises.readFile(path.join(storage, 'delivery.txt'), 'utf8'),
    'durably committed before terminal delivery fails'
  )
  t.alike(phases, ['verification:started', 'verification:succeeded', 'commit:succeeded', 'failure'])
})

test('directory uploads use separate direct connections in lexical order', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 93)
  const clientSeed = b4a.alloc(32, 94)
  const storage = await createTempDir(t)
  const source = await createTempDir(t)
  await fs.promises.writeFile(path.join(source, 'z.txt'), 'z')
  await fs.promises.writeFile(path.join(source, 'a.txt'), 'a')
  const connections: string[] = []
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  server.on('offer', (event) => {
    if (event.status === 'accepted') connections.push(event.name)
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const result = await client.upload(source)
  t.is(result.status, 'COMMITTED')
  t.alike(connections, ['a.txt', 'z.txt'])
  t.is(await fs.promises.readFile(path.join(storage, 'a.txt'), 'utf8'), 'a')
  t.is(await fs.promises.readFile(path.join(storage, 'z.txt'), 'utf8'), 'z')
})

test('a divergent durable TAR prefix is reset once before direct commit', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 95)
  const clientSeed = b4a.alloc(32, 96)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'reset.txt')
  await fs.promises.writeFile(input, 'resume reset payload')
  const clientKey = keyPairFromSeed(clientSeed)
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [clientKey.publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const offers: string[] = []
  let connections = 0
  server.on('offer', (event) => offers.push(event.status))
  server.on('connection', () => {
    connections++
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const manifest = await buildTarManifest(input, clientKey.publicKey)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  if (!sessions) throw new Error('Server session store unavailable')
  await sessions.admit(clientKey.publicKey, metadataFromManifest(manifest))
  await sessions.append(clientKey.publicKey, metadataFromManifest(manifest), 0, b4a.alloc(16, 0xff))

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(offers, ['resumed', 'reset'])
  t.is(connections, 2)
  t.is(await fs.promises.readFile(path.join(storage, 'reset.txt'), 'utf8'), 'resume reset payload')
})

test('a matching durable TAR prefix resumes on one direct connection', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 97)
  const clientSeed = b4a.alloc(32, 98)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'resume.txt')
  await fs.promises.writeFile(input, 'matching direct TAR resume payload')
  const clientKey = keyPairFromSeed(clientSeed)
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [clientKey.publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const offers: string[] = []
  let connections = 0
  server.on('offer', (event) => offers.push(event.status))
  server.on('connection', () => {
    connections++
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const manifest = await buildTarManifest(input, clientKey.publicKey)
  const chunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  const archive = b4a.concat(chunks)
  const metadata = metadataFromManifest(manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  if (!sessions) throw new Error('Server session store unavailable')
  await sessions.admit(clientKey.publicKey, metadata)
  await sessions.append(clientKey.publicKey, metadata, 0, archive.subarray(0, 512))

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(offers, ['resumed'])
  t.is(connections, 1)
  t.is(
    await fs.promises.readFile(path.join(storage, 'resume.txt'), 'utf8'),
    'matching direct TAR resume payload'
  )
})
