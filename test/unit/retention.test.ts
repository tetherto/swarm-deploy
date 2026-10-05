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
import { RetentionManager } from '../../dist/storage/retention.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import type { MetadataRecord } from '../../dist/tar-protocol/controls.js'
import { createClock, type TestClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 101)
const MUTABLE = 'release.tar.gz'

type RetentionOptions = ConstructorParameters<typeof RetentionManager>[0]

interface RetentionEvent {
  type: 'retention'
  trigger: string
  status: 'completed' | 'deferred' | 'failed'
  reason?: string
  expiredSessions?: number
  scrubbed?: number
  ageDeleted?: number
  storageDeleted?: number
  countDeleted?: number
  versionDeleted?: number
}

interface ReleaseCoordinates {
  series: string
  version?: string
}

interface FakeTimer {
  callback: () => void
}

interface TestScheduler {
  setInterval(callback: () => void): FakeTimer
  clearInterval(timer: unknown): void
  tick(): void
}

interface Harness {
  layout: StorageLayout
  clock: TestClock
  sessions: TarSessionStore
  commits: CommitStore
  input(name: string, content: Buffer): Promise<{ metadata: MetadataRecord; archive: Buffer }>
  stage(name: string, content: Buffer): Promise<TarSession>
  publish(
    name: string,
    content: Buffer,
    mutable?: boolean,
    release?: ReleaseCoordinates
  ): Promise<CommitRecord>
  manager(options?: Partial<RetentionOptions>): RetentionManager
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

function createScheduler(): TestScheduler {
  const timers = new Set<FakeTimer>()
  return {
    setInterval(callback) {
      const timer = { callback }
      timers.add(timer)
      return timer
    },
    clearInterval(timer) {
      timers.delete(timer as FakeTimer)
    },
    tick() {
      for (const timer of timers) timer.callback()
    }
  }
}

async function createHarness(
  t: Assert,
  {
    storage = createStorage(),
    maxStagingBytes = 1024 * 1024
  }: { storage?: TestStorage; maxStagingBytes?: number } = {}
): Promise<Harness> {
  const layout = initLayout(await createTempDir(t))
  const clock = createClock()
  const sessions = new TarSessionStore({ layout, maxStagingBytes, clock, storage })
  await sessions.init()
  t.teardown(() => sessions.close())
  const commits = new CommitStore({ layout, clock, storage })

  async function input(
    name: string,
    content: Buffer
  ): Promise<{ metadata: MetadataRecord; archive: Buffer }> {
    const source = path.join(await createTempDir(t), name)
    await fs.promises.writeFile(source, content)
    const manifest = await buildTarManifest(source, OWNER)
    return { metadata: metadataFromManifest(manifest), archive: await archive(manifest) }
  }

  async function stage(name: string, content: Buffer): Promise<TarSession> {
    const tar = await input(name, content)
    await sessions.admit(OWNER, tar.metadata)
    await sessions.append(OWNER, tar.metadata, 0, tar.archive)
    return sessions.verify(OWNER, tar.metadata)
  }

  return {
    layout,
    clock,
    sessions,
    commits,
    input,
    stage,
    async publish(name, content, mutable = false, release) {
      const session = await stage(name, content)
      const record = await commits.commit(session, {
        ...(mutable ? { replaceNames: [name] } : {}),
        ...(release === undefined ? {} : { release })
      })
      await sessions.retireCommitted(session.transferId)
      return record
    },
    manager(options = {}) {
      return new RetentionManager({
        layout,
        sessionStore: sessions,
        commitStore: commits,
        clock,
        storage,
        isSessionActive: () => false,
        ...options
      })
    }
  }
}

test('quota counts current and history once and evicts equal-age eligible names deterministically', async (t) => {
  const harness = await createHarness(t)
  const removed: string[] = []
  const ordinary = await harness.publish('zeta.bin', b4a.from('zz'))
  const superseded = await harness.publish(MUTABLE, b4a.from('aa'), true)
  harness.clock.advance(1)
  const current = await harness.publish(MUTABLE, b4a.from('bb'), true)
  const manager = harness.manager({
    maxStorageBytes: 6,
    isPinned: (record) => record.name === MUTABLE,
    logger: {
      info(_message, details) {
        removed.push(details.name as string)
      }
    }
  })

  t.is((await manager.run()).storageDeleted, 0, 'current plus history total exactly six bytes')
  t.is(
    (await harness.commits.list()).reduce((total, record) => total + record.size, 0),
    6
  )
  t.is((await manager.run({ incomingBytes: 4 })).storageDeleted, 2)
  t.alike(removed, [historyName(superseded.transferId), ordinary.name])
  t.alike(await harness.commits.list(), [current])
})

test('replaceable current stays pinned while history and create-only current age out', async (t) => {
  const harness = await createHarness(t)
  const superseded = await harness.publish(MUTABLE, b4a.from('old'), true)
  const current = await harness.publish(MUTABLE, b4a.from('new'), true)
  const createOnly = await harness.publish('ordinary.bin', b4a.from('ordinary'))
  const manager = harness.manager({
    maxAge: 10,
    isPinned: (record) => record.name === MUTABLE
  })
  harness.clock.advance(10)

  const result = await manager.run()

  t.is(result.ageDeleted, 2)
  t.is(await exists(path.join(harness.layout.root, MUTABLE)), true)
  t.is(await exists(path.join(harness.layout.root, historyName(superseded.transferId))), false)
  t.is(await exists(path.join(harness.layout.root, createOnly.name)), false)
  t.alike(await harness.commits.list(), [current])
})

test('age deletes at its boundary before quota deletes the oldest remaining record', async (t) => {
  const harness = await createHarness(t)
  const expired = await harness.publish('expired.bin', b4a.from('aa'))
  harness.clock.advance(10)
  const alpha = await harness.publish('alpha.bin', b4a.from('bb'))
  const bravo = await harness.publish('bravo.bin', b4a.from('cc'))
  const manager = harness.manager({ maxAge: 10, maxStorageBytes: 4 })

  const result = await manager.run({ incomingBytes: 2 })

  t.alike(result, {
    expiredSessions: 0,
    scrubbed: 0,
    ageDeleted: 1,
    countDeleted: 0,
    versionDeleted: 0,
    storageDeleted: 1
  })
  t.is(await exists(path.join(harness.layout.root, expired.name)), false)
  t.is(await exists(path.join(harness.layout.root, alpha.name)), false)
  t.alike(await harness.commits.list(), [bravo])
})

test('active receiving session defers scheduled expiry and cleanup until inactive', async (t) => {
  const harness = await createHarness(t)
  const scheduler = createScheduler()
  const events: RetentionEvent[] = []
  let activeId: string | null = null
  const manager = harness.manager({
    maxAge: 10,
    resumeTtl: 10,
    scheduler,
    isSessionActive: (session) => (session as TarSession).id === activeId,
    onEvent: (event) => events.push(event)
  })
  t.teardown(() => manager.stop())
  await manager.start()
  const committed = await harness.publish('aged.bin', b4a.from('old'))
  const inactive = await harness.input('inactive.bin', b4a.from('i'))
  const active = await harness.input('active.bin', b4a.from('a'))
  await harness.sessions.admit(OWNER, inactive.metadata)
  await harness.sessions.admit(OWNER, active.metadata)
  activeId = active.metadata.transferId
  harness.clock.advance(11)

  scheduler.tick()
  await manager.tickPromise
  t.is(await exists(path.join(harness.layout.root, committed.name)), true)
  t.is(harness.sessions.sessions.size, 2)
  t.alike(events.at(-1), {
    type: 'retention',
    trigger: 'scheduled',
    status: 'deferred',
    reason: 'ACTIVE_RECEIVE'
  })

  activeId = null
  scheduler.tick()
  await manager.tickPromise
  t.is(await exists(path.join(harness.layout.root, committed.name)), false)
  t.is(harness.sessions.sessions.size, 0)
  t.is(events.at(-1)?.expiredSessions, 2)
})

test('persistent TAR admission failures preserve committed artifacts and reservations', async (t) => {
  const harness = await createHarness(t, { maxStagingBytes: 4096 })
  const committed = await harness.publish('committed.bin', b4a.from('committed'))
  const held = await harness.input('held.bin', b4a.from('h'))
  const rejected = await harness.input('rejected.bin', b4a.from('r'))
  await harness.sessions.admit(OWNER, held.metadata)
  const reserved = harness.sessions.reservedBytes

  for (let attempt = 0; attempt < 2; attempt++) {
    await t.exception(() => harness.sessions.admit(OWNER, rejected.metadata), {
      code: ERRORS.STAGING_LIMIT
    })
    t.is(harness.sessions.reservedBytes, reserved)
  }

  t.is(await exists(path.join(harness.layout.root, committed.name)), true)
  t.alike(await harness.commits.list(), [committed])
})

test('scheduled unlink and fsync failures emit stable events and remain recoverable', async (t) => {
  for (const failure of ['unlink', 'sync'] as const) {
    let armed = false
    let managedPath: string | null = null
    let root: string | null = null
    const storage = createStorage({
      beforeOperation(operation, target) {
        if (
          armed &&
          ((failure === 'unlink' && operation === 'unlink' && target === managedPath) ||
            (failure === 'sync' && operation === 'sync' && target === root))
        ) {
          throw new Error(`injected ${failure}`)
        }
      }
    })
    const harness = await createHarness(t, { storage })
    root = harness.layout.root
    const scheduler = createScheduler()
    const events: RetentionEvent[] = []
    const manager = harness.manager({
      maxAge: 1,
      scheduler,
      onEvent(event) {
        events.push(event)
        if (event.trigger === 'scheduled') throw new Error('observer callback failed')
      }
    })
    t.teardown(() => manager.stop())
    await manager.start()
    const record = await harness.publish(`${failure}.bin`, b4a.from('managed'))
    managedPath = path.join(harness.layout.root, record.name)
    const unmanaged = path.join(harness.layout.root, `${failure}-operator.txt`)
    await fs.promises.writeFile(unmanaged, 'operator')
    harness.clock.advance(1)
    armed = true

    scheduler.tick()
    await manager.tickPromise
    t.alike(
      events.filter((event) => event.trigger === 'scheduled').at(-1),
      {
        type: 'retention',
        trigger: 'scheduled',
        status: 'failed',
        reason: ERRORS.CLEANUP_FAILED
      },
      failure
    )
    t.is(await fs.promises.readFile(unmanaged, 'utf8'), 'operator', failure)

    armed = false
    scheduler.tick()
    await manager.tickPromise
    t.is(events.at(-1)?.status, 'completed', `${failure} manager recovered`)
    t.is(await exists(managedPath), false, failure)
    t.is(await fs.promises.readFile(unmanaged, 'utf8'), 'operator', failure)
  }
})

test('scrub removes corrupt sidecars and invalid artifacts but preserves valid replacement state', async (t) => {
  const harness = await createHarness(t)
  const superseded = await harness.publish(MUTABLE, b4a.from('old'), true)
  const current = await harness.publish(MUTABLE, b4a.from('new'), true)
  const tampered = await harness.publish('tampered.bin', b4a.from('same'))
  const orphan = await harness.publish('orphan.bin', b4a.from('orphan'))
  await fs.promises.writeFile(path.join(harness.layout.root, tampered.name), 'DIFF')
  const orphanSidecar = path.join(harness.layout.commits, `${orphan.transferId}.json`)
  await fs.promises.writeFile(orphanSidecar, '{"version":')
  const unmanaged = path.join(harness.layout.root, 'operator.txt')
  await fs.promises.writeFile(unmanaged, 'operator')

  const result = await harness.manager().scrubCommitted()

  t.is(result.deleted, 2)
  t.alike(result.unknown, ['operator.txt', 'orphan.bin'])
  t.is(await exists(orphanSidecar), false)
  t.is(await fs.promises.readFile(path.join(harness.layout.root, orphan.name), 'utf8'), 'orphan')
  t.is(await fs.promises.readFile(unmanaged, 'utf8'), 'operator')
  t.alike(
    (await harness.commits.list()).map((record) => record.name).sort(),
    [MUTABLE, historyName(superseded.transferId)].sort()
  )
  t.is(
    (await harness.commits.list()).find((record) => record.name === MUTABLE)?.transferId,
    current.transferId
  )
})

test('scrub detects an inode swap while hashing and preserves the replacement path', async (t) => {
  let armed = false
  let swapped = false
  let managedPath: string | null = null
  const content = b4a.from('same bytes')
  const storage = createStorage({
    beforeOperation(operation, target) {
      if (!armed || swapped || operation !== 'read' || target !== managedPath) return
      swapped = true
      fs.unlinkSync(target)
      fs.writeFileSync(target, content)
    }
  })
  const harness = await createHarness(t, { storage })
  const record = await harness.publish('swapped.bin', content)
  managedPath = path.join(harness.layout.root, record.name)
  armed = true

  const result = await harness.manager().scrubCommitted()

  t.is(result.deleted, 1)
  t.alike(result.unknown, [record.name])
  t.alike(await fs.promises.readFile(managedPath), content)
  t.alike(await harness.commits.list(), [])
})

test('count rotation keeps newest commits per series including history', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(MUTABLE, b4a.from('1.0.0'), true, {
    series: 'api',
    version: '1.0.0'
  })
  harness.clock.advance(1)
  const second = await harness.publish(MUTABLE, b4a.from('1.1.0'), true, {
    series: 'api',
    version: '1.1.0'
  })
  harness.clock.advance(1)
  const third = await harness.publish(MUTABLE, b4a.from('1.2.0'), true, {
    series: 'api',
    version: '1.2.0'
  })
  const result = await harness
    .manager({
      maxCount: 2,
      isPinned: (record) => record.name === MUTABLE
    })
    .run()

  t.is(result.countDeleted, 1)
  t.is(result.versionDeleted, 0)
  t.alike(
    (await harness.commits.list()).map((record) => record.transferId).sort(),
    [second.transferId, third.transferId].sort()
  )
  t.is(await exists(path.join(harness.layout.root, historyName(first.transferId))), false)
})

