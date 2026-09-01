'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../../lib/errors')
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

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function createScheduler() {
  const timers = new Set()
  let installs = 0
  return {
    setInterval(callback) {
      const timer = { callback }
      timers.add(timer)
      installs++
      return timer
    },
    clearInterval(timer) {
      timers.delete(timer)
    },
    tick() {
      for (const timer of timers) timer.callback()
    },
    get installs() {
      return installs
    },
    get size() {
      return timers.size
    }
  }
}

async function createStores(
  t,
  { storage, retention = {}, isSessionActive = () => false, logger } = {}
) {
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
    logger,
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

test('commits serialize different names through capacity reservation', async (t) => {
  let alphaFinal = null
  let bravoFinal = null
  let alphaLinked = false
  let bravoLinked = false
  let alphaRemovedBeforeBravo = false
  const alphaAtPublication = deferred()
  const allowAlphaPublication = deferred()
  const storage = createStorage({
    async beforeOperation(name, source, destination) {
      if (name === 'unlink' && source === alphaFinal && !bravoLinked) {
        alphaRemovedBeforeBravo = true
      }
      if (name !== 'link' || destination !== alphaFinal || alphaLinked) return
      alphaLinked = true
      alphaAtPublication.resolve()
      await allowAlphaPublication.promise
    },
    async afterOperation(name, source, destination) {
      if (name === 'link' && destination === bravoFinal) bravoLinked = true
    }
  })
  const stores = await createStores(t, { storage, retention: { maxStorageBytes: 5 } })
  const alpha = await verify(stores, 'alpha.bin', b4a.from('aaa'))
  const bravo = await verify(stores, 'bravo.bin', b4a.from('bbb'))
  alphaFinal = alpha.finalPath
  bravoFinal = bravo.finalPath

  const first = stores.commitStore.commit(alpha.session, { retentionManager: stores.manager })
  await alphaAtPublication.promise
  const second = stores.commitStore.commit(bravo.session, { retentionManager: stores.manager })
  allowAlphaPublication.resolve()
  await Promise.all([first, second])

  t.is(alphaRemovedBeforeBravo, true)
  t.is(await pathExists(alpha.finalPath), false)
  t.is(await pathExists(bravo.finalPath), true)
})

test('commit validates corrupt staging before retention evicts managed commits', async (t) => {
  const stores = await createStores(t, { retention: { maxStorageBytes: 3 } })
  const existing = await commit(t, stores, 'existing.bin', b4a.from('aaa'))
  const incoming = await verify(stores, 'incoming.bin', b4a.from('bbb'))
  await fs.promises.writeFile(
    path.join(stores.layout.staging, `${hex(incoming.upload.offer.transferId)}.part`),
    b4a.from('bad')
  )

  await t.exception(
    () => stores.commitStore.commit(incoming.session, { retentionManager: stores.manager }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.CHECKSUM_MISMATCH
    }
  )

  t.is(await pathExists(existing.finalPath), true)
  t.alike(await stores.commitStore.list(), [existing.record])
})

test('commit succeeds when post-commit cleanup fails and retries cleanup later', async (t) => {
  const cleanupFailure = new Error('Injected post-commit cleanup failure')
  let firstFinal = null
  let secondFinal = null
  let advanceAfterPublication = false
  let failCleanup = false
  const errors = []
  let stores = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (failCleanup && name === 'unlink' && filePath === firstFinal) throw cleanupFailure
    },
    async afterOperation(name, source, destination) {
      if (!advanceAfterPublication || name !== 'link' || destination !== secondFinal) return
      advanceAfterPublication = false
      stores.clock.advance(11)
    }
  })
  stores = await createStores(t, {
    storage,
    retention: { maxAge: 10, maxStorageBytes: 9 },
    logger: {
      error(message, details) {
        errors.push({ message, details })
      }
    }
  })
  const first = await commit(t, stores, 'first.bin', b4a.from('one'))
  firstFinal = first.finalPath
  const incoming = await verify(stores, 'second.bin', b4a.from('two'))
  secondFinal = incoming.finalPath
  advanceAfterPublication = true
  failCleanup = true

  const record = await stores.commitStore.commit(incoming.session, {
    retentionManager: stores.manager
  })

  t.is(record.name, 'second.bin')
  t.is(await pathExists(first.finalPath), true)
  t.is(await pathExists(incoming.finalPath), true)
  t.is(stores.manager.cleanupFailure.code, ERRORS.CLEANUP_FAILED)
  t.alike(errors, [
    {
      message: 'Post-commit retention failed',
      details: { message: 'Unable to remove managed commit' }
    }
  ])

  await t.exception(() => stores.manager.run({ incomingBytes: 3 }), {
    name: 'SwarmDeployError',
    code: ERRORS.CLEANUP_FAILED
  })
  failCleanup = false
  await stores.manager.run({ incomingBytes: 3 })

  t.is(stores.manager.cleanupFailure, null)
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

