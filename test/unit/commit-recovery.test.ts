/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { historyName } from '../../dist/files.js'
import { initLayout } from '../../dist/storage/layout.js'
import { TarSessionStore, type TarSession } from '../../dist/storage/tar-session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import {
  DIRECTORY_JOURNAL_VERSION,
  readCommitJournal,
  serializeJournal,
  type AnyCommitJournal,
  type CommitRecord
} from '../../dist/storage/commit-journal.js'
import { prepareStorageRecovery, recoverStorage } from '../../dist/storage/recovery.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import type { MetadataRecord } from '../../dist/tar-protocol/controls.js'
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'
import { writeTree } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 7)
const MUTABLE = 'release.tar.gz'
const OLD_BYTES = b4a.from('old direct TAR payload')
const NEW_BYTES = b4a.from('new direct TAR payload')
const OLD_RELEASE = { series: 'api', version: '2.4.0' }
const RELEASE = { series: 'api', version: '2.4.1' }
const MUTATIONS = new Set(['link', 'rename', 'unlink', 'rmdir', 'rm', 'write', 'sync', 'truncate'])

type ReleaseCoordinates = { series: string; version?: string }

type ReplacementBoundary =
  | 'journal-durable'
  | 'history-linked'
  | 'final-renamed'
  | 'current-sidecar-renamed'
  | 'history-sidecar-durable'

type CreateBoundary = 'journal-durable' | 'final-linked' | 'sidecar-renamed'

interface Paths {
  final: string
  history: string
  staging: string
  tar: string
  session: string
  journal: string
  record: string
  oldRecord: string
}

interface Harness {
  layout: StorageLayout
  sessions: TarSessionStore
  commits: CommitStore
  stage(content: Buffer, name?: string, sourceParent?: string): Promise<TarSession>
  stageTree(name: string, spec: Record<string, string>): Promise<TarSession>
  publish(
    content: Buffer,
    name?: string,
    release?: ReleaseCoordinates,
    sourceParent?: string
  ): Promise<CommitRecord>
}

interface CrashedReplacement {
  layout: StorageLayout
  oldRecord: CommitRecord
  id: string
  paths: Paths
}

function id(session: TarSession): string {
  return session.id
}

function transferId(value: string): Buffer {
  return b4a.from(value, 'hex')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function archive(manifest: TarManifest): Promise<Buffer> {
  const chunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return b4a.concat(chunks)
}

async function tarInput(
  t: Assert,
  content: Buffer,
  name: string,
  sourceParent = 'release'
): Promise<{ metadata: MetadataRecord; archive: Buffer }> {
  const sourceRoot = await createTempDir(t)
  const releaseRoot = path.join(sourceRoot, sourceParent)
  await fs.promises.mkdir(releaseRoot)
  const source = path.join(releaseRoot, name)
  await fs.promises.writeFile(source, content)
  const manifest = await buildTarManifest(source, OWNER)
  return { metadata: metadataFromManifest(manifest), archive: await archive(manifest) }
}

function commitRelease(
  commits: CommitStore,
  session: TarSession,
  {
    replaceNames,
    release
  }: { replaceNames?: Iterable<string>; release?: ReleaseCoordinates | null } = {}
): Promise<CommitRecord> {
  return commits.commit(session, { replaceNames, release })
}

async function createHarness(t: Assert, storage: TestStorage = createStorage()): Promise<Harness> {
  const layout = initLayout(await createTempDir(t))
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 1024 * 1024, storage })
  await sessions.init()
  t.teardown(() => sessions.close())
  const commits = new CommitStore({ layout, storage, logger: { warn() {} } })

  async function stage(
    content: Buffer,
    name = MUTABLE,
    sourceParent = 'release'
  ): Promise<TarSession> {
    const input = await tarInput(t, content, name, sourceParent)
    await sessions.admit(OWNER, input.metadata)
    await sessions.append(OWNER, input.metadata, 0, input.archive)
    return sessions.verify(OWNER, input.metadata)
  }

  async function stageTree(name: string, spec: Record<string, string>): Promise<TarSession> {
    const sourceRoot = await createTempDir(t)
    await writeTree(path.join(sourceRoot, name), spec)
    const manifest = await buildTreeManifest(path.join(sourceRoot, name), OWNER)
    const metadata = treeMetadataFromManifest(manifest)
    const chunks: Buffer[] = []
    await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    await sessions.admit(OWNER, metadata)
    await sessions.append(OWNER, metadata, 0, b4a.concat(chunks))
    return sessions.verify(OWNER, metadata)
  }

  return {
    layout,
    sessions,
    commits,
    stage,
    stageTree,
    async publish(
      content: Buffer,
      name = MUTABLE,
      release?: ReleaseCoordinates,
      sourceParent = 'release'
    ): Promise<CommitRecord> {
      const session = await stage(content, name, sourceParent)
      const record = await commitRelease(commits, session, { replaceNames: [name], release })
      await sessions.retireCommitted(session.transferId)
      return record
    }
  }
}

function pathsFor(layout: StorageLayout, oldRecord: CommitRecord, nextId: string): Paths {
  return {
    final: path.join(layout.root, MUTABLE),
    history: path.join(layout.root, historyName(oldRecord.transferId)),
    staging: path.join(layout.staging, `${nextId}.part`),
    tar: path.join(layout.staging, `${nextId}.tar.part`),
    session: path.join(layout.sessions, `${nextId}.json`),
    journal: path.join(layout.journals, `${nextId}.json`),
    record: path.join(layout.commits, `${nextId}.json`),
    oldRecord: path.join(layout.commits, `${oldRecord.transferId}.json`)
  }
}