test('version rotation keeps newest distinct SemVer minor groups', async (t) => {
  const harness = await createHarness(t)
  const releases = ['1.9.9', '2.0.0-rc.1', '2.0.0', '2.1.0', '2.1.1']
  for (const [index, version] of releases.entries()) {
    await harness.publish(`api-${index}.bin`, b4a.from(version), false, {
      series: 'api',
      version
    })
    harness.clock.advance(1)
  }
  const result = await harness
    .manager({
      maxVersions: 2,
      versionGranularity: 'minor'
    })
    .run()

  t.is(result.versionDeleted, 1)
  t.is(result.countDeleted, 0)
  t.alike(
    (await harness.commits.list()).map((record) => record.release?.version).sort(),
    ['2.0.0-rc.1', '2.0.0', '2.1.0', '2.1.1'].sort()
  )
})

interface RotationCase {
  name: string
  versions: string[]
  maxCount?: number
  maxVersions?: number
  tie?: boolean
  expected: (published: CommitRecord[]) => number[]
}

const ROTATION_CASES: RotationCase[] = [
  {
    name: 'equal-time count ties',
    versions: ['1.0.0', '1.0.1', '1.0.2'],
    maxCount: 2,
    tie: true,
    expected: (published) => {
      const ordered = published
        .map((record, index) => ({ id: record.transferId, index }))
        .sort((left, right) => (left.id < right.id ? -1 : 1))
      return ordered.slice(0, 2).map((entry) => entry.index)
    }
  },
  {
    name: 'major groups',
    versions: ['1.9.9', '2.0.0-rc.1', '2.1.0', '3.0.0'],
    maxVersions: 2,
    expected: () => [1, 2, 3]
  },
  {
    name: 'count and version intersection',
    versions: ['1.0.0', '2.0.0', '2.0.1'],
    maxCount: 1,
    maxVersions: 1,
    expected: () => [2]
  }
]

