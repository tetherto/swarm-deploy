'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { ERRORS } = require('../../lib/errors')
const { transferId } = require('../../lib/protocol/transfer-id')
const { initLayout, acquireStorageLock } = require('../../lib/storage/layout')
const { writeAtomic, readJson } = require('../../lib/storage/atomic-file')
const { SessionStore } = require('../../lib/storage/session-store')
const { createTempDir } = require('../helpers/files')
const { createClock } = require('../helpers/clock')
const { createStorage } = require('../helpers/storage')

const OWNER = b4a.alloc(32, 7)
const OTHER_OWNER = b4a.alloc(32, 8)
const MAX_SESSION_METADATA_BYTES = 32 * 1024 * 1024

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function transferHex(offer) {
  return b4a.toString(offer.transferId, 'hex')
}

function stagingPath(layout, offer) {
  return path.join(layout.staging, `${transferHex(offer)}.part`)
}

function sessionPath(layout, offer) {
  return path.join(layout.sessions, `${transferHex(offer)}.json`)
}

function makeUpload(
  owner = OWNER,
  { name = 'artifact.bin', data = b4a.from('abcdefghijk'), chunkSize = 1024 * 1024 } = {}
) {
  const chunks = []
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.byteLength)))
  }

  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest: digest(data),
    chunkSize,
    chunkCount: chunks.length
  }
  offer.transferId = transferId({
    clientPublicKey: owner,
    name: offer.name,
    size: offer.size,
    digest: offer.digest,
    chunkSize: offer.chunkSize
  })

  return {
    offer,
    chunks: chunks.map((data, index) => ({ index, data, digest: digest(data) }))
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

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function lockOwner(layout) {
  return JSON.parse(await fs.promises.readFile(path.join(layout.lock, 'owner.json'), 'utf8'))
}

function retiredLockPath(layout, token) {
  return `${layout.lock}.retired-${token}`
}

async function createStore(t, options = {}) {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const clock = options.clock ?? createClock()
  const store = new SessionStore({
    layout,
    maxStagingBytes: options.maxStagingBytes ?? 4 * 1024 * 1024,
    clock,
    checkpointChunks: options.checkpointChunks ?? 16,
    storage: options.storage
  })
  await store.init()
  t.teardown(() => store.close())
  return { root, layout, clock, store }
}

test('layout creates absolute protected internal paths', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)

  t.is(layout.root, path.resolve(root))
  t.is(layout.internal, path.join(root, '.swarm-deploy'))
  for (const directory of [layout.staging, layout.sessions, layout.commits, layout.journals]) {
    const stat = await fs.promises.lstat(directory)
    t.ok(stat.isDirectory())
    t.absent(stat.isSymbolicLink())
  }
  t.is(layout.lock, path.join(layout.internal, 'lock'))
})

test('layout rejects symlinked internal directories', async (t) => {
  const root = await createTempDir(t)
  const outside = await createTempDir(t)
  const internal = path.join(root, '.swarm-deploy')
  await fs.promises.mkdir(internal)
  await fs.promises.symlink(outside, path.join(internal, 'staging'))

  t.exception(() => initLayout(root), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('atomic metadata writes replace regular files and reject symlinks', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const metadata = path.join(layout.sessions, 'atom.json')
  await writeAtomic(metadata, b4a.from('{"generation":1}'))
  await writeAtomic(metadata, b4a.from('{"generation":2}'))
  t.alike(await readJson(metadata), { generation: 2 })

  const outside = path.join(root, 'outside.json')
  await fs.promises.writeFile(outside, '{"outside":true}')
  await fs.promises.unlink(metadata)
  await fs.promises.symlink(outside, metadata)
  await t.exception(() => writeAtomic(metadata, b4a.from('{"unsafe":true}')), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await readJson(outside), { outside: true })
})

test('metadata reads fail closed when the final component changes to a symlink', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const metadata = path.join(layout.sessions, 'atom.json')
  const outside = path.join(root, 'outside.json')
  await fs.promises.writeFile(metadata, '{"inside":true}')
  await fs.promises.writeFile(outside, '{"outside":true}')

  let replaced = false
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (replaced || name !== 'open' || filePath !== metadata) return
      replaced = true
      await fs.promises.unlink(metadata)
      await fs.promises.symlink(outside, metadata)
    }
  })

  await t.exception(() => readJson(metadata, storage), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.ok(replaced)
  t.ok((await fs.promises.lstat(metadata)).isSymbolicLink())
  t.alike(await readJson(outside), { outside: true })
})

test('atomic metadata writes reject protected session-parent replacement', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const metadata = path.join(layout.sessions, 'atom.json')
  let replaced = false
  const retired = `${layout.sessions}.retired`
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (replaced || name !== 'lstat' || filePath !== layout.sessions) return
      replaced = true
      await fs.promises.rename(layout.sessions, retired)
      await fs.promises.mkdir(layout.sessions, { mode: 0o700 })
    }
  })

  await t.exception(() => writeAtomic(metadata, b4a.from('{"generation":1}'), storage), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.ok(replaced)
  t.is(await pathExists(metadata), false)
})