async function readRecord(filePath: string): Promise<CommitRecord> {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as CommitRecord
}

async function restart(layout: StorageLayout): Promise<TarSessionStore> {
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 1024 * 1024 })
  await sessions.init()
  return sessions
}

async function crashReplacement(
  t: Assert,
  boundary: ReplacementBoundary
): Promise<CrashedReplacement> {
  let armed = false
  let crashed = false
  let paths: Paths | null = null
  let commitSyncs = 0
  const storage = createStorage({
    beforeOperation(name) {
      if (crashed && MUTATIONS.has(name)) throw new Error('process stopped at crash boundary')
    },
    afterOperation(name, source, destination) {
      if (!armed || crashed || paths === null) return
      if (name === 'sync' && source === path.dirname(paths.record)) commitSyncs++
      const hit =
        (boundary === 'journal-durable' &&
          name === 'sync' &&
          source === path.dirname(paths.journal)) ||
        (boundary === 'history-linked' && name === 'link' && destination === paths.history) ||
        (boundary === 'final-renamed' && name === 'rename' && destination === paths.final) ||
        (boundary === 'current-sidecar-renamed' &&
          name === 'rename' &&
          destination === paths.record) ||
        (boundary === 'history-sidecar-durable' &&
          name === 'sync' &&
          source === path.dirname(paths.record) &&
          commitSyncs === 2)
      if (!hit) return
      crashed = true
      throw new Error(`crash at ${boundary}`)
    }
  })
  const harness = await createHarness(t, storage)
  const oldRecord = await harness.publish(OLD_BYTES, MUTABLE, OLD_RELEASE, OLD_RELEASE.version)
  const next = await harness.stage(NEW_BYTES, MUTABLE, RELEASE.version)
  paths = pathsFor(harness.layout, oldRecord, id(next))
  armed = true
  await commitRelease(harness.commits, next, {
    replaceNames: [MUTABLE],
    release: RELEASE
  }).then(
    () => undefined,
    () => undefined
  )
  t.ok(crashed, `${boundary} reached`)
  await harness.sessions.close()
  return { layout: harness.layout, oldRecord, id: id(next), paths }
}

async function assertCommittedReplacement(
  t: Assert,
  crash: CrashedReplacement,
  commits: CommitStore,
  label: string
): Promise<void> {
  const { paths, oldRecord } = crash
  t.alike(await fs.promises.readFile(paths.final), NEW_BYTES, `${label} current`)
  t.alike(await fs.promises.readFile(paths.history), OLD_BYTES, `${label} history`)
  const current = await readRecord(paths.record)
  t.is(current.version, 2, `${label} v2 sidecar`)
  t.alike(current.release, RELEASE, `${label} current release`)
  t.alike(await readRecord(paths.oldRecord), {
    ...oldRecord,
    name: historyName(oldRecord.transferId)
  })
  t.alike(
    (await commits.list()).map((record) => record.name).sort(),
    [MUTABLE, historyName(oldRecord.transferId)].sort(),
    `${label} exact records`
  )
  for (const leftover of [paths.staging, paths.tar, paths.session, paths.journal]) {
    t.is(await exists(leftover), false, `${label} cleaned ${path.basename(leftover)}`)
  }
  t.is((await fs.promises.readdir(crash.layout.publications)).length, 0, `${label} publications`)
}

test('pre-linearized direct-TAR replacement recovery restores old current and remains retryable', async (t) => {
  for (const boundary of ['history-linked', 'final-renamed'] as const) {
    const crash = await crashReplacement(t, boundary)
    const sessions = await restart(crash.layout)
    const commits = new CommitStore({ layout: crash.layout })
    const results = await recoverStorage({
      layout: crash.layout,
      sessionStore: sessions,
      commitStore: commits,
      logger: { warn() {} }
    })

    t.is(results[0].status, 'RESUMABLE', boundary)
    t.alike(await fs.promises.readFile(crash.paths.final), OLD_BYTES, `${boundary} old current`)
    t.alike(await readRecord(crash.paths.oldRecord), crash.oldRecord, `${boundary} old sidecar`)
    t.is(await exists(crash.paths.history), false, `${boundary} history removed`)
    t.is(await exists(crash.paths.record), false, `${boundary} new sidecar removed`)
    for (const retained of [crash.paths.staging, crash.paths.tar, crash.paths.session]) {
      t.is(await exists(retained), true, `${boundary} retained ${path.basename(retained)}`)
    }
    const retried = await commitRelease(
      commits,
      await sessions.readVerified(transferId(crash.id)),
      {
        replaceNames: [MUTABLE],
        release: RELEASE
      }
    )
    t.is(retried.version, 2, `${boundary} retry`)
    await assertCommittedReplacement(t, crash, commits, `${boundary} retry`)
    await sessions.close()
  }
})

test('post-linearized direct-TAR replacement recovery preserves exact current and history', async (t) => {
  for (const boundary of ['current-sidecar-renamed', 'history-sidecar-durable'] as const) {
    const crash = await crashReplacement(t, boundary)
    const sessions = await restart(crash.layout)
    const commits = new CommitStore({ layout: crash.layout })
    const result = await commits.recoverJournal(crash.id, sessions)

    t.is(result.status, 'COMMITTED', boundary)
    await assertCommittedReplacement(t, crash, commits, boundary)
    await sessions.close()
  }
})