for (const scenario of ROTATION_CASES) {
  test(`rotation selection: ${scenario.name}`, async (t) => {
    const harness = await createHarness(t)
    const pinned = await harness.publish(MUTABLE, b4a.from('pinned'), true, {
      series: 'api',
      version: '0.0.1'
    })
    harness.clock.advance(1)
    const legacy = await harness.publish('legacy.bin', b4a.from('legacy'))
    const other = await harness.publish('other.bin', b4a.from('other'), false, {
      series: 'other',
      version: '9.9.9'
    })
    const published: CommitRecord[] = []
    for (const [index, version] of scenario.versions.entries()) {
      published.push(
        await harness.publish(`api-${index}.bin`, b4a.from(version), false, {
          series: 'api',
          version
        })
      )
      if (!scenario.tie) harness.clock.advance(1)
    }

    const result = await harness
      .manager({
        ...(scenario.maxCount === undefined ? {} : { maxCount: scenario.maxCount }),
        ...(scenario.maxVersions === undefined
          ? {}
          : { maxVersions: scenario.maxVersions, versionGranularity: 'major' as const }),
        isPinned: (record) => record.name === MUTABLE
      })
      .run()

    const kept = scenario.expected(published).map((index) => published[index].transferId)
    t.alike(
      (await harness.commits.list()).map((record) => record.transferId).sort(),
      [pinned.transferId, legacy.transferId, other.transferId, ...kept].sort()
    )
    t.is(
      (result.countDeleted ?? 0) + (result.versionDeleted ?? 0),
      scenario.versions.length - kept.length
    )
    t.is(await exists(path.join(harness.layout.root, MUTABLE)), true)
    t.is(await exists(path.join(harness.layout.root, 'legacy.bin')), true)
    t.is(await exists(path.join(harness.layout.root, 'other.bin')), true)
  })
}