test('metadata descriptors close after read, write, and sync failures', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const metadata = path.join(layout.sessions, 'atom.json')
  await fs.promises.writeFile(metadata, '{"inside":true}')
  let mode = 'read'
  const events = []
  const storage = createStorage({
    failWriteFor: (filePath) => mode === 'write' && filePath.endsWith('.tmp'),
    failSyncFor: (filePath) => mode === 'sync' && filePath.endsWith('.tmp'),
    async beforeOperation(name) {
      if (mode === 'read' && name === 'read') throw new Error('Injected read failure')
    },
    async afterOperation(name, filePath) {
      if (name === 'open' || name === 'close') events.push(`${name}:${filePath}`)
    }
  })

  await t.exception(() => readJson(metadata, storage))
  t.alike(events, [`open:${metadata}`, `close:${metadata}`])

  mode = 'write'
  events.length = 0
  await t.exception(() =>
    writeAtomic(path.join(layout.sessions, 'write.json'), b4a.from('{}'), storage)
  )
  t.is(events.filter((event) => event.startsWith('open:')).length, 1)
  t.is(events.filter((event) => event.startsWith('close:')).length, 1)

  mode = 'sync'
  events.length = 0
  await t.exception(() =>
    writeAtomic(path.join(layout.sessions, 'sync.json'), b4a.from('{}'), storage)
  )
  t.is(events.filter((event) => event.startsWith('open:')).length, 1)
  t.is(events.filter((event) => event.startsWith('close:')).length, 1)
})

test('metadata reads reject sparse session-sized files before allocating or reading', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const metadata = path.join(layout.sessions, 'oversized.json')
  const handle = await fs.promises.open(metadata, 'w')
  await handle.truncate(MAX_SESSION_METADATA_BYTES + 1)
  await handle.close()

  let readAttempted = false
  const storage = createStorage({
    async beforeOperation(name) {
      if (name === 'read') readAttempted = true
    }
  })
  await t.exception(() => readJson(metadata, storage), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is(readAttempted, false)
})

test('storage lock rejects a live owner', async (t) => {
  const root = await createTempDir(t)
  const release = await acquireStorageLock(initLayout(root), {
    pid: 101,
    isProcessAlive: (pid) => pid === 101
  })
  t.teardown(() => release())

  await t.exception(
    () =>
      acquireStorageLock(initLayout(root), {
        pid: 102,
        isProcessAlive: (pid) => pid === 101
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.FILE_BUSY
    }
  )
})

test('default process liveness rejects a second storage owner', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const release = await acquireStorageLock(layout)
  t.teardown(() => release())

  await t.exception(() => acquireStorageLock(layout), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_BUSY
  })
})

test('storage lock publishes only after syncing its complete candidate', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const events = []
  const storage = createStorage({
    afterOperation(name, source, destination) {
      if (name === 'sync') events.push(`sync:${source}`)
      if (name === 'rename') events.push(`rename:${source}->${destination}`)
    }
  })
  const release = await acquireStorageLock(layout, {
    pid: 111,
    isProcessAlive: () => false,
    storage
  })
  t.teardown(() => release())

  const owner = await lockOwner(layout)
  const candidate = `${layout.lock}.candidate-${owner.token}`
  t.alike(owner, {
    pid: 111,
    startedAt: owner.startedAt,
    token: owner.token
  })
  t.ok(Number.isSafeInteger(owner.startedAt))
  t.ok(/^[0-9a-f]{64}$/.test(owner.token))
  t.alike(events, [
    `sync:${path.join(candidate, 'owner.json')}`,
    `sync:${candidate}`,
    `sync:${layout.internal}`,
    `rename:${candidate}->${layout.lock}`,
    `sync:${layout.internal}`
  ])
})

test('stale lock recovery preserves its tombstone and newer owner', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const releaseOld = await acquireStorageLock(layout, {
    pid: 201,
    isProcessAlive: () => false
  })
  const oldOwner = await lockOwner(layout)
  const releaseNew = await acquireStorageLock(layout, {
    pid: 202,
    isProcessAlive: (pid) => pid === 202
  })
  t.teardown(() => releaseNew())

  t.is((await lockOwner(layout)).pid, 202)
  const tombstone = retiredLockPath(layout, oldOwner.token)
  const tombstoneExists = await pathExists(tombstone)
  t.ok(tombstoneExists)
  if (tombstoneExists) t.alike(await lockOwner({ lock: tombstone }), oldOwner)

  await releaseOld()
  t.is((await lockOwner(layout)).pid, 202)
  await t.exception(
    () =>
      acquireStorageLock(layout, {
        pid: 203,
        isProcessAlive: (pid) => pid === 202
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.FILE_BUSY
    }
  )
})

