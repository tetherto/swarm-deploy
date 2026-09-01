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

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
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

    const linearized = point === 'staging link removed' || point === 'journal removed'
    if (linearized) await commits.commit(created.session)
    else await t.exception(() => commits.commit(created.session))
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

    if (!linearized) {
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

test('recovery rejects a shape-valid journal fingerprint that disagrees with the session', async (t) => {
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
  await fs.promises.link(expected.staging, expected.final)
  const journal = await readJson(expected.journal)
  journal.record.uploaderFingerprint = '0'.repeat(64)
  await fs.promises.writeFile(expected.journal, JSON.stringify(journal))
  await created.sessionStore.close()

  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(results[0].status, 'CORRUPT')
  t.is(await pathExists(expected.record), false)
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
  t.is(await pathExists(corrupt), false)
  t.ok(
    (await fs.promises.readdir(layout.journals)).some((name) =>
      name.startsWith(`.${'0'.repeat(64)}.corrupt-`)
    )
  )
})

test('recovery propagates corrupt resumable metadata from SessionStore', async (t) => {
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
  await t.exception(() =>
    recoverStorage({
      layout,
      sessionStore: created.sessionStore,
      commitStore: commits,
      logger: { warn() {} }
    })
  )
  t.is(await pathExists(expected.session), true)
  t.is(await pathExists(expected.staging), true)
  t.is(await pathExists(expected.journal), true)
})

test('recoverStorage invoked twice after cleanup-pending commit preserves final and sidecar', async (t) => {
  let layout = null
  let armed = false
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'unlink' && filePath === expected.session) {
        armed = false
        throw new Error('Injected cleanup failure after commit linearization')
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  armed = true
  await commits.commit(created.session)
  await created.sessionStore.close()

  const first = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })
  const finalBytes = await fs.promises.readFile(expected.final)
  const sidecar = await fs.promises.readFile(expected.record)
  const second = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(first.length, 1)
  t.is(first[0].status, 'COMMITTED')
  t.alike(second, [])
  t.alike(await fs.promises.readFile(expected.final), finalBytes)
  t.alike(await fs.promises.readFile(expected.record), sidecar)
  t.is(await pathExists(expected.staging), false)
  t.is(await pathExists(expected.session), false)
  t.is(await pathExists(expected.journal), false)
})

test('concurrent same-transfer commits cannot let the journal loser remove the winner journal', async (t) => {
  const created = await createVerifiedSession(t)
  const expected = paths(created.layout, created.upload.offer)
  const winnerAtPublication = deferred()
  const loserAtPublication = deferred()
  const winnerPublished = deferred()
  const loserCleaned = deferred()
  let winnerTemporary = null
  let loserTemporary = null

  const winnerStorage = createStorage({
    async beforeOperation(name, source, destination) {
      if (name !== 'link' || destination !== expected.journal) return
      winnerTemporary = source
      winnerAtPublication.resolve()
      await loserAtPublication.promise
    },
    async afterOperation(name, source, destination) {
      if (name !== 'link' || destination !== expected.journal) return
      winnerPublished.resolve()
      await loserCleaned.promise
      throw new Error('Injected winner crash after journal publication')
    }
  })
  const loserStorage = createStorage({
    async beforeOperation(name, source, destination) {
      if (name !== 'link' || destination !== expected.journal) return
      loserTemporary = source
      loserAtPublication.resolve()
      await winnerAtPublication.promise
      await winnerPublished.promise
    },
    async afterOperation(name, filePath) {
      if (name === 'unlink' && filePath === loserTemporary) loserCleaned.resolve()
    }
  })
  const winner = new CommitStore({
    layout: created.layout,
    clock: created.clock,
    storage: winnerStorage
  })
  const loser = new CommitStore({
    layout: created.layout,
    clock: created.clock,
    storage: loserStorage
  })

  const outcomes = await Promise.allSettled([
    winner._commit(created.session),
    loser._commit(created.session)
  ])
  const journal = await readJson(expected.journal)
  const winnerAttemptId = path.basename(winnerTemporary).split('.')[2]

  t.is(outcomes[0].status, 'rejected')
  t.is(outcomes[1].status, 'rejected')
  t.is(journal.attemptId, winnerAttemptId)
  t.is(await pathExists(winnerTemporary), false)
  t.is(await pathExists(loserTemporary), false)
  t.is(await pathExists(expected.journal), true)

  const results = await recoverStorage({
    layout: created.layout,
    sessionStore: created.sessionStore,
    commitStore: winner,
    logger: { warn() {} }
  })
  t.is(results.length, 1)
  t.is(results[0].status, 'RESUMABLE')
  t.is(await pathExists(expected.journal), false)
  t.is(await pathExists(expected.staging), true)
  t.is(await pathExists(expected.session), true)
  t.is(await pathExists(expected.final), false)
  await created.sessionStore.close()
})

