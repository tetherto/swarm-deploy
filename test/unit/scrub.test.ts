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
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { RetentionManager } from '../../dist/storage/retention.js'
import { recoverStorage } from '../../dist/storage/recovery.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { createClock, type TestClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 7)
const CHUNK_SIZE = 1024 * 1024

interface ErrnoError extends Error {
  code?: string
}

interface TestLogger {
  info?: (message: string, details: Record<string, unknown>) => void
  warn?: (message: string, details: Record<string, unknown>) => void
  error?: (message: string, details: Record<string, unknown>) => void
}

interface LoggedWarning {
  message: string
  details: Record<string, unknown>
}

/** The chunk fields the stores read; the transfer ID is passed separately. */
interface HarnessChunk {
  index: number
  data: Buffer
  digest: Digest
}

interface HarnessUpload {
  offer: Offer
  chunk: HarnessChunk
}

interface CreateStoresOptions {
  storage?: TestStorage
  isSessionActive?: (session: { state: string }) => boolean
  logger?: TestLogger
}

interface Stores {
  layout: StorageLayout
  clock: TestClock
  sessionStore: SessionStore
  commitStore: CommitStore
  manager: RetentionManager
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

function makeUpload(name: string, data: Buffer): HarnessUpload {
  const offer = {
    version: 1,
    name,
    size: data.byteLength,
    digest: sha256(data),
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  return {
    offer: {
      ...offer,
      transferId: transferId({
        clientPublicKey: OWNER,
        name,
        size: offer.size,
        digest: offer.digest,
        chunkSize: CHUNK_SIZE
      })
    },
    chunk: { index: 0, data, digest: sha256(data) }
  }
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

async function createFifo(filePath: string): Promise<boolean> {
  let execFile!: typeof import('node:child_process').execFile
  try {
    ;({ execFile } = require('child_process') as typeof import('node:child_process'))
  } catch {
    return false
  }
  await new Promise<void>((resolve, reject) => {
    execFile('mkfifo', [filePath], (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  return true
}

async function createStores(
  t: Assert,
  { storage, isSessionActive = () => false, logger }: CreateStoresOptions = {}
): Promise<Stores> {
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

async function commit(
  t: Assert,
  stores: Stores,
  name: string,
  data: Buffer
): Promise<{ record: CommitRecord; finalPath: string }> {
  const upload = makeUpload(name, data)
  await stores.sessionStore.offer(OWNER, upload.offer)
  await stores.sessionStore.writeChunk(upload.offer.transferId, asChunk(upload.chunk))
  await stores.sessionStore.finish(upload.offer.transferId)
  const record = await stores.commitStore.commit(
    stores.sessionStore.sessions.get(hex(upload.offer.transferId))!
  )
  return { record, finalPath: path.join(stores.layout.root, name) }
}

test('startup recovery fully hashes valid managed finals and reports unknown roots', async (t) => {
  let reads = 0
  let finalPath: string | null = null
  const storage = createStorage({
    beforeOperation(name, filePath) {
      if (name === 'read' && filePath === finalPath) reads++
    }
  })
  const stores = await createStores(t, { storage })
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  finalPath = valid.finalPath
  const unknown = path.join(stores.layout.root, 'operator-note.txt')
  await fs.promises.writeFile(unknown, b4a.from('preserve me'))
  const warnings: LoggedWarning[] = []

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
  const warnings: LoggedWarning[] = []
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
  let finalPath: string | null = null
  let replaced = false
  let displacedRoot: string | null = null
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (replaced || name !== 'open' || filePath !== finalPath) return
      replaced = true
      displacedRoot = `${path.dirname(filePath)}-displaced`
      await fs.promises.rename(path.dirname(filePath), displacedRoot)
      await fs.promises.mkdir(path.dirname(filePath))
      await fs.promises.link(path.join(displacedRoot, path.basename(filePath)), filePath)
    }
  })
  const stores = await createStores(t, { storage })
  const valid = await commit(t, stores, 'valid.bin', b4a.from('valid'))
  finalPath = valid.finalPath
  t.teardown(() =>
    fs.promises.rm(displacedRoot as unknown as string, { recursive: true, force: true })
  )

  await t.exception(() => stores.manager.scrubCommitted(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('scheduled retention uses lstat metadata without rehashing healthy finals', async (t) => {
  let reads = 0
  let finalPath: string | null = null
  const storage = createStorage({
    beforeOperation(name, filePath) {
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

/** Leaves a crashed replacement whose old sidecar still claims the mutable name. */
async function crashAfterNewSidecar(t: Assert): Promise<{
  layout: StorageLayout
  commitStore: CommitStore
  manager: RetentionManager
  current: CommitRecord
  superseded: CommitRecord
  journalPath: string
}> {
  const layout = initLayout(await createTempDir(t))
  const clock = createClock()
  const replaceNames = new Set(['release.tar.gz'])
  let crashed = false
  let armed = false
  const storage = createStorage({
    beforeOperation(name) {
      if (crashed && name !== 'lstat' && name !== 'stat' && name !== 'readdir' && name !== 'open') {
        throw new Error('Storage stopped at crash point')
      }
    },
    afterOperation(name, source) {
      if (!armed || crashed || name !== 'sync' || source !== layout.commits) return
      crashed = true
      throw new Error('Injected crash after the new current sidecar')
    }
  })
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    clock,
    storage,
    replaceNames
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commitStore = new CommitStore({ layout, clock, storage })

  const publish = async (data: Buffer): Promise<CommitRecord> => {
    const upload = makeUpload('release.tar.gz', data)
    await sessionStore.offer(OWNER, upload.offer)
    await sessionStore.writeChunk(upload.offer.transferId, asChunk(upload.chunk))
    await sessionStore.finish(upload.offer.transferId)
    const session = sessionStore.sessions.get(hex(upload.offer.transferId))!
    const record = await commitStore.commit(session, { replaceNames })
    await sessionStore.retireCommitted(upload.offer.transferId)
    return record
  }

  const superseded = await publish(b4a.from('release one'))
  const upload = makeUpload('release.tar.gz', b4a.from('release two'))
  await sessionStore.offer(OWNER, upload.offer)
  await sessionStore.writeChunk(upload.offer.transferId, asChunk(upload.chunk))
  await sessionStore.finish(upload.offer.transferId)
  armed = true
  await t.exception(() =>
    commitStore.commit(sessionStore.sessions.get(hex(upload.offer.transferId))!, { replaceNames })
  )

  const reader = new CommitStore({ layout, clock })
  const manager = new RetentionManager({
    layout,
    sessionStore,
    commitStore: reader,
    clock,
    isSessionActive: () => false
  })
  const current = await reader.list()
  t.is(current.length, 2, 'the crash left both sidecars on disk')
  return {
    layout,
    commitStore: reader,
    manager,
    current: current.find((record) => record.name === 'release.tar.gz')!,
    superseded,
    journalPath: path.join(layout.journals, `${hex(upload.offer.transferId)}.json`)
  }
}

test('scrub tolerates a journal-owned duplicate name and reports no unknown paths', async (t) => {
  const crashed = await crashAfterNewSidecar(t)

  const records = await crashed.commitStore.list()
  t.alike(
    records.map((record) => record.name).sort(),
    ['release.tar.gz', `history-${crashed.superseded.transferId}`].sort()
  )
  t.is(
    records.reduce((total, record) => total + record.size, 0),
    22
  )

  const scrub = await crashed.manager.scrubCommitted()
  t.is(scrub.deleted, 0)
  t.alike(scrub.unknown, [])
  t.is(scrub.records.length, 2)
  t.is(await pathExists(path.join(crashed.layout.root, 'release.tar.gz')), true)
  t.is(
    await pathExists(path.join(crashed.layout.root, `history-${crashed.superseded.transferId}`)),
    true
  )
})

test('enumeration rejects a duplicate name no journal explains', async (t) => {
  const crashed = await crashAfterNewSidecar(t)
  await fs.promises.unlink(crashed.journalPath)

  await t.exception(() => crashed.commitStore.list(), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => crashed.manager.scrubCommitted())
})

test('deletion tolerates the journal-owned rename of a superseded record', async (t) => {
  const crashed = await crashAfterNewSidecar(t)
  const history = (await crashed.commitStore.list()).find((record) =>
    record.name.startsWith('history-')
  )!

  t.is(await crashed.commitStore.delete(history), true)

  t.is(await pathExists(path.join(crashed.layout.root, history.name)), false)
  t.is(await pathExists(path.join(crashed.layout.root, 'release.tar.gz')), true)
  t.alike(
    (await crashed.commitStore.list()).map((record) => record.name),
    ['release.tar.gz']
  )
})
