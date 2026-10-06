/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, ERRORS, Server, keyPairFromSeed } from '../../dist/index.js'
import { buildTarManifest } from '../../dist/tar-protocol/manifest.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'

async function releaseArtifact(t: Parameters<Parameters<typeof test>[1]>[0]): Promise<string> {
  const releaseDir = path.join(await createTempDir(t), '2.4.1')
  await fs.promises.mkdir(releaseDir)
  const input = path.join(releaseDir, 'api.tar.gz')
  await fs.promises.writeFile(input, 'opt-out payload')
  return input
}

test('a client that opts out of the source parent keeps the legacy transfer identity', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 131)
  const clientSeed = b4a.alloc(32, 132)
  const storageDir = await createTempDir(t)
  const input = await releaseArtifact(t)

  const server = new Server({
    seed: serverSeed,
    storageDir,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 8192,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    includeSourceParent: false,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(
    result.transferId,
    (
      await buildTarManifest(input, keyPairFromSeed(clientSeed).publicKey, {
        includeSourceParent: false
      })
    ).transferId,
    'the committed transfer ID is the one a parentless client would compute'
  )
  t.is(await fs.promises.readFile(path.join(storageDir, 'api.tar.gz'), 'utf8'), 'opt-out payload')
})

test('a parent-dependent server pattern rejects an upload that opted out', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 133)
  const clientSeed = b4a.alloc(32, 134)
  const storageDir = await createTempDir(t)
  const input = await releaseArtifact(t)

  const server = new Server({
    seed: serverSeed,
    storageDir,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 8192,
    minFreeBytes: 0,
    artifactPatterns: ['{version}/api.tar.gz'],
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    includeSourceParent: false,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  await t.exception(client.upload(input), { code: ERRORS.INVALID_FILENAME })
  t.absent(
    await fs.promises
      .stat(path.join(storageDir, 'api.tar.gz'))
      .then(() => true)
      .catch(() => false),
    'nothing is published'
  )
})
