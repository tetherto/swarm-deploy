'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const { EventEmitter } = require('#events')
const fs = require('#fs')
const path = require('#path')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const {
  Server,
  keyPairFromSeed,
  transferId,
  OFFER,
  CHUNK,
  FINISH,
  STATUS_CODE,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} = require('../..')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')
const { createLocalTestnet, waitFor } = require('../helpers/testnet')

const SERVER_SEED = b4a.alloc(32, 1)
const ALLOWED_SEED = b4a.alloc(32, 2)
const UNKNOWN_SEED = b4a.alloc(32, 3)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function fingerprint(key) {
  return b4a.toString(sha256(key), 'hex').slice(0, 12)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function uploadFor(ownerKey) {
  const data = b4a.from('authenticated upload')
  const digest = sha256(data)
  const value = {
    version: 1,
    name: 'artifact.bin',
    size: data.byteLength,
    digest,
    chunkSize: 1024 * 1024,
    chunkCount: 1
  }
  value.transferId = transferId({
    clientPublicKey: ownerKey,
    name: value.name,
    size: value.size,
    digest,
    chunkSize: value.chunkSize
  })
  return value
}

function openClientChannel(socket) {
  const mux = Protomux.from(socket)
  const received = { status: [], ready: [], chunkAck: [], result: [] }
  const channel = mux.createChannel({
    protocol: 'swarm-deploy/upload/1',
    id: b4a.from('integration-upload')
  })
  const messages = [
    channel.addMessage({ encoding: offer }),
    channel.addMessage({ encoding: status, onmessage: (value) => received.status.push(value) }),
    channel.addMessage({ encoding: bitmapPage }),
    channel.addMessage({ encoding: ready, onmessage: (value) => received.ready.push(value) }),
    channel.addMessage({ encoding: chunk }),
    channel.addMessage({ encoding: chunkAck, onmessage: (value) => received.chunkAck.push(value) }),
    channel.addMessage({ encoding: finish }),
    channel.addMessage({ encoding: result, onmessage: (value) => received.result.push(value) })
  ]
  channel.open()
  return { messages, received }
}

function createClient(t, testnet, seed) {
  const swarm = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(seed)
  })
  t.teardown(() => swarm.destroy())
  return swarm
}

function connect(swarm, topic) {
  return new Promise((resolve) => {
    swarm.once('connection', resolve)
    swarm.join(topic, { server: false, client: true })
  })
}

function createScheduler() {
  const intervals = new Set()
  return {
    intervals,
    setInterval(callback) {
      const timer = { callback, unref() {} }
      intervals.add(timer)
      return timer
    },
    clearInterval(timer) {
      intervals.delete(timer)
    },
    setTimeout(callback) {
      return { callback, unref() {} }
    },
    clearTimeout() {}
  }
}

function createStubSwarm(events) {
  const swarm = new EventEmitter()
  swarm.join = (topic, options) => {
    events.push({ type: 'join', topic, options })
    return {
      async flushed() {
        events.push({ type: 'flushed' })
      }
    }
  }
  swarm.destroy = async () => {
    events.push({ type: 'destroy' })
  }
  return swarm
}

test('Server validates required upload limits', (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const options = {
    seed: SERVER_SEED,
    storageDir: '/tmp/swarm-deploy-validation',
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 1024 * 1024
  }

  for (const invalid of [
    { ...options, seed: undefined },
    { ...options, storageDir: '' },
    { ...options, allowedKeys: undefined },
    { ...options, maxFileBytes: undefined },
    { ...options, maxStagingBytes: undefined },
    { ...options, maxFileBytes: 1.5 },
    { ...options, maxStagingBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...options, maxConnections: 0 },
    { ...options, maxActiveUploads: 1.5 },
    { ...options, idleTimeout: 0 }
  ]) {
    t.exception(() => new Server(invalid), { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })
  }
})