test('direct-TAR replacement recovery is idempotent after convergence', async (t) => {
  const crash = await crashReplacement(t, 'current-sidecar-renamed')
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })

  const first = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    logger: { warn() {} }
  })
  const second = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(first[0].status, 'COMMITTED')
  t.is(second.length, 0)
  await assertCommittedReplacement(t, crash, commits, 'rerun')
  await sessions.close()
})

test('commit release identity survives sidecars, replacement history, and A-B-A dedup', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(OLD_BYTES, MUTABLE, OLD_RELEASE, OLD_RELEASE.version)
  t.alike(first.release, OLD_RELEASE)
  t.alike(
    (await readRecord(path.join(harness.layout.commits, `${first.transferId}.json`))).release,
    OLD_RELEASE
  )

  const second = await harness.publish(NEW_BYTES, MUTABLE, RELEASE, RELEASE.version)
  t.alike(second.release, RELEASE)
  t.alike(
    (await readRecord(path.join(harness.layout.commits, `${first.transferId}.json`))).release,
    OLD_RELEASE
  )

  const returning = await harness.stage(OLD_BYTES, MUTABLE, OLD_RELEASE.version)
  t.is(returning.id, first.transferId)
  const third = await commitRelease(harness.commits, returning, {
    replaceNames: [MUTABLE],
    release: OLD_RELEASE
  })
  await harness.sessions.retireCommitted(returning.transferId)
  t.alike(third.release, OLD_RELEASE)
  const records = await harness.commits.list()
  const current = records.find((record) => record.name === MUTABLE)
  const history = records.find((record) => record.name === historyName(second.transferId))
  t.alike(current?.release, OLD_RELEASE)
  t.alike(history?.release, RELEASE)
})

test('commit snapshots and validates release coordinates before publication', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stage(NEW_BYTES, 'snapshot.bin', RELEASE.version)
  await t.exception(
    commitRelease(harness.commits, session, {
      release: { series: '../api', version: RELEASE.version }
    }),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  await t.exception(
    commitRelease(harness.commits, session, {
      release: { series: 'api', version: 'v2.4.1' }
    }),
    { code: ERRORS.PROTOCOL_INVALID }
  )

  const mutable = { ...RELEASE }
  const committed = commitRelease(harness.commits, session, { release: mutable })
  mutable.series = 'changed'
  t.alike((await committed).release, RELEASE)
})

function snapshot(...paths: string[]): Promise<Buffer[]> {
  return Promise.all(paths.map((filePath) => fs.promises.readFile(filePath)))
}

test('same transfer and content cannot add, remove, or change release identity', async (t) => {
  const changed = { series: 'api', version: '9.9.9' }
  const variants = [
    { label: 'added', first: undefined, next: RELEASE },
    { label: 'removed', first: RELEASE, next: undefined },
    { label: 'changed', first: RELEASE, next: changed }
  ] as const
  for (const { label, first, next } of variants) {
    const harness = await createHarness(t)
    const committed = await harness.publish(NEW_BYTES, MUTABLE, first, RELEASE.version)
    const sidecar = path.join(harness.layout.commits, `${committed.transferId}.json`)
    const final = path.join(harness.layout.root, MUTABLE)
    const before = await snapshot(sidecar, final)

    const again = await harness.stage(NEW_BYTES, MUTABLE, RELEASE.version)
    t.is(again.id, committed.transferId, `${label} same transfer`)
    await t.exception(
      commitRelease(harness.commits, again, { replaceNames: [MUTABLE], release: next }),
      { code: ERRORS.PROTOCOL_INVALID, message: /release identity/i },
      `${label} mutable conflict`
    )
    await t.exception(
      commitRelease(harness.commits, again, { release: next }),
      { code: ERRORS.FILE_EXISTS },
      `${label} create-only conflict`
    )
    t.alike(await snapshot(sidecar, final), before, `${label} unchanged`)
    t.alike((await readRecord(sidecar)).release, first, `${label} identity preserved`)
    t.is(await exists(path.join(harness.layout.root, historyName(committed.transferId))), false)
    t.is((await harness.commits.list()).length, 1, `${label} one managed record`)

    const idempotent = await commitRelease(harness.commits, again, {
      replaceNames: [MUTABLE],
      release: first
    })
    t.alike(idempotent, committed, `${label} identical identity stays idempotent`)
  }
})

test('returning A-B-A content with different release identity conflicts instead of deduping', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(OLD_BYTES, MUTABLE, OLD_RELEASE, OLD_RELEASE.version)
  await harness.publish(NEW_BYTES, MUTABLE, RELEASE, RELEASE.version)
  const historyPath = path.join(harness.layout.root, historyName(first.transferId))
  const sidecar = path.join(harness.layout.commits, `${first.transferId}.json`)
  const before = await snapshot(sidecar, historyPath)

  const returning = await harness.stage(OLD_BYTES, MUTABLE, OLD_RELEASE.version)
  await t.exception(
    commitRelease(harness.commits, returning, {
      replaceNames: [MUTABLE],
      release: { series: 'api', version: '9.9.9' }
    }),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.alike(await snapshot(sidecar, historyPath), before)
  t.alike((await readRecord(sidecar)).release, OLD_RELEASE)
})

interface CreateCrash {
  harness: Harness
  session: TarSession
  id: string
  final: string
  journal: string
  record: string
  staging: string
}

