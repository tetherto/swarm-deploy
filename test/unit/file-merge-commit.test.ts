/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS, systemCodeOf } from '../../dist/errors.js'
import { TarSessionStore, type TarSession } from '../../dist/storage/tar-session-store.js'
import { CommitStore, type ReplacePermission } from '../../dist/storage/commit-store.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'
import { fileCatalogPath, readFileCatalog } from '../../dist/storage/file-catalog.js'
import {
  STATE_FEATURE_FILE_CATALOG,
  STATE_ROOT_NAME,
  stateRequiresFeature
} from '../../dist/storage/layout.js'
import { recoverStorage } from '../../dist/storage/recovery.js'
import { RetentionManager } from '../../dist/storage/retention.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix
} from '../../dist/tar-protocol/manifest.js'
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { publishedAs } from '../helpers/file-merge.js'
import { createTempDir } from '../helpers/files.js'
import { initLayout } from '../helpers/layout.js'
import { createClock } from '../helpers/clock.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'
import { writeTree, type TreeSpec } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 9)
const NAME = 'site'
/** What a stopped process can no longer do: change anything on disk. */
const MUTATIONS = new Set([
  'mkdir',
  'link',
  'rename',
  'swap',
  'unlink',
  'rmdir',
  'rm',
  'write',
  'writeFile',
  'sync',
  'truncate',
  'symlink',
  'chmod'
])
const ALLOW: ReplacePermission = { allows: () => true }

type CommitOptions = NonNullable<Parameters<CommitStore['commit']>[1]>

interface Harness {
  layout: StorageLayout
  storage: TestStorage
  sessions: TarSessionStore
  commits: CommitStore
  stage(name: string, spec: TreeSpec): Promise<TarSession>
  /** Stage, commit and retire, as the server does; a refused or failed upload drops its session. */
  merge(name: string, spec: TreeSpec, options?: CommitOptions): Promise<CommitRecord>
}

async function createHarness(
  t: Assert,
  {
    storage = createStorage(),
    legacy = false,
    layoutRoot,
    clock
  }: {
    storage?: TestStorage
    legacy?: boolean
    layoutRoot?: string
    clock?: ReturnType<typeof createClock>
  } = {}
): Promise<Harness> {
  const layout = initLayout(layoutRoot ?? (await createTempDir(t)))
  const sessions = new TarSessionStore({
    layout,
    maxStagingBytes: 8 * 1024 * 1024,
    storage,
    ...(clock === undefined ? {} : { clock })
  })
  await sessions.init()
  t.teardown(() => sessions.close())
  const commits = new CommitStore({
    layout,
    storage,
    logger: { warn() {} },
    ...(clock === undefined ? {} : { clock }),
    ...(legacy ? { legacyDirectoryTrees: true } : {})
  })

  async function stage(name: string, spec: TreeSpec): Promise<TarSession> {
    // A fixed parent folder, so the same content under the same name is the same transfer.
    const tree = path.join(await createTempDir(t), 'release', name)
    await writeTree(tree, spec)
    const manifest = await buildTreeManifest(tree, OWNER)
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
    storage,
    sessions,
    commits,
    stage,
    async merge(name, spec, options = {}) {
      const session = await stage(name, spec)
      try {
        const record = await commits.commit(session, options)
        await sessions.retireCommitted(session.transferId)
        return record
      } catch (error) {
        await sessions.delete(session.transferId).catch(() => false)
        throw error
      }
    }
  }
}

async function stageFile(
  t: Assert,
  sessions: TarSessionStore,
  name: string,
  content: string
): Promise<TarSession> {
  const source = path.join(await createTempDir(t), 'release', name)
  await fs.promises.mkdir(path.dirname(source), { recursive: true })
  await fs.promises.writeFile(source, content)
  const manifest = await buildTarManifest(source, OWNER)
  const metadata = metadataFromManifest(manifest)
  const chunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  await sessions.admit(OWNER, metadata)
  await sessions.append(OWNER, metadata, 0, b4a.concat(chunks))
  return sessions.verify(OWNER, metadata)
}

/** Every entry under `root`: a file maps to its text, a folder to '', a link to its target. */
async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await fs.promises.readdir(root)).sort()) {
    const full = path.join(root, entry)
    const stat = await fs.promises.lstat(full)
    if (stat.isSymbolicLink()) {
      out[`${prefix}${entry}`] = `-> ${await fs.promises.readlink(full)}`
    } else if (stat.isDirectory()) {
      out[`${prefix}${entry}/`] = ''
      Object.assign(out, await snapshot(full, `${prefix}${entry}/`))
    } else {
      out[`${prefix}${entry}`] = await fs.promises.readFile(full, 'utf8')
    }
  }
  return out
}

/** What `snapshot` reports for a folder that holds `files` (relative path to content). */
function folder(name: string, files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { [`${name}/`]: '' }
  for (const [relative, content] of Object.entries(files)) {
    const parts = relative.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      out[`${name}/${parts.slice(0, depth).join('/')}/`] = ''
    }
    out[`${name}/${relative}`] = content
  }
  return out
}

