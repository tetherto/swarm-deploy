'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { ERRORS } = require('../../dist/errors')
const { transferId } = require('../../dist/protocol/transfer-id')
const { initLayout } = require('../../dist/storage/layout')
const { readJson } = require('../../dist/storage/atomic-file')
const { SessionStore } = require('../../dist/storage/session-store')
const { CommitStore } = require('../../dist/storage/commit-store')
const { prepareStorageRecovery, recoverStorage } = require('../../dist/storage/recovery')
const { createClock } = require('../helpers/clock')
const { createTempDir } = require('../helpers/files')
const { createStorage } = require('../helpers/storage')

const OWNER = b4a.alloc(32, 0x81)
const CHUNK_SIZE = 1024 * 1024

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(name = 'crash-safe-delete.bin') {
  const data = b4a.from(`payload:${name}`)
  const digest = sha256(data)
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  offer.transferId = transferId({
    clientPublicKey: OWNER,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer,
    chunk: { transferId: offer.transferId, index: 0, digest, data }
  }
}

async function exists(filePath) {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

async function verifiedStore(t, storage = fs.promises, name = 'journal-retry.bin') {
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
  t.teardown(() => sessionStore.close())
  const upload = makeUpload(name)
  await sessionStore.offer(OWNER, upload.offer)
  await sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await sessionStore.finish(upload.offer.transferId)
  return {
    layout,
    clock,
    sessionStore,
    upload,
    session: sessionStore.sessions.get(hex(upload.offer.transferId))
  }
}

test('deleting state recovers expiry revocation and checksum cleanup crashes', async (t) => {
  for (const reason of ['expiry', 'revocation', 'checksum']) {
    let layout
    let failCleanupSync = false
    const storage = createStorage({
      failSyncFor: (filePath) => {
        if (!failCleanupSync || filePath !== layout.staging) return false
        failCleanupSync = false
        return true
      }
    })
    layout = initLayout(await createTempDir(t))
    const clock = createClock()
    const store = new SessionStore({
      layout,
      maxStagingBytes: CHUNK_SIZE,
      checkpointChunks: 1,
      clock,
      storage
    })
    await store.init()
    const upload = makeUpload(`${reason}.bin`)
    await store.offer(OWNER, upload.offer)
    failCleanupSync = true

    if (reason === 'expiry') {
      clock.advance(2)
      await t.exception(() => store.expire(1))
    } else if (reason === 'revocation') {
      await t.exception(() => store.deleteByOwner(OWNER))
    } else {
      await t.exception(() =>
        store.writeChunk(upload.offer.transferId, {
          ...upload.chunk,
          digest: b4a.alloc(32)
        })
      )
    }

    const id = hex(upload.offer.transferId)
    const metadataPath = path.join(layout.sessions, `${id}.json`)
    const stagingPath = path.join(layout.staging, `${id}.part`)
    t.is((await readJson(metadataPath)).state, 'deleting', `${reason} persisted deletion intent`)
    t.is(await exists(stagingPath), false, `${reason} removed staging before crash`)

    const reopened = new SessionStore({
      layout,
      maxStagingBytes: CHUNK_SIZE,
      checkpointChunks: 1
    })
    await reopened.init()
    t.is(reopened.sessions.size, 0, `${reason} restored no resumable state`)
    t.is(reopened.reservedBytes, 0, `${reason} released reservation`)
    t.is(await exists(metadataPath), false, `${reason} completed metadata cleanup`)
    t.is(await exists(stagingPath), false, `${reason} kept staging retired`)
    await reopened.close()
  }
})

test('deletion never unlinks staging before deleting metadata is durably synchronized', async (t) => {
  let layout
  let metadataPath
  let armAfterDeletingRename = false
  let failSessionSyncs = 0
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (path.basename(filePath) !== 'sessions' || failSessionSyncs === 0) return false
      failSessionSyncs--
      return true
    },
    afterOperation(name, source, destination) {
      if (
        armAfterDeletingRename &&
        name === 'rename' &&
        path.basename(destination) === path.basename(metadataPath)
      ) {
        armAfterDeletingRename = false
        failSessionSyncs = 1
      }
    }
  })
  layout = initLayout(await createTempDir(t))
  const store = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await store.init()
  const upload = makeUpload('durable-delete-order.bin')
  await store.offer(OWNER, upload.offer)
  const id = hex(upload.offer.transferId)
  metadataPath = path.join(layout.sessions, `${id}.json`)
  const stagingPath = path.join(layout.staging, `${id}.part`)

  armAfterDeletingRename = true
  await t.exception(() => store.delete(upload.offer.transferId))
  t.is((await readJson(metadataPath)).state, 'deleting')
  t.is(await exists(stagingPath), true, 'post-rename sync failure preserves staging')

  failSessionSyncs = 1
  await t.exception(() => store.delete(upload.offer.transferId))
  t.is((await readJson(metadataPath)).state, 'deleting')
  t.is(await exists(stagingPath), true, 'failed retry sync still preserves staging')
  await store.close()

  const reopened = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1
  })
  await reopened.init()
  t.is(reopened.sessions.size, 0)
  t.is(await exists(metadataPath), false)
  t.is(await exists(stagingPath), false)
  await reopened.close()
})

