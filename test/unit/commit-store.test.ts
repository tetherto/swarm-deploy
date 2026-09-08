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
import { historyName } from '../../dist/files.js'
import { initLayout } from '../../dist/storage/layout.js'
import { readJson } from '../../dist/storage/atomic-file.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import {
  assertCommitRecord,
  type CommitJournal,
  type CommitRecord,
  type ReplacementJournal
} from '../../dist/storage/commit-journal.js'
import { recoverStorage } from '../../dist/storage/recovery.js'
import { withNameLease } from '../../dist/storage/root-coordinator.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { createClock, type TestClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 7)
const CHUNK_SIZE = 1024 * 1024

interface ErrnoError extends Error {
  code?: string
}

/** The chunk fields the store reads; the transfer ID is passed separately. */
interface HarnessChunk {
  index: number
  data: Buffer
  digest: Digest
}

interface HarnessUpload {
  offer: Offer
  chunk: HarnessChunk
}

interface UploadOptions {
  name?: string
  data?: Buffer
}

/** Paths a single commit attempt touches. */
interface ExpectedPaths {
  final: string
  record: string
  staging: string
  session: string
  journal: string
}

interface LoggedWarning {
  message: string
  details: Record<string, unknown>
}

type CommitStoreLogger = ConstructorParameters<typeof CommitStore>[0]['logger']

/** Records the retention calls a replacement makes while the old current is pinned. */
interface RetentionCall {
  incomingBytes: number
  trigger: string
  names: string[]
}

interface CreateVerifiedSessionOptions {
  storage?: TestStorage
  upload?: HarnessUpload
}

interface VerifiedSession {
  layout: StorageLayout
  clock: TestClock
  sessionStore: SessionStore
  upload: HarnessUpload
  session: Parameters<CommitStore['commit']>[0]
}

/** Persisted commit records keep unknown fields across a round-trip. */
interface CommitRecordWithExtras extends CommitRecord {
  replacedAt?: number
}

function asChunk(chunk: HarnessChunk): Chunk {
  return chunk as unknown as Chunk
}

function sha256(bytes: Uint8Array): Digest {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function makeUpload({
  name = 'artifact.bin',
  data = b4a.from('verified artifact')
}: UploadOptions = {}): HarnessUpload {
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest: sha256(data),
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.ceil(data.byteLength / CHUNK_SIZE)
  }
  return {
    offer: {
      ...offer,
      transferId: transferId({
        clientPublicKey: OWNER,
        name: offer.name,
        size: offer.size,
        digest: offer.digest,
        chunkSize: offer.chunkSize
      })
    },
    chunk: { index: 0, data, digest: sha256(data) }
  }
}

function noSpace(message: string): ErrnoError {
  const error: ErrnoError = new Error(message)
  error.code = 'ENOSPC'
  return error
}

function stagingPath(layout: StorageLayout, offer: Offer): string {
  return path.join(layout.staging, `${hex(offer.transferId)}.part`)
}

function sessionPath(layout: StorageLayout, offer: Offer): string {
  return path.join(layout.sessions, `${hex(offer.transferId)}.json`)
}

function journalPath(layout: StorageLayout, offer: Offer): string {
  return path.join(layout.journals, `${hex(offer.transferId)}.json`)
}

function recordPath(layout: StorageLayout, offer: Offer): string {
  return path.join(layout.commits, `${hex(offer.transferId)}.json`)
}

async function readCommitRecord(filePath: string): Promise<CommitRecord> {
  return (await readJson(filePath)) as unknown as CommitRecord
}

async function readJournal(filePath: string): Promise<CommitJournal> {
  return (await readJson(filePath)) as unknown as CommitJournal
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if ((err as ErrnoError).code === 'ENOENT') return false
    throw err
  }
}

async function verifyUpload(
  sessionStore: SessionStore,
  upload: HarnessUpload
): Promise<Parameters<CommitStore['commit']>[0]> {
  await sessionStore.offer(OWNER, upload.offer)
  await sessionStore.writeChunk(upload.offer.transferId, asChunk(upload.chunk))
  await sessionStore.finish(upload.offer.transferId)
  return sessionStore.sessions.get(hex(upload.offer.transferId))!
}

async function createVerifiedSession(
  t: Assert,
  { storage, upload = makeUpload() }: CreateVerifiedSessionOptions = {}
): Promise<VerifiedSession> {
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
  const session = await verifyUpload(sessionStore, upload)
  t.teardown(() => sessionStore.close())

  return { layout, clock, sessionStore, upload, session }
}