/** Whether two snapshots hold exactly the same entries, whatever order they were listed in. */
function sameTree(left: Record<string, string>, right: Record<string, string>): boolean {
  const canonical = (tree: Record<string, string>): string =>
    JSON.stringify(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return canonical(left) === canonical(right)
}

function filesOf(spec: TreeSpec): Record<string, string> {
  return Object.fromEntries(Object.entries(spec).filter(([relative]) => !relative.endsWith('/')))
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function ownedPaths(h: Harness, name = NAME): Promise<string[]> {
  const catalog = await readFileCatalog(h.layout.catalogs, name, h.storage)
  return catalog === null ? [] : catalog.files.map((file) => file.path)
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a merge must leave nowhere once it is over: its journal, scratch and private residue. */
async function assertNoResidue(t: Assert, layout: StorageLayout, label: string): Promise<void> {
  t.alike(await fs.promises.readdir(layout.journals), [], `${label}: no journal`)
  t.alike(await fs.promises.readdir(layout.publications), [], `${label}: no scratch`)
}

test('a directory merges into a fresh name as owned files, with no tree record and no history', async (t) => {
  const h = await createHarness(t)
  const marker = path.join(h.layout.internal, STATE_ROOT_NAME)
  const before = fs.readFileSync(marker, 'utf8')
  t.is(stateRequiresFeature(h.layout, STATE_FEATURE_FILE_CATALOG), false)

  const spec: TreeSpec = { 'a.bin': 'alpha', 'sub/b.bin': 'beta', 'sub/zero.bin': '', 'empty/': '' }
  const session = await h.stage(NAME, spec)
  const record = await h.commits.commit(session)
  await h.sessions.retireCommitted(session.transferId)

  t.is(record.kind, 'directory')
  t.is(record.group, true, 'the record is the aggregate of owned files')
  t.is(record.name, NAME)
  const published = publishedAs(NAME, filesOf(spec))
  t.is(record.sha256, published.sha256)
  t.is(record.transferId, published.transferId)
  t.is(record.size, 9, 'only owned bytes count, and a zero-byte file is a file')
  t.is(record.entryCount, 3)
  t.not(record.transferId, session.id, 'the published identity is not the upload session')
  t.alike(
    await snapshot(h.layout.root),
    folder(NAME, { 'a.bin': 'alpha', 'sub/b.bin': 'beta', 'sub/zero.bin': '' }),
    'an empty folder entry creates nothing'
  )
  t.alike(await ownedPaths(h), ['a.bin', 'sub/b.bin', 'sub/zero.bin'])
  t.alike(await h.commits.list(), [record])
  t.alike(await fs.promises.readdir(h.layout.commits), [], 'no per-tree record is stored')
  t.alike(await fs.promises.readdir(h.layout.trash), [])
  await assertNoResidue(t, h.layout, 'finished')
  t.alike(await fs.promises.readdir(h.layout.sessions), [])
  t.alike(await fs.promises.readdir(h.layout.staging), [])

  t.is(stateRequiresFeature(h.layout, STATE_FEATURE_FILE_CATALOG), true)
  t.not(fs.readFileSync(marker, 'utf8'), before, 'the state now refuses an older server')
})

test('the state requires the catalog feature durably before the first new metadata is written', async (t) => {
  let atJournal: string | null = null
  let atCatalog: string | null = null
  const target: { layout: StorageLayout | null } = { layout: null }
  const storage = createStorage({
    beforeOperation(name, _source, destination) {
      const layout = target.layout
      if (layout === null) return
      const to = typeof destination === 'string' ? destination : ''
      const marker = path.join(layout.internal, STATE_ROOT_NAME)
      if (atJournal === null && name === 'link' && to.startsWith(layout.journals)) {
        atJournal = fs.readFileSync(marker, 'utf8')
      }
      if (
        atCatalog === null &&
        (name === 'rename' || name === 'link') &&
        to.startsWith(layout.catalogs)
      ) {
        atCatalog = fs.readFileSync(marker, 'utf8')
      }
    }
  })
  const h = await createHarness(t, { storage })
  target.layout = h.layout
  const canonical = await fs.promises.realpath(h.layout.root)
  await h.merge(NAME, { 'a.bin': 'a' })
  const expected = { version: 2, root: { path: canonical, requires: [STATE_FEATURE_FILE_CATALOG] } }
  t.alike(JSON.parse(atJournal ?? 'null'), expected, 'marked when the journal first became durable')
  t.alike(JSON.parse(atCatalog ?? 'null'), expected, 'and when the first catalog was written')
  t.is((await fs.promises.stat(path.join(h.layout.internal, STATE_ROOT_NAME))).mode & 0o777, 0o600)

  // A standalone file never marks the state.
  const plain = await createHarness(t)
  const session = await stageFile(t, plain.sessions, 'plain.txt', 'plain')
  await plain.commits.commit(session)
  t.is(stateRequiresFeature(plain.layout, STATE_FEATURE_FILE_CATALOG), false)
})

test('new files merge into a folder Swarm did not create, without adopting anything in it', async (t) => {
  const h = await createHarness(t)
  const operator = path.join(h.layout.root, 'operator')
  await writeTree(operator, {
    'keep.txt': 'mine',
    'same.txt': 'same',
    'sub/': '',
    'sub/theirs.txt': 't'
  })

  const record = await h.merge('operator', {
    'same.txt': 'same',
    'new.txt': 'new',
    'sub/inner.txt': 'inner',
    'empty/': ''
  })
  t.alike(
    await snapshot(operator),
    {
      'keep.txt': 'mine',
      'same.txt': 'same',
      'new.txt': 'new',
      'sub/': '',
      'sub/theirs.txt': 't',
      'sub/inner.txt': 'inner'
    },
    'omitted files stay, an identical file is left as it is, empty folders are not created'
  )
  t.alike(await ownedPaths(h, 'operator'), ['new.txt', 'sub/inner.txt'], 'only what was written')
  t.is(record.size, 8)
  t.is(record.entryCount, 2)

  // Owning nothing of the rest, Swarm will never delete it: removing the artifact keeps it all.
  t.is(await h.commits.delete(record), true)
  t.alike(await snapshot(operator), {
    'keep.txt': 'mine',
    'same.txt': 'same',
    'sub/': '',
    'sub/theirs.txt': 't'
  })
  t.alike(await ownedPaths(h, 'operator'), [])
})

test('a second upload merges with the first: it adds, replaces what is owned and keeps what it omits', async (t) => {
  const h = await createHarness(t)
  await h.merge(NAME, { 'a.bin': 'a1', 'sub/b.bin': 'b1', 'old.bin': 'old' })
  const first = await h.commits.list()
  const record = await h.merge(
    NAME,
    { 'a.bin': 'a2', 'sub/c.bin': 'c2', 'deep/er/d.bin': 'd2' },
    { replace: ALLOW }
  )
  t.alike(
    await snapshot(h.layout.root),
    folder(NAME, {
      'a.bin': 'a2',
      'sub/b.bin': 'b1',
      'old.bin': 'old',
      'sub/c.bin': 'c2',
      'deep/er/d.bin': 'd2'
    })
  )
  t.alike(await ownedPaths(h), ['a.bin', 'deep/er/d.bin', 'old.bin', 'sub/b.bin', 'sub/c.bin'])
  const expected = publishedAs(NAME, {
    'a.bin': 'a2',
    'sub/b.bin': 'b1',
    'old.bin': 'old',
    'sub/c.bin': 'c2',
    'deep/er/d.bin': 'd2'
  })
  t.is(record.sha256, expected.sha256)
  t.is(record.transferId, expected.transferId)
  t.is(record.size, expected.size)
  t.is(record.entryCount, 5)
  t.not(record.transferId, first[0].transferId, 'another set of owned files is another snapshot')
  t.is((await h.commits.list()).length, 1, 'one artifact per name')
  t.alike(
    (await fs.promises.readdir(h.layout.root)).filter((entry) => entry.startsWith('history-')),
    [],
    'a directory upload leaves no history copy'
  )
  await assertNoResidue(t, h.layout, 'finished')

  // The same upload again changes nothing and publishes nothing.
  const again = await h.merge(
    NAME,
    { 'a.bin': 'a2', 'sub/c.bin': 'c2', 'deep/er/d.bin': 'd2' },
    { replace: ALLOW }
  )
  t.is(again.transferId, record.transferId)
  await assertNoResidue(t, h.layout, 'no-op')
})

test('an upload that conflicts with anything is refused as a whole, before one public change', async (t) => {
  const h = await createHarness(t)
  await h.merge(NAME, { 'a.bin': 'a1', 'sub/b.bin': 'b1' })
  const site = path.join(h.layout.root, NAME)
  await fs.promises.writeFile(path.join(site, 'hand.txt'), 'hand')
  await fs.promises.symlink('sub', path.join(site, 'ln'))
  await fs.promises.symlink('a.bin', path.join(site, 'link.bin'))

  const cases: Array<[string, TreeSpec, CommitOptions, string]> = [
    ['a changed owned file needs permission', { 'a.bin': 'a2', 'new.bin': 'n' }, {}, 'a.bin'],
    [
      'permission for another name is no permission',
      { 'a.bin': 'a2', 'new.bin': 'n' },
      { replaceNames: ['other'] },
      'a.bin'
    ],
    [
      'a changed foreign file is never replaced',
      { 'hand.txt': 'ours', 'new.bin': 'n' },
      { replace: ALLOW },
      'hand.txt'
    ],
    ['a file where a folder is', { sub: 'x', 'new.bin': 'n' }, { replace: ALLOW }, 'sub'],
    [
      'a folder where a file is',
      { 'a.bin/inner.txt': 'x', 'new.bin': 'n' },
      { replace: ALLOW },
      'a.bin'
    ],
    [
      'through a link used as a folder',
      { 'ln/c.bin': 'c', 'new.bin': 'n' },
      { replace: ALLOW },
      'ln'
    ],
    ['over a link', { 'link.bin': 'a1', 'new.bin': 'n' }, { replace: ALLOW }, 'link.bin']
  ]
  for (const [label, spec, options, culprit] of cases) {
    const before = { tree: await snapshot(h.layout.root), records: await h.commits.list() }
    const failure = await h.merge(NAME, spec, options).then(
      () => null,
      (error: unknown) => error
    )
    t.is(codeOf(failure), ERRORS.FILE_EXISTS, label)
    t.ok(messageOf(failure).includes(culprit), `${label}: names the relative path`)
    t.absent(messageOf(failure).includes(h.layout.root), `${label}: never a public path`)
    t.absent(messageOf(failure).includes(h.layout.internal), `${label}: never a state path`)
    t.alike(await snapshot(h.layout.root), before.tree, `${label}: no public change`)
    t.alike(await h.commits.list(), before.records, `${label}: same artifact`)
    await assertNoResidue(t, h.layout, label)
    t.alike(await fs.promises.readdir(h.layout.staging), [], `${label}: nothing staged is kept`)
  }
})

test('pending committed cleanup blocks a later merge until its journal can be retired', async (t) => {
  const state: { layout: StorageLayout | null; blocked: boolean } = { layout: null, blocked: true }
  const storage = createStorage({
    beforeOperation(operation, target) {
      if (
        state.blocked &&
        state.layout !== null &&
        operation === 'unlink' &&
        target.startsWith(`${state.layout.journals}/`) &&
        target.endsWith('.json')
      ) {
        throw Object.assign(new Error('journal cleanup unavailable'), { code: 'EIO' })
      }
    }
  })
  const h = await createHarness(t, { storage })
  state.layout = h.layout
  const first = await h.merge(NAME, { 'QV.AC.snap': 'snap', 'flatpak/app.flatpak': 'flatpak' })
  t.is((await fs.promises.readdir(h.layout.journals)).length, 1)
  const generation = (await readFileCatalog(h.layout.catalogs, NAME, h.storage))!.generation
  for (let retry = 0; retry < 2; retry++) {
    const failure = await h.merge(NAME, { 'other.bin': 'later' }).then(
      () => null,
      (error: unknown) => error
    )
    t.is(codeOf(failure), ERRORS.FILE_BUSY, 'a retry cannot advance the pending catalog')
    t.is(await exists(path.join(h.layout.root, NAME, 'other.bin')), false)
  }
  t.is((await readFileCatalog(h.layout.catalogs, NAME, h.storage))!.generation, generation)
  t.is(await fs.promises.readFile(path.join(h.layout.root, NAME, 'QV.AC.snap'), 'utf8'), 'snap')

  // A routine scrub also cannot advance the catalog, even if another leaf changed on disk.
  await fs.promises.writeFile(
    path.join(h.layout.root, NAME, 'flatpak/app.flatpak'),
    'operator edit'
  )
  await h.commits.scrubRecords({ hash: true })
  t.is((await readFileCatalog(h.layout.catalogs, NAME, h.storage))!.generation, generation)
  const deletion = await h.commits.delete(first).then(
    () => null,
    (error: unknown) => error
  )
  t.is(codeOf(deletion), ERRORS.FILE_BUSY, 'deletion cannot discard pending commit proof')
  await h.sessions.close()
  const restarted = await recover(h.layout)
  t.is(restarted.results[0].status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(h.layout.root, NAME, 'QV.AC.snap'), 'utf8'), 'snap')
  t.is(
    await fs.promises.readFile(path.join(h.layout.root, NAME, 'flatpak/app.flatpak'), 'utf8'),
    'operator edit'
  )
  await restarted.sessions.close()
})

test('retrying cleanup before a disjoint merge preserves both successful commits across restart', async (t) => {
  const state: { layout: StorageLayout | null; failOnce: boolean } = {
    layout: null,
    failOnce: true
  }
  const storage = createStorage({
    beforeOperation(operation, target) {
      if (
        state.failOnce &&
        state.layout !== null &&
        operation === 'unlink' &&
        target.startsWith(`${state.layout.journals}/`) &&
        target.endsWith('.json')
      ) {
        state.failOnce = false
        throw Object.assign(new Error('transient journal cleanup error'), { code: 'EIO' })
      }
    }
  })
  const h = await createHarness(t, { storage })
  state.layout = h.layout
  await h.merge(NAME, { 'QV.AC.snap': 'snap' })
  t.is((await fs.promises.readdir(h.layout.journals)).length, 1)
  await h.merge(NAME, { 'flatpak/app.flatpak': 'flatpak' })
  await assertNoResidue(t, h.layout, 'after subsequent merge')
  await h.sessions.close()
  const restarted = await recover(h.layout)
  t.alike(
    await snapshot(h.layout.root),
    folder(NAME, { 'QV.AC.snap': 'snap', 'flatpak/app.flatpak': 'flatpak' })
  )
  t.alike(await ownedPaths({ ...h, commits: restarted.commits }), [
    'QV.AC.snap',
    'flatpak/app.flatpak'
  ])
  await restarted.sessions.close()
})

test('a file edited after Swarm wrote it is not Swarm’s to replace, and a vanished one is simply added back', async (t) => {
  const h = await createHarness(t)
  await h.merge(NAME, { 'a.bin': 'a1', 'b.bin': 'b1' })
  const site = path.join(h.layout.root, NAME)

  await fs.promises.writeFile(path.join(site, 'a.bin'), 'edited by hand')
  const failure = await h.merge(NAME, { 'a.bin': 'a2' }, { replace: ALLOW }).then(
    () => null,
    (error: unknown) => error
  )
  t.is(codeOf(failure), ERRORS.FILE_EXISTS)
  t.is(await fs.promises.readFile(path.join(site, 'a.bin'), 'utf8'), 'edited by hand')

  await fs.promises.rm(path.join(site, 'b.bin'))
  await h.merge(NAME, { 'b.bin': 'b2' })
  t.is(await fs.promises.readFile(path.join(site, 'b.bin'), 'utf8'), 'b2')
  t.is(
    await fs.promises.readFile(path.join(site, 'a.bin'), 'utf8'),
    'edited by hand',
    'and the hand-edited file stays'
  )
})

test('a permission decides which names may have owned files replaced: global, scoped and by name', async (t) => {
  const h = await createHarness(t)
  const cases: Array<[string, CommitOptions, boolean]> = [
    ['no permission', {}, false],
    ['everything allowed', { replace: ALLOW }, true],
    ['this name allowed', { replace: { allows: (name: string) => name === 'granted' } }, true],
    ['another name allowed', { replace: { allows: (name: string) => name === 'other' } }, false],
    ['a replaceNames entry for this name', { replaceNames: ['listed'] }, true],
    ['a replaceNames entry for another name', { replaceNames: ['other'] }, false]
  ]
  const names = ['none', 'all', 'granted', 'foreign', 'listed', 'unlisted']
  for (const [index, [label, options, allowed]] of cases.entries()) {
    const name = names[index]
    await h.merge(name, { 'a.bin': 'a1' })
    const outcome = await h.merge(name, { 'a.bin': 'a2' }, options).then(
      () => 'replaced',
      (error: unknown) => codeOf(error)
    )
    t.is(outcome, allowed ? 'replaced' : ERRORS.FILE_EXISTS, label)
    t.is(
      await fs.promises.readFile(path.join(h.layout.root, name, 'a.bin'), 'utf8'),
      allowed ? 'a2' : 'a1',
      label
    )
    // New files never need it.
    await h.merge(name, { 'new.bin': 'n' })
    t.is(await fs.promises.readFile(path.join(h.layout.root, name, 'new.bin'), 'utf8'), 'n', label)
  }
})

test('no public path is ever absent or half written while a merge runs', async (t) => {
  const state: {
    layout: StorageLayout | null
    armed: boolean
    checks: number
    violations: string[]
  } = {
    layout: null,
    armed: false,
    checks: 0,
    violations: []
  }
  const known = new Map<string, Set<string>>([
    ['site/a.bin', new Set(['a1'.repeat(5000), 'a2'.repeat(5000)])],
    ['site/sub/b.bin', new Set(['b1'])],
    ['site/keep.txt', new Set(['mine'])]
  ])
  const storage = createStorage({
    async afterOperation(name) {
      const layout = state.layout
      if (!state.armed || layout === null || !MUTATIONS.has(name)) return
      for (const [relative, allowed] of known) {
        state.checks++
        try {
          const content = await fs.promises.readFile(path.join(layout.root, relative), 'utf8')
          if (!allowed.has(content)) state.violations.push(`${relative}: ${content.length} bytes`)
        } catch (error: unknown) {
          state.violations.push(`${relative}: ${String((error as { code?: unknown }).code)}`)
        }
      }
    }
  })
  const h = await createHarness(t, { storage })
  state.layout = h.layout
  await h.merge(NAME, { 'a.bin': 'a1'.repeat(5000), 'sub/b.bin': 'b1' })
  await fs.promises.writeFile(path.join(h.layout.root, NAME, 'keep.txt'), 'mine')
  state.armed = true
  await h.merge(
    NAME,
    { 'a.bin': 'a2'.repeat(5000), 'sub/c.bin': 'c2', 'new/d.bin': 'd2' },
    { replace: ALLOW }
  )
  state.armed = false
  t.ok(state.checks > 20, `the paths were checked at every mutation (${state.checks})`)
  t.alike(state.violations, [], 'always the old or the new whole file, never missing')
  t.is(
    await fs.promises.readFile(path.join(h.layout.root, NAME, 'a.bin'), 'utf8'),
    'a2'.repeat(5000)
  )
})

/** The scenario every crash and recovery test uses: one owned file is replaced, others are added. */
const INITIAL = { 'a.bin': 'a1', 'sub/b.bin': 'b1' }
const UPLOAD: TreeSpec = {
  'a.bin': 'a2',
  'sub/c.bin': 'c2',
  'deep/e.bin': 'e2',
  'zero.bin': '',
  'empty/': ''
}
const FINAL = {
  'a.bin': 'a2',
  'sub/b.bin': 'b1',
  'sub/c.bin': 'c2',
  'deep/e.bin': 'e2',
  'zero.bin': ''
}

async function seed(
  h: Harness
): Promise<{ before: Record<string, string>; initial: CommitRecord }> {
  const initial = await h.merge(NAME, INITIAL)
  await fs.promises.writeFile(path.join(h.layout.root, NAME, 'keep.txt'), 'mine')
  return { before: await snapshot(h.layout.root), initial }
}

interface Crash {
  layout: StorageLayout
  session: TarSession
  before: Record<string, string>
  initial: CommitRecord
  crashed: boolean
  mutations: number
}

/**
 * Runs the scenario's merge against storage that stops the process after the mutation `stop`
 * accepts (every later mutation throws), then closes the session store as a dying process would.
 */
async function crashMerge(
  t: Assert,
  stop: (
    count: number,
    name: string,
    source: string,
    destination: string,
    layout: StorageLayout
  ) => boolean,
  options: CommitOptions = { replace: ALLOW }
): Promise<Crash> {
  const target: { layout: StorageLayout | null; armed: boolean; crashed: boolean; count: number } =
    {
      layout: null,
      armed: false,
      crashed: false,
      count: 0
    }
  const storage = createStorage({
    beforeOperation(name) {
      if (target.crashed && MUTATIONS.has(name)) {
        throw new Error('process stopped at crash boundary')
      }
    },
    afterOperation(name, source, destination) {
      const layout = target.layout
      if (!target.armed || target.crashed || layout === null || !MUTATIONS.has(name)) return
      target.count++
      const to = typeof destination === 'string' ? destination : ''
      if (stop(target.count, name, source, to, layout)) {
        target.crashed = true
        throw new Error(`crash after mutation ${target.count} (${name})`)
      }
    }
  })
  const h = await createHarness(t, { storage })
  target.layout = h.layout
  const { before, initial } = await seed(h)
  const session = await h.stage(NAME, UPLOAD)
  target.armed = true
  await h.commits.commit(session, options).then(
    () => undefined,
    () => undefined
  )
  await h.sessions.close()
  return {
    layout: h.layout,
    session,
    before,
    initial,
    crashed: target.crashed,
    mutations: target.count
  }
}

async function restart(layout: StorageLayout): Promise<TarSessionStore> {
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 8 * 1024 * 1024 })
  await sessions.init()
  return sessions
}