test('commit retries its canonical journal after journal-directory sync failure', async (t) => {
  let layout
  let failJournalSync = false
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failJournalSync || filePath !== layout.journals) return false
      failJournalSync = false
      return true
    }
  })
  const created = await verifiedStore(t, storage)
  layout = created.layout
  const commitStore = new CommitStore({ layout, clock: created.clock, storage })
  const journalPath = path.join(layout.journals, `${hex(created.upload.offer.transferId)}.json`)

  failJournalSync = true
  await t.exception(() => commitStore.commit(created.session))
  const owned = await readJson(journalPath)
  const record = await commitStore.commit(created.session)

  t.is(record.transferId, hex(created.upload.offer.transferId))
  t.is(
    (await readJson(path.join(layout.commits, `${record.transferId}.json`))).transferId,
    record.transferId
  )
  t.is(await exists(journalPath), false)
  t.ok(/^[0-9a-f]{64}$/.test(owned.attemptId))
  t.alike(
    await fs.promises.readFile(path.join(layout.root, record.name)),
    created.upload.chunk.data
  )
})

test('restart retires a corrupt matching journal and preserves resumable transfer', async (t) => {
  let layout
  let failJournalSync = false
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failJournalSync || filePath !== layout.journals) return false
      failJournalSync = false
      return true
    }
  })
  const created = await verifiedStore(t, storage, 'corrupt-journal.bin')
  layout = created.layout
  const id = hex(created.upload.offer.transferId)
  const journalPath = path.join(layout.journals, `${id}.json`)
  const commitStore = new CommitStore({ layout, clock: created.clock, storage })

  failJournalSync = true
  await t.exception(() => commitStore.commit(created.session))
  await fs.promises.writeFile(journalPath, '{corrupt')
  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore,
    logger: { warn() {} }
  })

  t.is(results[0].status, 'CORRUPT')
  t.is(await exists(journalPath), false)
  t.ok(
    (await fs.promises.readdir(layout.journals)).some((name) => name.startsWith(`.${id}.corrupt-`))
  )
  t.is(created.sessionStore.sessions.has(id), true)
  const record = await commitStore.commit(created.session)
  t.is(record.transferId, id)
})

test('startup classifies a corrupt journal before removing its orphan staging', async (t) => {
  let layout
  let orphanSessionPath
  let crashAfterSessionUnlink = false
  const storage = createStorage({
    afterOperation(name, filePath) {
      if (crashAfterSessionUnlink && name === 'unlink' && filePath === orphanSessionPath) {
        crashAfterSessionUnlink = false
        throw new Error('Injected crash after commit sidecar and session unlink')
      }
    }
  })
  const created = await verifiedStore(t, storage, 'corrupt-orphan.bin')
  layout = created.layout
  const valid = makeUpload('later-valid-session.bin')
  await created.sessionStore.offer(OWNER, valid.offer)
  const orphanId = hex(created.upload.offer.transferId)
  const validId = hex(valid.offer.transferId)
  const orphanFingerprint = hex(sha256(created.upload.offer.transferId)).slice(0, 12)
  orphanSessionPath = path.join(layout.sessions, `${orphanId}.json`)
  const orphanStagingPath = path.join(layout.staging, `${orphanId}.part`)
  const orphanJournalPath = path.join(layout.journals, `${orphanId}.json`)
  const commitStore = new CommitStore({ layout, clock: created.clock, storage })

  crashAfterSessionUnlink = true
  await commitStore.commit(created.session)
  await fs.promises.writeFile(orphanJournalPath, '{corrupt')
  await created.sessionStore.close()

  const events = []
  await prepareStorageRecovery({
    layout,
    commitStore,
    onEvent(event) {
      events.push(event)
    }
  })
  const reopened = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await reopened.init()
  await recoverStorage({ layout, sessionStore: reopened, commitStore })

  t.is(await exists(orphanJournalPath), false)
  t.is(await exists(orphanStagingPath), false)
  t.ok(
    (await fs.promises.readdir(layout.journals)).some((name) =>
      name.startsWith(`.${orphanId}.corrupt-`)
    )
  )
  t.is(reopened.sessions.has(validId), true)
  t.is(await exists(path.join(layout.staging, `${validId}.part`)), true)
  t.alike(events, [
    {
      type: 'recovery',
      status: 'CORRUPT',
      phase: 'classification',
      transfer: orphanFingerprint
    },
    {
      type: 'cleanup',
      transfer: orphanFingerprint,
      name: null,
      reason: 'corrupt-journal'
    }
  ])
  await reopened.close()
})

test('a valid foreign journal is not adopted or removed by commit retry', async (t) => {
  let layout
  let failJournalSync = false
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failJournalSync || filePath !== layout.journals) return false
      failJournalSync = false
      return true
    }
  })
  const created = await verifiedStore(t, storage, 'foreign-journal.bin')
  layout = created.layout
  const id = hex(created.upload.offer.transferId)
  const journalPath = path.join(layout.journals, `${id}.json`)
  const commitStore = new CommitStore({ layout, clock: created.clock, storage })

  failJournalSync = true
  await t.exception(() => commitStore.commit(created.session))
  const foreign = await readJson(journalPath)
  foreign.sourceStagingIdentity.ino = String(BigInt(foreign.sourceStagingIdentity.ino) + 1n)
  await fs.promises.writeFile(journalPath, JSON.stringify(foreign))

  await t.exception(() => commitStore.commit(created.session), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await readJson(journalPath), foreign)
  t.is(await exists(path.join(layout.root, created.upload.offer.name)), false)

  const recovered = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore,
    logger: { warn() {} }
  })
  t.is(recovered[0].status, 'CORRUPT')
  t.is(await exists(journalPath), false)
  t.is((await commitStore.commit(created.session)).transferId, id)
})