async function crashCreate(
  t: Assert,
  boundary: CreateBoundary,
  release: ReleaseCoordinates | null = RELEASE
): Promise<CreateCrash> {
  let armed = false
  let crashed = false
  let final = ''
  let journal = ''
  let record = ''
  const storage = createStorage({
    beforeOperation(name) {
      if (crashed && MUTATIONS.has(name)) throw new Error('process stopped at crash boundary')
    },
    afterOperation(name, source, destination) {
      if (!armed || crashed) return
      const hit =
        (boundary === 'journal-durable' && name === 'sync' && source === path.dirname(journal)) ||
        (boundary === 'final-linked' && name === 'link' && destination === final) ||
        (boundary === 'sidecar-renamed' && name === 'rename' && destination === record)
      if (!hit) return
      crashed = true
      throw new Error(`crash at ${boundary}`)
    }
  })
  const harness = await createHarness(t, storage)
  const session = await harness.stage(b4a.from(`create ${boundary}`), `${boundary}.bin`, '2.4.1')
  final = path.join(harness.layout.root, session.name)
  journal = path.join(harness.layout.journals, `${session.id}.json`)
  record = path.join(harness.layout.commits, `${session.id}.json`)
  const staging = path.join(harness.layout.staging, `${session.id}.part`)
  armed = true
  await commitRelease(harness.commits, session, { release }).then(
    () => undefined,
    () => undefined
  )
  t.ok(crashed, `${boundary} reached`)
  return { harness, session, id: session.id, final, journal, record, staging }
}

async function recoverCreate(crash: CreateCrash) {
  await crash.harness.sessions.close()
  const sessions = await restart(crash.harness.layout)
  const commits = new CommitStore({ layout: crash.harness.layout })
  return {
    sessions,
    commits,
    recover: () =>
      recoverStorage({
        layout: crash.harness.layout,
        sessionStore: sessions,
        commitStore: commits,
        logger: { warn() {} }
      })
  }
}

test('create-path journal recovery preserves release coordinates through real serialization', async (t) => {
  for (const boundary of ['journal-durable', 'final-linked', 'sidecar-renamed'] as const) {
    const crash = await crashCreate(t, boundary)
    const raw = JSON.parse(await fs.promises.readFile(crash.journal, 'utf8'))
    t.alike(raw.record.release, RELEASE, `${boundary} durable journal release`)
    const parsed = await readCommitJournal(crash.id, crash.harness.layout, createStorage())
    t.alike(parsed?.record.release, RELEASE, `${boundary} parsed journal release`)
    t.alike(serializeJournal(parsed as AnyCommitJournal), raw, `${boundary} serialize round trip`)

    const { sessions, commits, recover } = await recoverCreate(crash)
    const results = await recover()
    t.is(results.length, 1)
    t.alike(results[0].record?.release, RELEASE, `${boundary} recovery result release`)
    if (boundary === 'journal-durable') {
      t.is(results[0].status, 'RESUMABLE')
      const retried = await commits.commit(await sessions.readVerified(crash.session.transferId), {
        release: RELEASE
      })
      t.alike(retried.release, RELEASE, `${boundary} retry release`)
    } else {
      t.is(results[0].status, 'COMMITTED', boundary)
    }
    t.alike((await readRecord(crash.record)).release, RELEASE, `${boundary} sidecar release`)
    t.alike(
      (await commits.list()).map((record) => record.release),
      [RELEASE],
      `${boundary} listed release`
    )
    await sessions.close()
  }
})

test('create-path crash without release recovers without inventing release identity', async (t) => {
  const crash = await crashCreate(t, 'final-linked', null)
  const { sessions, commits, recover } = await recoverCreate(crash)
  t.is((await recover())[0].status, 'COMMITTED')
  const stored = await readRecord(crash.record)
  t.is(Object.prototype.hasOwnProperty.call(stored, 'release'), false)
  t.is((await commits.list())[0].release, undefined)
  await sessions.close()
})

test('retry with different release never mutates a pending create journal', async (t) => {
  const crash = await crashCreate(t, 'journal-durable')
  const before = await fs.promises.readFile(crash.journal)
  const { sessions, commits } = await recoverCreate(crash)
  const session = await sessions.readVerified(crash.session.transferId)
  for (const release of [{ series: 'api', version: '9.9.9' }, { series: 'api' }, null]) {
    await t.exception(commits.commit(session, { release }), { code: ERRORS.PROTOCOL_INVALID })
    t.alike(await fs.promises.readFile(crash.journal), before, 'journal bytes unchanged')
  }
  await sessions.close()
})

test('recovery conflicts when a sidecar release differs from the create journal', async (t) => {
  const tampered = [
    {
      label: 'changed',
      apply: (record: CommitRecord) => ({ ...record, release: { series: 'api', version: '9.9.9' } })
    },
    {
      label: 'removed',
      apply: (record: CommitRecord) => {
        const { release: _release, ...rest } = record
        return rest
      }
    }
  ]
  for (const { label, apply } of tampered) {
    const crash = await crashCreate(t, 'sidecar-renamed')
    const original = await readRecord(crash.record)
    await fs.promises.writeFile(crash.record, JSON.stringify(apply(original)))
    const { sessions, recover } = await recoverCreate(crash)
    await t.exception(recover(), { code: ERRORS.PROTOCOL_INVALID }, `${label} sidecar conflict`)
    t.is(await exists(crash.journal), true, `${label} journal retained`)
    t.alike(
      (await readRecord(crash.record)).release,
      (apply(original) as CommitRecord).release,
      `${label} sidecar not rewritten`
    )
    await sessions.close()
  }
})