async function recover(
  layout: StorageLayout,
  options: { isAuthorized?: (owner: Uint8Array) => boolean } = {}
) {
  const sessions = await restart(layout)
  const commits = new CommitStore({ layout, storage: createStorage(), logger: { warn() {} } })
  try {
    const results = await recoverStorage({
      layout,
      sessionStore: sessions,
      commitStore: commits,
      logger: { warn() {} },
      ...(options.isAuthorized ? { isAuthorized: options.isAuthorized } : {})
    })
    return { results, sessions, commits }
  } catch (error: unknown) {
    await sessions.close()
    throw error
  }
}

// One case per durable step of the merge (some seventy), each with its own harness, restart,
// recovery and retry, so it runs well past the 30 s of an ordinary test.
test(
  'a process stopped after any mutation of a merge recovers to exactly the old or the new state',
  { timeout: 300_000 },
  async (t) => {
    // The merge that is never stopped says how many mutations there are and what the end looks like.
    const complete = await crashMerge(t, () => false)
    const total = complete.mutations
    t.ok(total > 20, `the merge makes many durable steps (${total})`)
    const final = folder(NAME, FINAL)
    final[`${NAME}/keep.txt`] = 'mine'
    const finalRecord = publishedAs(NAME, FINAL)
    t.alike(await snapshot(complete.layout.root), final, 'unstopped, it ends in the new state')

    let rolledBack = 0
    let committed = 0
    for (let stopAfter = 1; stopAfter <= total; stopAfter++) {
      const label = `after mutation ${stopAfter} of ${total}`
      const crash = await crashMerge(t, (count) => count === stopAfter)
      t.ok(crash.crashed, `${label}: the stop was reached`)
      const { results, sessions, commits } = await recover(crash.layout)
      t.ok(results.length <= 1, label)
      const status = results.length === 0 ? 'NONE' : results[0].status
      const tree = await snapshot(crash.layout.root)
      const [current] = await commits.list()
      const isOld = sameTree(tree, crash.before)
      const isNew = sameTree(tree, final)
      t.ok(
        isOld || isNew,
        `${label}: the public tree is exactly the old or the new one (${status})`
      )
      t.is(
        isNew,
        current.transferId === finalRecord.transferId,
        `${label}: the catalog agrees with it`
      )
      t.is(
        isOld,
        current.transferId === crash.initial.transferId,
        `${label}: and so does the artifact`
      )
      t.is(tree[`${NAME}/keep.txt`], 'mine', `${label}: a foreign file is never touched`)
      await assertNoResidue(t, crash.layout, label)
      t.alike(
        (await fs.promises.readdir(crash.layout.catalogs)).filter(
          (entry) => !entry.endsWith('.json')
        ),
        [],
        `${label}: no catalog residue`
      )
      if (isOld) {
        rolledBack++
        t.ok(status === 'RESUMABLE' || status === 'NONE', `${label}: ${status}`)
        // Still retryable: the verified upload survived and merges again.
        const session = await sessions.readVerified(b4a.from(crash.session.id, 'hex'))
        await commits.commit(session, { replace: ALLOW })
        t.alike(await snapshot(crash.layout.root), final, `${label}: retried to the new state`)
      } else {
        committed++
        t.ok(status === 'COMMITTED' || status === 'NONE', `${label}: ${status}`)
      }
      await sessions.close()

      const again = await recover(crash.layout)
      t.is(again.results.length, 0, `${label}: recovery is idempotent`)
      t.alike(await snapshot(crash.layout.root), final, `${label}: and nothing moves`)
      await again.sessions.close()
    }
    t.ok(
      rolledBack > 0 && committed > 0,
      `both outcomes occurred (${rolledBack} old, ${committed} new)`
    )
  }
)