test("stale-lock contenders cannot retire the winner's new lock", async (t) => {
  const layout = initLayout(await createTempDir(t))
  const releaseStale = await acquireStorageLock(layout, {
    pid: 301,
    isProcessAlive: () => false
  })
  const bothObserved = createDeferred()
  const allowSecondRetirement = createDeferred()
  let observations = 0
  let secondRetirementBlocked = false
  let releaseWinner = null
  let releaseLoser = null
  t.teardown(async () => {
    if (releaseLoser) await releaseLoser()
    if (releaseWinner) await releaseWinner()
    await releaseStale()
  })

  async function observeFixedOwner(name, filePath) {
    if (
      (name !== 'readFile' && name !== 'open') ||
      filePath !== path.join(layout.lock, 'owner.json')
    ) {
      return
    }
    observations++
    if (observations === 2) bothObserved.resolve()
    if (observations <= 2) await bothObserved.promise
  }

  const winnerStorage = createStorage({ afterOperation: observeFixedOwner })
  const loserStorage = createStorage({
    afterOperation: observeFixedOwner,
    async beforeOperation(name, source) {
      if (name !== 'rename' || source !== layout.lock || secondRetirementBlocked) return
      secondRetirementBlocked = true
      await allowSecondRetirement.promise
    }
  })

  const winner = acquireStorageLock(layout, {
    pid: 302,
    isProcessAlive: (pid) => pid === 302,
    storage: winnerStorage
  })
  const loser = acquireStorageLock(layout, {
    pid: 303,
    isProcessAlive: (pid) => pid === 302,
    storage: loserStorage
  })

  releaseWinner = await winner
  t.ok(secondRetirementBlocked)
  allowSecondRetirement.resolve()
  await t.exception(
    async () => {
      releaseLoser = await loser
    },
    {
      name: 'SwarmDeployError',
      code: ERRORS.FILE_BUSY
    }
  )
  t.is((await lockOwner(layout)).pid, 302)
})

test('delayed release cannot retire a newer lock', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const releaseBlocked = createDeferred()
  const allowRelease = createDeferred()
  let blocked = false
  const oldStorage = createStorage({
    async beforeOperation(name, source) {
      if (name !== 'rename' || source !== layout.lock || blocked) return
      blocked = true
      releaseBlocked.resolve()
      await allowRelease.promise
    }
  })
  const releaseOld = await acquireStorageLock(layout, {
    pid: 401,
    isProcessAlive: () => false,
    storage: oldStorage
  })
  const oldOwner = await lockOwner(layout)

  const delayedRelease = releaseOld()
  await releaseBlocked.promise
  const releaseNew = await acquireStorageLock(layout, {
    pid: 402,
    isProcessAlive: (pid) => pid === 402
  })
  let releaseThird = null
  t.teardown(async () => {
    if (releaseThird) await releaseThird()
    await releaseNew()
  })

  allowRelease.resolve()
  await delayedRelease
  const lockStillExists = await pathExists(layout.lock)
  t.ok(lockStillExists)
  if (lockStillExists) t.is((await lockOwner(layout)).pid, 402)
  const tombstone = retiredLockPath(layout, oldOwner.token)
  const tombstoneExists = await pathExists(tombstone)
  t.ok(tombstoneExists)
  if (tombstoneExists) t.alike(await lockOwner({ lock: tombstone }), oldOwner)
  await t.exception(
    async () => {
      releaseThird = await acquireStorageLock(layout, {
        pid: 403,
        isProcessAlive: (pid) => pid === 402
      })
    },
    {
      name: 'SwarmDeployError',
      code: ERRORS.FILE_BUSY
    }
  )
})

