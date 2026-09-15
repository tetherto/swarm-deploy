/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, Server, keyPairFromSeed } from '../../dist/index.js'
import {
  buildTarManifest,
  deterministicTarSize,
  metadataFromManifest,
  regenerateTarSuffix
} from '../../dist/tar-protocol/manifest.js'
import type { SessionStore } from '../../dist/storage/session-store.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'
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
  const clientProgress: Array<{ bytesSent: number; totalBytes: number }> = []
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
  client.on('progress', (event) => clientProgress.push(event))
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
  if (!('size' in result)) throw new Error('Expected single upload result')
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
  t.ok(clientProgress.length >= 2)
  t.ok(clientProgress[0].bytesSent < clientProgress.at(-1)!.bytesSent)
  t.is(clientProgress.at(-1)!.bytesSent, deterministicTarSize(result.size))
  t.ok(clientProgress.every((event) => event.totalBytes === deterministicTarSize(result.size)))
})

test('identical direct upload short-circuits before TAR transfer without history mutation', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 113)
  const clientSeed = b4a.alloc(32, 114)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'identical.txt')
  await fs.promises.writeFile(input, 'same artifact twice')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    replaceNames: ['identical.txt'],
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  let connections = 0
  let clientProgress = 0
  let serverProgress = 0
  server.on('connection', () => connections++)
  client.on('progress', () => clientProgress++)
  server.on('progress', () => serverProgress++)
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  t.is((await client.upload(input)).status, 'COMMITTED')
  const before = (await fs.promises.readdir(storage)).sort()
  clientProgress = 0
  serverProgress = 0

  t.is((await client.upload(input)).status, 'ALREADY_COMMITTED')
  t.is(connections, 2)
  t.is(clientProgress, 0)
  t.is(serverProgress, 0)
  t.alike((await fs.promises.readdir(storage)).sort(), before)
  t.absent(before.some((name) => name.startsWith('history-')))
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
  const progress: Array<{ bytesSent: number; totalBytes: number }> = []
  let connections = 0
  server.on('offer', (event) => offers.push(event.status))
  client.on('progress', (event) => progress.push(event))
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
  t.ok(progress.length >= 2)
  t.ok(progress.every((event) => event.totalBytes === manifest.tarSize))
  t.ok(
    progress.every((event, index) => index === 0 || event.bytesSent > progress[index - 1].bytesSent)
  )
  t.ok(progress[0].bytesSent > 512)
  t.is(progress.at(-1)!.bytesSent, manifest.tarSize)
  t.is(
    await fs.promises.readFile(path.join(storage, 'resume.txt'), 'utf8'),
    'matching direct TAR resume payload'
  )
})

test('a committed upload still reports success when session cleanup fails', async (t) => {
  // Retiring the session happens after the artifact is durably published.
  // Failing there must not turn a completed commit into a client-visible
  // failure; the residue is purged on the next start instead.
  const testnet = await createLocalTestnet(t)
  const storageDir = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'cleanup failure payload')

  let blockRetire = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (blockRetire && name === 'unlink' && target.endsWith('.tar.part')) {
        throw Object.assign(new Error('EIO: simulated cleanup failure'), { code: 'EIO' })
      }
    }
  })

  const serverSeed = b4a.alloc(32, 71)
  const clientSeed = b4a.alloc(32, 72)
  const server = new Server({
    seed: serverSeed,
    storageDir,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 8192,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    storage
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
  blockRetire = true
  const result = await client.upload(input)

  t.is(result.status, 'COMMITTED', 'the client is told the truth about its commit')
  t.is(
    await fs.promises.readFile(path.join(storageDir, 'artifact.txt'), 'utf8'),
    'cleanup failure payload',
    'the artifact is published'
  )
})