test('Server firewalls unknown keys before protocol and allows authenticated uploads', async (t) => {
  const testnet = await createLocalTestnet(t)
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const unknownKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const events = []
  const logs = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    dht: testnet.createNode(),
    logger: {
      info(message, details) {
        logs.push({ message, details })
      }
    }
  })
  t.teardown(() => server.close())
  server.on('connection', (event) => events.push(event))
  const firewallAttempt = deferred()
  const originalFirewall = server._firewall.bind(server)
  server._firewall = (key) => {
    if (b4a.equals(key, unknownKey)) firewallAttempt.resolve()
    return originalFirewall(key)
  }
  await server.listen()

  const unknown = createClient(t, testnet, UNKNOWN_SEED)
  unknown.join(server.topic, { server: false, client: true })
  await firewallAttempt.promise
  t.is(events.length, 0)
  t.is(server._connections.size, 0)
  t.is(server._sessions.size, 0)
  t.is(server.sessionStore.sessions.size, 0)

  const allowed = createClient(t, testnet, ALLOWED_SEED)
  const socket = await connect(allowed, server.topic)
  const channel = openClientChannel(socket)
  const upload = uploadFor(allowedKey)
  channel.messages[OFFER].send(upload)
  await waitFor(() => channel.received.ready.length === 1)

  t.is(channel.received.status[0].code, STATUS_CODE.ACCEPT)
  t.is(server.sessionStore.sessions.size, 1)
  t.is(events.length, 1)
  const serialized = JSON.stringify({ events, logs })
  t.ok(serialized.includes(fingerprint(allowedKey)))
  t.absent(serialized.includes(b4a.toString(allowedKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(unknownKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(SERVER_SEED, 'hex')))

  channel.messages[CHUNK].send({
    transferId: upload.transferId,
    index: 0,
    digest: upload.digest,
    data: b4a.from('authenticated upload')
  })
  await waitFor(() => channel.received.chunkAck.length === 1)
  channel.messages[FINISH].send({ transferId: upload.transferId })
  await waitFor(() => channel.received.result.length === 1)

  t.is(channel.received.result[0].code, 0)
  t.is(server.sessionStore.sessions.size, 0)
  t.alike(
    await fs.promises.readFile(path.join(server.layout.root, upload.name)),
    b4a.from('authenticated upload')
  )
})

test('Server revocation closes sockets and deletes authenticated resumable sessions', async (t) => {
  const testnet = await createLocalTestnet(t)
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()

  const allowed = createClient(t, testnet, ALLOWED_SEED)
  const socket = await connect(allowed, server.topic)
  const channel = openClientChannel(socket)
  channel.messages[OFFER].send(uploadFor(allowedKey))
  await waitFor(() => server.sessionStore.sessions.size === 1)

  await server.reloadAllowlist([])
  await waitFor(() => socket.destroyed)

  t.is(server.sessionStore.sessions.size, 0)
})

test('Server starts recovery and retention before networking and rechecks revoked connections', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const unknownKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const scheduler = createScheduler()
  const events = []
  let server = null
  server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    scheduler,
    swarmFactory() {
      t.ok(server.sessionStore.initialized)
      t.ok(server.retentionManager.timer)
      events.push({ type: 'swarm' })
      return createStubSwarm(events)
    }
  })
  t.teardown(() => server.close())
  const allowlistEvents = []
  server.on('allowlist', (event) => allowlistEvents.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing allowlist listener')
  })

  await server.listen()
  t.is(server._firewall(unknownKey), true)
  t.is(server._firewall(allowedKey), false)
  await t.exception(() => server.reloadAllowlist(['not-a-public-key']))
  t.alike(server.allowedKeys, new Set([b4a.toString(allowedKey, 'hex')]))
  await server.reloadAllowlist([])
  t.alike(allowlistEvents, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'PROTOCOL_INVALID'
    },
    { status: 'completed', appliedCount: 0, pendingCount: 0 }
  ])

  let destroyed = null
  server._onConnection({
    remotePublicKey: allowedKey,
    destroy(error) {
      destroyed = error
    }
  })
  t.is(destroyed.code, 'AUTH_REJECTED')
  await server.close()

  t.alike(
    events.map((event) => event.type),
    ['swarm', 'join', 'flushed', 'destroy']
  )
  t.is(scheduler.intervals.size, 0)
})

