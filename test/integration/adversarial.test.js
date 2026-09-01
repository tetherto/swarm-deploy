'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const { ERRORS, Server, keyPairFromSeed, transferId } = require('../..')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { recoverStorage } = require('../../lib/storage/recovery')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')

const OWNER = b4a.alloc(32, 0x41)
const OTHER_OWNER = b4a.alloc(32, 0x42)
const CHUNK_SIZE = 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
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

test('restart converges after session unlink without exposing partial content', async (t) => {
  let armed = false
  let sessionPath = null
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (!armed || name !== 'unlink' || filePath !== sessionPath) return
      armed = false
      throw new Error('Injected crash after session unlink')
    }
  })
  const root = await createTempDir(t)
  const created = await createStore(t, { root, storage })
  const upload = makeUpload(OWNER, { name: 'restart.bin' })
  const session = await verify(created.store, OWNER, upload)
  const id = hex(upload.offer.transferId)
  sessionPath = path.join(created.layout.sessions, `${id}.json`)
  armed = true
  await t.exception(() => new CommitStore({ layout: created.layout, storage }).commit(session))
  await created.store.close()

  const restarted = new SessionStore({
    layout: created.layout,
    maxStagingBytes: 8 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  t.teardown(() => restarted.close())
  await restarted.init()
  const commitStore = new CommitStore({ layout: created.layout, storage })
  const recovered = await recoverStorage({
    layout: created.layout,
    sessionStore: restarted,
    commitStore,
    logger: { warn() {} }
  })

  t.is(recovered[0].status, 'COMMITTED')
  t.alike(
    await fs.promises.readFile(path.join(created.layout.root, upload.offer.name)),
    upload.chunk.data
  )
  t.alike(await fs.promises.readdir(created.layout.staging), [])
  t.alike(await fs.promises.readdir(created.layout.sessions), [])
  t.alike(await fs.promises.readdir(created.layout.journals), [])
})
