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
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
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
  await server.listen()

  const unknown = createClient(t, testnet, UNKNOWN_SEED)
  unknown.join(server.topic, { server: false, client: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(events.length, 0)
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

  await server.listen()
  t.is(server._firewall(unknownKey), true)
  t.is(server._firewall(allowedKey), false)
  await t.exception(() => server.reloadAllowlist(['not-a-public-key']))
  t.alike(server.allowedKeys, new Set([b4a.toString(allowedKey, 'hex')]))
  await server.reloadAllowlist([])

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
