/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { transferId } from '../../dist/protocol/transfer-id.js'
import type { Chunk, Digest, Offer } from '../../dist/protocol/types.js'
import { initLayout } from '../../dist/storage/layout.js'
import { readJson } from '../../dist/storage/atomic-file.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import type { CommitJournal, CommitRecord } from '../../dist/storage/commit-journal.js'
import { prepareStorageRecovery, recoverStorage } from '../../dist/storage/recovery.js'
import type { StorageAdapter, StorageLayout } from '../../dist/storage/types.js'
import { createClock, type TestClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 0x81)
const CHUNK_SIZE = 1024 * 1024

type CommitSession = Parameters<CommitStore['commit']>[0]

interface ErrnoError extends Error {
  code?: string
}

interface HarnessUpload {
  offer: Offer
  chunk: Chunk
}

/** The persisted session fields these crash-recovery assertions read. */
interface SessionMetadataJson {
  state: string
}

interface VerifiedStore {
  layout: StorageLayout
  clock: TestClock
  sessionStore: SessionStore
  upload: HarnessUpload
  session: CommitSession
}

function sha256(bytes: Uint8Array): Digest {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(name = 'crash-safe-delete.bin'): HarnessUpload {
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
  const id = transferId({
    clientPublicKey: OWNER,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE
  })
  return {
    offer: { ...offer, transferId: id },
    chunk: { transferId: id, index: 0, digest, data }
  }
}

async function readSessionMetadata(filePath: string): Promise<SessionMetadataJson> {
  return (await readJson(filePath)) as unknown as SessionMetadataJson
}

async function readCommitRecord(filePath: string): Promise<CommitRecord> {
  return (await readJson(filePath)) as unknown as CommitRecord
}

async function readJournalFile(filePath: string): Promise<CommitJournal> {
  return (await readJson(filePath)) as unknown as CommitJournal
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if ((err as ErrnoError).code === 'ENOENT') return false
    throw err
  }
}

async function verifiedStore(
  t: Assert,
  storage: StorageAdapter = fs.promises,
  name = 'journal-retry.bin'
): Promise<VerifiedStore> {
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
    session: sessionStore.sessions.get(hex(upload.offer.transferId))!
  }
}

test('deleting state recovers expiry revocation and checksum cleanup crashes', async (t) => {
  for (const reason of ['expiry', 'revocation', 'checksum']) {
    let layout!: StorageLayout
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
    t.is(
      (await readSessionMetadata(metadataPath)).state,
      'deleting',
      `${reason} persisted deletion intent`
    )
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
  let layout!: StorageLayout
  let metadataPath!: string
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
        path.basename(destination as string) === path.basename(metadataPath)
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
  t.is((await readSessionMetadata(metadataPath)).state, 'deleting')
  t.is(await exists(stagingPath), true, 'post-rename sync failure preserves staging')

  failSessionSyncs = 1
  await t.exception(() => store.delete(upload.offer.transferId))
  t.is((await readSessionMetadata(metadataPath)).state, 'deleting')
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
  let layout!: StorageLayout
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
  const owned = await readJournalFile(journalPath)
  const record = await commitStore.commit(created.session)

  t.is(record.transferId, hex(created.upload.offer.transferId))
  t.is(
    (await readCommitRecord(path.join(layout.commits, `${record.transferId}.json`))).transferId,
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
  let layout!: StorageLayout
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
  let layout!: StorageLayout
  let orphanSessionPath!: string
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

  const events: unknown[] = []
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
  let layout!: StorageLayout
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
  const foreign = await readJournalFile(journalPath)
  foreign.sourceStagingIdentity.ino = String(BigInt(foreign.sourceStagingIdentity.ino) + 1n)
  await fs.promises.writeFile(journalPath, JSON.stringify(foreign))

  await t.exception(() => commitStore.commit(created.session), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await readJournalFile(journalPath), foreign)
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