test('Server reports live allowlist read and parse failures then applies the next valid poll', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const nextKey = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const allowlistDir = await createTempDir(t)
  const allowlistPath = path.join(allowlistDir, 'private-customer-allowlist')
  await fs.promises.writeFile(allowlistPath, `${b4a.toString(allowedKey, 'hex')}\n`)
  const scheduler = createScheduler()
  let unreadable = false
  const storage = createStorage({
    beforeOperation(name, filePath) {
      if (unreadable && name === 'readFile' && filePath === allowlistPath) {
        const error = new Error(`cannot read ${allowlistPath}`)
        error.code = 'EACCES'
        throw error
      }
    }
  })
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    allowlistPath,
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    minFreeBytes: 0,
    scheduler,
    storage,
    swarmFactory: () => createStubSwarm([]),
    logger: {
      warn() {
        throw new Error('throwing server logger')
      }
    }
  })
  const events = []
  server.on('allowlist', (event) => events.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing server listener')
  })
  await server.listen()
  events.length = 0

  await fs.promises.writeFile(allowlistPath, 'PRIVATE-CONTENT\n')
  await server.allowlistWatcher.timer.callback()
  t.is(server._firewall(allowedKey), false)
  t.alike(server.allowedKeys, new Set([b4a.toString(allowedKey, 'hex')]))
  t.alike(server.allowlistWatcher.keys, new Set([b4a.toString(allowedKey, 'hex')]))

  unreadable = true
  await server.allowlistWatcher.timer.callback()
  t.is(server._firewall(allowedKey), false)

  unreadable = false
  await fs.promises.writeFile(allowlistPath, `${b4a.toString(nextKey, 'hex')}\n`)
  await server.allowlistWatcher.timer.callback()
  t.is(server._firewall(allowedKey), true)
  t.is(server._firewall(nextKey), false)
  t.alike(events, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'INVALID_PUBLIC_KEY'
    },
    { status: 'failed', appliedCount: 1, pendingCount: 0, reason: 'EACCES' },
    { status: 'completed', appliedCount: 1, pendingCount: 0 }
  ])
  const serialized = JSON.stringify(events)
  t.absent(serialized.includes(b4a.toString(allowedKey, 'hex')))
  t.absent(serialized.includes(b4a.toString(nextKey, 'hex')))
  t.absent(serialized.includes('private-customer-allowlist'))
  t.absent(serialized.includes('PRIVATE-CONTENT'))
  await server.close()
})

test('Server initial allowlist failure emits safely and remains startup-fatal', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const allowlistDir = await createTempDir(t)
  const allowlistPath = path.join(allowlistDir, 'private-initial-allowlist')
  await fs.promises.writeFile(allowlistPath, 'PRIVATE-INITIAL-CONTENT\n')
  let swarmCreations = 0
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    allowlistPath,
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    minFreeBytes: 0,
    swarmFactory() {
      swarmCreations++
      return createStubSwarm([])
    }
  })
  const events = []
  server.on('allowlist', (event) => events.push(event))
  server.on('allowlist', () => {
    throw new Error('throwing initial failure listener')
  })

  await t.exception(() => server.listen(), {
    name: 'SwarmDeployError',
    code: 'INVALID_PUBLIC_KEY'
  })
  t.is(swarmCreations, 0)
  t.alike(events, [
    {
      status: 'failed',
      appliedCount: 1,
      pendingCount: 0,
      reason: 'INVALID_PUBLIC_KEY'
    }
  ])
  const serialized = JSON.stringify(events)
  t.absent(serialized.includes('private-initial-allowlist'))
  t.absent(serialized.includes('PRIVATE-INITIAL-CONTENT'))
})

test('Server startup failure releases the storage lock', async (t) => {
  const storageDir = await createTempDir(t)
  const options = {
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(ALLOWED_SEED).publicKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024
  }
  const failed = new Server({
    ...options,
    swarmFactory() {
      throw new Error('injected swarm failure')
    }
  })

  await t.exception(() => failed.listen())
  const recovered = new Server({
    ...options,
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => recovered.close())
  await recovered.listen()

  t.ok(recovered.listening)
})

test('Server reloadAllowlist revokes removed keys before listen', async (t) => {
  const allowedKey = keyPairFromSeed(ALLOWED_SEED).publicKey
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [allowedKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => server.close())

  const events = []
  server.on('allowlist', (event) => events.push(event))

  const reloaded = await server.reloadAllowlist([])

  t.alike(reloaded, new Set())
  t.alike(server.allowedKeys, new Set())
  t.alike(events, [{ status: 'completed', appliedCount: 0, pendingCount: 0 }])
  t.is(server.pendingRevocations.size, 0)
})

test('Server contains logger failures', async (t) => {
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [keyPairFromSeed(ALLOWED_SEED).publicKey],
    maxFileBytes: 1024 * 1024,
    maxStagingBytes: 2 * 1024 * 1024,
    logger: {
      info() {
        throw new Error('logger failure')
      },
      warn() {
        throw new Error('logger failure')
      },
      error() {
        throw new Error('logger failure')
      }
    },
    swarmFactory() {
      return createStubSwarm([])
    }
  })
  t.teardown(() => server.close())

  await server.listen()
  t.is(server._firewall(keyPairFromSeed(UNKNOWN_SEED).publicKey), true)
})