test('count rotation applies independently per series', async (t) => {
  const harness = await createHarness(t)
  const records: CommitRecord[] = []
  for (const series of ['api', 'web']) {
    for (const version of ['1.0.0', '1.0.1']) {
      records.push(
        await harness.publish(`${series}-${version}.bin`, b4a.from(`${series}${version}`), false, {
          series,
          version
        })
      )
      harness.clock.advance(1)
    }
  }

  const result = await harness.manager({ maxCount: 1 }).run()

  t.is(result.countDeleted, 2)
  t.alike(
    (await harness.commits.list()).map((record) => record.transferId).sort(),
    [records[1].transferId, records[3].transferId].sort()
  )
})

test('count-only releases without versions are ignored by version rotation', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish('api-a.bin', b4a.from('a'), false, { series: 'api' })
  harness.clock.advance(1)
  const second = await harness.publish('api-b.bin', b4a.from('b'), false, { series: 'api' })

  const result = await harness.manager({ maxVersions: 1, versionGranularity: 'major' }).run()

  t.is(result.versionDeleted, 0)
  t.alike(
    (await harness.commits.list()).map((record) => record.transferId).sort(),
    [first.transferId, second.transferId].sort()
  )
})

test('count and version stages run after age and before quota with stable reasons and events', async (t) => {
  const harness = await createHarness(t)
  const reasons: Array<[string, unknown]> = []
  const events: RetentionEvent[] = []
  const expired = await harness.publish('old.bin', b4a.from('old'), false, {
    series: 'api',
    version: '1.0.0'
  })
  harness.clock.advance(10)
  const countVictim = await harness.publish('api-1.bin', b4a.from('c1'), false, {
    series: 'api',
    version: '1.0.1'
  })
  harness.clock.advance(1)
  const webOld = await harness.publish('web-1.bin', b4a.from('w1'), false, {
    series: 'web',
    version: '1.0.0'
  })
  harness.clock.advance(1)
  const keep = await harness.publish('web-2.bin', b4a.from('w2'), false, {
    series: 'web',
    version: '2.0.0'
  })
  harness.clock.advance(1)
  const survivor = await harness.publish('api-2.bin', b4a.from('c2'), false, {
    series: 'api',
    version: '1.0.2'
  })

  const manager = harness.manager({
    maxAge: 10,
    maxCount: 1,
    maxVersions: 1,
    versionGranularity: 'major',
    maxStorageBytes: 100,
    logger: {
      info(_message, details) {
        reasons.push([details.name as string, details.reason])
      }
    },
    onEvent: (event) => events.push(event)
  })

  const result = await manager.run()

  t.alike(result, {
    expiredSessions: 0,
    scrubbed: 0,
    ageDeleted: 1,
    countDeleted: 2,
    versionDeleted: 0,
    storageDeleted: 0
  })
  t.alike(reasons, [
    [expired.name, 'MAX_AGE'],
    [countVictim.name, 'MAX_COUNT'],
    [webOld.name, 'MAX_COUNT']
  ])
  t.alike(events.at(-1), { type: 'retention', trigger: 'manual', status: 'completed', ...result })
  t.alike(
    (await harness.commits.list()).map((record) => record.transferId).sort(),
    [keep.transferId, survivor.transferId].sort()
  )
})