/** One mutable name plus a reusable session store, for replacement sequences. */
interface ReplacementHarness {
  layout: StorageLayout
  clock: TestClock
  sessionStore: SessionStore
  commits: CommitStore
  replaceNames: Set<string>
  publish(data: Buffer, name?: string): Promise<CommitRecord>
  stage(data: Buffer, name?: string): Promise<HarnessUpload>
  session(upload: HarnessUpload): Parameters<CommitStore['commit']>[0]
}

const MUTABLE = 'release.tar.gz'

async function createReplacementHarness(
  t: Assert,
  { storage, logger }: { storage?: TestStorage; logger?: CommitStoreLogger } = {}
): Promise<ReplacementHarness> {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const clock = createClock()
  const replaceNames = new Set([MUTABLE])
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    clock,
    checkpointChunks: 1,
    storage,
    replaceNames
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commits = new CommitStore({ layout, clock, storage, logger })

  async function stage(data: Buffer, name = MUTABLE): Promise<HarnessUpload> {
    const upload = makeUpload({ name, data })
    await verifyUpload(sessionStore, upload)
    return upload
  }

  return {
    layout,
    clock,
    sessionStore,
    commits,
    replaceNames,
    stage,
    session: (upload) => sessionStore.sessions.get(hex(upload.offer.transferId))!,
    async publish(data: Buffer, name = MUTABLE): Promise<CommitRecord> {
      const upload = await stage(data, name)
      const record = await commits.commit(
        sessionStore.sessions.get(hex(upload.offer.transferId))!,
        {
          replaceNames
        }
      )
      await sessionStore.retireCommitted(upload.offer.transferId)
      return record
    }
  }
}

async function inode(filePath: string): Promise<string> {
  const stat = await fs.promises.lstat(filePath)
  return `${stat.dev}:${stat.ino}`
}