test('storage lock rejects malformed owner state without replacing it', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const ownerPath = path.join(layout.lock, 'owner.json')
  await fs.promises.mkdir(layout.lock)
  await fs.promises.writeFile(ownerPath, '{not-json')

  await t.exception(
    () =>
      acquireStorageLock(layout, {
        pid: 501,
        isProcessAlive: () => false
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  t.is(await fs.promises.readFile(ownerPath, 'utf8'), '{not-json')
})

test('storage lock rejects a symlink owner state without replacing it', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  const outsideOwner = path.join(outside, 'owner.json')
  await fs.promises.writeFile(
    outsideOwner,
    JSON.stringify({ pid: 601, startedAt: 1, token: 'a'.repeat(64) })
  )
  await fs.promises.mkdir(layout.lock)
  const ownerPath = path.join(layout.lock, 'owner.json')
  await fs.promises.symlink(outsideOwner, ownerPath)

  await t.exception(
    () =>
      acquireStorageLock(layout, {
        pid: 602,
        isProcessAlive: () => false
      }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  t.ok((await fs.promises.lstat(ownerPath)).isSymbolicLink())
  t.is((await lockOwner({ lock: outside })).pid, 601)
})

test('offer reserves its complete logical size without double-reserving resumes', async (t) => {
  const { store } = await createStore(t)
  const upload = makeUpload()

  const first = await store.offer(OWNER, upload.offer)
  t.is(first.state, 'receiving')
  t.is(store.reservedBytes, upload.offer.size)

  const resumed = await store.offer(OWNER, upload.offer)
  t.ok(resumed.resumed)
  t.is(store.reservedBytes, upload.offer.size)
})

test('offer rejects a symlinked transfer-derived staging path', async (t) => {
  const { layout, root, store } = await createStore(t)
  const upload = makeUpload()
  const outside = path.join(root, 'outside.part')
  await fs.promises.writeFile(outside, 'safe')
  await fs.promises.symlink(outside, stagingPath(layout, upload.offer))

  await t.exception(() => store.offer(OWNER, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readFile(outside), b4a.from('safe'))
})

test('offer rejects protected staging-parent replacement', async (t) => {
  let replaced = false
  let layout
  let upload
  let retired
  const events = []
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (replaced || name !== 'open' || filePath !== stagingPath(layout, upload.offer)) return
      replaced = true
      await fs.promises.rename(layout.staging, retired)
      await fs.promises.mkdir(layout.staging, { mode: 0o700 })
    },
    async afterOperation(name, filePath) {
      if (!layout || !upload) return
      if (filePath === stagingPath(layout, upload.offer) && (name === 'open' || name === 'close')) {
        events.push(`${name}:${filePath}`)
      }
    }
  })
  const created = await createStore(t, { storage })
  layout = created.layout
  upload = makeUpload()
  retired = `${layout.staging}.retired`

  await t.exception(() => created.store.offer(OWNER, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.ok(replaced)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.alike(events, [
    `open:${stagingPath(layout, upload.offer)}`,
    `close:${stagingPath(layout, upload.offer)}`
  ])
})

test('staging opens require regular no-follow descriptors', async (t) => {
  const opened = []
  let stagingStats = 0
  let layout
  let upload
  const storage = createStorage({
    async afterOperation(name, filePath, flags) {
      if (!layout || !upload) return
      if (filePath !== stagingPath(layout, upload.offer)) return
      if (name === 'open') opened.push(flags)
      if (name === 'stat') stagingStats++
    }
  })
  const created = await createStore(t, { storage, checkpointChunks: 1 })
  layout = created.layout
  upload = makeUpload()

  await created.store.offer(OWNER, upload.offer)
  await created.store.writeChunk(upload.offer.transferId, upload.chunks[0])

  t.is(opened.length, 3)
  t.is(stagingStats, 3)
  for (const flags of opened) t.ok(Number.isSafeInteger(flags))
})

test('offer rejects capacity, final destinations, and conflicting session names', async (t) => {
  const { root, store } = await createStore(t, { maxStagingBytes: 12 })
  const first = makeUpload()
  const second = makeUpload(OTHER_OWNER, { name: 'other.bin' })
  await store.offer(OWNER, first.offer)

  await t.exception(() => store.offer(OTHER_OWNER, second.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.STAGING_LIMIT
  })

  const conflict = makeUpload(OTHER_OWNER, { data: b4a.from('different'), name: first.offer.name })
  await t.exception(() => store.offer(OTHER_OWNER, conflict.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_BUSY
  })

  const existing = makeUpload(OTHER_OWNER, { name: 'existing.bin' })
  await fs.promises.writeFile(path.join(root, existing.offer.name), 'already here')
  await t.exception(() => store.offer(OTHER_OWNER, existing.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
})

test('offer rejects noncanonical IDs and chunk counts', async (t) => {
  const { store } = await createStore(t)
  const upload = makeUpload()

  await t.exception(() => store.offer(OWNER, { ...upload.offer, transferId: b4a.alloc(32) }), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(
    () => store.offer(OWNER, { ...upload.offer, chunkCount: upload.offer.chunkCount + 1 }),
    {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    }
  )
})

test('offer requires 1 MiB chunks and caps chunk count before allocation', async (t) => {
  const { store } = await createStore(t, { maxStagingBytes: Number.MAX_SAFE_INTEGER })
  const legacy = makeUpload(OWNER, { chunkSize: 4 })
  await t.exception(() => store.offer(OWNER, legacy.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })

  const count = 262_145
  const offer = {
    version: 1,
    name: 'oversized.bin',
    size: count * 1024 * 1024,
    digest: b4a.alloc(32),
    chunkSize: 1024 * 1024,
    chunkCount: count
  }
  offer.transferId = transferId({ clientPublicKey: OWNER, ...offer })
  await t.exception(() => store.offer(OWNER, offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('writeChunk writes exact offsets, verifies digests, and checkpoints metadata', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload(OWNER, { data: b4a.concat([b4a.alloc(1024 * 1024), b4a.from('efgh')]) })
  await store.offer(OWNER, upload.offer)

  const result = await store.writeChunk(upload.offer.transferId, upload.chunks[1])
  t.ok(result.verified.has(1))
  t.alike(
    await fs.promises.readFile(stagingPath(layout, upload.offer)),
    b4a.concat([b4a.alloc(1024 * 1024), b4a.from('efgh')])
  )

  const before = await readJson(sessionPath(layout, upload.offer))
  t.is(before.bitmap, 'AA==')
  await store.checkpoint(upload.offer.transferId)
  const persisted = await readJson(sessionPath(layout, upload.offer))
  t.is(persisted.bitmap, 'Ag==')
  t.is(persisted.chunkDigests[1], b4a.toString(upload.chunks[1].digest, 'hex'))
})

test('offer syncs durable staging before publishing its session metadata', async (t) => {
  const events = []
  const storage = createStorage({
    async afterOperation(name, source, destination) {
      if (name === 'sync' || name === 'rename')
        events.push(`${name}:${source}->${destination ?? ''}`)
    }
  })
  const { layout, store } = await createStore(t, { storage })
  const upload = makeUpload()

  await store.offer(OWNER, upload.offer)

  const stagingSync = `sync:${layout.staging}->`
  const stagingSyncAt = events.indexOf(stagingSync)
  const sessionRenameAt = events.findIndex((event) =>
    event.endsWith(`->${sessionPath(layout, upload.offer)}`)
  )
  t.ok(stagingSyncAt >= 0)
  t.ok(sessionRenameAt > stagingSyncAt)
})

test('offer cleans and syncs staging after its parent sync fails', async (t) => {
  let failNextStagingSync = false
  let layout
  const events = []
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failNextStagingSync || filePath !== layout.staging) return false
      failNextStagingSync = false
      return true
    },
    async beforeOperation(name, filePath) {
      if (name === 'sync' && filePath === layout.staging) events.push(`sync-attempt:${filePath}`)
    },
    async afterOperation(name, filePath) {
      if (
        (name === 'sync' && filePath === layout.staging) ||
        (name === 'unlink' && filePath === stagingPath(layout, upload.offer))
      ) {
        events.push(`${name}:${filePath}`)
      }
    }
  })
  const created = await createStore(t, { storage })
  layout = created.layout
  const upload = makeUpload()

  failNextStagingSync = true
  await t.exception(() => created.store.offer(OWNER, upload.offer))
  t.alike(events, [
    `sync-attempt:${layout.staging}`,
    `unlink:${stagingPath(layout, upload.offer)}`,
    `sync-attempt:${layout.staging}`,
    `sync:${layout.staging}`
  ])
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)

  if (await pathExists(stagingPath(layout, upload.offer))) {
    await fs.promises.unlink(stagingPath(layout, upload.offer))
  } else {
    await created.store.offer(OWNER, upload.offer)
    await created.store.close()
    const reopened = new SessionStore({ layout, maxStagingBytes: 1024, storage })
    await reopened.init()
    t.teardown(() => reopened.close())
    t.ok((await reopened.offer(OWNER, upload.offer)).resumed)
  }
})

test('offer removes staging after metadata fails before rename', async (t) => {
  let failMetadataWrite = false
  const events = []
  const storage = createStorage({
    failWriteFor: (filePath) => failMetadataWrite && filePath.includes('.json.'),
    async afterOperation(name, filePath) {
      if (
        (name === 'sync' &&
          (filePath === layout.staging || filePath === stagingPath(layout, upload.offer))) ||
        (name === 'unlink' && filePath === stagingPath(layout, upload.offer))
      ) {
        events.push(`${name}:${filePath}`)
      }
    }
  })
  const { layout, store } = await createStore(t, { storage })
  const upload = makeUpload()
  events.length = 0

  failMetadataWrite = true
  await t.exception(() => store.offer(OWNER, upload.offer))
  t.alike(events, [
    `sync:${stagingPath(layout, upload.offer)}`,
    `sync:${layout.staging}`,
    `unlink:${stagingPath(layout, upload.offer)}`,
    `sync:${layout.staging}`
  ])
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(store.reservedBytes, 0)

  failMetadataWrite = false
  await store.offer(OWNER, upload.offer)
  await store.close()
  const reopened = new SessionStore({ layout, maxStagingBytes: 1024, storage })
  await reopened.init()
  t.teardown(() => reopened.close())
  t.ok((await reopened.offer(OWNER, upload.offer)).resumed)
})

test('offer preserves renamed metadata after its parent sync fails', async (t) => {
  let failNextSessionSync = false
  let layout
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failNextSessionSync || filePath !== layout.sessions) return false
      failNextSessionSync = false
      return true
    }
  })
  const created = await createStore(t, { storage })
  layout = created.layout
  const upload = makeUpload()

  failNextSessionSync = true
  await t.exception(() => created.store.offer(OWNER, upload.offer))
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(sessionPath(layout, upload.offer)), true)
  t.is(created.store.reservedBytes, upload.offer.size)
  t.ok((await created.store.offer(OWNER, upload.offer)).resumed)

  await created.store.close()
  const reopened = new SessionStore({ layout, maxStagingBytes: 1024, storage })
  await reopened.init()
  t.teardown(() => reopened.close())
  t.ok((await reopened.offer(OWNER, upload.offer)).resumed)
})