test('the catalog is the commit point: its durable write decides, not the journal phase', async (t) => {
  const final = folder(NAME, FINAL)
  final[`${NAME}/keep.txt`] = 'mine'
  const phaseOf = async (crash: Crash): Promise<unknown> =>
    (
      JSON.parse(
        await fs.promises.readFile(
          path.join(crash.layout.journals, `${crash.session.id}.json`),
          'utf8'
        )
      ) as { phase: unknown }
    ).phase

  // Every file is public and the journal says so, but the catalog is not durable yet: the merge
  // did not happen, and recovery takes every file back.
  const beforeCatalog = await crashMerge(
    t,
    (_count, name, source, _destination, layout) =>
      name === 'sync' && source.startsWith(layout.catalogs)
  )
  t.ok(beforeCatalog.crashed)
  t.is(await phaseOf(beforeCatalog), 'installed')
  t.alike(
    await snapshot(beforeCatalog.layout.root),
    final,
    'every file of the upload is already visible to readers'
  )
  const undone = await recover(beforeCatalog.layout)
  t.is(undone.results[0].status, 'RESUMABLE')
  t.alike(await snapshot(beforeCatalog.layout.root), beforeCatalog.before)
  t.is((await undone.commits.list())[0].transferId, beforeCatalog.initial.transferId)
  await undone.sessions.close()

  // The catalog is durable and the journal is not past `installed`: the merge happened, and
  // recovery only finishes the cleanup.
  const atCatalog = await crashMerge(
    t,
    (_count, name, _source, destination, layout) =>
      name === 'rename' && destination.startsWith(layout.catalogs)
  )
  t.ok(atCatalog.crashed)
  t.is(await phaseOf(atCatalog), 'installed')
  const done = await recover(atCatalog.layout)
  t.is(done.results[0].status, 'COMMITTED')
  t.alike(await snapshot(atCatalog.layout.root), final)
  t.is((await done.commits.list())[0].transferId, publishedAs(NAME, FINAL).transferId)
  await assertNoResidue(t, atCatalog.layout, 'recovered')
  await done.sessions.close()
})