test('commit hard-links the complete verified staging inode and writes its sidecar', async (t) => {
  const { layout, clock, upload, session } = await createVerifiedSession(t)
  const staging = stagingPath(layout, upload.offer)
  const before = await fs.promises.lstat(staging)
  const commits = new CommitStore({ layout, clock })

  const record = await commits.commit(session)
  const finalPath = path.join(layout.root, upload.offer.name)
  const finalStat = await fs.promises.lstat(finalPath)
  const sidecar = await readCommitRecord(recordPath(layout, upload.offer))

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
    beforeOperation(name) {
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

test('sidecar persistence failures roll back before commit linearization', async (t) => {
  for (const boundary of ['temp-open', 'write', 'rename', 'parent-sync']) {
    let armed = false
    let layout!: StorageLayout
    let record: string | null = null
    const storage = createStorage({
      beforeOperation(name, source, destination) {
        if (!armed) return
        const temporary =
          typeof source === 'string' &&
          source.startsWith(`${layout.commits}${path.sep}.`) &&
          source.endsWith('.tmp')
        const fail =
          (boundary === 'temp-open' && name === 'open' && temporary) ||
          (boundary === 'write' && name === 'write' && temporary) ||
          (boundary === 'rename' && name === 'rename' && destination === record) ||
          (boundary === 'parent-sync' && name === 'sync' && source === layout.commits)
        if (!fail) return
        armed = false
        throw noSpace(`No space at sidecar ${boundary}`)
      }
    })
    const created = await createVerifiedSession(t, { storage })
    layout = created.layout
    record = recordPath(layout, created.upload.offer)
    const commits = new CommitStore({ layout, storage })
    armed = true

    await t.exception(() => commits.commit(created.session), { code: 'ENOSPC' }, boundary)
    t.is(await pathExists(path.join(layout.root, created.upload.offer.name)), false, boundary)
    t.is(await pathExists(record), false, boundary)
    t.is(await pathExists(stagingPath(layout, created.upload.offer)), true, boundary)
    t.is(await pathExists(sessionPath(layout, created.upload.offer)), true, boundary)
    t.is(await pathExists(journalPath(layout, created.upload.offer)), false, boundary)
  }
})

test('post-linearization cleanup failures return success and recover leftovers', async (t) => {
  for (const boundary of [
    'session-unlink',
    'session-sync',
    'staging-unlink',
    'staging-sync',
    'journal-unlink',
    'journal-sync'
  ]) {
    let armed = false
    let layout!: StorageLayout
    let expected!: ExpectedPaths
    let sidecarDurable = false
    const warnings: LoggedWarning[] = []
    const storage = createStorage({
      beforeOperation(name, source) {
        if (!armed) return
        const fail =
          (boundary === 'session-unlink' && name === 'unlink' && source === expected.session) ||
          (boundary === 'session-sync' && name === 'sync' && source === layout.sessions) ||
          (boundary === 'staging-unlink' && name === 'unlink' && source === expected.staging) ||
          (boundary === 'staging-sync' && name === 'sync' && source === layout.staging) ||
          (sidecarDurable &&
            boundary === 'journal-unlink' &&
            name === 'unlink' &&
            source === expected.journal) ||
          (sidecarDurable &&
            boundary === 'journal-sync' &&
            name === 'sync' &&
            source === layout.journals)
        if (!fail) return
        armed = false
        throw noSpace(`No space at cleanup ${boundary}`)
      },
      afterOperation(name, source) {
        if (armed && name === 'sync' && source === layout.commits) sidecarDurable = true
      }
    })
    const created = await createVerifiedSession(t, { storage })
    layout = created.layout
    expected = {
      final: path.join(layout.root, created.upload.offer.name),
      record: recordPath(layout, created.upload.offer),
      staging: stagingPath(layout, created.upload.offer),
      session: sessionPath(layout, created.upload.offer),
      journal: journalPath(layout, created.upload.offer)
    }
    const commits = new CommitStore({
      layout,
      storage,
      logger: {
        warn(message, details) {
          warnings.push({ message, details })
        }
      }
    })
    armed = true

    const record = await commits.commit(created.session)
    const before = await fs.promises.lstat(expected.final)
    t.is(record.transferId, hex(created.upload.offer.transferId), `${boundary} committed`)
    t.alike(await fs.promises.readFile(expected.final), created.upload.chunk.data, boundary)
    t.alike(await readCommitRecord(expected.record), record, boundary)
    t.is(warnings.length, 1, `${boundary} diagnostic`)

    await created.sessionStore.close()
    const restarted = new SessionStore({
      layout,
      maxStagingBytes: CHUNK_SIZE,
      storage
    })
    await restarted.init()
    t.teardown(() => restarted.close())
    await recoverStorage({
      layout,
      sessionStore: restarted,
      commitStore: commits,
      logger: { warn() {} }
    })

    const after = await fs.promises.lstat(expected.final)
    t.is(after.dev, before.dev, `${boundary} final device preserved`)
    t.is(after.ino, before.ino, `${boundary} final inode preserved`)
    t.alike(await readCommitRecord(expected.record), record, `${boundary} sidecar preserved`)
    t.is(await pathExists(expected.staging), false, `${boundary} staging cleaned`)
    t.is(await pathExists(expected.session), false, `${boundary} session cleaned`)
    t.is(await pathExists(expected.journal), false, `${boundary} journal cleaned`)
    t.is(restarted.sessions.size, 0, `${boundary} no resumed session`)
    t.is(restarted.reservedBytes, 0, `${boundary} no reservation`)
  }
})

test('revocation after sidecar durability preserves committed publication', async (t) => {
  const signal = { aborted: false }
  const warnings: LoggedWarning[] = []
  let armed = false
  let layout!: StorageLayout
  const storage = createStorage({
    afterOperation(name, filePath) {
      if (!armed || name !== 'sync' || filePath !== layout.commits) return
      armed = false
      signal.aborted = true
    }
  })
  const created = await createVerifiedSession(t, { storage })
  layout = created.layout
  const commits = new CommitStore({
    layout,
    storage,
    logger: {
      warn(message, details) {
        warnings.push({ message, details })
      }
    }
  })
  armed = true

  const record = await commits.commit(created.session, { signal })

  t.is(record.transferId, hex(created.upload.offer.transferId))
  t.alike(
    await fs.promises.readFile(path.join(layout.root, created.upload.offer.name)),
    created.upload.chunk.data
  )
  t.alike(await readCommitRecord(recordPath(layout, created.upload.offer)), record)
  t.is(await pathExists(journalPath(layout, created.upload.offer)), true)
  t.is(await pathExists(stagingPath(layout, created.upload.offer)), true)
  t.is(await pathExists(sessionPath(layout, created.upload.offer)), true)
  t.is(warnings.length, 1)
})

test('commit durably journals a unique attempt and staging inode before linking', async (t) => {
  let layout!: StorageLayout
  let armed = false
  const storage = createStorage({
    afterOperation(name, filePath) {
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
  const journal = await readJournal(journalPath(layout, created.upload.offer))

  t.ok(/^[0-9a-f]{64}$/.test(journal.attemptId))
  t.alike(journal.sourceStagingIdentity, {
    dev: String(staging.dev),
    ino: String(staging.ino)
  })
  t.is(await pathExists(path.join(layout.root, created.upload.offer.name)), false)
})

test('delete removes only its managed object and durably removes its sidecar', async (t) => {
  const events: string[] = []
  const storage = createStorage({
    afterOperation(name, filePath) {
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
  let staging: string | null = null
  const storage = createStorage({
    afterOperation(name, sourcePath) {
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

test('assertCommitRecord preserves unknown persisted fields', (t) => {
  const record = {
    version: 1,
    name: 'artifact.bin',
    size: 17,
    sha256: hex(sha256(b4a.from('verified artifact'))),
    committedAt: 1,
    uploaderFingerprint: hex(sha256(OWNER)),
    transferId: hex(makeUpload().offer.transferId),
    replacedAt: 42
  }

  const validated = assertCommitRecord(record) as CommitRecordWithExtras

  t.is(validated.replacedAt, 42)
  t.alike(validated, record)
})

test('commit routes plain revoked errors through revoked cleanup', async (t) => {
  let staging: string | null = null
  const storage = createStorage({
    beforeOperation(name, sourcePath) {
      if (name === 'link' && sourcePath === staging) {
        const error: ErrnoError = new Error('Uploader access revoked')
        error.code = ERRORS.REVOKED
        throw error
      }
    }
  })
  const { layout, upload, session } = await createVerifiedSession(t, { storage })
  staging = stagingPath(layout, upload.offer)
  const commits = new CommitStore({ layout, storage })

  await t.exception(() => commits.commit(session), {
    name: 'Error',
    code: ERRORS.REVOKED
  })

  t.is(await pathExists(path.join(layout.root, upload.offer.name)), false)
  t.is(await pathExists(recordPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('retryAbortedAttempt removes only a failed revoked attempt before owner deletion', async (t) => {
  const signal = { aborted: false }
  let staging: string | null = null
  let finalPath: string | null = null
  let failRollback = true
  const storage = createStorage({
    afterOperation(name, sourcePath) {
      if (name === 'link' && sourcePath === staging) signal.aborted = true
    },
    beforeOperation(name, filePath) {
      if (failRollback && name === 'unlink' && filePath === finalPath) {
        throw new Error('Injected rollback failure')
      }
    }
  })
  const created = await createVerifiedSession(t, { storage })
  const { layout, upload, session, sessionStore } = created
  staging = stagingPath(layout, upload.offer)
  finalPath = path.join(layout.root, upload.offer.name)
  const commits = new CommitStore({ layout, storage })

  await t.exception(() => commits.commit(session, { signal }), { name: 'AggregateError' })
  t.is(await pathExists(finalPath), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), true)
  t.is((await readJournal(journalPath(layout, upload.offer))).state, 'aborting')
  t.is(await pathExists(staging), true)

  failRollback = false
  await commits.retryAbortedAttempt(upload.offer.transferId, sessionStore)
  t.is(await pathExists(finalPath), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  await sessionStore.delete(upload.offer.transferId)
  t.is(await pathExists(staging), false)
})

test('retryAbortedAttempt cleans a linearized commit without a live session', async (t) => {
  let failCleanup = false
  let sessionMetadata: string | null = null
  const storage = createStorage({
    beforeOperation(name, filePath) {
      if (!failCleanup || name !== 'unlink' || filePath !== sessionMetadata) return
      failCleanup = false
      throw new Error('Injected post-linearization cleanup failure')
    }
  })
  const created = await createVerifiedSession(t, { storage })
  const { layout, upload, session, sessionStore } = created
  const finalPath = path.join(layout.root, upload.offer.name)
  const sidecarPath = recordPath(layout, upload.offer)
  sessionMetadata = sessionPath(layout, upload.offer)
  const commits = new CommitStore({ layout, storage })
  failCleanup = true
  const record = await commits.commit(session)
  await sessionStore.retireCommitted(upload.offer.transferId)
  const before = await fs.promises.lstat(finalPath)

  const result = (await commits.retryAbortedAttempt(upload.offer.transferId, sessionStore)) as {
    status: string
    record: CommitRecord
  }

  t.is(result.status, 'COMMITTED')
  t.alike(result.record, record)
  t.is(sessionStore.sessions.size, 0)
  t.is(sessionStore.reservedBytes, 0)
  t.alike(await fs.promises.readFile(finalPath), upload.chunk.data)
  t.alike(await readCommitRecord(sidecarPath), record)
  const after = await fs.promises.lstat(finalPath)
  t.is(after.dev, before.dev)
  t.is(after.ino, before.ino)
  t.is(await pathExists(sessionMetadata), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('retryAbortedAttempt leaves foreign final and sidecar state untouched', async (t) => {
  for (const boundary of ['final', 'sidecar']) {
    let failCleanup = false
    let sessionMetadata: string | null = null
    const storage = createStorage({
      beforeOperation(name, filePath) {
        if (!failCleanup || name !== 'unlink' || filePath !== sessionMetadata) return
        failCleanup = false
        throw new Error('Injected post-linearization cleanup failure')
      }
    })
    const created = await createVerifiedSession(t, {
      storage,
      upload: makeUpload({ name: `foreign-${boundary}.bin` })
    })
    const { layout, upload, session, sessionStore } = created
    const finalPath = path.join(layout.root, upload.offer.name)
    const sidecarPath = recordPath(layout, upload.offer)
    sessionMetadata = sessionPath(layout, upload.offer)
    const commits = new CommitStore({ layout, storage })
    failCleanup = true
    await commits.commit(session)

    let expectedFinal = upload.chunk.data
    let expectedSidecar = await readCommitRecord(sidecarPath)
    if (boundary === 'final') {
      expectedFinal = b4a.from('foreign final')
      await fs.promises.unlink(finalPath)
      await fs.promises.writeFile(finalPath, expectedFinal)
    } else {
      expectedSidecar = { ...expectedSidecar, committedAt: expectedSidecar.committedAt + 1 }
      await fs.promises.writeFile(sidecarPath, JSON.stringify(expectedSidecar))
    }
    const journalBefore = await readJournal(journalPath(layout, upload.offer))

    await t.exception(
      () => commits.retryAbortedAttempt(upload.offer.transferId, sessionStore),
      { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID },
      boundary
    )
    t.alike(await fs.promises.readFile(finalPath), expectedFinal, `${boundary} final preserved`)
    t.alike(await readCommitRecord(sidecarPath), expectedSidecar, `${boundary} sidecar preserved`)
    t.alike(
      await readJournal(journalPath(layout, upload.offer)),
      journalBefore,
      `${boundary} journal unchanged`
    )
    t.is(await pathExists(stagingPath(layout, upload.offer)), true, `${boundary} staging retained`)
    t.is(await pathExists(sessionMetadata), true, `${boundary} session retained`)
  }
})

test('initLayout protects the private publication namespace', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const stat = await fs.promises.lstat(layout.publications)

  t.is(layout.publications, path.join(layout.internal, 'publications'))
  t.is(stat.isDirectory(), true)

  const commits = new CommitStore({ layout })
  await fs.promises.rmdir(layout.publications)

  await t.exception(() => commits.list(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('withNameLease serializes one name while distinct names proceed', async (t) => {
  const root = await createTempDir(t)
  const order: string[] = []
  let releaseFirst: (() => void) | null = null
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const serialized = withNameLease(root, MUTABLE, async () => {
    order.push('first-start')
    await first
    order.push('first-end')
  })
  const queued = withNameLease(root, MUTABLE, () => {
    order.push('second-start')
  })
  const concurrent = withNameLease(root, 'manifest.json', () => {
    order.push('other')
  })

  await concurrent
  t.alike(order, ['first-start', 'other'])
  releaseFirst!()
  await Promise.all([serialized, queued])
  t.alike(order, ['first-start', 'other', 'first-end', 'second-start'])

  t.is(await withNameLease(root, MUTABLE, () => 'value'), 'value')
  await t.exception(
    () =>
      withNameLease(root, MUTABLE, () => {
        throw new Error('leased failure')
      }),
    { message: 'leased failure' }
  )
  t.is(await withNameLease(root, MUTABLE, () => 'after failure'), 'after failure')
})

test('inspect reports replaceability only for configured managed mutable names', async (t) => {
  const harness = await createReplacementHarness(t)
  const { commits, replaceNames } = harness

  const first = makeUpload({ name: MUTABLE, data: b4a.from('release one') })
  t.is((await commits.inspect(MUTABLE, first.offer, { replaceNames })).status, 'AVAILABLE')

  await harness.publish(b4a.from('release one'))

  const same = makeUpload({ name: MUTABLE, data: b4a.from('release one') })
  const next = makeUpload({ name: MUTABLE, data: b4a.from('release two') })

  t.is((await commits.inspect(MUTABLE, same.offer, { replaceNames })).status, 'ALREADY_COMMITTED')
  const replaceable = await commits.inspect(MUTABLE, next.offer, { replaceNames })
  t.is(replaceable.status, 'REPLACEABLE')
  t.is(
    replaceable.status === 'REPLACEABLE' ? replaceable.record.sha256 : null,
    hex(sha256(b4a.from('release one')))
  )

  t.is((await commits.inspect(MUTABLE, next.offer)).status, 'FILE_EXISTS')
  t.is(
    (await commits.inspect(MUTABLE, next.offer, { replaceNames: new Set(['other.bin']) })).status,
    'FILE_EXISTS'
  )
})

test('inspect never replaces prefix-sharing or unmanaged mutable paths', async (t) => {
  const harness = await createReplacementHarness(t)
  const { commits, layout, replaceNames } = harness

  await harness.publish(b4a.from('sibling content'), 'release.tar.gz.bak')
  const sibling = makeUpload({ name: 'release.tar.gz.bak', data: b4a.from('sibling next') })
  t.is(
    (await commits.inspect('release.tar.gz.bak', sibling.offer, { replaceNames })).status,
    'FILE_EXISTS'
  )

  await fs.promises.writeFile(path.join(layout.root, MUTABLE), b4a.from('operator artifact'))
  const unmanaged = makeUpload({ name: MUTABLE, data: b4a.from('replacement bytes') })
  t.is((await commits.inspect(MUTABLE, unmanaged.offer, { replaceNames })).status, 'FILE_EXISTS')
  t.alike(
    await fs.promises.readFile(path.join(layout.root, MUTABLE)),
    b4a.from('operator artifact')
  )
})

test('inspect and commit refuse the reserved history namespace', async (t) => {
  const harness = await createReplacementHarness(t)
  const reserved = `history-${'a'.repeat(64)}`
  const upload = makeUpload({ name: reserved, data: b4a.from('reserved') })

  await t.exception(() => harness.commits.inspect(reserved, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
  await t.exception(() => harness.sessionStore.offer(OWNER, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
  t.is(await pathExists(path.join(harness.layout.root, reserved)), false)
})

test('replacement preserves the old inode as history and publishes the new inode', async (t) => {
  const retention: RetentionCall[] = []
  const harness = await createReplacementHarness(t)
  const { commits, layout, sessionStore, replaceNames } = harness
  const oldRecord = await harness.publish(b4a.from('release one'))
  const finalPath = path.join(layout.root, MUTABLE)
  const oldInode = await inode(finalPath)
  const history = path.join(layout.root, historyName(oldRecord.transferId))

  const upload = await harness.stage(b4a.from('release two content'))
  const staging = stagingPath(layout, upload.offer)
  const stagingInode = await inode(staging)
  const retentionManager = {
    run: () => Promise.resolve(),
    afterCommit: () => Promise.resolve(),
    async _runUnlocked(options: { incomingBytes: number; trigger: string }) {
      retention.push({
        incomingBytes: options.incomingBytes,
        trigger: options.trigger,
        names: (await commits.list()).map((record) => record.name).sort()
      })
    },
    async _afterCommitUnlocked() {
      retention.push({
        incomingBytes: 0,
        trigger: 'post-commit',
        names: (await commits.list()).map((record) => record.name).sort()
      })
    }
  }

  const record = await commits.commit(harness.session(upload), {
    replaceNames,
    retentionManager
  })
  await sessionStore.retireCommitted(upload.offer.transferId)

  t.is(record.version, 2)
  t.is(record.name, MUTABLE)
  t.alike(record.replaces, {
    name: MUTABLE,
    transferId: oldRecord.transferId,
    historyName: historyName(oldRecord.transferId)
  })
  t.alike(await fs.promises.readFile(finalPath), b4a.from('release two content'))
  t.is(await inode(finalPath), stagingInode)
  t.alike(await fs.promises.readFile(history), b4a.from('release one'))
  t.is(await inode(history), oldInode)

  t.alike(await readCommitRecord(recordPath(layout, upload.offer)), record)
  t.alike(await readCommitRecord(path.join(layout.commits, `${oldRecord.transferId}.json`)), {
    ...oldRecord,
    name: historyName(oldRecord.transferId)
  })
  t.is(await pathExists(staging), false)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  t.is((await fs.promises.readdir(layout.publications)).length, 0)

  t.alike(
    (await commits.list()).map((entry) => entry.name).sort(),
    [MUTABLE, historyName(oldRecord.transferId)].sort()
  )
  t.alike(retention, [
    { incomingBytes: record.size, trigger: 'commit', names: [MUTABLE] },
    {
      incomingBytes: 0,
      trigger: 'post-commit',
      names: [MUTABLE, historyName(oldRecord.transferId)].sort()
    }
  ])
})

test('replacement of identical verified content publishes nothing new', async (t) => {
  const harness = await createReplacementHarness(t)
  const { commits, layout, replaceNames } = harness
  const record = await harness.publish(b4a.from('release one'))
  const finalPath = path.join(layout.root, MUTABLE)
  const before = await inode(finalPath)

  const upload = await harness.stage(b4a.from('release one'))
  const repeated = await commits.commit(harness.session(upload), { replaceNames })

  t.alike(repeated, record)
  t.is(await inode(finalPath), before)
  t.is(await pathExists(path.join(layout.root, historyName(record.transferId))), false)
  t.alike(await commits.list(), [record])
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.is(await pathExists(sessionPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('repeated replacement dedupes an identical superseded history artifact', async (t) => {
  const harness = await createReplacementHarness(t)
  const { commits, layout, replaceNames } = harness
  const first = await harness.publish(b4a.from('content A'))
  const second = await harness.publish(b4a.from('content B'))
  const historyA = path.join(layout.root, historyName(first.transferId))
  const historyB = path.join(layout.root, historyName(second.transferId))
  t.is(await pathExists(historyA), true)

  const third = await harness.publish(b4a.from('content A'))
  t.is(third.transferId, first.transferId)
  t.is(third.name, MUTABLE)
  t.is(await pathExists(historyB), true)
  t.is(await pathExists(historyA), false)
  t.alike(await fs.promises.readFile(path.join(layout.root, MUTABLE)), b4a.from('content A'))
  t.alike(
    (await commits.list()).map((entry) => entry.name).sort(),
    [MUTABLE, historyName(second.transferId)].sort()
  )
  t.alike(await readCommitRecord(path.join(layout.commits, `${third.transferId}.json`)), third)

  const fourth = await harness.publish(b4a.from('content B'))
  t.is(fourth.transferId, second.transferId)
  t.is(await pathExists(historyA), true)
  t.is(await pathExists(historyB), false)
  t.alike(
    (await commits.list()).map((entry) => entry.name).sort(),
    [MUTABLE, historyName(first.transferId)].sort()
  )
})

test('replacement refuses a foreign path at its history name', async (t) => {
  const harness = await createReplacementHarness(t)
  const { commits, layout, replaceNames } = harness
  const oldRecord = await harness.publish(b4a.from('release one'))
  const history = path.join(layout.root, historyName(oldRecord.transferId))
  await fs.promises.writeFile(history, b4a.from('operator history'))
  const finalInode = await inode(path.join(layout.root, MUTABLE))

  const upload = await harness.stage(b4a.from('release two'))
  await t.exception(() => commits.commit(harness.session(upload), { replaceNames }), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })

  t.alike(await fs.promises.readFile(history), b4a.from('operator history'))
  t.alike(await fs.promises.readFile(path.join(layout.root, MUTABLE)), b4a.from('release one'))
  t.is(await inode(path.join(layout.root, MUTABLE)), finalInode)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(sessionPath(layout, upload.offer)), true)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
})

test('replacement journals every provenance identity before visible mutation', async (t) => {
  let armed = false
  let journalBytes: ReplacementJournal | null = null
  let expectedHistory: string | null = null
  let journalFile: string | null = null
  const storage = createStorage({
    async beforeOperation(name, source, destination) {
      if (!armed || name !== 'link' || destination !== expectedHistory) return
      armed = false
      journalBytes = (await readJson(journalFile!)) as unknown as ReplacementJournal
      throw new Error('Injected history link failure')
    }
  })
  const harness = await createReplacementHarness(t, { storage })
  const { commits, layout, replaceNames } = harness
  const oldRecord = await harness.publish(b4a.from('release one'))
  const finalStat = await fs.promises.lstat(path.join(layout.root, MUTABLE))
  expectedHistory = path.join(layout.root, historyName(oldRecord.transferId))

  const upload = await harness.stage(b4a.from('release two'))
  const stagingStat = await fs.promises.lstat(stagingPath(layout, upload.offer))
  journalFile = journalPath(layout, upload.offer)
  armed = true

  await t.exception(() => commits.commit(harness.session(upload), { replaceNames }))

  const journal = journalBytes!
  t.is(journal.version, 2)
  t.is(journal.intent, 'replace')
  t.is(journal.state, 'committing')
  t.is(journal.phase, 'journaled')
  t.is(journal.name, MUTABLE)
  t.is(journal.historyName, historyName(oldRecord.transferId))
  t.ok(/^[0-9a-f]{64}$/.test(journal.attemptId))
  t.ok(journal.publicationName.startsWith(journal.attemptId))
  t.alike(journal.sourceStagingIdentity, {
    dev: String(stagingStat.dev),
    ino: String(stagingStat.ino)
  })
  t.alike(journal.finalIdentity, { dev: String(finalStat.dev), ino: String(finalStat.ino) })
  t.alike(journal.historyIdentity, journal.finalIdentity)
  t.alike(journal.publicationIdentity, journal.sourceStagingIdentity)
  t.alike(journal.oldRecord, oldRecord)
  t.is(journal.record.transferId, hex(upload.offer.transferId))

  t.alike(await fs.promises.readFile(path.join(layout.root, MUTABLE)), b4a.from('release one'))
  t.is(await pathExists(expectedHistory), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is(await pathExists(journalFile), false)
})

test('replacement revoked before its history link restores the pinned old artifact', async (t) => {
  const signal = { aborted: false }
  let historyPath: string | null = null
  const storage = createStorage({
    afterOperation(name, source, destination) {
      if (name === 'link' && destination === historyPath) signal.aborted = true
    }
  })
  const harness = await createReplacementHarness(t, { storage })
  const { layout, commits, replaceNames } = harness
  const old = await harness.publish(b4a.from('release one'))
  const finalPath = path.join(layout.root, MUTABLE)
  const oldInode = await inode(finalPath)
  historyPath = path.join(layout.root, `history-${old.transferId}`)
  const upload = await harness.stage(b4a.from('release two'))

  await t.exception(() => commits.commit(harness.session(upload), { replaceNames, signal }), {
    name: 'SwarmDeployError',
    code: ERRORS.REVOKED
  })

  t.alike(await fs.promises.readFile(finalPath), b4a.from('release one'))
  t.is(await inode(finalPath), oldInode)
  t.is(await pathExists(historyPath), false)
  t.is(await pathExists(recordPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is((await fs.promises.readdir(layout.publications)).length, 0)
  t.alike(await commits.list(), [old])
})

test('replacement revoked after its final rename restores the old inode from history', async (t) => {
  const signal = { aborted: false }
  let finalPath: string | null = null
  const storage = createStorage({
    afterOperation(name, source, destination) {
      if (name === 'rename' && destination === finalPath) signal.aborted = true
    }
  })
  const harness = await createReplacementHarness(t, { storage })
  const { layout, commits, replaceNames } = harness
  const old = await harness.publish(b4a.from('release one'))
  const historyPath = path.join(layout.root, `history-${old.transferId}`)
  const oldInode = await inode(path.join(layout.root, MUTABLE))
  const upload = await harness.stage(b4a.from('release two'))
  finalPath = path.join(layout.root, MUTABLE)

  await t.exception(() => commits.commit(harness.session(upload), { replaceNames, signal }), {
    name: 'SwarmDeployError',
    code: ERRORS.REVOKED
  })

  t.alike(await fs.promises.readFile(finalPath), b4a.from('release one'))
  t.is(await inode(finalPath), oldInode)
  t.is(await pathExists(historyPath), false)
  t.is(await pathExists(recordPath(layout, upload.offer)), false)
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), true)
  t.is((await fs.promises.readdir(layout.publications)).length, 0)
  t.alike(await commits.list(), [old])
})

test('revocation after the new sidecar cannot unpublish the replacement', async (t) => {
  const signal = { aborted: false }
  let armed = false
  let commitsDir: string | null = null
  const storage = createStorage({
    afterOperation(name, source) {
      if (armed && name === 'sync' && source === commitsDir) signal.aborted = true
    }
  })
  const harness = await createReplacementHarness(t, { storage })
  const { layout, commits, replaceNames } = harness
  commitsDir = layout.commits
  const old = await harness.publish(b4a.from('release one'))
  const historyPath = path.join(layout.root, `history-${old.transferId}`)
  const upload = await harness.stage(b4a.from('release two'))

  armed = true
  const record = await commits.commit(harness.session(upload), { replaceNames, signal })

  t.is(record.version, 2)
  t.alike(await fs.promises.readFile(path.join(layout.root, MUTABLE)), b4a.from('release two'))
  t.alike(await fs.promises.readFile(historyPath), b4a.from('release one'))
  t.is(await pathExists(journalPath(layout, upload.offer)), false)
  t.is(await pathExists(stagingPath(layout, upload.offer)), false)
  t.alike(
    (await commits.list()).map((entry) => entry.name).sort(),
    [MUTABLE, `history-${old.transferId}`].sort()
  )
})
