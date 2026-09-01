'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const Hyperswarm = require('hyperswarm')
const { Server, keyPairFromSeed, transferId, ERRORS } = require('../..')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')
const { createLocalTestnet } = require('../helpers/testnet')
const { settlePromptly } = require('../helpers/cancellation')

const SERVER_SEED = b4a.alloc(32, 0x71)
const CLIENT_SEED = b4a.alloc(32, 0x72)
const CHUNK_SIZE = 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function uploadFor(ownerKey, name = 'offline-revocation.bin') {
  const data = b4a.from('persisted partial upload')
  const digest = sha256(data)
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  offer.transferId = transferId({
    clientPublicKey: ownerKey,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: { transferId: offer.transferId, index: 0, digest, data }
  }
}

function stubSwarm(events = []) {
  const swarm = new EventEmitter()
  swarm.join = () => {
    events.push('join')
    return {
      async flushed() {
        events.push('flushed')
      },
      async destroy() {
        events.push('discovery-destroy')
      }
    }
  }
  swarm.destroy = async () => {
    events.push('swarm-destroy')
  }
  return swarm
}

test('real Hyperswarm rejection branches install socket errors before destroy', async (t) => {
  const testnet = await createLocalTestnet(t)
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const modes = [
    ['closed', ERRORS.AUTH_REJECTED],
    ['newly-revoked', ERRORS.AUTH_REJECTED],
    ['capacity', ERRORS.FILE_BUSY]
  ]

  for (let index = 0; index < modes.length; index++) {
    const [mode, expectedCode] = modes[index]
    const reached = deferred()
    let firewallAttempts = 0
    const server = new Server({
      seed: b4a.alloc(32, 0x73 + index),
      storageDir: await createTempDir(t),
      allowedKeys: [ownerKey],
      maxFileBytes: CHUNK_SIZE,
      maxStagingBytes: CHUNK_SIZE,
      maxConnections: 1,
      maxActiveUploads: 1,
      minFreeBytes: 0,
      dht: testnet.createNode()
    })
    const originalFirewall = server._firewall.bind(server)
    server._firewall = (key) => {
      if (b4a.equals(key, ownerKey)) firewallAttempts++
      return originalFirewall(key)
    }
    const originalConnection = server._onConnection.bind(server)
    server._onConnection = (socket, peerInfo) => {
      const before = socket.listenerCount('error')
      const destroy = socket.destroy.bind(socket)
      socket.destroy = (error) => {
        const atDestroy = socket.listenerCount('error')
        destroy()
        reached.resolve({ socket, error, before, atDestroy })
      }
      if (mode === 'closed') server.closed = true
      if (mode === 'newly-revoked') server._allowlist.delete(hex(ownerKey))
      if (mode === 'capacity') server._connections.set({ occupied: true }, {})
      originalConnection(socket, peerInfo)
      if (mode === 'closed') server.closed = false
      if (mode === 'capacity') server._connections.clear()
    }
    await server.listen()

    const client = new Hyperswarm({
      dht: testnet.createNode(),
      keyPair: keyPairFromSeed(CLIENT_SEED)
    })
    const discovery = client.join(server.topic, { server: false, client: true })
    await discovery.flushed()
    const rejected = await reached.promise

    t.is(rejected.error.code, expectedCode, `${mode} rejection code`)
    t.ok(firewallAttempts > 0, `${mode} passed through the real firewall`)
    t.ok(rejected.atDestroy > rejected.before, `${mode} installed a safe error listener`)
    t.is(server._sessions.size, 0, `${mode} opened no protocol session`)
    rejected.socket.emit('error', new Error(`${mode} late socket error`))
    t.pass(`${mode} process remained alive after socket error`)

    await client.destroy()
    await server.close()
  }
})

test('restart purges offline-revoked resumable state before networking', async (t) => {
  const storageDir = await createTempDir(t)
  const configDir = await createTempDir(t)
  const allowlistPath = path.join(configDir, 'allowlist')
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const upload = uploadFor(ownerKey)
  await fs.promises.writeFile(allowlistPath, `${hex(ownerKey)}\n`)

  const options = {
    seed: SERVER_SEED,
    storageDir,
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    allowlistPath,
    swarmFactory: () => stubSwarm()
  }
  const first = new Server({ ...options, allowedKeys: [ownerKey] })
  await first.listen()
  await first.sessionStore.offer(ownerKey, upload.offer)
  await first.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await first.close()

  await fs.promises.writeFile(allowlistPath, '')
  const restarted = new Server({ ...options, allowedKeys: [] })
  await restarted.listen()
  t.is(restarted.sessionStore.sessions.size, 0)
  t.is(restarted.sessionStore.reservedBytes, 0)
  t.alike(await fs.promises.readdir(restarted.layout.sessions), [])
  t.alike(await fs.promises.readdir(restarted.layout.staging), [])
  await restarted.close()

  await fs.promises.writeFile(allowlistPath, `${hex(ownerKey)}\n`)
  const reallowed = new Server({ ...options, allowedKeys: [ownerKey] })
  await reallowed.listen()
  const offered = await reallowed.sessionStore.offer(ownerKey, upload.offer)
  t.is(offered.resumed, false)
  await reallowed.close()
})

test('Server retires corrupt journal orphan staging before networking', async (t) => {
  const storageDir = await createTempDir(t)
  const layout = initLayout(storageDir)
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const corrupt = uploadFor(ownerKey, 'corrupt-orphan-startup.bin')
  const valid = uploadFor(ownerKey, 'valid-resume-startup.bin')
  let crashAfterSessionUnlink = false
  const storage = createStorage({
    afterOperation(name, filePath) {
      if (
        crashAfterSessionUnlink &&
        name === 'unlink' &&
        path.basename(filePath) === `${hex(corrupt.offer.transferId)}.json`
      ) {
        crashAfterSessionUnlink = false
        throw new Error('Injected crash after session unlink')
      }
    }
  })
  const sessions = new SessionStore({
    layout,
    maxStagingBytes: 2 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await sessions.init()
  await sessions.offer(ownerKey, corrupt.offer)
  await sessions.writeChunk(corrupt.offer.transferId, corrupt.chunk)
  await sessions.finish(corrupt.offer.transferId)
  await sessions.offer(ownerKey, valid.offer)
  const commits = new CommitStore({ layout, storage })
  crashAfterSessionUnlink = true
  await commits.commit(sessions.sessions.get(hex(corrupt.offer.transferId)))
  await fs.promises.writeFile(
    path.join(layout.journals, `${hex(corrupt.offer.transferId)}.json`),
    '{corrupt'
  )
  await sessions.close()

  const lifecycle = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: 2 * CHUNK_SIZE,
    minFreeBytes: 0,
    swarmFactory() {
      lifecycle.push('network')
      return stubSwarm()
    }
  })
  server.on('cleanup', (event) => {
    if (event.reason === 'corrupt-journal') lifecycle.push('cleanup')
  })
  await server.listen()

  t.alike(lifecycle, ['cleanup', 'network'])
  t.is(server.sessionStore.sessions.has(hex(valid.offer.transferId)), true)
  const journalNames = await fs.promises.readdir(layout.journals)
  t.is(journalNames.length, 1)
  t.ok(journalNames[0].startsWith(`.${hex(corrupt.offer.transferId)}.corrupt-`))
  t.is(
    (await fs.promises.readdir(layout.staging)).includes(`${hex(corrupt.offer.transferId)}.part`),
    false
  )
  t.is(
    (await fs.promises.readdir(layout.staging)).includes(`${hex(valid.offer.transferId)}.part`),
    true
  )
  await server.close()
})

test('Server close aborts a never-resolving discovery flush and releases resources', async (t) => {
  const storageDir = await createTempDir(t)
  const joined = deferred()
  const events = []
  const swarm = new EventEmitter()
  const discovery = {
    flushed() {
      joined.resolve()
      return new Promise(() => {})
    },
    async destroy() {
      events.push('discovery-destroy')
    }
  }
  swarm.join = () => discovery
  swarm.destroy = async () => {
    events.push('swarm-destroy')
  }
  const options = {
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0
  }
  const server = new Server({ ...options, swarmFactory: () => swarm })
  const starting = server.listen()
  await joined.promise
  const retention = server.retentionManager
  const closing = server.close()

  t.ok(events.includes('discovery-destroy'), 'close synchronously starts discovery cancellation')
  t.ok(events.includes('swarm-destroy'), 'close synchronously starts swarm cancellation')
  const [startResult, closeResult] = await settlePromptly([starting, closing])
  t.is(startResult.status, 'rejected')
  t.is(startResult.reason.code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.is(server.listening, false)
  t.is(server.swarm, null)
  t.is(server.discovery, null)
  t.is(server.sessionStore, null)
  t.is(server._connections.size, 0)
  t.is(server._sessions.size, 0)
  t.is(retention.timer, null)

  const recovered = new Server({ ...options, swarmFactory: () => stubSwarm() })
  await recovered.listen()
  await recovered.close()
})

test('Server close during storage startup prevents later swarm announcement', async (t) => {
  const entered = deferred()
  const release = deferred()
  let blocked = false
  let swarmCreations = 0
  let storageDir
  const storage = createStorage({
    async beforeOperation(operation, filePath) {
      if (blocked || operation !== 'readdir' || !filePath.endsWith('/sessions')) return
      blocked = true
      entered.resolve()
      await release.promise
    }
  })
  storageDir = await createTempDir(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory() {
      swarmCreations++
      return stubSwarm()
    }
  })
  const starting = server.listen()
  await entered.promise
  const closing = server.close()
  release.resolve()
  const [startResult, closeResult] = await settlePromptly([starting, closing])

  t.is(startResult.status, 'rejected')
  t.is(startResult.reason.code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.is(swarmCreations, 0)
  t.is(server.listening, false)
})