/** The stop right after the first file of an upload became public (a link or a rename into the root). */
function publishedFirstFile(
  _count: number,
  name: string,
  source: string,
  destination: string,
  layout: StorageLayout
): boolean {
  return (
    (name === 'link' || name === 'rename') &&
    destination.startsWith(layout.root) &&
    source.startsWith(layout.publications)
  )
}

test('a revoked owner aborts an unfinished merge and cannot undo a finished one', async (t) => {
  const final = folder(NAME, FINAL)
  final[`${NAME}/keep.txt`] = 'mine'
  // The first file is already public when the owner is revoked.
  const unfinished = await crashMerge(t, publishedFirstFile)
  t.ok(unfinished.crashed)
  const aborted = await recover(unfinished.layout, { isAuthorized: () => false })
  t.is(aborted.results[0].status, 'ABORTED')
  t.alike(await snapshot(unfinished.layout.root), unfinished.before, 'rolled back to the old state')
  await assertNoResidue(t, unfinished.layout, 'aborted')
  t.alike(
    await fs.promises.readdir(unfinished.layout.sessions),
    [],
    'the revoked upload is dropped'
  )
  t.alike(await fs.promises.readdir(unfinished.layout.staging), [])
  await aborted.sessions.close()

  const finished = await crashMerge(
    t,
    (_count, name, _source, destination, layout) =>
      name === 'rename' && destination.startsWith(layout.catalogs)
  )
  t.ok(finished.crashed)
  const kept = await recover(finished.layout, { isAuthorized: () => false })
  t.is(kept.results[0].status, 'COMMITTED')
  t.alike(await snapshot(finished.layout.root), final, 'a durable merge is never undone')
  await kept.sessions.close()
})