test('recovered committed create-path release cannot be changed by a later same-transfer retry', async (t) => {
  const crash = await crashCreate(t, 'sidecar-renamed')
  const { sessions, commits, recover } = await recoverCreate(crash)
  t.is((await recover())[0].status, 'COMMITTED')
  const before = await fs.promises.readFile(crash.record)
  const input = await tarInput(
    t,
    b4a.from('create sidecar-renamed'),
    'sidecar-renamed.bin',
    '2.4.1'
  )
  await sessions.admit(OWNER, input.metadata)
  await sessions.append(OWNER, input.metadata, 0, input.archive)
  const again = await sessions.verify(OWNER, input.metadata)
  t.is(again.id, crash.id)
  await t.exception(
    commitRelease(commits, again, { release: { series: 'api', version: '9.9.9' } }),
    { code: ERRORS.FILE_EXISTS }
  )
  await t.exception(
    commitRelease(commits, again, {
      replaceNames: ['sidecar-renamed.bin'],
      release: { series: 'api', version: '9.9.9' }
    }),
    { code: ERRORS.PROTOCOL_INVALID, message: /release identity/i }
  )
  t.alike(await fs.promises.readFile(crash.record), before, 'sidecar unchanged')
  await sessions.close()
})

test('replacement recovery rejects changed staging provenance without publishing attacker bytes', async (t) => {
  const crash = await crashReplacement(t, 'journal-durable')
  await fs.promises.unlink(crash.paths.staging)
  await fs.promises.writeFile(crash.paths.staging, b4a.from('attacker-controlled staging'))
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })

  const results = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    logger: { warn() {} }
  })

  t.is(results[0].status, 'CORRUPT')
  t.alike(await fs.promises.readFile(crash.paths.final), OLD_BYTES)
  t.is(await exists(crash.paths.history), false)
  t.is(await exists(crash.paths.record), false)
  t.alike(await fs.promises.readFile(crash.paths.staging), b4a.from('attacker-controlled staging'))
  t.is(await exists(crash.paths.journal), false)
  await sessions.close()
})

test('replacement recovery never overwrites an unmanaged current destination', async (t) => {
  const crash = await crashReplacement(t, 'history-linked')
  await fs.promises.unlink(crash.paths.final)
  await fs.promises.writeFile(crash.paths.final, b4a.from('operator-owned current'))
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })

  await t.exception(
    () =>
      recoverStorage({
        layout: crash.layout,
        sessionStore: sessions,
        commitStore: commits,
        logger: { warn() {} }
      }),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.alike(await fs.promises.readFile(crash.paths.final), b4a.from('operator-owned current'))
  t.alike(await fs.promises.readFile(crash.paths.history), OLD_BYTES)
  t.is(await exists(crash.paths.journal), true)
  t.is(await exists(crash.paths.staging), true)
  t.is(await exists(crash.paths.tar), true)
  await sessions.close()
})

test('replacement commit never overwrites an unmanaged pre-existing history path', async (t) => {
  const harness = await createHarness(t)
  const oldRecord = await harness.publish(OLD_BYTES)
  const history = path.join(harness.layout.root, historyName(oldRecord.transferId))
  await fs.promises.writeFile(history, b4a.from('operator-owned history'))
  const next = await harness.stage(NEW_BYTES)
  const paths = pathsFor(harness.layout, oldRecord, id(next))

  await t.exception(() => harness.commits.commit(next, { replaceNames: [MUTABLE] }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(paths.final), OLD_BYTES)
  t.alike(await fs.promises.readFile(history), b4a.from('operator-owned history'))
  t.is(await exists(paths.journal), false)
  t.is(await exists(paths.staging), true)
  t.is(await exists(paths.tar), true)
  t.is(await exists(paths.session), true)
})

test('corrupt replacement journal retirement preserves verified direct-TAR staging ownership', async (t) => {
  const crash = await crashReplacement(t, 'history-linked')
  await fs.promises.writeFile(crash.paths.journal, '{"version":2,"phase":')
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })

  const results = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    logger: { warn() {} }
  })
  t.is(results[0].status, 'CORRUPT')
  t.is(await exists(crash.paths.journal), false)
  t.is(await exists(crash.paths.staging), true)
  t.is(await exists(crash.paths.tar), true)
  t.is(await exists(crash.paths.session), true)
  t.alike(await fs.promises.readFile(crash.paths.final), OLD_BYTES)
  t.alike(await fs.promises.readFile(crash.paths.history), OLD_BYTES)
  await sessions.close()

  const orphan = 'f'.repeat(64)
  const orphanJournal = path.join(crash.layout.journals, `${orphan}.json`)
  const orphanStaging = path.join(crash.layout.staging, `${orphan}.part`)
  const orphanTar = path.join(crash.layout.staging, `${orphan}.tar.part`)
  await fs.promises.writeFile(orphanJournal, '{"version":2')
  await fs.promises.writeFile(orphanStaging, 'orphan file staging')
  await fs.promises.writeFile(orphanTar, 'orphan TAR evidence')
  t.is(await prepareStorageRecovery({ layout: crash.layout, commitStore: commits }), 1)
  t.is(await exists(orphanStaging), false)
  t.alike(await fs.promises.readFile(orphanTar), b4a.from('orphan TAR evidence'))
})

