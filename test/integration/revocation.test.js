'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const { Server, keyPairFromSeed, transferId, ERRORS } = require('../..')
const { ServerSession } = require('../../dist/protocol/server-session')
const { OFFER, CHUNK, FINISH, RESULT } = require('../../dist/protocol/constants')
const { initLayout } = require('../../dist/storage/layout')
const { readJson } = require('../../dist/storage/atomic-file')
const { SessionStore } = require('../../dist/storage/session-store')
const { CommitStore } = require('../../dist/storage/commit-store')
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

function attachServerSession(server, ownerKey, onDestroy) {
  const transport = createChannel()
  const socket = new EventEmitter()
  socket.destroy = (error) => onDestroy(error)
  const owner = hex(ownerKey)
  const connection = {
    owner,
    ownerKey,
    sessions: new Set(),
    socket,
    refreshTransport() {}
  }
  server._connections.set(socket, connection)
  server._sockets.set(owner, new Set([socket]))
  server._onPair(
    {
      createChannel() {
        return transport.channel
      }
    },
    socket,
    connection,
    b4a.from('late-revocation')
  )
  return { ...transport, socket, connection, session: [...connection.sessions][0] }
}

async function runLinearizedServerRevocation(t, name, { deferRetry = false } = {}) {
  const cleanupStarted = deferred()
  const releaseCleanup = deferred()
  const revocationStarted = deferred()
  let armed = false
  let sessionPath = null
  const storage = createStorage({
    async beforeOperation(operation, filePath) {
      if (!armed || operation !== 'unlink' || filePath !== sessionPath) return
      armed = false
      cleanupStarted.resolve()
      await releaseCleanup.promise
      throw new Error('Injected post-linearization cleanup failure')
    }
  })
  const storageDir = await createTempDir(t)
  const ownerKey = keyPairFromSeed(OWNER_SEED).publicKey
  const server = new Server({
    seed: b4a.alloc(32, name.length),
    storageDir,
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const attached = attachServerSession(server, ownerKey, () => revocationStarted.resolve())
  const upload = makeUpload(ownerKey, name)
  const id = hex(upload.offer.transferId)
  sessionPath = path.join(server.layout.sessions, `${id}.json`)
  const stagingPath = path.join(server.layout.staging, `${id}.part`)
  const journalPath = path.join(server.layout.journals, `${id}.json`)
  const finalPath = path.join(server.layout.root, name)
  const sidecarPath = path.join(server.layout.commits, `${id}.json`)
  await attached.messages[OFFER].onmessage(upload.offer)
  await attached.messages[CHUNK].onmessage(upload.chunk)

  armed = true
  const finishing = attached.messages[FINISH].onmessage({ transferId: upload.offer.transferId })
  await diagnosticTimeout(cleanupStarted.promise, `${name} cleanup barrier`)
  if (deferRetry) {
    server.commitStore.retryAbortedAttempt = async () => {
      throw new Error('Simulated restart before pending retry')
    }
  }
  const reloading = server.reloadAllowlist([])
  await diagnosticTimeout(revocationStarted.promise, `${name} revocation barrier`)
  releaseCleanup.resolve()
  await finishing
  await attached.session.settle()

  let reloadError = null
  try {
    await reloading
  } catch (err) {
    reloadError = err
  }
  return {
    server,
    storage,
    storageDir,
    upload,
    id,
    sessionPath,
    stagingPath,
    journalPath,
    finalPath,
    sidecarPath,
    reloadError
  }
}

test('late Server revocation preserves linearized commits online and after restart', async (t) => {
  const online = await runLinearizedServerRevocation(t, 'late-online.bin')
  const onlineRecord = await readJson(online.sidecarPath)
  const onlineFinal = await fs.promises.lstat(online.finalPath)
  t.is(online.reloadError, null)
  t.is(online.server.sessionStore.sessions.size, 0)
  t.is(online.server.sessionStore.reservedBytes, 0)
  t.is(online.server._activeUploads.size, 0)
  t.is(online.server.pendingRevocations.size, 0)
  t.alike(await fs.promises.readFile(online.finalPath), online.upload.chunk.data)
  await t.exception(() => fs.promises.lstat(online.sessionPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(online.stagingPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(online.journalPath), { code: 'ENOENT' })
  t.is(
    await online.server.commitStore.retryAbortedAttempt(
      online.upload.offer.transferId,
      online.server.sessionStore
    ),
    false
  )
  await online.server.reloadAllowlist([])
  const onlineAfter = await fs.promises.lstat(online.finalPath)
  t.is(onlineAfter.dev, onlineFinal.dev)
  t.is(onlineAfter.ino, onlineFinal.ino)
  t.alike(await readJson(online.sidecarPath), onlineRecord)

  const interrupted = await runLinearizedServerRevocation(t, 'late-restart.bin', {
    deferRetry: true
  })
  const interruptedRecord = await readJson(interrupted.sidecarPath)
  const interruptedFinal = await fs.promises.lstat(interrupted.finalPath)
  t.is(interrupted.reloadError.name, 'AggregateError')
  t.is(interrupted.server.sessionStore.sessions.size, 0)
  t.is(interrupted.server.sessionStore.reservedBytes, 0)
  t.is(interrupted.server._activeUploads.size, 0)
  t.is(interrupted.server.pendingRevocations.size, 1)
  t.alike(await fs.promises.readFile(interrupted.finalPath), interrupted.upload.chunk.data)
  t.is((await readJson(interrupted.journalPath)).state, 'committing')
  await interrupted.server.close()

  const restarted = new Server({
    seed: b4a.alloc(32, 0x59),
    storageDir: interrupted.storageDir,
    allowedKeys: [],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage: interrupted.storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => restarted.close())
  await restarted.listen()
  const restartedFinal = await fs.promises.lstat(interrupted.finalPath)
  t.is(restartedFinal.dev, interruptedFinal.dev)
  t.is(restartedFinal.ino, interruptedFinal.ino)
  t.alike(await fs.promises.readFile(interrupted.finalPath), interrupted.upload.chunk.data)
  t.alike(await readJson(interrupted.sidecarPath), interruptedRecord)
  await t.exception(() => fs.promises.lstat(interrupted.sessionPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(interrupted.stagingPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(interrupted.journalPath), { code: 'ENOENT' })
  t.is(restarted.sessionStore.sessions.size, 0)
  t.is(restarted.sessionStore.reservedBytes, 0)
})

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
