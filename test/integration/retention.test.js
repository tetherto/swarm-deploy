'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const createTestnet = require('hyperdht/testnet')
const { Client, Server, keyPairFromSeed, transferId } = require('../..')
const { ClientSession } = require('../../lib/protocol/client-session')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { RetentionManager, DEFAULT_RESUME_TTL } = require('../../lib/storage/retention')
const { createClock } = require('../helpers/clock')
const { createTempDir } = require('../helpers/files')

const OWNER = b4a.alloc(32, 0x61)
const SERVER_SEED = b4a.alloc(32, 0x62)
const CLIENT_SEED = b4a.alloc(32, 0x63)
const CHUNK_SIZE = 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(name, data) {
  const digest = sha256(data)
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: data.byteLength === 0 ? 0 : 1
  }
  offer.transferId = transferId({
    clientPublicKey: OWNER,
    name,
    size: offer.size,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: { transferId: offer.transferId, index: 0, digest, data }
  }
}

async function pathExists(filePath) {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

async function createStores(t, options = {}) {
  const layout = initLayout(await createTempDir(t))
  const clock = createClock()
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: 4 * CHUNK_SIZE,
    checkpointChunks: 1,
    clock
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commitStore = new CommitStore({ layout, clock })
  let activeId = null
  const manager = new RetentionManager({
    layout,
    sessionStore,
    commitStore,
    clock,
    isSessionActive: (session) => session.id === activeId,
    ...options
  })
  return {
    layout,
    clock,
    sessionStore,
    commitStore,
    manager,
    setActive(id) {
      activeId = id
    }
  }
}

async function commit(stores, name, data) {
  const upload = makeUpload(name, data)
  await stores.sessionStore.offer(OWNER, upload.offer)
  if (upload.offer.chunkCount > 0) {
    await stores.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  }
  await stores.sessionStore.finish(upload.offer.transferId)
  const record = await stores.commitStore.commit(
    stores.sessionStore.sessions.get(hex(upload.offer.transferId))
  )
  await stores.sessionStore.retireCommitted(upload.offer.transferId)
  return { upload, record, finalPath: path.join(stores.layout.root, name) }
}

test('retention honors exact age and quota boundaries', async (t) => {
  const age = await createStores(t, { maxAge: 10 })
  const artifact = await commit(age, 'age.bin', b4a.from('abc'))
  age.clock.advance(9)
  t.is((await age.manager.run()).ageDeleted, 0)
  t.is(await pathExists(artifact.finalPath), true)
  age.clock.advance(1)
  t.is((await age.manager.run()).ageDeleted, 1)
  t.is(await pathExists(artifact.finalPath), false)

  const quota = await createStores(t, { maxStorageBytes: 6 })
  const alpha = await commit(quota, 'alpha.bin', b4a.from('aaa'))
  quota.clock.advance(1)
  const bravo = await commit(quota, 'bravo.bin', b4a.from('bbb'))
  t.is((await quota.manager.run()).storageDeleted, 0)
  t.is(await pathExists(alpha.finalPath), true)
  t.is(await pathExists(bravo.finalPath), true)

  const reservation = await quota.manager.run({ incomingBytes: 1 })
  t.is(reservation.storageDeleted, 1)
  t.is(await pathExists(alpha.finalPath), false)
  t.is(await pathExists(bravo.finalPath), true)
})

test('retention rotates commits but never expires an active upload', async (t) => {
  const stores = await createStores(t, {
    maxStorageBytes: 3,
    resumeTtl: DEFAULT_RESUME_TTL
  })
  const committed = await commit(stores, 'committed.bin', b4a.from('old'))
  const active = makeUpload('active.bin', b4a.from('new'))
  await stores.sessionStore.offer(OWNER, active.offer)
  const activeId = hex(active.offer.transferId)
  stores.setActive(activeId)
  stores.clock.advance(DEFAULT_RESUME_TTL + 1)

  const result = await stores.manager.run({ incomingBytes: 1 })

  t.is(result.storageDeleted, 1)
  t.is(await pathExists(committed.finalPath), false)
  t.is(stores.sessionStore.sessions.has(activeId), true)
  t.is(await pathExists(path.join(stores.layout.staging, `${activeId}.part`)), true)

  stores.setActive(null)
  t.is(await stores.manager.expireSessions(), 1)
  t.is(stores.sessionStore.sessions.has(activeId), false)
})

test('Node and Bare lifecycle closes swarms, timers, descriptors, and testnet', async (t) => {
  const testnet = await createTestnet(3)
  let server = null
  let client = null
  let watcher = null
  let retention = null
  let serverSwarm = null
  let clientSwarm = null
  let sourceHandle = null
  const originalOpenSource = ClientSession.prototype._openSource
  ClientSession.prototype._openSource = async function () {
    await originalOpenSource.call(this)
    if (this.file) sourceHandle = this.file
  }
  try {
    const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
    const root = await createTempDir(t)
    const allowlist = path.join(await createTempDir(t), 'allowlist')
    await fs.promises.writeFile(allowlist, `${hex(ownerKey)}\n`)
    server = new Server({
      seed: SERVER_SEED,
      storageDir: root,
      allowedKeys: [ownerKey],
      allowlistPath: allowlist,
      maxFileBytes: CHUNK_SIZE,
      maxStagingBytes: CHUNK_SIZE,
      minFreeBytes: 0,
      cleanupInterval: 60_000,
      dht: testnet.createNode()
    })
    await server.listen()
    client = new Client({
      seed: CLIENT_SEED,
      serverPublicKey: server.publicKey,
      connectTimeout: 5_000,
      idleTimeout: 5_000,
      dht: testnet.createNode()
    })
    const source = path.join(await createTempDir(t), 'lifecycle.bin')
    await fs.promises.writeFile(source, b4a.from('close every resource'))

    const uploaded = await client.upload(source)
    t.is(uploaded.status, 'COMMITTED')
    watcher = server.allowlistWatcher
    retention = server.retentionManager
    serverSwarm = server.swarm
    clientSwarm = client.swarm

    await client.close()
    await server.close()

    t.is(client.swarm, null)
    t.is(client.discovery, null)
    t.is(client.sessions.size, 0)
    t.is(client.sockets.size, 0)
    t.is(client.socketWaiters.length, 0)
    t.is(client.delayWaiters.length, 0)
    t.is(server.swarm, null)
    t.is(server.sessionStore, null)
    t.is(server._connections.size, 0)
    t.is(server._sessions.size, 0)
    t.is(watcher.timer, null)
    t.is(retention.timer, null)
    t.ok(serverSwarm.destroyed)
    t.ok(clientSwarm.destroyed)
    await t.exception(() => sourceHandle.stat(), { code: 'EBADF' })
    await t.exception(() => sourceHandle.read(b4a.alloc(1), 0, 1, 0), { code: 'EBADF' })

    await testnet.destroy()
  } finally {
    ClientSession.prototype._openSource = originalOpenSource
    await Promise.allSettled([client?.close(), server?.close()])
    await testnet.destroy().catch(() => {})
  }
})