test('offer preserves primary and cleanup failures', async (t) => {
  let failStagingParentSync = false
  let layout
  const storage = createStorage({
    failSyncFor: (filePath) => failStagingParentSync && filePath === layout.staging
  })
  const created = await createStore(t, { storage })
  layout = created.layout
  const upload = makeUpload()

  failStagingParentSync = true
  let failure = null
  try {
    await created.store.offer(OWNER, upload.offer)
  } catch (err) {
    failure = err
  }
  t.is(failure?.name, 'SwarmDeployError')
  t.is(failure?.code, ERRORS.PROTOCOL_INVALID)
  t.ok(failure?.cause)
  t.ok(failure?.cleanupCause)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
})

test('deletion durably removes metadata before its staging name', async (t) => {
  const events = []
  const storage = createStorage({
    async afterOperation(name, source) {
      if (name === 'unlink' || name === 'sync') events.push(`${name}:${source}`)
    }
  })
  const { layout, store } = await createStore(t, { storage })
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  events.length = 0

  await store.delete(upload.offer.transferId)

  t.alike(events, [
    `unlink:${sessionPath(layout, upload.offer)}`,
    `sync:${layout.sessions}`,
    `unlink:${stagingPath(layout, upload.offer)}`,
    `sync:${layout.staging}`
  ])
})