test('create-only direct-TAR crash boundaries leave only resumable or committed bytes', async (t) => {
  for (const boundary of [
    'journal-durable',
    'final-linked',
    'sidecar-renamed'
  ] as const satisfies readonly CreateBoundary[]) {
    let armed = false
    let crashed = false
    let final = ''
    let journal = ''
    let record = ''
    const storage = createStorage({
      beforeOperation(name) {
        if (crashed && MUTATIONS.has(name)) throw new Error('process stopped at crash boundary')
      },
      afterOperation(name, source, destination) {
        if (!armed || crashed) return
        const hit =
          (boundary === 'journal-durable' && name === 'sync' && source === path.dirname(journal)) ||
          (boundary === 'final-linked' && name === 'link' && destination === final) ||
          (boundary === 'sidecar-renamed' && name === 'rename' && destination === record)
        if (!hit) return
        crashed = true
        throw new Error(`crash at ${boundary}`)
      }
    })
    const harness = await createHarness(t, storage)
    const session = await harness.stage(b4a.from(`create ${boundary}`), `${boundary}.bin`)
    final = path.join(harness.layout.root, session.name)
    journal = path.join(harness.layout.journals, `${session.id}.json`)
    record = path.join(harness.layout.commits, `${session.id}.json`)
    const staging = path.join(harness.layout.staging, `${session.id}.part`)
    const tar = path.join(harness.layout.staging, `${session.id}.tar.part`)
    const metadata = path.join(harness.layout.sessions, `${session.id}.json`)
    armed = true
    await harness.commits.commit(session).then(
      () => undefined,
      () => undefined
    )
    t.ok(crashed, `${boundary} reached`)
    await harness.sessions.close()

    const restarted = await restart(harness.layout)
    const commits = new CommitStore({ layout: harness.layout })
    const results = await recoverStorage({
      layout: harness.layout,
      sessionStore: restarted,
      commitStore: commits,
      logger: { warn() {} }
    })
    const resumable = boundary === 'journal-durable'
    t.is(results[0].status, resumable ? 'RESUMABLE' : 'COMMITTED', boundary)
    t.is(await exists(journal), false, `${boundary} journal`)
    if (resumable) {
      t.is(await exists(final), false, `${boundary} no visible artifact`)
      t.is(await exists(record), false, `${boundary} no sidecar`)
      t.is(await exists(staging), true, `${boundary} verified staging`)
      t.is(await exists(tar), true, `${boundary} TAR staging`)
      t.is(await exists(metadata), true, `${boundary} session`)
    } else {
      t.alike(
        await fs.promises.readFile(final),
        b4a.from(`create ${boundary}`),
        `${boundary} committed artifact`
      )
      t.is(await exists(record), true, `${boundary} sidecar`)
      t.is(await exists(staging), false, `${boundary} file staging`)
      t.is(await exists(tar), false, `${boundary} TAR staging`)
      t.is(await exists(metadata), false, `${boundary} session`)
    }
    await restarted.close()
  }
})

function offerFor(
  session: TarSession,
  release: ReleaseCoordinates | null | undefined
): Parameters<CommitStore['inspect']>[1] {
  return {
    name: session.name,
    size: session.size,
    digest: session.digest,
    transferId: transferId(session.id),
    ...(release === undefined ? {} : { release })
  }
}

test('inspect reports ALREADY_COMMITTED only when transfer and release identity agree', async (t) => {
  const other = { series: 'api', version: '9.9.9' }
  for (const [label, committed] of [
    ['released', RELEASE],
    ['legacy', undefined]
  ] as const) {
    const harness = await createHarness(t)
    const name = `${label}.bin`
    const session = await harness.stage(NEW_BYTES, name, RELEASE.version)
    const record = await commitRelease(harness.commits, session, { release: committed })
    await harness.sessions.retireCommitted(session.transferId)
    const offered = (release: ReleaseCoordinates | null): Promise<{ status: string }> =>
      harness.commits.inspect(name, offerFor(session, release))

    t.is((await offered(committed ?? null)).status, 'ALREADY_COMMITTED', `${label} agrees`)
    t.alike(
      (await harness.commits.inspect(name, offerFor(session, committed ?? null))) as unknown,
      { status: 'ALREADY_COMMITTED', record },
      `${label} record`
    )
    for (const different of committed ? [null, other, { series: 'api' }] : [RELEASE]) {
      t.is(
        (await offered(different)).status,
        'FILE_EXISTS',
        `${label} ${JSON.stringify(different)}`
      )
    }
  }
})

test('inspect fails closed when a mutable transfer is offered with another release identity', async (t) => {
  const harness = await createHarness(t)
  const record = await harness.publish(NEW_BYTES, MUTABLE, RELEASE, RELEASE.version)
  const session = await harness.stage(NEW_BYTES, MUTABLE, RELEASE.version)
  t.is(session.id, record.transferId)

  t.is(
    (
      await harness.commits.inspect(MUTABLE, offerFor(session, RELEASE), {
        replaceNames: [MUTABLE]
      })
    ).status,
    'ALREADY_COMMITTED'
  )
  for (const different of [null, { series: 'api', version: '9.9.9' }]) {
    await t.exception(
      harness.commits.inspect(MUTABLE, offerFor(session, different), { replaceNames: [MUTABLE] }),
      { code: ERRORS.PROTOCOL_INVALID, message: /release identity/i },
      JSON.stringify(different)
    )
  }
})

test('identical bytes under a different matched release replace a mutable name and keep history', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(NEW_BYTES, MUTABLE, OLD_RELEASE, OLD_RELEASE.version)
  const second = await harness.stage(NEW_BYTES, MUTABLE, RELEASE.version)
  t.not(second.id, first.transferId)

  const inspected = await harness.commits.inspect(MUTABLE, offerFor(second, RELEASE), {
    replaceNames: [MUTABLE]
  })
  t.alike(inspected as unknown, { status: 'REPLACEABLE', record: first })

  const committed = await commitRelease(harness.commits, second, {
    replaceNames: [MUTABLE],
    release: RELEASE
  })
  await harness.sessions.retireCommitted(second.transferId)
  t.alike(committed.release, RELEASE)
  t.alike(
    (await harness.commits.list()).map((record) => record.release?.version).sort(),
    [OLD_RELEASE.version, RELEASE.version].sort()
  )
  t.alike(
    await fs.promises.readFile(path.join(harness.layout.root, historyName(first.transferId))),
    NEW_BYTES
  )
})

