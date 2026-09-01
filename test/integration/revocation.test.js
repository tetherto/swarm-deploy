'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const { Server, keyPairFromSeed, transferId, ERRORS } = require('../..')
const { ServerSession } = require('../../lib/protocol/server-session')
const { OFFER, CHUNK, FINISH, RESULT } = require('../../lib/protocol/constants')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')

const OWNER = b4a.alloc(32, 0x51)
const OWNER_SEED = b4a.alloc(32, 0x52)
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

function diagnosticTimeout(promise, label, timeout = 1_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${label}`)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function makeUpload(ownerKey = OWNER, name = 'revoked.bin') {
  const data = b4a.from('revocation barrier payload')
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
    size: offer.size,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: { transferId: offer.transferId, index: 0, digest, data }
  }
}

function createChannel() {
  const outbound = []
  const messages = []
  const channel = {
    drained: true,
    closed: false,
    _recv() {},
    addMessage(options) {
      const index = messages.length
      const message = {
        ...options,
        send(value) {
          outbound.push({ index, value })
          return true
        }
      }
      messages.push(message)
      return message
    },
    open() {},
    close() {
      channel.closed = true
    }
  }
  return { channel, messages, outbound }
}

async function createSession(t, storage = fs.promises) {
  const layout = initLayout(await createTempDir(t))
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commitStore = new CommitStore({ layout, storage })
  const transport = createChannel()
  const destroyed = []
  const session = new ServerSession({
    channel: transport.channel,
    ownerKey: OWNER,
    sessionStore,
    commitStore,
    maxFileBytes: CHUNK_SIZE,
    destroy(error) {
      destroyed.push(error)
    }
  })
  t.teardown(() => session.close())
  return { layout, sessionStore, commitStore, session, destroyed, ...transport }
}

async function offerReady(created, upload) {
  await created.messages[OFFER].onmessage(upload.offer)
  tIsReady(created)
}

function tIsReady(created) {
  if (created.session.state !== 'READY') {
    throw new Error(`Expected READY session, got ${created.session.state}`)
  }
}

test('revocation stops an active write and its queued successor without acknowledgements', async (t) => {
  const writeStarted = deferred()
  const releaseWrite = deferred()
  let blocked = false
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (blocked || name !== 'write' || !filePath.endsWith('.part')) return
      blocked = true
      writeStarted.resolve()
      await releaseWrite.promise
    }
  })
  const created = await createSession(t, storage)
  const upload = makeUpload()
  await offerReady(created, upload)

  const active = created.messages[CHUNK].onmessage(upload.chunk)
  await diagnosticTimeout(writeStarted.promise, 'active staging write barrier')
  const queued = created.messages[CHUNK].onmessage(upload.chunk)
  created.session.revoke()
  releaseWrite.resolve()
  await Promise.all([active, queued])
  await created.session.settle()

  t.is(created.session.state, 'TERMINAL')
  t.is(created.channel.closed, true)
  t.is(created.outbound.filter((entry) => entry.index === 5).length, 0)
  t.is(created.destroyed[0].code, ERRORS.REVOKED)
  await created.sessionStore.deleteByOwner(OWNER)
  t.is(created.sessionStore.sessions.size, 0)
})

test('revocation at the publication link rolls back final and sidecar', async (t) => {
  const linkStarted = deferred()
  const releaseLink = deferred()
  let finalPath = null
  let blocked = false
  const storage = createStorage({
    async beforeOperation(name, source, destination) {
      if (blocked || name !== 'link' || destination !== finalPath) return
      blocked = true
      linkStarted.resolve()
      await releaseLink.promise
    }
  })
  const created = await createSession(t, storage)
  const upload = makeUpload(OWNER, 'committing.bin')
  finalPath = path.join(created.layout.root, upload.offer.name)
  await offerReady(created, upload)
  await created.messages[CHUNK].onmessage(upload.chunk)

  const finishing = created.messages[FINISH].onmessage({
    transferId: upload.offer.transferId
  })
  await diagnosticTimeout(linkStarted.promise, 'commit publication link barrier')
  created.session.revoke()
  releaseLink.resolve()
  await finishing
  await created.session.settle()

  t.is(
    created.outbound.some((entry) => entry.index === RESULT),
    false
  )
  await t.exception(() => fs.promises.lstat(finalPath), { code: 'ENOENT' })
  await t.exception(
    () =>
      fs.promises.lstat(path.join(created.layout.commits, `${hex(upload.offer.transferId)}.json`)),
    { code: 'ENOENT' }
  )
  t.is(
    await created.commitStore.retryAbortedAttempt(upload.offer.transferId, created.sessionStore),
    false
  )
  await created.sessionStore.deleteByOwner(OWNER)
  t.is(created.sessionStore.sessions.size, 0)
})

function createStubSwarm() {
  const swarm = new EventEmitter()
  swarm.join = () => ({ flushed: async () => {} })
  swarm.destroy = async () => {}
  return swarm
}

test('an unchanged allowlist reload retries failed revocation cleanup', async (t) => {
  const ownerKey = keyPairFromSeed(OWNER_SEED).publicKey
  let armed = false
  let sessionPath = null
  let failures = 0
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (!armed || failures > 0 || name !== 'unlink' || filePath !== sessionPath) return
      failures++
      throw new Error('Injected revocation cleanup failure')
    }
  })
  const server = new Server({
    seed: b4a.alloc(32, 0x53),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const upload = makeUpload(ownerKey, 'retry-revocation.bin')
  await server.sessionStore.offer(ownerKey, upload.offer)
  sessionPath = path.join(server.layout.sessions, `${hex(upload.offer.transferId)}.json`)
  armed = true

  let firstFailure = null
  try {
    await server.reloadAllowlist([])
  } catch (err) {
    firstFailure = err
  }
  t.is(firstFailure.name, 'AggregateError')
  t.alike(server.allowedKeys, new Set())
  t.is(server.pendingRevocations.size, 1)
  t.is(server.sessionStore.sessions.size, 1)

  await server.reloadAllowlist([])

  t.is(failures, 1)
  t.is(server.pendingRevocations.size, 0)
  t.is(server.sessionStore.sessions.size, 0)
  t.alike(await fs.promises.readdir(server.layout.sessions), [])
  t.alike(await fs.promises.readdir(server.layout.staging), [])
})
