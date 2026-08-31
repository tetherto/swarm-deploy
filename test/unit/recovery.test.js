'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { transferId } = require('../../lib/protocol/transfer-id')
const { initLayout } = require('../../lib/storage/layout')
const { readJson } = require('../../lib/storage/atomic-file')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
const { recoverStorage } = require('../../lib/storage/recovery')
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

function makeUpload() {
  const data = b4a.from('verified artifact')
  const offer = {
    version: 1,
    name: 'artifact.bin',
    size: data.byteLength,
    digest: sha256(data),
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  offer.transferId = transferId({
    clientPublicKey: OWNER,
    name: offer.name,
    size: offer.size,
    digest: offer.digest,
    chunkSize: offer.chunkSize
  })
  return {
    offer,
    chunk: { index: 0, data, digest: sha256(data) }
  }
}

function paths(layout, offer) {
  const id = hex(offer.transferId)
  return {
    final: path.join(layout.root, offer.name),
    staging: path.join(layout.staging, `${id}.part`),
    session: path.join(layout.sessions, `${id}.json`),
    journal: path.join(layout.journals, `${id}.json`),
    record: path.join(layout.commits, `${id}.json`)
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

async function createVerifiedSession(t, storage) {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const clock = createClock()
  const upload = makeUpload()
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    clock,
    checkpointChunks: 1,
    storage
  })
  await sessionStore.init()
  await sessionStore.offer(OWNER, upload.offer)
  await sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await sessionStore.finish(upload.offer.transferId)
  return {
    layout,
    clock,
    upload,
    sessionStore,
    session: sessionStore.sessions.get(hex(upload.offer.transferId))
  }
}

for (const point of [
  'journal parent synchronized',
  'final hard link created',
  'storage directory synchronized',
  'commit sidecar parent synchronized',
  'staging link removed',
  'journal removed'
]) {
  test(`recovery converges after crash point: ${point}`, async (t) => {
    let layout = null
    let upload = null
    let armed = true
    const afterOperation = async (name, source, destination) => {
      if (!armed || !layout || !upload) return
      const expected = paths(layout, upload.offer)
      const crash =
        (point === 'journal parent synchronized' &&
          name === 'sync' &&
          source === layout.journals) ||
        (point === 'final hard link created' &&
          name === 'link' &&
          source === expected.staging &&
          destination === expected.final) ||
        (point === 'storage directory synchronized' && name === 'sync' && source === layout.root) ||
        (point === 'commit sidecar parent synchronized' &&
          name === 'sync' &&
          source === layout.commits) ||
        (point === 'staging link removed' && name === 'unlink' && source === expected.staging) ||
        (point === 'journal removed' && name === 'unlink' && source === expected.journal)
      if (crash) {
        armed = false
        throw new Error(`Injected crash after ${point}`)
      }
    }
    const storage = createStorage({ afterOperation })

    const created = await createVerifiedSession(t, storage)
    layout = created.layout
    upload = created.upload
    const expected = paths(layout, upload.offer)
    const unknown = path.join(layout.root, 'operator-note.txt')
    await fs.promises.writeFile(unknown, b4a.from('do not modify'))
    const commits = new CommitStore({ layout, clock: created.clock, storage })

    await t.exception(() => commits.commit(created.session))
    await created.sessionStore.close()
    await recoverStorage({
      layout,
      sessionStore: created.sessionStore,
      commitStore: commits,
      logger: { warn() {} }
    })

    t.alike(await fs.promises.readFile(unknown), b4a.from('do not modify'))
    t.is(await pathExists(expected.journal), false)

    const restarted = new SessionStore({
      layout,
      maxStagingBytes: CHUNK_SIZE,
      clock: created.clock,
      storage
    })
    await restarted.init()
    t.teardown(() => restarted.close())

    if (point === 'journal parent synchronized') {
      t.is(await pathExists(expected.final), false)
      t.is(await pathExists(expected.record), false)
      t.is(await pathExists(expected.staging), true)
      t.is(await pathExists(expected.session), true)
      t.is(restarted.sessions.get(hex(upload.offer.transferId)).state, 'verified')
      return
    }

    t.alike(await fs.promises.readFile(expected.final), upload.chunk.data)
    t.alike(await readJson(expected.record), {
      version: 1,
      name: upload.offer.name,
      size: upload.offer.size,
      sha256: hex(upload.offer.digest),
      committedAt: created.clock.now(),
      uploaderFingerprint: hex(sha256(OWNER)),
      transferId: hex(upload.offer.transferId)
    })
    t.is(await pathExists(expected.staging), false)
    t.is(await pathExists(expected.session), false)
    t.is(restarted.sessions.size, 0)
  })
}

test('recovery leaves a same-content foreign final unmanaged', async (t) => {
  let layout = null
  let armed = false
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'sync' && filePath === layout.journals) {
        armed = false
        throw new Error('Injected journal parent sync failure')
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  armed = true
  await t.exception(() => commits.commit(created.session))
  await fs.promises.copyFile(expected.staging, expected.final)
  await created.sessionStore.close()

  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(results[0].status, 'FILE_EXISTS')
  t.is(await pathExists(expected.record), false)
  t.alike(await fs.promises.readFile(expected.final), created.upload.chunk.data)
  t.is(await pathExists(expected.staging), true)
})

test('recovery reports corrupt journals and continues valid journals', async (t) => {
  let layout = null
  let armed = false
  const warnings = []
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'sync' && filePath === layout.journals) {
        armed = false
        throw new Error('Injected journal parent sync failure')
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const corrupt = path.join(layout.journals, `${'0'.repeat(64)}.json`)
  await fs.promises.writeFile(corrupt, '{bad journal')
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  armed = true
  await t.exception(() => commits.commit(created.session))
  await created.sessionStore.close()
  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: {
      warn(message, detail) {
        warnings.push({ message, detail })
      }
    }
  })

  t.is(results.length, 2)
  t.is(results[0].status, 'CORRUPT')
  t.is(results[1].status, 'RESUMABLE')
  t.is(warnings.length, 1)
  t.is(await pathExists(expected.journal), false)
  t.is(await pathExists(corrupt), true)
})

test('recovery delegates corrupt resumable metadata to SessionStore validation', async (t) => {
  let layout = null
  let armed = false
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'sync' && filePath === layout.journals) {
        armed = false
        throw new Error('Injected journal parent sync failure')
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  armed = true
  await t.exception(() => commits.commit(created.session))
  await fs.promises.writeFile(expected.session, '{}')
  await created.sessionStore.close()
  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(results[0].status, 'CORRUPT')
  t.is(await pathExists(expected.session), true)
  t.is(await pathExists(expected.staging), true)
  t.is(await pathExists(expected.journal), true)
})