test('identical bytes with unchanged release stay idempotent for a different transfer', async (t) => {
  const harness = await createHarness(t)
  const countOnly = { series: 'api' }
  const first = await harness.publish(NEW_BYTES, MUTABLE, countOnly, '2.4.0')
  const second = await harness.stage(NEW_BYTES, MUTABLE, '2.4.1')
  t.not(second.id, first.transferId)

  t.alike(
    (await harness.commits.inspect(MUTABLE, offerFor(second, countOnly), {
      replaceNames: [MUTABLE]
    })) as unknown,
    { status: 'ALREADY_COMMITTED', record: first }
  )
})

test('legacy current with identical bytes is replaceable by a matched release', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(NEW_BYTES, MUTABLE, undefined, '2.4.0')
  const second = await harness.stage(NEW_BYTES, MUTABLE, '2.4.1')

  t.alike(
    (await harness.commits.inspect(MUTABLE, offerFor(second, RELEASE), {
      replaceNames: [MUTABLE]
    })) as unknown,
    { status: 'REPLACEABLE', record: first }
  )
  t.alike(
    (await harness.commits.inspect(MUTABLE, offerFor(second, null), {
      replaceNames: [MUTABLE]
    })) as unknown,
    { status: 'ALREADY_COMMITTED', record: first }
  )
})

test('a directory commit publishes by rename and persists a version 3 record', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', {
    'a/b.bin': 'bb',
    'a/empty/': '',
    'z.bin': 'z'
  })
  const record = await harness.commits.commit(session)
  t.is(record.version, 3)
  t.is(record.kind, 'directory')
  t.is(record.name, '0.18.1')
  t.is(record.entryCount, 4)
  t.is(record.size, 3)
  t.is(record.replaces, undefined)
  const finalPath = path.join(harness.layout.root, '0.18.1')
  t.ok((await fs.promises.lstat(finalPath)).isDirectory())
  t.alike((await fs.promises.readdir(finalPath)).sort(), ['a', 'z.bin'])
  await t.exception(() =>
    fs.promises.lstat(path.join(harness.layout.staging, `${record.transferId}.tree`))
  )
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(
    (await harness.commits.list()).map((value) => value.name),
    ['0.18.1']
  )
})

test('a directory artifact is create-only and never changes kind', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  await harness.commits.commit(first)
  await harness.sessions.retireCommitted(first.transferId)

  const second = await harness.stageTree('0.18.1', { 'a.bin': 'b' })
  await t.exception(() => harness.commits.commit(second), { code: ERRORS.FILE_EXISTS })
  await harness.sessions.retireCommitted(second.transferId)
  const replaceAttempt = await harness.stageTree('0.18.1', { 'a.bin': 'c' })
  await t.exception(() => harness.commits.commit(replaceAttempt, { replaceNames: ['0.18.1'] }), {
    code: ERRORS.FILE_EXISTS
  })
  await harness.sessions.retireCommitted(replaceAttempt.transferId)

  const asFile = await harness.stage(b4a.from('file'), '0.18.1')
  await t.exception(() => harness.commits.commit(asFile), { code: ERRORS.FILE_EXISTS })
  await harness.sessions.retireCommitted(asFile.transferId)

  const fileFirst = await harness.stage(b4a.from('file'), 'plain.bin')
  await harness.commits.commit(fileFirst)
  await harness.sessions.retireCommitted(fileFirst.transferId)
  const dirSecond = await harness.stageTree('plain.bin', { 'a.bin': 'a' })
  await t.exception(() => harness.commits.commit(dirSecond), { code: ERRORS.FILE_EXISTS })
})

test('an unchanged directory offer is already committed and a mutated one is not', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  const record = await harness.commits.commit(session)
  const offer = {
    name: record.name,
    kind: 'directory' as const,
    size: record.size,
    entryCount: record.entryCount,
    digest: b4a.from(record.sha256, 'hex'),
    transferId: b4a.from(record.transferId, 'hex')
  }
  t.alike(await harness.commits.inspect(record.name, offer), {
    status: 'ALREADY_COMMITTED',
    record
  })
  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1', 'a.bin'), 'mutated')
  t.alike(await harness.commits.inspect(record.name, offer), { status: 'FILE_EXISTS' })
})

type DirectoryBoundary = 'tree-renamed' | 'renamed-phase' | 'sidecar-phase'

interface DirectoryCrash {
  layout: StorageLayout
  session: TarSession
  id: string
  final: string
  journal: string
  record: string
  stagingTree: string
}

async function crashDirectory(t: Assert, boundary: DirectoryBoundary): Promise<DirectoryCrash> {
  let armed = false
  let crashed = false
  let final = ''
  let journal = ''
  let record = ''
  let treeRenamed = false
  const storage = createStorage({
    beforeOperation(name) {
      if (crashed && MUTATIONS.has(name)) throw new Error('process stopped at crash boundary')
    },
    afterOperation(name, source, destination) {
      if (!armed || crashed) return
      if (name === 'rename' && destination === final) treeRenamed = true
      const hit =
        (boundary === 'tree-renamed' && name === 'rename' && destination === final) ||
        (boundary === 'renamed-phase' &&
          treeRenamed &&
          name === 'sync' &&
          source === path.dirname(journal)) ||
        (boundary === 'sidecar-phase' && name === 'sync' && source === path.dirname(record))
      if (!hit) return
      crashed = true
      throw new Error(`crash at ${boundary}`)
    }
  })
  const harness = await createHarness(t, storage)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  final = path.join(harness.layout.root, session.name)
  journal = path.join(harness.layout.journals, `${session.id}.json`)
  record = path.join(harness.layout.commits, `${session.id}.json`)
  const stagingTree = path.join(harness.layout.staging, `${session.id}.tree`)
  armed = true
  await harness.commits.commit(session).then(
    () => undefined,
    () => undefined
  )
  t.ok(crashed, `${boundary} reached`)
  await harness.sessions.close()
  return {
    layout: harness.layout,
    session,
    id: session.id,
    final,
    journal,
    record,
    stagingTree
  }
}