test('chunks require exact lengths and failed writes never become verified', async (t) => {
  const storage = createStorage({ failWriteFor: (filePath) => filePath.endsWith('.part') })
  const { layout, store } = await createStore(t, { storage })
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)

  await t.exception(
    () => store.writeChunk(upload.offer.transferId, { ...upload.chunks[0], data: b4a.from('xx') }),
    { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID }
  )
  await t.exception(() => store.writeChunk(upload.offer.transferId, upload.chunks[0]))

  await store.checkpoint(upload.offer.transferId)
  const persisted = await readJson(sessionPath(layout, upload.offer))
  t.is(persisted.bitmap, 'AA==')
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
})

test('automatic checkpoint rolls back in-memory chunks after staging sync failure', async (t) => {
  let failStagingSync = false
  const storage = createStorage({
    failSyncFor: (filePath) => failStagingSync && filePath.endsWith('.part')
  })
  const { layout, store } = await createStore(t, { storage, checkpointChunks: 1 })
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  const before = await readJson(sessionPath(layout, upload.offer))

  failStagingSync = true
  await t.exception(() => store.writeChunk(upload.offer.transferId, upload.chunks[0]))

  const rolledBack = await store.offer(OWNER, upload.offer)
  t.is(rolledBack.state, 'receiving')
  t.is(rolledBack.verified.has(0), false)
  t.alike(await readJson(sessionPath(layout, upload.offer)), before)

  if (rolledBack.verified.has(0)) {
    await store.delete(upload.offer.transferId)
  } else {
    failStagingSync = false
    const retried = await store.writeChunk(upload.offer.transferId, upload.chunks[0])
    t.ok(retried.verified.has(0))
  }
})

test('automatic checkpoint rolls back in-memory chunks after metadata write failure', async (t) => {
  let failMetadataWrite = false
  const storage = createStorage({
    failWriteFor: (filePath) => failMetadataWrite && filePath.includes('.json.')
  })
  const { layout, store } = await createStore(t, { storage, checkpointChunks: 1 })
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  const before = await readJson(sessionPath(layout, upload.offer))

  failMetadataWrite = true
  await t.exception(() => store.writeChunk(upload.offer.transferId, upload.chunks[0]))

  const rolledBack = await store.offer(OWNER, upload.offer)
  t.is(rolledBack.state, 'receiving')
  t.is(rolledBack.verified.has(0), false)
  t.alike(await readJson(sessionPath(layout, upload.offer)), before)

  if (rolledBack.verified.has(0)) {
    await store.delete(upload.offer.transferId)
  } else {
    failMetadataWrite = false
    const retried = await store.writeChunk(upload.offer.transferId, upload.chunks[0])
    t.ok(retried.verified.has(0))
  }
})

test('automatic checkpoint keeps renamed metadata after session-parent sync failure', async (t) => {
  let failSessionSync = false
  let layout
  const storage = createStorage({
    failSyncFor: (filePath) => failSessionSync && filePath === layout.sessions
  })
  const created = await createStore(t, { storage, checkpointChunks: 1 })
  layout = created.layout
  const upload = makeUpload()
  await created.store.offer(OWNER, upload.offer)

  failSessionSync = true
  await t.exception(() => created.store.writeChunk(upload.offer.transferId, upload.chunks[0]))

  const resumed = await created.store.offer(OWNER, upload.offer)
  t.is(resumed.state, 'receiving')
  t.is(resumed.verified.has(0), true)
  t.is((await readJson(sessionPath(layout, upload.offer))).bitmap, 'AQ==')
  failSessionSync = false
})

