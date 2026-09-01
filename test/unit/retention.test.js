'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { ERRORS } = require('../../lib/errors')
const { transferId } = require('../../lib/protocol/transfer-id')
const { initLayout } = require('../../lib/storage/layout')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { RetentionManager, DEFAULT_RESUME_TTL } = require('../../lib/storage/retention')
const { createClock } = require('../helpers/clock')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')

const OWNER = b4a.alloc(32, 7)
const CHUNK_SIZE = 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(name, data) {
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest: sha256(data),
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  offer.transferId = transferId({
    clientPublicKey: OWNER,
    name,
    size: offer.size,
    digest: offer.digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: { index: 0, data, digest: sha256(data) }
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

async function createStores(t, { storage, retention = {}, isSessionActive } = {}) {
  const layout = initLayout(await createTempDir(t))
  const clock = createClock()
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    clock,
    storage
  })
  await sessionStore.init()
  const commitStore = new CommitStore({ layout, clock, storage })
  const manager = new RetentionManager({
    layout,
    sessionStore,
    commitStore,
    clock,
    storage,
    isSessionActive,
    ...retention
  })
  t.teardown(() => sessionStore.close())
  return { layout, clock, sessionStore, commitStore, manager }
}

async function commit(t, stores, name, data) {
  const upload = makeUpload(name, data)
  await stores.sessionStore.offer(OWNER, upload.offer)
  await stores.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await stores.sessionStore.finish(upload.offer.transferId)
  const record = await stores.commitStore.commit(
    stores.sessionStore.sessions.get(hex(upload.offer.transferId))
  )
  return { upload, record, finalPath: path.join(stores.layout.root, name) }
}

async function verify(stores, name, data) {
  const upload = makeUpload(name, data)
  await stores.sessionStore.offer(OWNER, upload.offer)
  await stores.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await stores.sessionStore.finish(upload.offer.transferId)
  return {
    upload,
    session: stores.sessionStore.sessions.get(hex(upload.offer.transferId)),
    finalPath: path.join(stores.layout.root, name)
  }
}

test('retention keeps managed commits when no limits are configured', async (t) => {
  const stores = await createStores(t)
  const artifact = await commit(t, stores, 'keep.bin', b4a.from('keep'))

  await stores.manager.run()

  t.is(await pathExists(artifact.finalPath), true)
  t.alike(await stores.commitStore.list(), [artifact.record])
})

test('retention expires commits using their server commit time', async (t) => {
  const stores = await createStores(t, { retention: { maxAge: 1_000 } })
  const artifact = await commit(t, stores, 'old.bin', b4a.from('old'))
  stores.clock.advance(1_000)

  await stores.manager.run()

  t.is(await pathExists(artifact.finalPath), false)
  t.alike(await stores.commitStore.list(), [])
})

test('retention evicts oldest filename first to reserve incoming capacity', async (t) => {
  const stores = await createStores(t, { retention: { maxStorageBytes: 6 } })
  const alpha = await commit(t, stores, 'alpha.bin', b4a.from('aaa'))
  const bravo = await commit(t, stores, 'bravo.bin', b4a.from('bbb'))

  await stores.manager.run({ incomingBytes: 3 })

  t.is(await pathExists(alpha.finalPath), false)
  t.is(await pathExists(bravo.finalPath), true)
})

test('commit reserves retention capacity before final publication', async (t) => {
  const stores = await createStores(t, { retention: { maxStorageBytes: 3 } })
  const existing = await commit(t, stores, 'existing.bin', b4a.from('aaa'))
  const incoming = await verify(stores, 'incoming.bin', b4a.from('bbb'))

  await stores.commitStore.commit(incoming.session, { retentionManager: stores.manager })

  t.is(await pathExists(existing.finalPath), false)
  t.is(await pathExists(incoming.finalPath), true)
})

test('retention removes expired commits before rotating for size', async (t) => {
  const stores = await createStores(t, { retention: { maxAge: 1_000, maxStorageBytes: 6 } })
  const expired = await commit(t, stores, 'expired.bin', b4a.from('aaa'))
  stores.clock.advance(1_000)
  const fresh = await commit(t, stores, 'fresh.bin', b4a.from('bbb'))

  await stores.manager.run({ incomingBytes: 3 })

  t.is(await pathExists(expired.finalPath), false)
  t.is(await pathExists(fresh.finalPath), true)
})

test('retention rejects a too-large incoming commit without evicting', async (t) => {
  const stores = await createStores(t, { retention: { maxStorageBytes: 5 } })
  const existing = await commit(t, stores, 'existing.bin', b4a.from('aaa'))

  await t.exception(() => stores.manager.run({ incomingBytes: 6 }), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_TOO_LARGE
  })

  t.is(await pathExists(existing.finalPath), true)
})

