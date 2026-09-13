/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, Server, keyPairFromSeed } from '../../dist/index.js'
import { buildTarManifest, metadataFromManifest } from '../../dist/tar-protocol/manifest.js'
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
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(storage, 'artifact.txt'), 'utf8'), 'direct TAR payload')
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
