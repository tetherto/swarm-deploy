'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const {
  ERRORS,
  SwarmDeployError,
  Client,
  Server,
  keyPairFromSeed,
  transferId,
  OFFER,
  STATUS,
  BITMAP_PAGE,
  FINISH
} = require('../..')
const { ClientSession } = require('../../lib/protocol/client-session')
const { ServerSession } = require('../../lib/protocol/server-session')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { recoverStorage } = require('../../lib/storage/recovery')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')
const { createLocalTestnet } = require('../helpers/testnet')

const OWNER = b4a.alloc(32, 0x41)
const OTHER_OWNER = b4a.alloc(32, 0x42)
const CHUNK_SIZE = 1024 * 1024
const GIBIBYTE = 1024 * 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function diagnosticTimeout(promise, label, timeout = 2_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${label}`)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function transportFailure() {
  const error = new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Injected transport boundary')
  error.transport = true
  return error
}

function noSpace(message) {
  const error = new Error(message)
  error.code = 'ENOSPC'
  return error
}

function destroyServerConnections(server) {
  for (const socket of server._connections.keys()) socket.destroy()
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(ownerKey = OWNER, options = {}) {
  const data = options.data || b4a.from('adversarial payload')
  const name = options.name || 'adversarial.bin'
  const size = options.size ?? data.byteLength
  const digest = options.digest || sha256(data)
  const offer = {
    version: 1,
    name,
    size,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: size === 0 ? 0 : 1
  }
  offer.transferId = transferId({
    clientPublicKey: ownerKey,
    name,
    size,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: {
      transferId: offer.transferId,
      index: 0,
      digest: sha256(data),
      data
    }
  }
}

function createStubSwarm() {
  const swarm = new EventEmitter()
  swarm.join = () => ({ flushed: async () => {} })
  swarm.destroy = async () => {}
  return swarm
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

async function createStore(t, options = {}) {
  const layout = initLayout(options.root || (await createTempDir(t)))
  const store = new SessionStore({
    layout,
    maxStagingBytes: options.maxStagingBytes ?? 8 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage: options.storage,
    minFreeBytes: options.minFreeBytes
  })
  await store.init()
  t.teardown(() => store.close())
  return { layout, store }
}

async function verify(store, ownerKey, upload) {
  await store.offer(ownerKey, upload.offer)
  if (upload.offer.chunkCount > 0) {
    await store.writeChunk(upload.offer.transferId, upload.chunk)
  }
  await store.finish(upload.offer.transferId)
  return store.sessions.get(hex(upload.offer.transferId))
}

async function createSessionUnlinkCrash(t, name) {
  let armed = false
  let sessionPath = null
  const storage = createStorage({
    async afterOperation(operation, filePath) {
      if (!armed || operation !== 'unlink' || filePath !== sessionPath) return
      armed = false
      throw new Error('Injected crash after session unlink')
    }
  })
  const root = await createTempDir(t)
  const created = await createStore(t, { root, storage })
  const upload = makeUpload(OWNER, { name })
  const session = await verify(created.store, OWNER, upload)
  const id = hex(upload.offer.transferId)
  sessionPath = path.join(created.layout.sessions, `${id}.json`)
  armed = true
  await t.exception(() => new CommitStore({ layout: created.layout, storage }).commit(session))
  await created.store.close()
  return {
    ...created,
    upload,
    id,
    storage,
    stagingPath: path.join(created.layout.staging, `${id}.part`),
    journalPath: path.join(created.layout.journals, `${id}.json`)
  }
}

test('path and inode attack corpus never escapes or mutates foreign targets', async (t) => {
  const created = await createStore(t)
  const attacks = [
    '/absolute.bin',
    '../escape.bin',
    'dir/file.bin',
    'dir\\file.bin',
    'nul\u0000.bin',
    'control\u0001.bin',
    'résumé.bin',
    '.hidden',
    '..',
    'a/../b'
  ]

  for (const name of attacks) {
    const upload = makeUpload(OWNER, { name })
    await t.exception(() => created.store.offer(OWNER, upload.offer), {
      name: 'SwarmDeployError',
      code: ERRORS.INVALID_FILENAME
    })
  }

  const outside = await createTempDir(t)
  const target = path.join(outside, 'target.bin')
  await fs.promises.writeFile(target, b4a.from('foreign target'))

  const symlinkUpload = makeUpload(OWNER, { name: 'symlink.bin' })
  const stagingLink = path.join(
    created.layout.staging,
    `${hex(symlinkUpload.offer.transferId)}.part`
  )
  await fs.promises.symlink(target, stagingLink)
  await t.exception(() => created.store.offer(OWNER, symlinkUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readFile(target), b4a.from('foreign target'))

  const hardlinkUpload = makeUpload(OWNER, { name: 'hardlink.bin' })
  const hardlink = path.join(created.layout.root, hardlinkUpload.offer.name)
  await fs.promises.link(target, hardlink)
  await t.exception(() => created.store.offer(OWNER, hardlinkUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(target), b4a.from('foreign target'))

  const internalRoot = await createTempDir(t)
  const internalTarget = await createTempDir(t)
  const internal = path.join(internalRoot, '.swarm-deploy')
  await fs.promises.mkdir(internal)
  await fs.promises.symlink(internalTarget, path.join(internal, 'sessions'))
  t.exception(() => initLayout(internalRoot), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readdir(internalTarget), [])
})

test('length, chunk hash, whole hash, and excess-byte failures publish nothing', async (t) => {
  const cases = [
    {
      name: 'short',
      upload: makeUpload(OWNER, { name: 'short.bin', data: b4a.from('abc'), size: 4 }),
      mutate(upload) {
        upload.chunk.data = b4a.from('abc')
      },
      operation: 'write',
      code: ERRORS.PROTOCOL_INVALID
    },
    {
      name: 'excess',
      upload: makeUpload(OWNER, { name: 'excess.bin', data: b4a.from('abcd'), size: 3 }),
      mutate(upload) {
        upload.chunk.data = b4a.from('abcd')
      },
      operation: 'write',
      code: ERRORS.PROTOCOL_INVALID
    },
    {
      name: 'chunk digest',
      upload: makeUpload(OWNER, { name: 'chunk-hash.bin' }),
      mutate(upload) {
        upload.chunk.digest = b4a.alloc(32)
      },
      operation: 'write',
      code: ERRORS.CHECKSUM_MISMATCH
    },
    {
      name: 'whole digest',
      upload: makeUpload(OWNER, {
        name: 'whole-hash.bin',
        digest: b4a.alloc(32)
      }),
      mutate() {},
      operation: 'finish',
      code: ERRORS.CHECKSUM_MISMATCH
    }
  ]

  for (const entry of cases) {
    const created = await createStore(t)
    await created.store.offer(OWNER, entry.upload.offer)
    entry.mutate(entry.upload)
    if (entry.operation === 'write') {
      await t.exception(
        () => created.store.writeChunk(entry.upload.offer.transferId, entry.upload.chunk),
        { name: 'SwarmDeployError', code: entry.code },
        entry.name
      )
    } else {
      await created.store.writeChunk(entry.upload.offer.transferId, entry.upload.chunk)
      await t.exception(() => created.store.finish(entry.upload.offer.transferId), {
        name: 'SwarmDeployError',
        code: entry.code
      })
    }
    t.is(
      await pathExists(path.join(created.layout.root, entry.upload.offer.name)),
      false,
      `${entry.name} final absent`
    )
  }
})

test('same-ID offers are idempotent while same-name races admit one transfer', async (t) => {
  const duplicateStore = await createStore(t)
  const duplicate = makeUpload()
  const duplicates = await Promise.all([
    duplicateStore.store.offer(OWNER, duplicate.offer),
    duplicateStore.store.offer(OWNER, duplicate.offer)
  ])
  t.is(duplicates.filter((snapshot) => snapshot.resumed).length, 1)
  t.is(duplicateStore.store.sessions.size, 1)

  const racingStore = await createStore(t)
  const first = makeUpload(OWNER, { name: 'race.bin', data: b4a.from('first') })
  const second = makeUpload(OTHER_OWNER, { name: 'race.bin', data: b4a.from('second') })
  const raced = await Promise.allSettled([
    racingStore.store.offer(OWNER, first.offer),
    racingStore.store.offer(OTHER_OWNER, second.offer)
  ])
  t.is(raced.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const rejected = raced.find((outcome) => outcome.status === 'rejected')
  t.is(rejected.reason.code, ERRORS.FILE_BUSY)
  t.is(racingStore.store.sessions.size, 1)
})

test('disconnect boundaries resume without exposing partial uploads', async (t) => {
  const testnet = await createLocalTestnet(t)
  const clientSeed = b4a.alloc(32, 0x45)
  const ownerKey = keyPairFromSeed(clientSeed).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x46),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: 16 * CHUNK_SIZE,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()

  const originalClientSend = ClientSession.prototype._send
  const originalClientPump = ClientSession.prototype._pump
  const originalServerSend = ServerSession.prototype._send
  let clientSendHook = null
  let clientPumpHook = null
  let serverSendHook = null
  ClientSession.prototype._send = async function (index, value) {
    if (clientSendHook) await clientSendHook(index, this)
    return originalClientSend.call(this, index, value)
  }
  ClientSession.prototype._pump = async function () {
    if (clientPumpHook && (await clientPumpHook(this)) === false) return
    return originalClientPump.call(this)
  }
  ServerSession.prototype._send = async function (index, value, options) {
    const sent = await originalServerSend.call(this, index, value, options)
    if (serverSendHook) await serverSendHook(index, this)
    return sent
  }
  t.teardown(() => {
    ClientSession.prototype._send = originalClientSend
    ClientSession.prototype._pump = originalClientPump
    ServerSession.prototype._send = originalServerSend
  })

  const cases = [
    {
      name: 'before-offer',
      install(trigger) {
        clientSendHook = async (index, session) => {
          if (index !== OFFER) return
          clientSendHook = null
          trigger()
          const error = transportFailure()
          session.destroy(error)
          throw error
        }
      }
    },
    {
      name: 'after-accept',
      install(trigger) {
        serverSendHook = async (index) => {
          if (index !== STATUS) return
          serverSendHook = null
          trigger()
          destroyServerConnections(server)
        }
      }
    },
    {
      name: 'after-bitmap',
      install(trigger) {
        serverSendHook = async (index) => {
          if (index !== BITMAP_PAGE) return
          serverSendHook = null
          trigger()
          destroyServerConnections(server)
        }
      }
    },
    {
      name: 'after-ready',
      install(trigger) {
        clientPumpHook = async (session) => {
          if (session.state !== 'READY' || session.nextMissing !== 0) return
          clientPumpHook = null
          trigger()
          session.destroy(transportFailure())
          return false
        }
      }
    },
    {
      name: 'after-chunk-before-ack',
      install(trigger) {
        const original = server.sessionStore.writeChunk
        server.sessionStore.writeChunk = async (...args) => {
          const snapshot = await original.apply(server.sessionStore, args)
          server.sessionStore.writeChunk = original
          trigger()
          destroyServerConnections(server)
          return snapshot
        }
        return () => {
          server.sessionStore.writeChunk = original
        }
      }
    },
    {
      name: 'after-ack',
      install(trigger) {
        clientPumpHook = async (session) => {
          if (
            session.state !== 'READY' ||
            session.inFlight.size !== 0 ||
            session.nextMissing !== session.missing.length
          ) {
            return
          }
          clientPumpHook = null
          trigger()
          session.destroy(transportFailure())
          return false
        }
      }
    },
    {
      name: 'before-finish',
      install(trigger) {
        clientSendHook = async (index, session) => {
          if (index !== FINISH) return
          clientSendHook = null
          trigger()
          const error = transportFailure()
          session.destroy(error)
          throw error
        }
      }
    },
    {
      name: 'during-verification',
      install(trigger, releaseBoundary) {
        const originalStorage = server.sessionStore.storage
        const originalFinish = server.sessionStore.finish
        const verificationSettled = deferred()
        server.sessionStore.finish = async (...args) => {
          try {
            return await originalFinish.apply(server.sessionStore, args)
          } finally {
            server.sessionStore.finish = originalFinish
            verificationSettled.resolve()
          }
        }
        server.sessionStore.storage = createStorage({
          async beforeOperation(operation, filePath) {
            if (operation !== 'read' || !filePath.endsWith('.part')) return
            server.sessionStore.storage = originalStorage
            trigger()
            destroyServerConnections(server)
            await releaseBoundary.promise
          }
        })
        return {
          beforeResume: verificationSettled.promise,
          cleanup() {
            server.sessionStore.finish = originalFinish
            server.sessionStore.storage = originalStorage
          }
        }
      }
    },
    {
      name: 'after-commit-before-result',
      visible: true,
      install(trigger) {
        const original = server.commitStore.commit
        server.commitStore.commit = async (...args) => {
          const record = await original.apply(server.commitStore, args)
          server.commitStore.commit = original
          trigger()
          destroyServerConnections(server)
          return record
        }
        return () => {
          server.commitStore.commit = original
        }
      }
    }
  ]

  for (const entry of cases) {
    const client = new Client({
      seed: clientSeed,
      serverPublicKey: server.publicKey,
      connectTimeout: 5_000,
      idleTimeout: 5_000,
      dht: testnet.createNode()
    })
    const source = path.join(await createTempDir(t), `${entry.name}.bin`)
    const data = b4a.from(`disconnect at ${entry.name}`)
    await fs.promises.writeFile(source, data)
    const finalPath = path.join(server.layout.root, path.basename(source))
    const triggered = deferred()
    const retryEntered = deferred()
    const releaseRetry = deferred()
    const releaseBoundary = deferred()
    const originalDelay = client._delay
    let fired = false
    const control = entry.install(() => {
      if (fired) return
      fired = true
      triggered.resolve()
    }, releaseBoundary)
    client._delay = async (...args) => {
      retryEntered.resolve()
      await releaseRetry.promise
      return originalDelay.apply(client, args)
    }
    const uploading = client.upload(source)
    try {
      await diagnosticTimeout(
        Promise.all([triggered.promise, retryEntered.promise]),
        entry.name,
        5_000
      )
      t.is(await pathExists(finalPath), entry.visible === true, `${entry.name} visibility`)
      if (entry.visible) t.alike(await fs.promises.readFile(finalPath), data)
      releaseBoundary.resolve()
      if (control?.beforeResume) {
        await diagnosticTimeout(control.beforeResume, `${entry.name} settle`, 5_000)
      }
      releaseRetry.resolve()
      const result = await diagnosticTimeout(uploading, `${entry.name} resume`, 10_000)
      t.ok(
        result.status === 'COMMITTED' || result.status === 'ALREADY_COMMITTED',
        `${entry.name} resumed`
      )
      t.alike(await fs.promises.readFile(finalPath), data, `${entry.name} final`)
    } finally {
      releaseBoundary.resolve()
      releaseRetry.resolve()
      client._delay = originalDelay
      clientSendHook = null
      clientPumpHook = null
      serverSendHook = null
      if (typeof control === 'function') control()
      else if (control?.cleanup) control.cleanup()
      await uploading.catch(() => {})
      await client.close()
    }
  }
})

test('staging and minimum free-disk reservations reject before creating state', async (t) => {
  const staging = await createStore(t, { maxStagingBytes: 3 })
  const exact = makeUpload(OWNER, { name: 'exact.bin', data: b4a.from('abc') })
  await staging.store.offer(OWNER, exact.offer)
  const over = makeUpload(OWNER, { name: 'over.bin', data: b4a.from('x') })
  await t.exception(() => staging.store.offer(OWNER, over.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.STAGING_LIMIT
  })

  const diskStorage = createStorage()
  diskStorage.statfs = async () => ({ bavail: 10, bsize: 1 })
  const disk = await createStore(t, {
    storage: diskStorage,
    minFreeBytes: 8,
    maxStagingBytes: 100
  })
  const upload = makeUpload(OWNER, { name: 'disk.bin', data: b4a.from('abc') })
  await t.exception(() => disk.store.offer(OWNER, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
  t.is(disk.store.sessions.size, 0)
  t.alike(await fs.promises.readdir(disk.layout.staging), [])

  const serverOwner = keyPairFromSeed(OWNER).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x43),
    storageDir: await createTempDir(t),
    allowedKeys: [serverOwner],
    maxFileBytes: 100,
    maxStagingBytes: 100,
    minFreeBytes: 8,
    storage: diskStorage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const serverUpload = makeUpload(serverOwner, {
    name: 'server-disk.bin',
    data: b4a.from('abc')
  })
  await t.exception(() => server.sessionStore.offer(serverOwner, serverUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })

  const unsupported = await createStore(t, {
    storage: createStorage(),
    minFreeBytes: 1,
    maxStagingBytes: 100
  })
  const unsupportedUpload = makeUpload(OWNER, {
    name: 'unsupported-disk.bin',
    data: b4a.from('x')
  })
  await t.exception(() => unsupported.store.offer(OWNER, unsupportedUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
})

test('Server defaults to 1 GiB reserve and real statfs enforces both edges', async (t) => {
  const ownerKey = keyPairFromSeed(OWNER).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x44),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: 100,
    maxStagingBytes: 100,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  t.is(server.minFreeBytes, GIBIBYTE)
  t.is(server.sessionStore.minFreeBytes, GIBIBYTE)

  const admitted = await createStore(t, {
    minFreeBytes: 1,
    maxStagingBytes: 100
  })
  const accepted = makeUpload(OWNER, { name: 'real-statfs-ok.bin', data: b4a.from('x') })
  await admitted.store.offer(OWNER, accepted.offer)
  t.is(admitted.store.sessions.size, 1)

  const rejected = await createStore(t, {
    minFreeBytes: Number.MAX_SAFE_INTEGER,
    maxStagingBytes: 100
  })
  const available = await fs.promises.statfs(rejected.layout.staging)
  t.ok(BigInt(available.bavail) * BigInt(available.bsize) < BigInt(Number.MAX_SAFE_INTEGER))
  const refused = makeUpload(OWNER, { name: 'real-statfs-low.bin', data: b4a.from('x') })
  await t.exception(() => rejected.store.offer(OWNER, refused.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
  t.is(rejected.store.sessions.size, 0)
})

test('pre-publication write, sync, and link failures preserve resumable state and foreign finals', async (t) => {
  for (const failure of ['write', 'sync', 'link']) {
    let armed = false
    let layout = null
    let finalPath = null
    const storage = createStorage({
      async beforeOperation(name, source, destination) {
        if (!armed) return
        if (failure === 'write' && name === 'write' && source.startsWith(layout.journals)) {
          throw new Error('Injected journal write failure')
        }
        if (failure === 'sync' && name === 'sync' && source.startsWith(layout.journals)) {
          throw new Error('Injected journal sync failure')
        }
        if (failure === 'link' && name === 'link' && destination === finalPath) {
          throw new Error('Injected final link failure')
        }
      }
    })
    const created = await createStore(t, { storage })
    layout = created.layout
    const upload = makeUpload(OWNER, { name: `${failure}.bin` })
    const session = await verify(created.store, OWNER, upload)
    finalPath = path.join(layout.root, upload.offer.name)
    armed = true
    await t.exception(() => new CommitStore({ layout, storage }).commit(session))
    armed = false

    t.is(await pathExists(finalPath), false, `${failure} final absent`)
    t.is(created.store.sessions.has(hex(upload.offer.transferId)), true)
    t.is(await pathExists(path.join(layout.staging, `${hex(upload.offer.transferId)}.part`)), true)
  }

  const foreign = await createStore(t)
  const upload = makeUpload(OWNER, { name: 'foreign.bin' })
  const session = await verify(foreign.store, OWNER, upload)
  const destination = path.join(foreign.layout.root, upload.offer.name)
  await fs.promises.writeFile(destination, b4a.from('operator-owned'))
  await t.exception(() => new CommitStore({ layout: foreign.layout }).commit(session), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(destination), b4a.from('operator-owned'))
})

test('coded ENOSPC at staging and publication boundaries preserves safe state', async (t) => {
  for (const operation of ['write', 'sync']) {
    let armed = false
    const storage = createStorage({
      async beforeOperation(name, filePath) {
        if (!armed || name !== operation || !filePath.endsWith('.part')) return
        armed = false
        throw noSpace(`No space during staging ${operation}`)
      }
    })
    const created = await createStore(t, { storage })
    const upload = makeUpload(OWNER, { name: `staging-${operation}-enospc.bin` })
    await created.store.offer(OWNER, upload.offer)
    armed = true
    await t.exception(
      () => created.store.writeChunk(upload.offer.transferId, upload.chunk),
      { code: 'ENOSPC' },
      `staging ${operation}`
    )
    const session = created.store.sessions.get(hex(upload.offer.transferId))
    t.is(session.state, 'receiving')
    t.is(session.verified.size, 0)
    t.is(await pathExists(path.join(created.layout.root, upload.offer.name)), false)
    t.is(await pathExists(path.join(created.layout.staging, `${session.id}.part`)), true)
  }

  for (const boundary of ['link', 'root-sync']) {
    let armed = false
    let finalPath = null
    let root = null
    const storage = createStorage({
      async beforeOperation(name, source, destination) {
        if (!armed) return
        if (boundary === 'link' && name === 'link' && destination === finalPath) {
          armed = false
          throw noSpace('No space linking final')
        }
        if (boundary === 'root-sync' && name === 'sync' && source === root) {
          armed = false
          throw noSpace('No space syncing publication directory')
        }
      }
    })
    const created = await createStore(t, { storage })
    root = created.layout.root
    const upload = makeUpload(OWNER, { name: `${boundary}-enospc.bin` })
    const session = await verify(created.store, OWNER, upload)
    finalPath = path.join(root, upload.offer.name)
    armed = true
    let failure = null
    try {
      await new CommitStore({ layout: created.layout, storage }).commit(session)
    } catch (err) {
      failure = err
    }
    if (boundary === 'link') {
      t.is(failure.code, ERRORS.COMMIT_FAILED, `${boundary} typed commit failure`)
      t.is(failure.cause.code, 'ENOSPC', `${boundary} preserves ENOSPC cause`)
    } else {
      t.is(failure.code, 'ENOSPC', `${boundary} preserves coded failure`)
    }
    t.is(await pathExists(finalPath), false, `${boundary} final absent`)
    t.is(created.store.sessions.has(session.id), true, `${boundary} remains resumable`)
    t.is(
      await pathExists(path.join(created.layout.staging, `${session.id}.part`)),
      true,
      `${boundary} staging retained`
    )
  }
})

test('restart converges after session unlink without exposing partial content', async (t) => {
  const created = await createSessionUnlinkCrash(t, 'restart.bin')

  const restarted = new SessionStore({
    layout: created.layout,
    maxStagingBytes: 8 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage: created.storage
  })
  t.teardown(() => restarted.close())
  await restarted.init()
  t.is(restarted.reservedBytes, created.upload.offer.size)
  const commitStore = new CommitStore({ layout: created.layout, storage: created.storage })
  const recovered = await recoverStorage({
    layout: created.layout,
    sessionStore: restarted,
    commitStore,
    logger: { warn() {} }
  })

  t.is(recovered[0].status, 'COMMITTED')
  t.alike(
    await fs.promises.readFile(path.join(created.layout.root, created.upload.offer.name)),
    created.upload.chunk.data
  )
  t.is(restarted.reservedBytes, 0)
  t.alike(await fs.promises.readdir(created.layout.staging), [])
  t.alike(await fs.promises.readdir(created.layout.sessions), [])
  t.alike(await fs.promises.readdir(created.layout.journals), [])
})

test('orphan staging requires a bounded canonical same-inode journal', async (t) => {
  const cases = [
    {
      name: 'malformed',
      mutate: async (created) => fs.promises.writeFile(created.journalPath, '{')
    },
    {
      name: 'oversized',
      mutate: async (created) =>
        fs.promises.writeFile(created.journalPath, b4a.alloc(16 * 1024 + 1))
    },
    {
      name: 'journal symlink',
      mutate: async (created) => {
        created.foreignTarget = path.join(created.layout.root, 'foreign-journal-target')
        await fs.promises.writeFile(created.foreignTarget, 'foreign journal target')
        await fs.promises.unlink(created.journalPath)
        await fs.promises.symlink(created.foreignTarget, created.journalPath)
      }
    },
    {
      name: 'wrong top-level ID',
      mutate: async (created) => {
        const journal = JSON.parse(await fs.promises.readFile(created.journalPath, 'utf8'))
        journal.transferId = 'f'.repeat(64)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    },
    {
      name: 'wrong staging inode',
      mutate: async (created) => {
        const journal = JSON.parse(await fs.promises.readFile(created.journalPath, 'utf8'))
        journal.sourceStagingIdentity.ino = String(BigInt(journal.sourceStagingIdentity.ino) + 1n)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    },
    {
      name: 'foreign record',
      mutate: async (created) => {
        const journal = JSON.parse(await fs.promises.readFile(created.journalPath, 'utf8'))
        journal.record.transferId = 'e'.repeat(64)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    }
  ]

  for (const entry of cases) {
    const created = await createSessionUnlinkCrash(t, `${entry.name.replaceAll(' ', '-')}.bin`)
    await entry.mutate(created)
    const restarted = new SessionStore({
      layout: created.layout,
      maxStagingBytes: 8 * CHUNK_SIZE,
      storage: created.storage
    })
    await t.exception(
      () => restarted.init(),
      { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID },
      entry.name
    )
    t.is(restarted.initialized, false, `${entry.name} not initialized`)
    t.is(restarted.reservedBytes, 0, `${entry.name} not silently admitted`)
    if (created.foreignTarget) {
      t.is(await fs.promises.readFile(created.foreignTarget, 'utf8'), 'foreign journal target')
    }
    await restarted.close()
  }
})
