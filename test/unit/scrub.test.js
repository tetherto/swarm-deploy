'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { ERRORS } = require('../../dist/errors')
const { transferId } = require('../../dist/protocol/transfer-id')
const { initLayout } = require('../../dist/storage/layout')
const { SessionStore } = require('../../dist/storage/session-store')
const { CommitStore } = require('../../dist/storage/commit-store')
const { RetentionManager } = require('../../dist/storage/retention')
const { recoverStorage } = require('../../dist/storage/recovery')
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

async function createFifo(filePath) {
  let execFile
  try {
    ;({ execFile } = require('child_process'))
  } catch {
    return false
  }
  await new Promise((resolve, reject) => {
    execFile('mkfifo', [filePath], (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  return true
}

async function createStores(t, { storage, isSessionActive = () => false, logger } = {}) {
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
    logger
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
  return { record, finalPath: path.join(stores.layout.root, name) }
}

test('startup recovery fully hashes valid managed finals and reports unknown roots', async (t) => {
  let reads = 0
  let finalPath = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (name === 'read' && filePath === finalPath) reads++
    }
  })
  const stores = await createStores(t, { storage })
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  finalPath = valid.finalPath
  const unknown = path.join(stores.layout.root, 'operator-note.txt')
  await fs.promises.writeFile(unknown, b4a.from('preserve me'))
  const warnings = []

  await recoverStorage({
    layout: stores.layout,
    sessionStore: stores.sessionStore,
    commitStore: stores.commitStore,
    logger: {
      warn(message, details) {
        warnings.push({ message, details })
      }
    }
  })

  t.ok(reads > 0)
  t.is(await pathExists(valid.finalPath), true)
  t.alike(await stores.commitStore.list(), [valid.record])
  t.alike(await fs.promises.readFile(unknown), b4a.from('preserve me'))
  t.alike(warnings, [
    { message: 'Ignoring unknown committed path', details: { name: 'operator-note.txt' } }
  ])
})

test('startup scrub removes missing, truncated, symlinked, and digest-invalid managed files', async (t) => {
  const stores = await createStores(t)
  const missing = await commit(t, stores, 'missing.bin', b4a.from('missing'))
  const truncated = await commit(t, stores, 'truncated.bin', b4a.from('truncated'))
  const symlinked = await commit(t, stores, 'symlinked.bin', b4a.from('symlinked'))
  const changed = await commit(t, stores, 'changed.bin', b4a.from('changed'))
  await fs.promises.unlink(missing.finalPath)
  await fs.promises.truncate(truncated.finalPath, 1)
  await fs.promises.unlink(symlinked.finalPath)
  const foreignTarget = path.join(stores.layout.root, 'foreign-target.bin')
  await fs.promises.writeFile(foreignTarget, b4a.from('foreign'))
  await fs.promises.symlink(foreignTarget, symlinked.finalPath)
  await fs.promises.writeFile(changed.finalPath, b4a.from('CHANGED'))

  const result = await stores.manager.scrubCommitted()

  t.is(result.deleted, 4)
  t.alike(await stores.commitStore.list(), [])
  t.is(await pathExists(missing.finalPath), false)
  t.is(await pathExists(truncated.finalPath), false)
  t.is(await pathExists(symlinked.finalPath), false)
  t.is(await pathExists(changed.finalPath), false)
  t.alike(await fs.promises.readFile(foreignTarget), b4a.from('foreign'))
})

test('startup scrub removes managed FIFOs where supported', async (t) => {
  const stores = await createStores(t)
  const fifo = await commit(t, stores, 'managed.fifo', b4a.from('fifo'))
  await fs.promises.unlink(fifo.finalPath)
  if (!(await createFifo(fifo.finalPath))) {
    t.ok(true)
    return
  }

  const result = await stores.manager.scrubCommitted()

  t.is(result.deleted, 1)
  t.is(await pathExists(fifo.finalPath), false)
  t.alike(await stores.commitStore.list(), [])
})

test('startup scrub removes empty managed directories and preserves non-empty ones', async (t) => {
  const warnings = []
  const stores = await createStores(t, {
    logger: {
      warn(message, details) {
        warnings.push({ message, details })
      }
    }
  })
  const empty = await commit(t, stores, 'empty-directory.bin', b4a.from('empty'))
  const nonempty = await commit(t, stores, 'nonempty-directory.bin', b4a.from('full'))
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  await fs.promises.unlink(empty.finalPath)
  await fs.promises.mkdir(empty.finalPath)
  await fs.promises.unlink(nonempty.finalPath)
  await fs.promises.mkdir(nonempty.finalPath)
  const operatorFile = path.join(nonempty.finalPath, 'operator-note.txt')
  await fs.promises.writeFile(operatorFile, b4a.from('preserve me'))

  const result = await stores.manager.scrubCommitted()

  t.is(result.deleted, 2)
  t.alike(result.unknown, ['nonempty-directory.bin'])
  t.is(await pathExists(empty.finalPath), false)
  t.alike(await fs.promises.readFile(operatorFile), b4a.from('preserve me'))
  t.alike(await stores.commitStore.list(), [valid.record])
  t.alike(
    warnings.filter((warning) => warning.message === 'Preserving non-empty managed directory'),
    [
      {
        message: 'Preserving non-empty managed directory',
        details: { name: 'nonempty-directory.bin' }
      }
    ]
  )
})

test('startup scrub fails closed when the storage root changes during hashing', async (t) => {
  let finalPath = null
  let replaced = false
  let displacedRoot = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (replaced || name !== 'open' || filePath !== finalPath) return
      replaced = true
      displacedRoot = `${path.dirname(finalPath)}-displaced`
      await fs.promises.rename(path.dirname(finalPath), displacedRoot)
      await fs.promises.mkdir(path.dirname(finalPath))
      await fs.promises.link(path.join(displacedRoot, path.basename(finalPath)), finalPath)
    }
  })
  const stores = await createStores(t, { storage })
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  finalPath = valid.finalPath
  t.teardown(() => fs.promises.rm(displacedRoot, { recursive: true, force: true }))

  await t.exception(() => stores.manager.scrubCommitted(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('scheduled retention uses lstat metadata without rehashing healthy finals', async (t) => {
  let reads = 0
  let finalPath = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (name === 'read' && filePath === finalPath) reads++
    }
  })
  const stores = await createStores(t, { storage })
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  finalPath = valid.finalPath

  await stores.manager.run()

  t.is(reads, 0)
  t.is(await pathExists(valid.finalPath), true)
})
