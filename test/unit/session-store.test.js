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

test('stale lock recovery cannot be undone by an older owner', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const releaseOld = await acquireStorageLock(layout, {
    pid: 201,
    isProcessAlive: () => false
  })
  const releaseNew = await acquireStorageLock(layout, {
    pid: 202,
    isProcessAlive: (pid) => pid === 202
  })
  t.teardown(() => releaseNew())

  await releaseOld()
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