test('recovery converges after session metadata unlink before staging cleanup', async (t) => {
  let layout = null
  let expected = null
  let armed = false
  const storage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'unlink' && filePath === expected.session) {
        armed = false
        throw new Error('Injected crash after session metadata unlink')
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  expected = paths(layout, created.upload.offer)
  const unrelatedStaging = path.join(layout.staging, `${'f'.repeat(64)}.part`)
  const unrelatedSession = path.join(layout.sessions, `${'f'.repeat(64)}.json`)
  await fs.promises.writeFile(unrelatedStaging, b4a.from('unrelated staging'))
  await fs.promises.writeFile(unrelatedSession, b4a.from('unrelated session'))
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  armed = true
  await commits.commit(created.session)
  t.is(await pathExists(expected.session), false)
  t.is(await pathExists(expected.staging), true)
  t.is(await pathExists(expected.journal), true)
  await created.sessionStore.close()

  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(results.length, 1)
  t.is(results[0].status, 'COMMITTED')
  t.alike(await fs.promises.readFile(expected.final), created.upload.chunk.data)
  t.alike((await readJson(expected.record)).sha256, hex(created.upload.offer.digest))
  t.is(await pathExists(expected.staging), false)
  t.is(await pathExists(expected.session), false)
  t.is(await pathExists(expected.journal), false)
  t.alike(await fs.promises.readFile(unrelatedStaging), b4a.from('unrelated staging'))
  t.alike(await fs.promises.readFile(unrelatedSession), b4a.from('unrelated session'))
})

test('recovery propagates cleanup directory fsync failure and a retry converges', async (t) => {
  let layout = null
  let crashCommit = false
  let failCleanupSync = false
  const cleanupFailure = new Error('Injected cleanup parent fsync failure')
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (crashCommit && name === 'unlink' && filePath === expected.session) {
        crashCommit = false
        throw new Error('Injected cleanup failure after commit linearization')
      }
      if (failCleanupSync && name === 'sync' && filePath === layout.sessions) {
        failCleanupSync = false
        throw cleanupFailure
      }
    }
  })
  const created = await createVerifiedSession(t, storage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const commits = new CommitStore({ layout, clock: created.clock, storage })

  crashCommit = true
  await commits.commit(created.session)
  await created.sessionStore.close()

  failCleanupSync = true
  let caught = null
  try {
    await recoverStorage({
      layout,
      sessionStore: created.sessionStore,
      commitStore: commits,
      logger: { warn() {} }
    })
  } catch (err) {
    caught = err
  }
  t.is(caught, cleanupFailure)
  t.is(await pathExists(expected.journal), true)

  const results = await recoverStorage({
    layout,
    sessionStore: created.sessionStore,
    commitStore: commits,
    logger: { warn() {} }
  })
  t.is(results.length, 1)
  t.is(results[0].status, 'COMMITTED')
  t.alike(await fs.promises.readFile(expected.final), created.upload.chunk.data)
  t.is(await pathExists(expected.record), true)
  t.is(await pathExists(expected.staging), false)
  t.is(await pathExists(expected.session), false)
  t.is(await pathExists(expected.journal), false)
})

test('recovery aborts on journal EIO without continuing to a later valid journal', async (t) => {
  let layout = null
  let armed = false
  const setupStorage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'sync' && filePath === layout.journals) {
        armed = false
        throw new Error('Injected crash after journal publication')
      }
    }
  })
  const created = await createVerifiedSession(t, setupStorage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const earlierJournal = path.join(layout.journals, `${'0'.repeat(64)}.json`)
  const eio = new Error('Injected journal read failure')
  eio.code = 'EIO'
  const warnings = []
  const recoveryStorage = createStorage({
    async beforeOperation(name, filePath) {
      if (name === 'read' && filePath === earlierJournal) throw eio
    }
  })

  armed = true
  const setupCommits = new CommitStore({ layout, clock: created.clock, storage: setupStorage })
  await t.exception(() => setupCommits.commit(created.session))
  await fs.promises.writeFile(earlierJournal, '{}')
  await created.sessionStore.close()

  let caught = null
  try {
    await recoverStorage({
      layout,
      sessionStore: created.sessionStore,
      commitStore: new CommitStore({
        layout,
        clock: created.clock,
        storage: recoveryStorage
      }),
      logger: {
        warn(message, detail) {
          warnings.push({ message, detail })
        }
      }
    })
  } catch (err) {
    caught = err
  }

  t.is(caught, eio)
  t.is(warnings.length, 0)
  t.is(await pathExists(earlierJournal), true)
  t.is(await pathExists(expected.journal), true)
  t.is(await pathExists(expected.final), false)
  t.is(await pathExists(expected.staging), true)
  t.is(await pathExists(expected.session), true)
})

test('recovery aborts on uncoded storage-safety errors without reporting corruption', async (t) => {
  let layout = null
  let armed = false
  const setupStorage = createStorage({
    async afterOperation(name, filePath) {
      if (armed && name === 'sync' && filePath === layout.journals) {
        armed = false
        throw new Error('Injected crash after journal publication')
      }
    }
  })
  const created = await createVerifiedSession(t, setupStorage)
  layout = created.layout
  const expected = paths(layout, created.upload.offer)
  const storageSafetyFailure = new Error('Injected directory replacement safety failure')
  const warnings = []
  let journalStats = 0
  const recoveryStorage = createStorage({
    async beforeOperation(name, filePath) {
      if (name !== 'stat' || filePath !== expected.journal) return
      journalStats++
      if (journalStats === 2) throw storageSafetyFailure
    }
  })

  armed = true
  const setupCommits = new CommitStore({ layout, clock: created.clock, storage: setupStorage })
  await t.exception(() => setupCommits.commit(created.session))
  await created.sessionStore.close()

  let caught = null
  try {
    await recoverStorage({
      layout,
      sessionStore: created.sessionStore,
      commitStore: new CommitStore({
        layout,
        clock: created.clock,
        storage: recoveryStorage
      }),
      logger: {
        warn(message, detail) {
          warnings.push({ message, detail })
        }
      }
    })
  } catch (err) {
    caught = err
  }

  t.is(caught, storageSafetyFailure)
  t.is(caught.code, undefined)
  t.is(warnings.length, 0)
  t.is(await pathExists(expected.journal), true)
  t.is(await pathExists(expected.final), false)
})