test('version stage reports MAX_VERSIONS deletions after count keeps every record', async (t) => {
  const harness = await createHarness(t)
  const reasons: Array<[string, unknown]> = []
  const old = await harness.publish('api-old.bin', b4a.from('old'), false, {
    series: 'api',
    version: '1.0.0'
  })
  harness.clock.advance(1)
  await harness.publish('api-new.bin', b4a.from('new'), false, { series: 'api', version: '2.0.0' })

  const result = await harness
    .manager({
      maxCount: 5,
      maxVersions: 1,
      versionGranularity: 'major',
      logger: {
        info(_message, details) {
          reasons.push([details.name as string, details.reason])
        }
      }
    })
    .run()

  t.is(result.countDeleted, 0)
  t.is(result.versionDeleted, 1)
  t.alike(reasons, [[old.name, 'MAX_VERSIONS']])
})

test('rotation options are validated', async (t) => {
  const harness = await createHarness(t)
  for (const options of [
    { maxCount: 0 },
    { maxCount: 1.5 },
    { maxVersions: 0, versionGranularity: 'major' },
    { maxVersions: 1 },
    { versionGranularity: 'major' },
    { maxVersions: 1, versionGranularity: 'patch' }
  ]) {
    await t.exception(
      () => harness.manager(options as Partial<RetentionOptions>),
      undefined,
      JSON.stringify(options)
    )
  }
})

test('commit defers post-commit retention only when asked and keeps pre-commit checks', async (t) => {
  for (const defer of [false, true]) {
    const harness = await createHarness(t)
    const manager = harness.manager({ maxVersions: 1, versionGranularity: 'major' })
    await harness.publish('api-2.0.0.bin', b4a.from('newer'), false, {
      series: 'api',
      version: '2.0.0'
    })
    harness.clock.advance(1)
    const session = await harness.stage('api-1.0.0.bin', b4a.from('older'))
    const record = await harness.commits.commit(session, {
      retentionManager: manager,
      release: { series: 'api', version: '1.0.0' },
      deferPostCommitRetention: defer
    })

    t.is(await exists(path.join(harness.layout.root, 'api-1.0.0.bin')), defer, `defer=${defer}`)
    if (defer) {
      t.ok(
        (await harness.commits.list()).some((entry) => entry.transferId === record.transferId),
        'record survives until the caller runs retention'
      )
      t.is(await manager.afterCommit(), true)
      t.is(await exists(path.join(harness.layout.root, 'api-1.0.0.bin')), false)
    }
  }
})
