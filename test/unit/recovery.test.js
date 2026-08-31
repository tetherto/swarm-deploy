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
  'journal persisted',
  'final hard link created',
  'storage directory synchronized',
  'commit sidecar persisted',
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
        (point === 'journal persisted' && name === 'rename' && destination === expected.journal) ||
        (point === 'final hard link created' &&
          name === 'link' &&
          source === expected.staging &&
          destination === expected.final) ||
        (point === 'storage directory synchronized' && name === 'sync' && source === layout.root) ||
        (point === 'commit sidecar persisted' &&
          name === 'rename' &&
          destination === expected.record) ||
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

    if (point === 'journal persisted') {
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