test('an aborted merge rolls back every file it published and every folder it made', async (t) => {
  const state: { layout: StorageLayout | null; armed: boolean; published: number } = {
    layout: null,
    armed: false,
    published: 0
  }
  // A bare signal, as the other abort tests use: Bare has no `AbortController`.
  const controller = { aborted: false }
  const signal = {
    get aborted() {
      return controller.aborted
    },
    addEventListener() {},
    removeEventListener() {}
  }
  const storage = createStorage({
    afterOperation(name, _source, destination) {
      const layout = state.layout
      if (!state.armed || layout === null || name !== 'link') return
      if (typeof destination === 'string' && destination.startsWith(layout.root)) {
        state.published++
        if (state.published === 2) controller.aborted = true
      }
    }
  })
  const h = await createHarness(t, { storage })
  state.layout = h.layout
  const { before, initial } = await seed(h)
  const session = await h.stage(NAME, UPLOAD)
  state.armed = true
  const failure = await h.commits.commit(session, { replace: ALLOW, signal }).then(
    () => null,
    (error: unknown) => error
  )
  state.armed = false
  t.is(codeOf(failure), ERRORS.ABORTED)
  t.ok(state.published >= 2, 'files were already public when it stopped')
  t.alike(await snapshot(h.layout.root), before, 'back to the old state, new folders removed')
  await assertNoResidue(t, h.layout, 'aborted')
  t.alike(await h.commits.list(), [initial])
  // The verified upload is intact and merges when asked again.
  await h.commits.commit(session, { replace: ALLOW })
  const final = folder(NAME, FINAL)
  final[`${NAME}/keep.txt`] = 'mine'
  t.alike(await snapshot(h.layout.root), final)
})

