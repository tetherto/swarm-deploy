'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { ERRORS } = require('../../lib/errors')
const { transferId } = require('../../lib/protocol/transfer-id')
const { initLayout } = require('../../lib/storage/layout')
const { readJson } = require('../../lib/storage/atomic-file')
const { SessionStore } = require('../../lib/storage/session-store')
const { CommitStore } = require('../../lib/storage/commit-store')
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

function makeUpload({ name = 'artifact.bin', data = b4a.from('verified artifact') } = {}) {
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest: sha256(data),
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.ceil(data.byteLength / CHUNK_SIZE)
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

function stagingPath(layout, offer) {
  return path.join(layout.staging, `${hex(offer.transferId)}.part`)
}

function sessionPath(layout, offer) {
  return path.join(layout.sessions, `${hex(offer.transferId)}.json`)
}

function journalPath(layout, offer) {
  return path.join(layout.journals, `${hex(offer.transferId)}.json`)
}

function recordPath(layout, offer) {
  return path.join(layout.commits, `${hex(offer.transferId)}.json`)
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

async function createVerifiedSession(t, { storage, upload = makeUpload() } = {}) {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const clock = createClock()
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
  t.teardown(() => sessionStore.close())

  return {
    layout,
    clock,
    sessionStore,
    upload,
    session: sessionStore.sessions.get(hex(upload.offer.transferId))
  }
}

test('commit hard-links the complete verified staging inode and writes its sidecar', async (t) => {
  const { layout, clock, upload, session } = await createVerifiedSession(t)
  const staging = stagingPath(layout, upload.offer)
  const before = await fs.promises.lstat(staging)
  const commits = new CommitStore({ layout, clock })

  const record = await commits.commit(session)
  const finalPath = path.join(layout.root, upload.offer.name)
  const finalStat = await fs.promises.lstat(finalPath)
  const sidecar = await readJson(recordPath(layout, upload.offer))

  t.alike(await fs.promises.readFile(finalPath), upload.chunk.data)
  t.is(finalStat.dev, before.dev)
  t.is(finalStat.ino, before.ino)
  t.is(await pathExists(staging), false)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  t.alike(sidecar, record)
  t.alike(record, {
    version: 1,
    name: upload.offer.name,
    size: upload.offer.size,
    sha256: hex(upload.offer.digest),
    committedAt: clock.now(),
    uploaderFingerprint: hex(sha256(OWNER)),
    transferId: hex(upload.offer.transferId)
  })
})

test('commit rehashes exact staging bytes immediately before linking', async (t) => {
  const { layout, upload, session } = await createVerifiedSession(t)
  const staging = stagingPath(layout, upload.offer)
  await fs.promises.writeFile(staging, b4a.from('mutated staging data'))
  const commits = new CommitStore({ layout })

  await t.exception(() => commits.commit(session), {
    name: 'SwarmDeployError',
    code: ERRORS.CHECKSUM_MISMATCH
  })
  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(staging), true)
  t.is(await pathExists(sessionPath(layout, upload.offer)), true)
})

test('commit never replaces an existing destination and retains verified staging', async (t) => {
  const { layout, upload, session } = await createVerifiedSession(t)
  const finalPath = path.join(layout.root, upload.offer.name)
  await fs.promises.writeFile(finalPath, b4a.from('already committed elsewhere'))
  const commits = new CommitStore({ layout })

  await t.exception(() => commits.commit(session), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(finalPath), b4a.from('already committed elsewhere'))
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(sessionPath(layout, upload.offer)), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('inspect recognizes only matching managed committed records', async (t) => {
  const { layout, clock, upload, session } = await createVerifiedSession(t)
  const commits = new CommitStore({ layout, clock })
  await commits.commit(session)

  t.is((await commits.inspect(upload.offer.name, upload.offer)).status, 'ALREADY_COMMITTED')

  const different = makeUpload({ name: upload.offer.name, data: b4a.from('different content') })
  t.is((await commits.inspect(different.offer.name, different.offer)).status, 'FILE_EXISTS')

  await fs.promises.writeFile(path.join(layout.root, 'unmanaged.bin'), b4a.from('unmanaged'))
  const unmanaged = makeUpload({ name: 'unmanaged.bin' })
  t.is((await commits.inspect(unmanaged.offer.name, unmanaged.offer)).status, 'FILE_EXISTS')
})

test('link failure preserves verified session state without a final file', async (t) => {
  const storage = createStorage({
    async beforeOperation(name) {
      if (name === 'link') throw new Error('Injected link failure')
    }
  })
  const { layout, upload, session } = await createVerifiedSession(t, { storage })
  const commits = new CommitStore({ layout, storage })

  await t.exception(() => commits.commit(session))
  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(sessionPath(layout, upload.offer)), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('commit durably journals a unique attempt and staging inode before linking', async (t) => {
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
  const created = await createVerifiedSession(t, { storage })
  layout = created.layout
  const staging = await fs.promises.lstat(stagingPath(layout, created.upload.offer))
  const commits = new CommitStore({ layout, storage })

  armed = true
  await t.exception(() => commits.commit(created.session))
  const journal = await readJson(journalPath(layout, created.upload.offer))

  t.ok(/^[0-9a-f]{64}$/.test(journal.attemptId))
  t.alike(journal.sourceStagingIdentity, {
    dev: String(staging.dev),
    ino: String(staging.ino)
  })
  t.is(await pathExists(path.join(layout.root, created.upload.offer.name)), false)
})

test('delete removes only its managed object and durably removes its sidecar', async (t) => {
  const events = []
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (name === 'unlink' || name === 'sync') events.push(`${name}:${filePath}`)
    }
  })
  const { layout, clock, upload, session } = await createVerifiedSession(t, { storage })
  const commits = new CommitStore({ layout, clock, storage })
  const record = await commits.commit(session)
  events.length = 0

  t.is(await commits.delete(record), true)
  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(recordPath(layout, upload.offer)), false)
  t.alike(events, [
    `unlink:${path.join(layout.root, upload.offer.name)}`,
    `sync:${layout.root}`,
    `unlink:${recordPath(layout, upload.offer)}`,
    `sync:${layout.commits}`
  ])
})

test('commit abort signal prevents final publication before linking', async (t) => {
  const { layout, upload, session } = await createVerifiedSession(t)
  const commits = new CommitStore({ layout })
  const signal = { aborted: true }

  await t.exception(() => commits.commit(session, { signal }), {
    name: 'SwarmDeployError',
    code: ERRORS.REVOKED
  })

  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
})

test('commit removes its publication when revoked during final link', async (t) => {
  const signal = { aborted: false }
  let staging = null
  const storage = createStorage({
    async afterOperation(name, sourcePath) {
      if (name === 'link' && sourcePath === staging) signal.aborted = true
    }
  })
  const { layout, upload, session } = await createVerifiedSession(t, { storage })
  staging = stagingPath(layout, upload.offer)
  const commits = new CommitStore({ layout, storage })

  await t.exception(() => commits.commit(session, { signal }), {
    name: 'SwarmDeployError',
    code: ERRORS.REVOKED
  })

  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(recordPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})
