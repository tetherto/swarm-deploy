'use strict'

const test = require('brittle')
const b4a = require('b4a')
const fs = require('#fs')
const path = require('#path')
const Hyperswarm = require('hyperswarm')
const { Client, Server, buildFileManifest, keyPairFromSeed, transferId, ERRORS } = require('../..')
const { createTempDir } = require('../helpers/files')
const { createLocalTestnet } = require('../helpers/testnet')

const SERVER_SEED = b4a.alloc(32, 0xa1)
const CLIENT_SEED = b4a.alloc(32, 0xa2)
const UNKNOWN_SEED = b4a.alloc(32, 0xa3)
const CHUNK_SIZE = 1024 * 1024

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function recordEvents(emitter, names, output) {
  for (const name of names) emitter.on(name, (payload) => output.push({ name, payload }))
}

function assertSubsequence(t, events, expected, label) {
  let cursor = 0
  for (const event of events) {
    if (expected[cursor](event)) cursor++
    if (cursor === expected.length) break
  }
  t.is(cursor, expected.length, label)
}

test('typed observability covers resume reject recovery retention auth and privacy', async (t) => {
  const testnet = await createLocalTestnet(t)
  const root = await createTempDir(t)
  const sourceDir = await createTempDir(t)
  const source = path.join(sourceDir, 'resume-events.bin')
  const rejectedSource = path.join(sourceDir, 'oversized-events.bin')
  const bytes = b4a.alloc(CHUNK_SIZE + 3, 0x5a)
  await fs.promises.writeFile(source, bytes)
  await fs.promises.writeFile(rejectedSource, b4a.alloc(2 * CHUNK_SIZE + 1, 0x6b))

  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const serverEvents = []
  const clientEvents = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: root,
    allowedKeys: [ownerKey],
    maxFileBytes: 3 * CHUNK_SIZE,
    maxStagingBytes: 4 * CHUNK_SIZE,
    maxStorageBytes: 2 * CHUNK_SIZE,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  recordEvents(
    server,
    [
      'authentication',
      'connection-open',
      'connection-close',
      'offer',
      'progress',
      'verification',
      'commit',
      'recovery',
      'scrub',
      'retention',
      'cleanup',
      'revocation'
    ],
    serverEvents
  )
  server.on('progress', () => {
    throw new Error('throwing server event listener')
  })
  await server.listen()
  t.teardown(() => server.close())

  const manifest = await buildFileManifest(source)
  const id = transferId({
    clientPublicKey: ownerKey,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize
  })
  const offer = {
    version: 1,
    transferId: id,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount
  }
  await server.sessionStore.offer(ownerKey, offer)
  await server.sessionStore.writeChunk(id, {
    transferId: id,
    index: 0,
    digest: manifest.chunkDigests[0],
    data: bytes.subarray(0, CHUNK_SIZE)
  })

  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 5_000,
    dht: testnet.createNode()
  })
  recordEvents(
    client,
    [
      'authentication',
      'connection-open',
      'connection-close',
      'offer',
      'progress',
      'verification',
      'commit',
      'result',
      'close'
    ],
    clientEvents
  )
  client.on('progress', () => {
    throw new Error('throwing client event listener')
  })
  t.teardown(() => client.close())

  const uploaded = await client.upload(source)
  t.is(uploaded.status, 'COMMITTED')
  await t.exception(() => client.upload(rejectedSource), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_TOO_LARGE
  })

  const firewallAttempt = deferred()
  const originalFirewall = server._firewall.bind(server)
  server._firewall = (key) => {
    if (b4a.equals(key, keyPairFromSeed(UNKNOWN_SEED).publicKey)) firewallAttempt.resolve()
    return originalFirewall(key)
  }
  const unknown = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(UNKNOWN_SEED)
  })
  t.teardown(() => unknown.destroy())
  unknown.join(server.topic, { server: false, client: true })
  await firewallAttempt.promise

  const cleanup = await buildFileManifest(rejectedSource)
  const cleanupId = transferId({
    clientPublicKey: ownerKey,
    name: cleanup.name,
    size: cleanup.size,
    digest: cleanup.digest,
    chunkSize: cleanup.chunkSize
  })
  await server.sessionStore.offer(ownerKey, {
    version: 1,
    transferId: cleanupId,
    name: cleanup.name,
    size: cleanup.size,
    digest: cleanup.digest,
    chunkSize: cleanup.chunkSize,
    chunkCount: cleanup.chunkCount
  })
  await server.reloadAllowlist([])
  await client.close()

  assertSubsequence(
    t,
    serverEvents,
    [
      (event) => event.name === 'recovery' && event.payload.status === 'started',
      (event) => event.name === 'scrub' && event.payload.status === 'completed',
      (event) => event.name === 'recovery' && event.payload.status === 'completed',
      (event) => event.name === 'retention' && event.payload.trigger === 'startup',
      (event) => event.name === 'authentication' && event.payload.status === 'accepted',
      (event) => event.name === 'connection-open',
      (event) => event.name === 'offer' && event.payload.status === 'resumed',
      (event) => event.name === 'progress' && event.payload.bytesReceived === manifest.size,
      (event) => event.name === 'verification' && event.payload.status === 'started',
      (event) => event.name === 'verification' && event.payload.status === 'succeeded',
      (event) => event.name === 'commit' && event.payload.status === 'started',
      (event) => event.name === 'commit' && event.payload.status === 'succeeded',
      (event) =>
        event.name === 'offer' &&
        event.payload.status === 'rejected' &&
        event.payload.reason === ERRORS.FILE_TOO_LARGE,
      (event) => event.name === 'authentication' && event.payload.status === 'rejected',
      (event) => event.name === 'connection-close',
      (event) => event.name === 'cleanup' && event.payload.reason === 'revocation',
      (event) => event.name === 'revocation'
    ],
    'server lifecycle event order'
  )
  assertSubsequence(
    t,
    clientEvents,
    [
      (event) => event.name === 'authentication' && event.payload.status === 'accepted',
      (event) => event.name === 'connection-open',
      (event) => event.name === 'offer' && event.payload.status === 'offered',
      (event) => event.name === 'offer' && event.payload.status === 'resumed',
      (event) => event.name === 'progress' && event.payload.bytesSent === manifest.size,
      (event) => event.name === 'verification' && event.payload.status === 'started',
      (event) => event.name === 'verification' && event.payload.status === 'succeeded',
      (event) => event.name === 'commit' && event.payload.status === 'succeeded',
      (event) => event.name === 'result' && event.payload.status === 'COMMITTED',
      (event) =>
        event.name === 'result' &&
        event.payload.status === ERRORS.FILE_TOO_LARGE &&
        event.payload.final === true,
      (event) => event.name === 'connection-close',
      (event) => event.name === 'close'
    ],
    'client lifecycle event order'
  )

  const serialized = JSON.stringify({ serverEvents, clientEvents })
  for (const secret of [SERVER_SEED, CLIENT_SEED, UNKNOWN_SEED, ownerKey, server.publicKey]) {
    t.absent(serialized.includes(hex(secret)), `events hide ${hex(secret).slice(0, 4)} material`)
  }
  for (const event of serverEvents.filter((entry) => entry.payload.fingerprint)) {
    t.ok(/^[0-9a-f]{12}$/.test(event.payload.fingerprint))
  }
})