test('duplicate chunk digests are idempotent but conflicting duplicates fail closed', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  await store.writeChunk(upload.offer.transferId, upload.chunks[0])
  const duplicate = await store.writeChunk(upload.offer.transferId, upload.chunks[0])
  t.ok(duplicate.duplicate)

  await t.exception(
    () =>
      store.writeChunk(upload.offer.transferId, {
        ...upload.chunks[0],
        digest: digest(b4a.alloc(11, 'z'.charCodeAt(0))),
        data: b4a.alloc(11, 'z'.charCodeAt(0))
      }),
    { name: 'SwarmDeployError', code: ERRORS.CHECKSUM_MISMATCH }
  )
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(store.reservedBytes, 0)
})

test('invalid chunk digest deletes the session and releases its reservation', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)

  await t.exception(
    () => store.writeChunk(upload.offer.transferId, { ...upload.chunks[0], digest: b4a.alloc(32) }),
    { name: 'SwarmDeployError', code: ERRORS.CHECKSUM_MISMATCH }
  )
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(store.reservedBytes, 0)
})

test('checkpointed sessions reconstruct reservations and verified chunks after restart', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const clock = createClock()
  const upload = makeUpload()
  const first = new SessionStore({ layout, maxStagingBytes: 1024, clock })
  await first.init()
  await first.offer(OWNER, upload.offer)
  await first.writeChunk(upload.offer.transferId, upload.chunks[0])
  await first.checkpoint(upload.offer.transferId)
  await first.close()

  const reopened = new SessionStore({ layout, maxStagingBytes: 1024, clock })
  await reopened.init()
  t.teardown(() => reopened.close())
  const resumed = await reopened.offer(OWNER, upload.offer)
  t.ok(resumed.resumed)
  t.ok(resumed.verified.has(0))
  t.is(reopened.reservedBytes, upload.offer.size)
})