test('retention admission is non-destructive and blocks unhealthy capacity', async (t) => {
  const stores = await createStores(t, { retention: { maxStorageBytes: 3 } })
  const existing = await commit(t, stores, 'existing.bin', b4a.from('aaa'))

  t.is(await stores.manager.admit(3), true)
  t.is(await pathExists(existing.finalPath), true)
  await t.exception(() => stores.manager.admit(4), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_TOO_LARGE
  })

  stores.manager.cleanupFailure = new SwarmDeployError(
    ERRORS.CLEANUP_FAILED,
    'pending scheduled cleanup'
  )
  await t.exception(() => stores.manager.admit(1), {
    name: 'SwarmDeployError',
    code: ERRORS.CLEANUP_FAILED
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

test('scheduled age retention defers until a receiving upload finishes', async (t) => {
  const scheduler = createScheduler()
  let activeId = null
  const stores = await createStores(t, {
    retention: { maxAge: 10, scheduler },
    isSessionActive: (session) => session.id === activeId
  })
  t.teardown(() => stores.manager.stop())
  await stores.manager.start()
  const existing = await commit(t, stores, 'age-deferred.bin', b4a.from('old'))
  const active = makeUpload('receiving-age.bin', b4a.from('new'))
  await stores.sessionStore.offer(OWNER, active.offer)
  activeId = hex(active.offer.transferId)
  stores.clock.advance(10)

  scheduler.tick()
  await stores.manager.tickPromise
  t.is(await pathExists(existing.finalPath), true)

  await stores.sessionStore.writeChunk(active.offer.transferId, active.chunk)
  await stores.sessionStore.finish(active.offer.transferId)
  scheduler.tick()
  await stores.manager.tickPromise
  t.is(await pathExists(existing.finalPath), false)
})

test('scheduled quota retention defers until a receiving upload finishes', async (t) => {
  const scheduler = createScheduler()
  let activeId = null
  const stores = await createStores(t, {
    retention: { maxStorageBytes: 2, scheduler },
    isSessionActive: (session) => session.id === activeId
  })
  t.teardown(() => stores.manager.stop())
  await stores.manager.start()
  const existing = await commit(t, stores, 'quota-deferred.bin', b4a.from('old'))
  const active = makeUpload('receiving-quota.bin', b4a.from('new'))
  await stores.sessionStore.offer(OWNER, active.offer)
  activeId = hex(active.offer.transferId)

  scheduler.tick()
  await stores.manager.tickPromise
  t.is(await pathExists(existing.finalPath), true)

  await stores.sessionStore.writeChunk(active.offer.transferId, active.chunk)
  await stores.sessionStore.finish(active.offer.transferId)
  scheduler.tick()
  await stores.manager.tickPromise
  t.is(await pathExists(existing.finalPath), false)
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
  stores.clock.advance(DEFAULT_RESUME_TTL)

  await stores.manager.expireSessions()

  t.is(stores.sessionStore.sessions.has(hex(inactive.offer.transferId)), true)
  t.is(stores.sessionStore.sessions.has(activeId), true)
  stores.clock.advance(1)
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
          maxAge: -1,
          isSessionActive: () => false
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
          maxStorageBytes: Number.MAX_SAFE_INTEGER + 1,
          isSessionActive: () => false
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
          resumeTtl: 0,
          isSessionActive: () => false
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
          cleanupInterval: 2 ** 31,
          isSessionActive: () => false
        })
      ),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
})

test('retention requires an explicit session activity predicate', async (t) => {
  const stores = await createStores(t)

  await t.exception(
    () =>
      Promise.resolve(
        new RetentionManager({
          layout: stores.layout,
          sessionStore: stores.sessionStore,
          commitStore: stores.commitStore
        })
      ),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
})

test('retention serializes overlapping scheduled and manual runs', async (t) => {
  let stores = null
  let hold = false
  let running = 0
  let maximumRunning = 0
  let calls = 0
  const entered = deferred()
  const release = deferred()
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (!stores || !hold || name !== 'readdir' || filePath !== stores.layout.commits) return
      calls++
      running++
      maximumRunning = Math.max(maximumRunning, running)
      if (calls === 1) entered.resolve()
      await release.promise
      running--
    }
  })
  stores = await createStores(t, { storage, retention: { cleanupInterval: 1 } })
  t.teardown(() => stores.manager.stop())
  await stores.manager.start()
  hold = true
  const manual = stores.manager.run()
  await entered.promise
  await delay(20)

  t.is(maximumRunning, 1)
  release.resolve()
  await manual
  await delay(20)
  stores.manager.stop()

  t.ok(calls >= 2)
  t.is(maximumRunning, 1)
})

test('retention start shares startup, coalesces ticks, and stops safely', async (t) => {
  const scheduler = createScheduler()
  let stores = null
  let hold = true
  const entered = deferred()
  const release = deferred()
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (!stores || !hold || name !== 'readdir' || filePath !== stores.layout.commits) return
      entered.resolve()
      await release.promise
    }
  })
  stores = await createStores(t, { storage, retention: { scheduler } })
  const first = stores.manager.start()
  const second = stores.manager.start()
  t.is(first, second)
  await entered.promise
  const stopping = stores.manager.stop()
  release.resolve()
  await Promise.all([first, second, stopping])
  t.is(scheduler.size, 0)

  hold = false
  await stores.manager.start()
  t.is(scheduler.installs, 1)
  scheduler.tick()
  scheduler.tick()
  scheduler.tick()
  await stores.manager.stop()
  t.is(scheduler.size, 0)

  await stores.manager.start()
  t.is(scheduler.installs, 2)
  await stores.manager.stop()
})

test('throwing retention loggers do not escape cleanup handling', async (t) => {
  const stores = await createStores(t, {
    logger: {
      warn() {
        throw new Error('logger failure')
      },
      error() {
        throw new Error('logger failure')
      }
    }
  })
  await fs.promises.writeFile(path.join(stores.layout.root, 'unknown.txt'), b4a.from('unknown'))

  await stores.manager.run()

  t.is(await pathExists(path.join(stores.layout.root, 'unknown.txt')), true)
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