test('a failure while publishing is reported with the relative path and rolls the whole upload back', async (t) => {
  const state: { layout: StorageLayout | null; armed: boolean; seen: number } = {
    layout: null,
    armed: false,
    seen: 0
  }
  const storage = createStorage({
    beforeOperation(name, source, destination) {
      const layout = state.layout
      if (!state.armed || layout === null || name !== 'link') return
      if (typeof destination === 'string' && destination.startsWith(layout.root)) {
        state.seen++
        if (state.seen === 2) {
          throw Object.assign(new Error(`no space left ${source} ${destination}`), {
            code: 'ENOSPC'
          })
        }
      }
    }
  })
  const h = await createHarness(t, { storage })
  state.layout = h.layout
  const { before } = await seed(h)
  state.armed = true
  const failure = await h.merge(NAME, UPLOAD, { replace: ALLOW }).then(
    () => null,
    (error: unknown) => error
  )
  state.armed = false
  t.is(codeOf(failure), ERRORS.DISK_RESERVE, 'an errno maps to its stable code')
  t.ok(/^Cannot [a-z ]+ [\w./-]+ \(ENOSPC\)$/.test(messageOf(failure)), messageOf(failure))
  t.absent(messageOf(failure).includes(h.layout.root), 'the message names no public path')
  t.absent(messageOf(failure).includes(h.layout.internal), 'and no state path')
  t.alike(await snapshot(h.layout.root), before, 'nothing of the upload stays public')
  await assertNoResidue(t, h.layout, 'rolled back')
})

test('a merge into a directory an earlier build published imports it on exact proof only', async (t) => {
  const layoutRoot = await createTempDir(t)
  const old = await createHarness(t, { legacy: true, layoutRoot })
  const legacy = await old.merge('exact', { 'a.bin': 'a', 'sub/b.bin': 'b' })
  t.is(legacy.version, 3, 'an earlier build left a whole-tree record')
  t.not(legacy.group, true)
  const dirty = await old.merge('dirty', { 'a.bin': 'a', 'sub/b.bin': 'b' })
  await old.sessions.close()

  const h = await createHarness(t, { layoutRoot })
  // Untouched since it was published: every leaf is owned, and the old record is retired.
  const record = await h.merge('exact', { 'c.bin': 'c' })
  t.alike(await ownedPaths(h, 'exact'), ['a.bin', 'c.bin', 'sub/b.bin'])
  t.is(record.size, 3)
  t.is(await exists(path.join(h.layout.commits, `${legacy.transferId}.json`)), false)
  t.alike(
    (await h.commits.list()).filter((entry) => entry.name === 'exact').map((entry) => entry.group),
    [true]
  )

  // Edited, or holding a file nobody listed: nothing old is adopted, the new leaves still land.
  const dirtyRoot = path.join(h.layout.root, 'dirty')
  await fs.promises.writeFile(path.join(dirtyRoot, 'sub', 'b.bin'), 'edited')
  const fresh = await h.merge('dirty', { 'c.bin': 'c' })
  t.alike(await ownedPaths(h, 'dirty'), ['c.bin'], 'only what this merge wrote')
  t.is(fresh.size, 1)
  t.is(await exists(path.join(h.layout.commits, `${dirty.transferId}.json`)), false)
  t.alike(await snapshot(dirtyRoot), {
    'a.bin': 'a',
    'c.bin': 'c',
    'sub/': '',
    'sub/b.bin': 'edited'
  })
  await h.sessions.close()
})

test('a directory artifact with a whole-tree record from an earlier build still lists and deletes', async (t) => {
  const layoutRoot = await createTempDir(t)
  const old = await createHarness(t, { legacy: true, layoutRoot })
  const legacy = await old.merge('earlier', { 'a.bin': 'a', 'sub/b.bin': 'b' })
  await old.sessions.close()
  const h = await createHarness(t, { layoutRoot })
  t.alike(await h.commits.list(), [legacy], 'the record is served as it was stored')
  t.is(await h.commits.delete(legacy), true)
  t.is(await exists(path.join(h.layout.root, 'earlier')), false, 'and removed as one tree')
  t.alike(await h.commits.list(), [])
})

test('merge scratch is private residue: an orphan is swept and an open merge is not', async (t) => {
  const crash = await crashMerge(t, publishedFirstFile)
  const orphan = path.join(crash.layout.publications, `${'7'.repeat(64)}.merge`)
  await fs.promises.mkdir(orphan)
  await fs.promises.writeFile(path.join(orphan, 'p0'), 'private')
  const foreign = path.join(crash.layout.publications, 'operator-notes.txt')
  await fs.promises.writeFile(foreign, 'keep me')

  const sessions = await restart(crash.layout)
  const commits = new CommitStore({ layout: crash.layout, logger: { warn() {} } })
  t.is(await commits.sweepMergeScratch(), 1, 'only the orphan goes; the open merge owns the rest')
  t.is(await exists(orphan), false)
  t.is(await fs.promises.readFile(foreign, 'utf8'), 'keep me')
  t.ok(
    (await fs.promises.readdir(crash.layout.publications)).some((entry) => entry.endsWith('.merge'))
  )
  t.alike(
    [...(await commits.pendingReplacementPins())].length,
    2,
    'the open merge pins the snapshots it moves between'
  )
  await sessions.close()

  const done = await recover(crash.layout)
  t.is(done.results[0].status, 'RESUMABLE')
  t.alike(await fs.promises.readdir(crash.layout.publications), ['operator-notes.txt'])
  await done.sessions.close()
})

test('a merge counts its bytes honestly: the quota pass may evict an unpinned artifact, and the artifact is what it owns', async (t) => {
  const clock = createClock()
  const h = await createHarness(t, { clock })
  const retention = new RetentionManager({
    layout: h.layout,
    sessionStore: h.sessions,
    commitStore: h.commits,
    storage: h.storage,
    clock,
    isSessionActive: () => false,
    maxStorageBytes: 12
  })
  const bystander = await stageFile(t, h.sessions, 'old.bin', 'x'.repeat(10))
  await h.commits.commit(bystander)
  await h.sessions.retireCommitted(bystander.transferId)
  clock.advance(1)

  // Ten bytes held and four incoming is over the limit: the bystander makes room.
  const first = await h.merge(NAME, { 'a.bin': 'aaaa' }, { retentionManager: retention })
  t.is(first.size, 4)
  t.is(
    await exists(path.join(h.layout.root, 'old.bin')),
    false,
    'room was made for the incoming bytes'
  )
  clock.advance(1)

  // Four held and six incoming fits: nothing is evicted, and the artifact counts what it owns
  // after the merge, not what was sent.
  const second = await h.merge(
    NAME,
    { 'b.bin': 'bbbb', 'c.bin': 'cc' },
    { retentionManager: retention }
  )
  t.is(second.size, 10)
  t.alike(await ownedPaths(h), ['a.bin', 'b.bin', 'c.bin'])
  t.alike(
    await snapshot(h.layout.root),
    folder(NAME, { 'a.bin': 'aaaa', 'b.bin': 'bbbb', 'c.bin': 'cc' })
  )
})