test('init rejects receiving staging with trailing bytes', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const upload = makeUpload()
  const first = new SessionStore({ layout, maxStagingBytes: 1024, checkpointChunks: 1 })
  await first.init()
  await first.offer(OWNER, upload.offer)
  await first.writeChunk(upload.offer.transferId, upload.chunks[0])
  await first.close()
  await fs.promises.appendFile(stagingPath(layout, upload.offer), b4a.from('trailing'))

  const reopened = new SessionStore({ layout, maxStagingBytes: 1024 })
  await t.exception(() => reopened.init(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('init requires exact staging length for verified sessions', async (t) => {
  for (const size of [10, 12]) {
    const root = await createTempDir(t)
    const layout = initLayout(root)
    const upload = makeUpload()
    const first = new SessionStore({ layout, maxStagingBytes: 1024, checkpointChunks: 1 })
    await first.init()
    await first.offer(OWNER, upload.offer)
    await first.writeChunk(upload.offer.transferId, upload.chunks[0])
    await first.finish(upload.offer.transferId)
    await first.close()
    await fs.promises.truncate(stagingPath(layout, upload.offer), size)

    const reopened = new SessionStore({ layout, maxStagingBytes: 1024 })
    await t.exception(() => reopened.init(), {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    })
  }
})

test('init fails closed on malformed session metadata and symlinked session files', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  await fs.promises.writeFile(path.join(layout.sessions, `${'a'.repeat(64)}.json`), '{not json')
  const malformed = new SessionStore({ layout, maxStagingBytes: 1024 })
  await t.exception(() => malformed.init(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })

  await fs.promises.unlink(path.join(layout.sessions, `${'a'.repeat(64)}.json`))
  const target = path.join(root, 'outside.json')
  await fs.promises.writeFile(target, '{}')
  await fs.promises.symlink(target, path.join(layout.sessions, `${'b'.repeat(64)}.json`))
  const symlinked = new SessionStore({ layout, maxStagingBytes: 1024 })
  await t.exception(() => symlinked.init(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('init rejects a verified session that does not contain every chunk', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  await store.close()

  const metadataPath = sessionPath(layout, upload.offer)
  const metadata = await readJson(metadataPath)
  metadata.state = 'verified'
  await fs.promises.writeFile(metadataPath, JSON.stringify(metadata))

  const reopened = new SessionStore({ layout, maxStagingBytes: 1024 })
  await t.exception(() => reopened.init(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('finish requires all chunks, forces a checkpoint, and supports empty files', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  await t.exception(() => store.finish(upload.offer.transferId), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  for (const chunk of upload.chunks) await store.writeChunk(upload.offer.transferId, chunk)
  const finished = await store.finish(upload.offer.transferId)
  t.is(finished.state, 'verified')
  t.is((await readJson(sessionPath(layout, upload.offer))).state, 'verified')

  const empty = makeUpload(OWNER, { name: 'empty.bin', data: b4a.alloc(0) })
  const accepted = await store.offer(OWNER, empty.offer)
  t.is(accepted.verified.size, 0)
  t.is((await store.finish(empty.offer.transferId)).state, 'verified')
})

test('finish restores receiving state when verified metadata cannot persist', async (t) => {
  let failMetadataWrite = false
  const storage = createStorage({
    failWriteFor: (filePath) => failMetadataWrite && filePath.includes('.json.')
  })
  const { layout, store } = await createStore(t, { storage, checkpointChunks: 1 })
  const upload = makeUpload()
  await store.offer(OWNER, upload.offer)
  await store.writeChunk(upload.offer.transferId, upload.chunks[0])
  const before = await readJson(sessionPath(layout, upload.offer))

  failMetadataWrite = true
  await t.exception(() => store.finish(upload.offer.transferId))

  const rolledBack = await store.offer(OWNER, upload.offer)
  t.is(rolledBack.state, 'receiving')
  t.is(rolledBack.verified.has(0), true)
  t.alike(await readJson(sessionPath(layout, upload.offer)), before)

  failMetadataWrite = false
  t.is((await store.finish(upload.offer.transferId)).state, 'verified')
})

test('finish keeps renamed verified metadata after session-parent sync failure', async (t) => {
  let failSessionSync = false
  let layout
  const storage = createStorage({
    failSyncFor: (filePath) => failSessionSync && filePath === layout.sessions
  })
  const created = await createStore(t, { storage, checkpointChunks: 1 })
  layout = created.layout
  const upload = makeUpload()
  await created.store.offer(OWNER, upload.offer)
  await created.store.writeChunk(upload.offer.transferId, upload.chunks[0])

  failSessionSync = true
  await t.exception(() => created.store.finish(upload.offer.transferId))

  const resumed = await created.store.offer(OWNER, upload.offer)
  t.is(resumed.state, 'verified')
  t.is((await readJson(sessionPath(layout, upload.offer))).state, 'verified')
  failSessionSync = false
})

test('delete, deleteByOwner, and expire remove staging metadata and reservations', async (t) => {
  const { layout, clock, store } = await createStore(t)
  const first = makeUpload(OWNER, { name: 'first.bin' })
  const second = makeUpload(OTHER_OWNER, { name: 'second.bin' })
  await store.offer(OWNER, first.offer)
  await store.offer(OTHER_OWNER, second.offer)
  await store.delete(first.offer.transferId)
  t.is(await pathExists(sessionPath(layout, first.offer)), false)
  t.is(store.reservedBytes, second.offer.size)

  await store.deleteByOwner(OTHER_OWNER)
  t.is(await pathExists(sessionPath(layout, second.offer)), false)
  t.is(store.reservedBytes, 0)

  await store.offer(OWNER, first.offer)
  clock.advance(1_000)
  t.is(await store.expire(1_000), 0)
  t.is(await pathExists(stagingPath(layout, first.offer)), true)
  clock.advance(1)
  t.is(await store.expire(1_000), 1)
  t.is(await pathExists(stagingPath(layout, first.offer)), false)
  t.is(await pathExists(sessionPath(layout, first.offer)), false)
  t.is(store.reservedBytes, 0)
})

test('finish rehashes staging and deletes mismatched whole-file sessions', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload(OWNER, { chunkSize: 1024 * 1024 })
  upload.offer.digest = b4a.alloc(32)
  upload.offer.transferId = transferId({
    clientPublicKey: OWNER,
    name: upload.offer.name,
    size: upload.offer.size,
    digest: upload.offer.digest,
    chunkSize: upload.offer.chunkSize
  })
  await store.offer(OWNER, upload.offer)
  await store.writeChunk(upload.offer.transferId, upload.chunks[0])

  await t.exception(() => store.finish(upload.offer.transferId), {
    name: 'SwarmDeployError',
    code: ERRORS.CHECKSUM_MISMATCH
  })
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(store.reservedBytes, 0)
})

test('finish rejects an empty file with a mismatched offered digest', async (t) => {
  const { layout, store } = await createStore(t)
  const upload = makeUpload(OWNER, {
    name: 'empty-invalid.bin',
    data: b4a.alloc(0),
    chunkSize: 1024 * 1024
  })
  upload.offer.digest = b4a.alloc(32, 1)
  upload.offer.transferId = transferId({
    clientPublicKey: OWNER,
    name: upload.offer.name,
    size: upload.offer.size,
    digest: upload.offer.digest,
    chunkSize: upload.offer.chunkSize
  })
  await store.offer(OWNER, upload.offer)

  await t.exception(() => store.finish(upload.offer.transferId), {
    name: 'SwarmDeployError',
    code: ERRORS.CHECKSUM_MISMATCH
  })
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
})