test('retention propagates deletion failure before accepting capacity-dependent commit', async (t) => {
  let failDelete = false
  let protectedPath = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (failDelete && name === 'unlink' && filePath === protectedPath) {
        throw new Error('Injected retention deletion failure')
      }
    }
  })
  const stores = await createStores(t, { storage, retention: { maxStorageBytes: 3 } })
  const existing = await commit(t, stores, 'existing.bin', b4a.from('aaa'))
  protectedPath = existing.finalPath
  failDelete = true

  let caught = null
  try {
    await stores.manager.run({ incomingBytes: 3 })
  } catch (err) {
    caught = err
  }

  t.is(caught.code, ERRORS.CLEANUP_FAILED)
  t.is(caught.cause.message, 'Injected retention deletion failure')
  t.is(await pathExists(existing.finalPath), true)
  t.alike(await stores.commitStore.list(), [existing.record])
})

test('retention preserves unknown files and active staging', async (t) => {
  const stores = await createStores(t, {
    retention: { maxStorageBytes: 0 },
    isSessionActive: () => true
  })
  const unknown = path.join(stores.layout.root, 'operator-note.txt')
  const upload = makeUpload('active.bin', b4a.from('active'))
  await fs.promises.writeFile(unknown, b4a.from('untouched'))
  await stores.sessionStore.offer(OWNER, upload.offer)
  const staging = path.join(stores.layout.staging, `${hex(upload.offer.transferId)}.part`)

  await stores.manager.run()

  t.alike(await fs.promises.readFile(unknown), b4a.from('untouched'))
  t.is(await pathExists(staging), true)
})

test('retention expires only disconnected sessions past the default TTL', async (t) => {
  let activeId = null
  const stores = await createStores(t, {
    isSessionActive: (session) => session.id === activeId
  })
  const inactive = makeUpload('inactive.bin', b4a.from('inactive'))
  const active = makeUpload('active.bin', b4a.from('active'))
  await stores.sessionStore.offer(OWNER, inactive.offer)
  await stores.sessionStore.offer(OWNER, active.offer)
  activeId = hex(active.offer.transferId)
  stores.clock.advance(DEFAULT_RESUME_TTL + 1)

  await stores.manager.expireSessions()

  t.is(stores.sessionStore.sessions.has(hex(inactive.offer.transferId)), false)
  t.is(stores.sessionStore.sessions.has(activeId), true)
})

test('retention validates numeric limits and durations', async (t) => {
  const stores = await createStores(t)

  await t.exception(
    () =>
      Promise.resolve(
        new RetentionManager({
          layout: stores.layout,
          sessionStore: stores.sessionStore,
          commitStore: stores.commitStore,
          maxAge: -1
        })
      ),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
  await t.exception(
    () =>
      Promise.resolve(
        new RetentionManager({
          layout: stores.layout,
          sessionStore: stores.sessionStore,
          commitStore: stores.commitStore,
          maxStorageBytes: Number.MAX_SAFE_INTEGER + 1
        })
      ),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
  await t.exception(
    () =>
      Promise.resolve(
        new RetentionManager({
          layout: stores.layout,
          sessionStore: stores.sessionStore,
          commitStore: stores.commitStore,
          resumeTtl: 0
        })
      ),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
})

test('retention rejects a managed record that disappears during enumeration', async (t) => {
  let removeRecord = false
  let recordPath = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (!removeRecord || name !== 'lstat' || filePath !== recordPath) return
      removeRecord = false
      await fs.promises.unlink(recordPath)
    }
  })
  const stores = await createStores(t, { storage })
  const artifact = await commit(t, stores, 'managed.bin', b4a.from('managed'))
  recordPath = path.join(stores.layout.commits, `${artifact.record.transferId}.json`)
  removeRecord = true

  await t.exception(() => stores.manager.run(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})