test('catalog read I/O failures preserve ownership and do not quarantine valid metadata', async (t) => {
  const state: { file: string | null; failure: string | null } = { file: null, failure: null }
  const storage = createStorage({
    beforeOperation(operation, target) {
      if (operation === 'open' && target === state.file && state.failure !== null) {
        throw Object.assign(new Error('temporary catalog read failure'), { code: state.failure })
      }
    }
  })
  const h = await createHarness(t, { storage })
  await h.merge(NAME, { 'a.bin': 'owned' })
  state.file = fileCatalogPath(h.layout.catalogs, NAME)
  const before = await fs.promises.readFile(state.file, 'utf8')
  for (const code of ['EIO', 'EACCES']) {
    state.failure = code
    const failure = await h.commits.scrubRecords({ hash: true }).then(
      () => null,
      (error: unknown) => error
    )
    t.ok(failure, 'the failed read is propagated')
    t.is(systemCodeOf(failure), code, 'the original system reason survives its storage guard')
    t.is(await fs.promises.readFile(state.file, 'utf8'), before, `${code}: catalog preserved`)
    t.alike(await fs.promises.readdir(h.layout.catalogs), [path.basename(state.file)])
  }
  state.failure = null
  await h.merge(NAME, { 'a.bin': 'new' }, { replace: ALLOW })
  t.is(await fs.promises.readFile(path.join(h.layout.root, NAME, 'a.bin'), 'utf8'), 'new')
})

test('merge quota reserves only owned-set growth, including after scrub releases a missing leaf', async (t) => {
  const h = await createHarness(t)
  const bystander = await stageFile(t, h.sessions, 'keep.bin', 'k'.repeat(9))
  await h.commits.commit(bystander)
  await h.sessions.retireCommitted(bystander.transferId)
  await h.merge(NAME, { 'a.bin': 'a'.repeat(90) })
  const retention = new RetentionManager({
    layout: h.layout,
    sessionStore: h.sessions,
    commitStore: h.commits,
    storage: h.storage,
    isSessionActive: () => false,
    maxStorageBytes: 100
  })
  const merged = await h.merge(
    NAME,
    { 'a.bin': 'a'.repeat(90), 'b.bin': 'b' },
    { retentionManager: retention }
  )
  t.is(merged.size, 91)
  t.is(
    await exists(path.join(h.layout.root, 'keep.bin')),
    true,
    'unchanged bytes do not evict another artifact'
  )
  const smaller = await h.merge(
    NAME,
    { 'a.bin': 'small' },
    { retentionManager: retention, replace: ALLOW }
  )
  t.is(smaller.size, 6)
  t.is(
    await exists(path.join(h.layout.root, 'keep.bin')),
    true,
    'a shrinking replacement retains no public history'
  )

  // A disappeared leaf is released by scrub; restoring it must still reserve its new bytes.
  await fs.promises.unlink(path.join(h.layout.root, NAME, 'a.bin'))
  await h.merge(NAME, { 'a.bin': 'a'.repeat(99) }, { retentionManager: retention })
  t.is((await h.commits.list()).find((record) => record.name === NAME)!.size, 100)
  t.is(
    await exists(path.join(h.layout.root, 'keep.bin')),
    false,
    'restored bytes reserve real capacity'
  )
})

test(
  'a merge of a thousand files journals every action, past the old 16 KiB, and publishes them all',
  { timeout: 120_000 },
  async (t) => {
    const state: { layout: StorageLayout | null; largest: number } = { layout: null, largest: 0 }
    const storage = createStorage({
      async afterOperation(name, _source, destination) {
        const layout = state.layout
        if (layout === null || (name !== 'link' && name !== 'rename')) return
        const to = typeof destination === 'string' ? destination : ''
        if (to.startsWith(layout.journals)) {
          state.largest = Math.max(state.largest, (await fs.promises.stat(to)).size)
        }
      }
    })
    const h = await createHarness(t, { storage })
    state.layout = h.layout
    const spec: TreeSpec = {}
    for (let index = 0; index < 1000; index++) {
      spec[`group-${index % 10}/file-${String(index).padStart(4, '0')}.bin`] = `${index}`
    }
    const record = await h.merge(NAME, spec)
    t.is(record.entryCount, 1000)
    t.ok(state.largest > 16 * 1024 * 10, `the journal was ${state.largest} bytes`)
    t.is((await ownedPaths(h)).length, 1000)
    t.is(
      await fs.promises.readFile(
        path.join(h.layout.root, NAME, 'group-7', 'file-0997.bin'),
        'utf8'
      ),
      '997'
    )
    await assertNoResidue(t, h.layout, 'finished')
  }
)

test('removing a directory artifact deletes only unchanged owned files and prunes only empty folders', async (t) => {
  const h = await createHarness(t)
  const record = await h.merge(NAME, {
    'a.bin': 'a',
    'sub/b.bin': 'b',
    'sub/deep/c.bin': 'c',
    'gone.bin': 'g'
  })
  const site = path.join(h.layout.root, NAME)
  await fs.promises.writeFile(path.join(site, 'sub', 'hand.txt'), 'hand')
  await fs.promises.writeFile(path.join(site, 'a.bin'), 'x')
  await fs.promises.rm(path.join(site, 'gone.bin'))

  const current = (await h.commits.list())[0]
  t.is(current.transferId, record.transferId)
  t.is(await h.commits.delete(current), true)
  t.alike(
    await snapshot(h.layout.root),
    {
      'site/': '',
      'site/a.bin': 'x',
      'site/sub/': '',
      'site/sub/hand.txt': 'hand'
    },
    'a changed file and a foreign one stay with the folders that hold them; the empty folder goes'
  )
  t.alike(await ownedPaths(h), [])
  t.alike(await h.commits.list(), [])
})