async function restartDirectoryCrash(crash: DirectoryCrash) {
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })
  return {
    sessions,
    commits,
    recover: () =>
      recoverStorage({
        layout: crash.layout,
        sessionStore: sessions,
        commitStore: commits,
        logger: { warn() {} }
      })
  }
}

test('directory restart survives a missing staging tree while a commit journal is open', async (t) => {
  for (const boundary of ['tree-renamed', 'renamed-phase', 'sidecar-phase'] as const) {
    const crash = await crashDirectory(t, boundary)
    const { sessions, commits, recover } = await restartDirectoryCrash(crash)
    const results = await recover()
    t.is(results.length, 1, boundary)
    t.is(results[0].status, 'COMMITTED', boundary)
    t.ok((await fs.promises.lstat(crash.final)).isDirectory(), `${boundary} final tree`)
    t.ok(await exists(crash.record), `${boundary} sidecar`)
    t.is(await exists(crash.journal), false, `${boundary} journal`)
    t.is(await exists(crash.stagingTree), false, `${boundary} staging tree`)
    t.is(await exists(path.join(crash.layout.sessions, `${crash.id}.json`)), false, boundary)
    t.alike(
      (await commits.list()).map((entry) => entry.name),
      ['0.18.1'],
      boundary
    )
    await sessions.close()
  }
})

test('directory recovery rolls back an unauthorized rename before the sidecar exists', async (t) => {
  const crash = await crashDirectory(t, 'renamed-phase')
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })
  const results = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    isAuthorized: () => false,
    logger: { warn() {} }
  })
  t.is(results[0].status, 'RESUMABLE')
  t.is(await exists(crash.final), false)
  t.ok((await fs.promises.lstat(crash.stagingTree)).isDirectory())
  t.is(await exists(crash.record), false)
  await sessions.close()
})

test('directory recovery stays committed after the sidecar is durable even when unauthorized', async (t) => {
  const crash = await crashDirectory(t, 'sidecar-phase')
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout })
  const results = await recoverStorage({
    layout: crash.layout,
    sessionStore: sessions,
    commitStore: commits,
    isAuthorized: () => false,
    logger: { warn() {} }
  })
  t.is(results[0].status, 'COMMITTED')
  t.ok((await fs.promises.lstat(crash.final)).isDirectory())
  t.ok(await exists(crash.record))
  await sessions.close()
})

test('a directory commit can retry after abort once the journal is written', async (t) => {
  let journalSeen = false
  const controller = { aborted: false }
  const signal = {
    get aborted() {
      return controller.aborted
    },
    addEventListener() {},
    removeEventListener() {}
  }
  const storage = createStorage({
    afterOperation(name, source) {
      if (name === 'sync' && source.endsWith('journals')) journalSeen = true
    },
    beforeOperation(name) {
      if (journalSeen && name === 'rename') controller.aborted = true
    }
  })
  const harness = await createHarness(t, storage)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  await t.exception(() => harness.commits.commit(session, { signal }), { code: ERRORS.ABORTED })
  t.is(await exists(path.join(harness.layout.journals, `${session.id}.json`)), false)
  const retried = await harness.commits.commit(session)
  t.is(retried.name, '0.18.1')
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
})

test('a directory tree with a forbidden entry is reported as FILE_EXISTS on re-offer', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  const record = await harness.commits.commit(session)
  await harness.sessions.retireCommitted(session.transferId)
  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1', '.cache'), 'x')
  const offer = {
    name: record.name,
    kind: 'directory' as const,
    size: record.size,
    entryCount: record.entryCount,
    digest: b4a.from(record.sha256, 'hex'),
    transferId: b4a.from(record.transferId, 'hex')
  }
  t.alike(await harness.commits.inspect(record.name, offer), { status: 'FILE_EXISTS' })
})

test('a directory recovery refuses an unmanaged path at the artifact name', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  const record = await harness.commits.commit(session)
  await fs.promises.unlink(path.join(harness.layout.commits, `${record.transferId}.json`))
  const attemptId = 'a'.repeat(64)
  await fs.promises.writeFile(
    path.join(harness.layout.journals, `${record.transferId}.json`),
    JSON.stringify(
      serializeJournal({
        version: DIRECTORY_JOURNAL_VERSION,
        intent: 'create-directory',
        state: 'committing',
        phase: 'renamed',
        transferId: record.transferId,
        attemptId,
        name: record.name,
        stagingTreeName: `${record.transferId}.tree`,
        stagingTreeIdentity: { dev: '0', ino: '0' },
        record
      })
    )
  )
  await fs.promises.rm(path.join(harness.layout.root, '0.18.1'), { recursive: true })
  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1'), 'foreign')
  await t.exception(() => harness.commits.recoverJournal(session.id, harness.sessions), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is(await fs.promises.readFile(path.join(harness.layout.root, '0.18.1'), 'utf8'), 'foreign')
})
