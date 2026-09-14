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
import type { CommitRecord } from '../../dist/storage/commit-journal.js'
import { prepareStorageRecovery, recoverStorage } from '../../dist/storage/recovery.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import type { MetadataRecord } from '../../dist/tar-protocol/controls.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 7)
const MUTABLE = 'release.tar.gz'
const OLD_BYTES = b4a.from('old direct TAR payload')
const NEW_BYTES = b4a.from('new direct TAR payload')
const MUTATIONS = new Set(['link', 'rename', 'unlink', 'rmdir', 'rm', 'write', 'sync', 'truncate'])

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
  stage(content: Buffer, name?: string): Promise<TarSession>
  publish(content: Buffer, name?: string): Promise<CommitRecord>
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
  name: string
): Promise<{ metadata: MetadataRecord; archive: Buffer }> {
  const sourceRoot = await createTempDir(t)
  const source = path.join(sourceRoot, name)
  await fs.promises.writeFile(source, content)
  const manifest = await buildTarManifest(source, OWNER)
  return { metadata: metadataFromManifest(manifest), archive: await archive(manifest) }
}

async function createHarness(t: Assert, storage: TestStorage = createStorage()): Promise<Harness> {
  const layout = initLayout(await createTempDir(t))
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 1024 * 1024, storage })
  await sessions.init()
  t.teardown(() => sessions.close())
  const commits = new CommitStore({ layout, storage, logger: { warn() {} } })

  async function stage(content: Buffer, name = MUTABLE): Promise<TarSession> {
    const input = await tarInput(t, content, name)
    await sessions.admit(OWNER, input.metadata)
    await sessions.append(OWNER, input.metadata, 0, input.archive)
    return sessions.verify(OWNER, input.metadata)
  }

  return {
    layout,
    sessions,
    commits,
    stage,
    async publish(content: Buffer, name = MUTABLE): Promise<CommitRecord> {
      const session = await stage(content, name)
      const record = await commits.commit(session, { replaceNames: [name] })
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
  const oldRecord = await harness.publish(OLD_BYTES)
  const next = await harness.stage(NEW_BYTES)
  paths = pathsFor(harness.layout, oldRecord, id(next))
  armed = true
  await harness.commits.commit(next, { replaceNames: [MUTABLE] }).then(
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
  t.is((await readRecord(paths.record)).version, 2, `${label} v2 sidecar`)
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
    const retried = await commits.commit(await sessions.readVerified(transferId(crash.id)), {
      replaceNames: [MUTABLE]
    })
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
