/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { historyName } from '../../dist/files.js'
import { TarSessionStore, type TarSession } from '../../dist/storage/tar-session-store.js'
import { nativeAtomicSwap } from '../../dist/storage/atomic-swap.js'
import { CommitStore, type ReplacePermission } from '../../dist/storage/commit-store.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'
import {
  STATE_FEATURE_DIRECTORY_REPLACEMENT,
  STATE_ROOT_NAME,
  findLayout,
  requireStateFeature,
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
import { createTempDir } from '../helpers/files.js'
import { initLayout } from '../helpers/layout.js'
import { createStorage, type CreateStorageOptions } from '../helpers/storage.js'
import { writeTree, type TreeSpec } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 7)
const NAME = '0.18.1'
const MUTATIONS = new Set([
  'link',
  'rename',
  'swap',
  'unlink',
  'rmdir',
  'rm',
  'write',
  'sync',
  'truncate'
])
const ALLOW: ReplacePermission = { allows: () => true }

const TREE_A: TreeSpec = { 'a.bin': 'alpha', 'sub/inner.bin': 'inner-a', 'empty/': '' }
const TREE_B: TreeSpec = { 'a.bin': 'bravo', 'sub/other.bin': 'other-b', 'extra/': '' }

interface DirectoryOffer {
  name: string
  kind: 'directory'
  size: number
  entryCount: number
  digest: Uint8Array
  transferId: Uint8Array
}

interface Harness {
  layout: StorageLayout
  sessions: TarSessionStore
  commits: CommitStore
  stageTree(name: string, spec: TreeSpec): Promise<TarSession>
  /**
   * The offer a client would make for a tree, taken from its manifest alone. It admits no session,
   * so it can describe content while another transfer for the same name is staged (admitting two
   * active sessions for one name is refused with FILE_BUSY, and must stay refused).
   */
  offerFor(name: string, spec: TreeSpec): Promise<DirectoryOffer>
  publish(name: string, spec: TreeSpec): Promise<CommitRecord>
  replace(name: string, spec: TreeSpec, permission?: ReplacePermission): Promise<CommitRecord>
}

async function createHarness(
  t: Assert,
  storage = createStorage(),
  layoutRoot?: string
): Promise<Harness> {
  const layout = initLayout(layoutRoot ?? (await createTempDir(t)))
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 4 * 1024 * 1024, storage })
  await sessions.init()
  t.teardown(() => sessions.close())
  // This file covers the whole-tree replacement transaction of earlier builds and its recovery, so
  // a directory is committed here as those builds did. A directory upload is now merged file by
  // file; that has its own tests (file-merge-commit).
  const commits = new CommitStore({
    layout,
    storage,
    logger: { warn() {} },
    legacyDirectoryTrees: true
  })

  // A fixed parent folder, so the same content under the same name is the same transfer.
  async function sourceManifest(name: string, spec: TreeSpec) {
    const sourceRoot = await createTempDir(t)
    const tree = path.join(sourceRoot, 'release', name)
    await writeTree(tree, spec)
    return buildTreeManifest(tree, OWNER)
  }

  async function stageTree(name: string, spec: TreeSpec): Promise<TarSession> {
    const manifest = await sourceManifest(name, spec)
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
    stageTree,
    async offerFor(name, spec) {
      const manifest = await sourceManifest(name, spec)
      return {
        name,
        kind: 'directory',
        size: manifest.payloadBytes,
        entryCount: manifest.entryCount,
        digest: manifest.treeSha256,
        transferId: manifest.transferId
      }
    },
    async publish(name, spec) {
      const session = await stageTree(name, spec)
      const record = await commits.commit(session)
      await sessions.retireCommitted(session.transferId)
      return record
    },
    async replace(name, spec, permission = ALLOW) {
      const session = await stageTree(name, spec)
      const record = await commits.commit(session, { replace: permission })
      await sessions.retireCommitted(session.transferId)
      return record
    }
  }
}

/** Every entry under `root` by relative path: a file maps to its text, a directory to ''. */
async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await fs.promises.readdir(root)).sort()) {
    const full = path.join(root, entry)
    const stat = await fs.promises.lstat(full)
    if (stat.isDirectory()) {
      out[`${prefix}${entry}/`] = ''
      Object.assign(out, await snapshot(full, `${prefix}${entry}/`))
    } else {
      out[`${prefix}${entry}`] = await fs.promises.readFile(full, 'utf8')
    }
  }
  return out
}

/** What `snapshot` reports for a tree written from `spec`. */
function shape(spec: TreeSpec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [relative, content] of Object.entries(spec)) {
    const parts = relative.split('/').filter(Boolean)
    for (let depth = 1; depth < parts.length; depth++) {
      out[`${parts.slice(0, depth).join('/')}/`] = ''
    }
    if (relative.endsWith('/')) out[`${parts.join('/')}/`] = ''
    else out[parts.join('/')] = content
  }
  return out
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

async function readRecord(target: string): Promise<CommitRecord> {
  return JSON.parse(await fs.promises.readFile(target, 'utf8')) as CommitRecord
}

function stateRecord(layout: StorageLayout): unknown {
  return JSON.parse(fs.readFileSync(path.join(layout.internal, STATE_ROOT_NAME), 'utf8'))
}

async function restart(layout: StorageLayout): Promise<TarSessionStore> {
  const sessions = new TarSessionStore({ layout, maxStagingBytes: 4 * 1024 * 1024 })
  await sessions.init()
  return sessions
}

async function recover(
  layout: StorageLayout,
  options: { isAuthorized?: (owner: Uint8Array) => boolean } = {}
) {
  const sessions = await restart(layout)
  const commits = new CommitStore({
    layout,
    storage: createStorage(),
    logger: { warn() {} },
    legacyDirectoryTrees: true
  })
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

type Boundary =
  | 'journal-durable'
  | 'dedup-moved'
  | 'moved'
  | 'swapped'
  | 'current-sidecar'
  | 'history-moved'
  | 'history-sidecar'
  | 'cleanup'

const BEFORE_LINEARIZATION: readonly Boundary[] = [
  'journal-durable',
  'dedup-moved',
  'moved',
  'swapped'
]

interface Crashed {
  layout: StorageLayout
  nextId: string
  oldRecord: CommitRecord
  /** The history record the returning content already had, when it was parked. */
  parkedRecord: CommitRecord | null
  harness: Harness
}

/**
 * Runs one replacement against storage that stops the process (every later mutation throws) right
 * after the named boundary, then closes the session store as a dying process would. `dedup` makes
 * the content that is replacing already exist as a history copy (A, B, then A again).
 */
async function crashReplacement(
  t: Assert,
  boundary: Boundary,
  dedup: boolean,
  extra: CreateStorageOptions = {}
): Promise<Crashed> {
  const target: {
    layout: StorageLayout | null
    nextId: string
    oldId: string
    armed: boolean
    crashed: boolean
  } = { layout: null, nextId: '', oldId: '', armed: false, crashed: false }
  const storage = createStorage({
    ...extra,
    beforeOperation(name) {
      if (target.crashed && MUTATIONS.has(name)) {
        throw new Error('process stopped at crash boundary')
      }
    },
    afterOperation(name, source, destination) {
      const layout = target.layout
      if (!target.armed || target.crashed || layout === null) return
      const to = typeof destination === 'string' ? destination : ''
      const hit =
        (boundary === 'journal-durable' && name === 'sync' && source === layout.journals) ||
        (boundary === 'dedup-moved' &&
          name === 'rename' &&
          to.startsWith(layout.publications) &&
          to.endsWith('.dedup')) ||
        (boundary === 'moved' &&
          name === 'rename' &&
          to.startsWith(layout.publications) &&
          to.endsWith('.tree')) ||
        (boundary === 'swapped' && name === 'swap') ||
        (boundary === 'current-sidecar' &&
          name === 'rename' &&
          to === path.join(layout.commits, `${target.nextId}.json`)) ||
        (boundary === 'history-moved' &&
          name === 'rename' &&
          source.startsWith(layout.publications) &&
          to === path.join(layout.root, historyName(target.oldId))) ||
        (boundary === 'history-sidecar' &&
          name === 'rename' &&
          to === path.join(layout.commits, `${target.oldId}.json`)) ||
        (boundary === 'cleanup' &&
          name === 'unlink' &&
          source === path.join(layout.sessions, `${target.nextId}.json`))
      if (!hit) return
      target.crashed = true
      throw new Error(`crash at ${boundary}`)
    }
  })
  const harness = await createHarness(t, storage)
  target.layout = harness.layout
  let oldRecord: CommitRecord
  let next: TarSession
  let parkedRecord: CommitRecord | null = null
  if (dedup) {
    await harness.publish(NAME, TREE_A)
    await harness.replace(NAME, TREE_B)
    const current = (await harness.commits.list()).find((record) => record.name === NAME)
    if (current === undefined) throw new Error('the current record is missing')
    oldRecord = current
    next = await harness.stageTree(NAME, TREE_A)
    parkedRecord = await readRecord(path.join(harness.layout.commits, `${next.id}.json`))
  } else {
    oldRecord = await harness.publish(NAME, TREE_A)
    next = await harness.stageTree(NAME, TREE_B)
  }
  target.nextId = next.id
  target.oldId = oldRecord.transferId
  // Learn what this layout's filesystem can do before the clock starts: the probe is not the
  // transaction under test.
  await harness.commits.supportsAtomicSwap()
  target.armed = true
  await harness.commits.commit(next, { replace: ALLOW }).then(
    () => undefined,
    () => undefined
  )
  t.ok(target.crashed, `${boundary} reached`)
  await harness.sessions.close()
  return { layout: harness.layout, nextId: next.id, oldRecord, parkedRecord, harness }
}

test('a managed directory is replaced by exchange and the old tree is kept as history', async (t) => {
  const harness = await createHarness(t)
  const old = await harness.publish(NAME, TREE_A)
  t.is(old.version, 3)
  t.alike(
    stateRecord(harness.layout),
    { version: 1, root: harness.layout.root },
    'untouched so far'
  )
  t.is(stateRequiresFeature(harness.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT), false)

  const record = await harness.replace(NAME, TREE_B)
  t.is(record.version, 3, 'the current record is a version 3 directory record')
  t.is(record.replaces, undefined)
  t.is(record.name, NAME)
  t.not(record.transferId, old.transferId)

  const root = harness.layout.root
  t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B), 'the name holds the new tree')
  t.alike(
    await snapshot(path.join(root, historyName(old.transferId))),
    shape(TREE_A),
    'the old tree, empty directories included, is the history copy'
  )
  const history = await readRecord(path.join(harness.layout.commits, `${old.transferId}.json`))
  t.alike(history, { ...old, version: 4, name: historyName(old.transferId) })
  t.alike(await readRecord(path.join(harness.layout.commits, `${record.transferId}.json`)), record)
  t.alike(
    (await harness.commits.list()).map((entry) => entry.name).sort(),
    [NAME, historyName(old.transferId)].sort()
  )
  for (const leftover of [
    harness.layout.journals,
    harness.layout.publications,
    harness.layout.sessions
  ]) {
    t.alike(await fs.promises.readdir(leftover), [], `${path.basename(leftover)} is empty`)
  }
  t.is(await exists(path.join(harness.layout.staging, `${record.transferId}.tree`)), false)
  t.alike(
    (await fs.promises.readdir(harness.layout.staging)).filter((entry) => !entry.endsWith('.part')),
    [],
    'no staging tree is left'
  )
})

test('without permission a directory is never replaced', async (t) => {
  const harness = await createHarness(t)
  await harness.publish(NAME, TREE_A)
  for (const permission of [undefined, { allows: () => false }]) {
    const session = await harness.stageTree(NAME, TREE_B)
    await t.exception(
      () => harness.commits.commit(session, permission ? { replace: permission } : {}),
      { code: ERRORS.FILE_EXISTS }
    )
    await harness.sessions.retireCommitted(session.transferId)
  }
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_A))
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(stateRecord(harness.layout), { version: 1, root: harness.layout.root })
})

test('a permission by name decides which directories are replaced', async (t) => {
  const harness = await createHarness(t)
  await harness.publish('beta-1.0.0', TREE_A)
  await harness.publish('prod-1.0.0', TREE_A)
  const scoped: ReplacePermission = { allows: (name) => name.startsWith('beta-') }

  const beta = await harness.replace('beta-1.0.0', TREE_B, scoped)
  t.is(beta.name, 'beta-1.0.0')
  const refused = await harness.stageTree('prod-1.0.0', TREE_B)
  await t.exception(() => harness.commits.commit(refused, { replace: scoped }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await snapshot(path.join(harness.layout.root, 'beta-1.0.0')), shape(TREE_B))
  t.alike(await snapshot(path.join(harness.layout.root, 'prod-1.0.0')), shape(TREE_A))
})

test('a legacy replaceNames entry now replaces a managed directory too', async (t) => {
  const harness = await createHarness(t)
  const old = await harness.publish(NAME, TREE_A)
  const session = await harness.stageTree(NAME, TREE_B)
  const record = await harness.commits.commit(session, { replaceNames: [NAME] })
  t.not(record.transferId, old.transferId)
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_B))
  t.ok(await exists(path.join(harness.layout.root, historyName(old.transferId))))
})

test('an unmanaged path is never adopted or replaced, even where every name is allowed', async (t) => {
  const harness = await createHarness(t)
  const root = harness.layout.root

  // A directory nobody uploaded.
  await writeTree(path.join(root, 'operator'), { 'keep.txt': 'mine' })
  const first = await harness.stageTree('operator', TREE_B)
  await t.exception(() => harness.commits.commit(first, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await snapshot(path.join(root, 'operator')), { 'keep.txt': 'mine' })

  // A symlink at the name.
  await fs.promises.mkdir(path.join(root, 'elsewhere'))
  await fs.promises.symlink('elsewhere', path.join(root, 'linked'))
  const second = await harness.stageTree('linked', TREE_B)
  await t.exception(() => harness.commits.commit(second, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.is(await fs.promises.readlink(path.join(root, 'linked')), 'elsewhere')

  // A file where a directory is offered, and a directory where a file is.
  await fs.promises.writeFile(path.join(root, 'plain'), 'file')
  const third = await harness.stageTree('plain', TREE_B)
  await t.exception(() => harness.commits.commit(third, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.is(await fs.promises.readFile(path.join(root, 'plain'), 'utf8'), 'file')

  // A managed directory that lost its record is unmanaged too.
  const lost = await harness.publish('lost', TREE_A)
  await fs.promises.unlink(path.join(harness.layout.commits, `${lost.transferId}.json`))
  const fourth = await harness.stageTree('lost', TREE_B)
  await t.exception(() => harness.commits.commit(fourth, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await snapshot(path.join(root, 'lost')), shape(TREE_A))

  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(stateRecord(harness.layout), { version: 1, root: harness.layout.root })
})

test('a managed artifact never changes kind', async (t) => {
  const harness = await createHarness(t)
  await harness.publish(NAME, TREE_A)
  // A file offered over a managed directory is refused, even where the name may be replaced.
  const asFile = await harness.commits.inspect(
    NAME,
    {
      name: NAME,
      kind: 'file',
      size: 12,
      digest: b4a.alloc(32, 1),
      transferId: b4a.alloc(32, 2)
    },
    { replace: ALLOW }
  )
  t.alike(asFile, { status: 'FILE_EXISTS' })
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_A))
})

test('a managed directory that was changed afterwards is preserved, whatever changed', async (t) => {
  const mutations: Array<[string, (tree: string) => Promise<void>]> = [
    ['a child file changed', (tree) => fs.promises.writeFile(path.join(tree, 'a.bin'), 'mutated')],
    ['a child file added', (tree) => fs.promises.writeFile(path.join(tree, 'new.bin'), 'x')],
    ['a child file removed', (tree) => fs.promises.unlink(path.join(tree, 'a.bin'))],
    ['an empty directory added', (tree) => fs.promises.mkdir(path.join(tree, 'fresh'))],
    ['an empty directory removed', (tree) => fs.promises.rmdir(path.join(tree, 'empty'))],
    [
      'a nested file added',
      (tree) => fs.promises.writeFile(path.join(tree, 'sub', 'deep.bin'), 'x')
    ],
    ['a symlink added', (tree) => fs.promises.symlink('a.bin', path.join(tree, 'link'))]
  ]
  for (const [label, mutate] of mutations) {
    const harness = await createHarness(t)
    await harness.publish(NAME, TREE_A)
    const tree = path.join(harness.layout.root, NAME)
    await mutate(tree)
    const before = await snapshot(tree)
    const session = await harness.stageTree(NAME, TREE_B)
    await t.exception(
      () => harness.commits.commit(session, { replace: ALLOW }),
      { code: ERRORS.FILE_EXISTS },
      label
    )
    t.alike(await snapshot(tree), before, `${label}: left as it was`)
    t.alike(await fs.promises.readdir(harness.layout.journals), [], `${label}: no journal`)
    t.alike(await fs.promises.readdir(harness.layout.publications), [], `${label}: nothing parked`)
  }
})

test('inspect reports what a directory offer would do', async (t) => {
  const harness = await createHarness(t)
  const old = await harness.publish(NAME, TREE_A)
  const next = await harness.stageTree(NAME, TREE_B)
  const offer = {
    name: NAME,
    kind: 'directory' as const,
    size: next.size,
    entryCount: next.entryCount,
    digest: next.digest,
    transferId: next.transferId
  }

  t.alike(await harness.commits.inspect(NAME, offer), { status: 'FILE_EXISTS' }, 'off by default')
  t.alike(await harness.commits.inspect(NAME, offer, { replace: ALLOW }), {
    status: 'REPLACEABLE',
    record: old
  })
  t.alike(
    await harness.commits.inspect(NAME, offer, {
      replace: { allows: () => true, busy: () => true }
    }),
    { status: 'BUSY' }
  )
  t.alike(
    await harness.commits.inspect(NAME, offer, {
      replace: { allows: () => true, busy: async () => false }
    }),
    { status: 'REPLACEABLE', record: old }
  )
  t.alike(
    await harness.commits.inspect('free-name', { ...offer, name: 'free-name' }, { replace: ALLOW }),
    { status: 'AVAILABLE' }
  )

  // The offer that is already the current content is already committed, whoever replaces. It is
  // built from the manifest: the staged B session above still owns the name, and a second active
  // session for it is exactly what the server refuses.
  const current = await harness.offerFor(NAME, TREE_A)
  t.alike(
    await harness.commits.inspect(NAME, current, { replace: ALLOW }),
    { status: 'ALREADY_COMMITTED', record: old },
    'current content, with another transfer staged for the name'
  )
  await t.exception(() => harness.stageTree(NAME, TREE_A), { code: ERRORS.FILE_BUSY })
})

test('a storage that cannot exchange directories refuses before anything published changes', async (t) => {
  const withoutSwap = await createHarness(t, createStorage({ atomicSwap: false }))
  await withoutSwap.publish(NAME, TREE_A)
  const session = await withoutSwap.stageTree(NAME, TREE_B)
  const offer = {
    name: NAME,
    kind: 'directory' as const,
    size: session.size,
    entryCount: session.entryCount,
    digest: session.digest,
    transferId: session.transferId
  }
  t.alike(await withoutSwap.commits.inspect(NAME, offer, { replace: ALLOW }), {
    status: 'UNSUPPORTED'
  })
  await t.exception(() => withoutSwap.commits.commit(session, { replace: ALLOW }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })

  const failing = await createHarness(
    t,
    createStorage({
      atomicSwap: () => Promise.reject(Object.assign(new Error('no exchange'), { code: 'ENOTSUP' }))
    })
  )
  await failing.publish(NAME, TREE_A)
  const other = await failing.stageTree(NAME, TREE_B)
  await t.exception(() => failing.commits.commit(other, { replace: ALLOW }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })

  for (const harness of [withoutSwap, failing]) {
    t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_A))
    t.alike(await fs.promises.readdir(harness.layout.journals), [])
    t.alike(await fs.promises.readdir(harness.layout.publications), [], 'the probe cleaned up')
    t.alike(
      stateRecord(harness.layout),
      { version: 1, root: harness.layout.root },
      'the state is not marked for a replacement that never began'
    )
  }
})

test('the exchange probe runs once per layout and not for a file or a plain create', async (t) => {
  let swaps = 0
  const storage = createStorage({
    beforeOperation(name) {
      if (name === 'swap') swaps++
    }
  })
  const harness = await createHarness(t, storage)
  await harness.publish(NAME, TREE_A)
  await harness.publish('other', TREE_A)
  t.is(swaps, 0, 'creating directories never probes')
  t.is(await harness.commits.supportsAtomicSwap(), true)
  t.is(swaps, 1, 'one probe exchange')
  await harness.replace(NAME, TREE_B)
  t.is(swaps, 2, 'the replacement exchanged once more and did not probe again')
  await harness.replace(NAME, TREE_A)
  t.is(swaps, 3)
  t.is(await harness.commits.supportsAtomicSwap(), true)
  t.is(swaps, 3, 'the answer is remembered')
  // Another layout is another filesystem as far as this store knows: it asks for itself.
  const separate = await createHarness(t, storage)
  t.is(await separate.commits.supportsAtomicSwap(), true)
  t.is(swaps, 4)
})

test('a probe that cannot run is not an answer and is tried again', async (t) => {
  let fail = true
  const storage = createStorage({
    atomicSwap: async (first, second) => {
      if (fail) throw Object.assign(new Error('disk error'), { code: 'EIO' })
      await nativeAtomicSwap(first, second)
    }
  })
  const harness = await createHarness(t, storage)
  await t.exception(() => harness.commits.supportsAtomicSwap(), { code: ERRORS.COMMIT_FAILED })
  fail = false
  t.is(await harness.commits.supportsAtomicSwap(), true)
})

test('the state is marked durably before the journal exists, and a 0.7 reader refuses it', async (t) => {
  let atJournal: unknown = null
  const target: { layout: StorageLayout | null; armed: boolean } = { layout: null, armed: false }
  const storage = createStorage({
    beforeOperation(name, _source, destination) {
      const layout = target.layout
      if (
        layout !== null &&
        target.armed &&
        name === 'link' &&
        atJournal === null &&
        typeof destination === 'string' &&
        destination.startsWith(layout.journals)
      ) {
        atJournal = stateRecord(layout)
      }
    }
  })
  const harness = await createHarness(t, storage)
  target.layout = harness.layout
  await harness.publish(NAME, TREE_A)
  const marker = path.join(harness.layout.internal, STATE_ROOT_NAME)
  const canonicalRoot = await fs.promises.realpath(harness.layout.root)
  t.is(legacyReadBinding(marker), canonicalRoot, 'a 0.7 reader reads the untouched record')

  target.armed = true
  await harness.replace(NAME, TREE_B)
  const expected = {
    version: 2,
    root: { path: canonicalRoot, requires: [STATE_FEATURE_DIRECTORY_REPLACEMENT] }
  }
  t.alike(atJournal, expected, 'already marked when the journal was first made durable')
  t.alike(stateRecord(harness.layout), expected)
  t.is(stateRequiresFeature(harness.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT), true)
  t.is(
    (await fs.promises.stat(marker)).mode & 0o777,
    0o600,
    'the record stays private to its owner'
  )
  t.alike(
    (await fs.promises.readdir(harness.layout.internal)).filter((entry) => entry.endsWith('.tmp')),
    [],
    'no temporary record is left'
  )

  // What a downgraded server runs first, before it reads one journal, sidecar or session.
  await t.exception(
    () => legacyReadBinding(marker),
    { code: ERRORS.PROTOCOL_INVALID, message: /Malformed state directory record/ },
    'a 0.7 reader stops at startup'
  )

  // This release reads both shapes, and reset-storage finds its layout through the same reader.
  const found = findLayout(harness.layout.root, harness.layout.internal)
  t.is(found.internal, harness.layout.internal)
  const again = initLayout(harness.layout.root, harness.layout.internal)
  t.is(again.root, harness.layout.root)
  t.alike(stateRecord(harness.layout), expected, 'opening it again leaves the record as it is')
})

test('marking the state is idempotent and never binds another root', async (t) => {
  // A record this release refuses, written for each shape and checked below.
  const first = await createHarness(t)
  requireStateFeature(first.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT)
  const bytes = fs.readFileSync(path.join(first.layout.internal, STATE_ROOT_NAME), 'utf8')
  requireStateFeature(first.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT)
  t.is(
    fs.readFileSync(path.join(first.layout.internal, STATE_ROOT_NAME), 'utf8'),
    bytes,
    'a second call changes nothing'
  )

  const marker = path.join(first.layout.internal, STATE_ROOT_NAME)
  const canonical = await fs.promises.realpath(first.layout.root)
  const refused: Array<[string, unknown]> = [
    [
      'an unknown required feature',
      { version: 2, root: { path: canonical, requires: ['future-v9'] } }
    ],
    ['a strict record under version 1', { version: 1, root: { path: canonical, requires: [] } }],
    ['no requirement list', { version: 2, root: { path: canonical } }],
    ['an extra key', { version: 2, root: { path: canonical, requires: [], extra: 1 } }],
    ['a non-string feature', { version: 2, root: { path: canonical, requires: [5] } }],
    ['no root', { version: 2 }]
  ]
  for (const [label, record] of refused) {
    fs.writeFileSync(marker, JSON.stringify(record))
    await t.exception(
      () => findLayout(first.layout.root, first.layout.internal),
      { code: ERRORS.PROTOCOL_INVALID },
      label
    )
  }

  const second = await createHarness(t)
  fs.writeFileSync(
    path.join(second.layout.internal, STATE_ROOT_NAME),
    JSON.stringify({ version: 1, root: '/somewhere/else' })
  )
  await t.exception(
    () => requireStateFeature(second.layout, STATE_FEATURE_DIRECTORY_REPLACEMENT),
    { code: ERRORS.PROTOCOL_INVALID, message: /belongs to output root/ },
    'a record naming another root is refused'
  )
})

test('a replacement waits while the artifact is busy and goes through once it is not', async (t) => {
  let busy = true
  const permission: ReplacePermission = { allows: () => true, busy: () => busy }
  const harness = await createHarness(t)
  const old = await harness.publish(NAME, TREE_A)
  const session = await harness.stageTree(NAME, TREE_B)
  await t.exception(() => harness.commits.commit(session, { replace: permission }), {
    code: ERRORS.FILE_BUSY
  })
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_A))
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(stateRecord(harness.layout), { version: 1, root: harness.layout.root })
  t.alike(await fs.promises.readdir(harness.layout.sessions), [`${session.id}.json`])

  busy = false
  const record = await harness.commits.commit(session, { replace: permission })
  t.not(record.transferId, old.transferId)
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_B))
})

test('replacing A with B, then A, then B keeps exactly one copy of each and the right history', async (t) => {
  const harness = await createHarness(t)
  const root = harness.layout.root
  const a = await harness.publish(NAME, TREE_A)

  const b = await harness.replace(NAME, TREE_B)
  t.alike(await snapshot(path.join(root, historyName(a.transferId))), shape(TREE_A))

  const againA = await harness.replace(NAME, TREE_A)
  t.is(againA.transferId, a.transferId, 'the same content is the same transfer')
  t.alike(await snapshot(path.join(root, NAME)), shape(TREE_A))
  t.alike(await snapshot(path.join(root, historyName(b.transferId))), shape(TREE_B))
  t.is(
    await exists(path.join(root, historyName(a.transferId))),
    false,
    'the returning content is the only copy of itself'
  )
  t.alike(
    (await harness.commits.list()).map((record) => `${record.name}:${record.version}`).sort(),
    [`${NAME}:3`, `${historyName(b.transferId)}:4`].sort()
  )
  t.alike(await readRecord(path.join(harness.layout.commits, `${a.transferId}.json`)), againA)

  const againB = await harness.replace(NAME, TREE_B)
  t.is(againB.transferId, b.transferId)
  t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B))
  t.alike(await snapshot(path.join(root, historyName(a.transferId))), shape(TREE_A))
  t.is(await exists(path.join(root, historyName(b.transferId))), false)
  t.alike(
    (await harness.commits.list()).map((record) => `${record.name}:${record.version}`).sort(),
    [`${NAME}:3`, `${historyName(a.transferId)}:4`].sort()
  )
  t.alike(await fs.promises.readdir(harness.layout.publications), [])
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
})

test('a returning history copy that is not what its record says blocks the replacement', async (t) => {
  const harness = await createHarness(t)
  const root = harness.layout.root
  const a = await harness.publish(NAME, TREE_A)
  await harness.replace(NAME, TREE_B)
  await fs.promises.writeFile(path.join(root, historyName(a.transferId), 'a.bin'), 'tampered')
  const session = await harness.stageTree(NAME, TREE_A)
  await t.exception(() => harness.commits.commit(session, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B))
  t.is(
    await fs.promises.readFile(path.join(root, historyName(a.transferId), 'a.bin'), 'utf8'),
    'tampered'
  )
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
})

test('an occupied history name that is not the old tree blocks the replacement untouched', async (t) => {
  const harness = await createHarness(t)
  const root = harness.layout.root
  const a = await harness.publish(NAME, TREE_A)
  await writeTree(path.join(root, historyName(a.transferId)), { 'foreign.txt': 'foreign' })
  const session = await harness.stageTree(NAME, TREE_B)
  await t.exception(() => harness.commits.commit(session, { replace: ALLOW }), {
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await snapshot(path.join(root, historyName(a.transferId))), { 'foreign.txt': 'foreign' })
  t.alike(await snapshot(path.join(root, NAME)), shape(TREE_A))
})

test('every boundary of a replacement recovers to the old tree or to the finished replacement', async (t) => {
  const boundaries: Boundary[] = [
    'journal-durable',
    'moved',
    'swapped',
    'current-sidecar',
    'history-moved',
    'history-sidecar',
    'cleanup'
  ]
  for (const boundary of boundaries) {
    const crash = await crashReplacement(t, boundary, false)
    const { layout, nextId, oldRecord } = crash
    const root = layout.root
    const history = path.join(root, historyName(oldRecord.transferId))
    const sidecar = path.join(layout.commits, `${nextId}.json`)
    const before = BEFORE_LINEARIZATION.includes(boundary)

    const { results, sessions, commits } = await recover(layout)
    t.is(results.length, 1, boundary)
    t.is(results[0].status, before ? 'RESUMABLE' : 'COMMITTED', boundary)
    t.is(await exists(path.join(layout.journals, `${nextId}.json`)), false, `${boundary}: journal`)
    t.alike(await fs.promises.readdir(layout.publications), [], `${boundary}: nothing parked`)
    if (before) {
      t.alike(await snapshot(path.join(root, NAME)), shape(TREE_A), `${boundary}: old tree`)
      t.is(await exists(history), false, `${boundary}: no history`)
      t.is(await exists(sidecar), false, `${boundary}: no new record`)
      t.alike(
        await snapshot(path.join(layout.staging, `${nextId}.tree`)),
        shape(TREE_B),
        `${boundary}: the new tree is back in staging`
      )
      t.alike(
        await readRecord(path.join(layout.commits, `${oldRecord.transferId}.json`)),
        oldRecord
      )
      t.alike(
        (await commits.list()).map((record) => record.name),
        [NAME],
        boundary
      )
      // Still retryable: the session survived and the replacement can be run again.
      const session = await sessions.readVerified(b4a.from(nextId, 'hex'))
      const retried = await commits.commit(session, { replace: ALLOW })
      t.is(retried.transferId, nextId, `${boundary}: retry`)
      t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B), `${boundary}: retried`)
    } else {
      t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B), `${boundary}: new tree`)
      t.alike(await snapshot(history), shape(TREE_A), `${boundary}: old tree is history`)
      const current = await readRecord(sidecar)
      t.is(current.version, 3, boundary)
      t.is(current.name, NAME, boundary)
      t.alike(
        await readRecord(path.join(layout.commits, `${oldRecord.transferId}.json`)),
        { ...oldRecord, version: 4, name: historyName(oldRecord.transferId) },
        `${boundary}: old record is its history record`
      )
      t.alike(
        (await commits.list()).map((record) => record.name).sort(),
        [NAME, historyName(oldRecord.transferId)].sort(),
        boundary
      )
      t.is(
        await exists(path.join(layout.sessions, `${nextId}.json`)),
        false,
        `${boundary}: session`
      )
    }
    await sessions.close()

    // Recovery repeated finds nothing to do and changes nothing.
    const second = await recover(layout)
    t.is(second.results.length, 0, `${boundary}: idempotent`)
    await second.sessions.close()
  }
})

test('every boundary of a replacement that returns old content recovers exactly, dedup included', async (t) => {
  const boundaries: Boundary[] = [
    'journal-durable',
    'dedup-moved',
    'moved',
    'swapped',
    'current-sidecar',
    'history-moved',
    'history-sidecar',
    'cleanup'
  ]
  for (const boundary of boundaries) {
    const crash = await crashReplacement(t, boundary, true)
    const { layout, nextId, oldRecord, parkedRecord } = crash
    if (parkedRecord === null) throw new Error('no parked record')
    const root = layout.root
    const returning = path.join(root, historyName(nextId))
    const history = path.join(root, historyName(oldRecord.transferId))
    const sidecar = path.join(layout.commits, `${nextId}.json`)
    const before = BEFORE_LINEARIZATION.includes(boundary)

    const { results, sessions, commits } = await recover(layout)
    t.is(results[0].status, before ? 'RESUMABLE' : 'COMMITTED', boundary)
    t.alike(await fs.promises.readdir(layout.publications), [], `${boundary}: nothing parked`)
    if (before) {
      t.alike(await snapshot(path.join(root, NAME)), shape(TREE_B), `${boundary}: current is B`)
      t.alike(
        await snapshot(returning),
        shape(TREE_A),
        `${boundary}: the history copy of the returning content is back`
      )
      t.alike(
        await readRecord(sidecar),
        parkedRecord,
        `${boundary}: its record is exactly as it was`
      )
      t.is(await exists(history), false, `${boundary}: no history of the replaced tree yet`)
      t.alike(
        await snapshot(path.join(layout.staging, `${nextId}.tree`)),
        shape(TREE_A),
        `${boundary}: the returning tree is staged again`
      )
      t.alike(
        (await commits.list()).map((record) => record.name).sort(),
        [NAME, historyName(nextId)].sort(),
        boundary
      )
      const retried = await commits.commit(await sessions.readVerified(b4a.from(nextId, 'hex')), {
        replace: ALLOW
      })
      t.is(retried.transferId, nextId, `${boundary}: retry`)
      t.is(await exists(returning), false, `${boundary}: retried and deduplicated`)
    } else {
      t.alike(await snapshot(path.join(root, NAME)), shape(TREE_A), `${boundary}: current is A`)
      t.alike(await snapshot(history), shape(TREE_B), `${boundary}: B is history`)
      t.is(await exists(returning), false, `${boundary}: the duplicate is gone`)
      const current = await readRecord(sidecar)
      t.is(current.version, 3, boundary)
      t.is(current.name, NAME, boundary)
      t.alike(
        (await commits.list()).map((record) => record.name).sort(),
        [NAME, historyName(oldRecord.transferId)].sort(),
        boundary
      )
    }
    await sessions.close()
    const second = await recover(layout)
    t.is(second.results.length, 0, `${boundary}: idempotent`)
    await second.sessions.close()
  }
})

test('a revoked owner aborts an unfinished replacement and cannot undo a finished one', async (t) => {
  const unfinished = await crashReplacement(t, 'swapped', false)
  const aborted = await recover(unfinished.layout, { isAuthorized: () => false })
  t.is(aborted.results[0].status, 'ABORTED')
  t.alike(
    await snapshot(path.join(unfinished.layout.root, NAME)),
    shape(TREE_A),
    'the old tree is restored'
  )
  t.is(
    await exists(path.join(unfinished.layout.root, historyName(unfinished.oldRecord.transferId))),
    false
  )
  await aborted.sessions.close()

  const finished = await crashReplacement(t, 'current-sidecar', false)
  const kept = await recover(finished.layout, { isAuthorized: () => false })
  t.is(kept.results[0].status, 'COMMITTED')
  t.alike(await snapshot(path.join(finished.layout.root, NAME)), shape(TREE_B))
  await kept.sessions.close()
})

test('recovery stops at a path it does not own and leaves it exactly as it found it', async (t) => {
  // The publication path replaced by a foreign directory after the new tree was parked.
  const parked = await crashReplacement(t, 'moved', false)
  const [publicationName] = await fs.promises.readdir(parked.layout.publications)
  const publication = path.join(parked.layout.publications, publicationName)
  await fs.promises.rename(publication, `${publication}.aside`)
  await writeTree(publication, { 'foreign.txt': 'foreign' })
  await t.exception(() => recover(parked.layout), { code: ERRORS.PROTOCOL_INVALID })
  t.alike(await snapshot(publication), { 'foreign.txt': 'foreign' })
  t.alike(await snapshot(path.join(parked.layout.root, NAME)), shape(TREE_A))
  t.is(
    await exists(path.join(parked.layout.journals, `${parked.nextId}.json`)),
    true,
    'journal kept'
  )

  // The visible name replaced by a foreign directory after the exchange.
  const swapped = await crashReplacement(t, 'swapped', false)
  const visible = path.join(swapped.layout.root, NAME)
  await fs.promises.rename(visible, path.join(swapped.layout.root, 'moved-aside'))
  await writeTree(visible, { 'foreign.txt': 'foreign' })
  await t.exception(() => recover(swapped.layout), { code: ERRORS.PROTOCOL_INVALID })
  t.alike(await snapshot(visible), { 'foreign.txt': 'foreign' })
  t.is(await exists(path.join(swapped.layout.journals, `${swapped.nextId}.json`)), true)

  // The history name taken by a foreign directory after the new current record became durable.
  const linearized = await crashReplacement(t, 'current-sidecar', false)
  const historyPath = path.join(
    linearized.layout.root,
    historyName(linearized.oldRecord.transferId)
  )
  await writeTree(historyPath, { 'foreign.txt': 'foreign' })
  await t.exception(() => recover(linearized.layout), { code: ERRORS.PROTOCOL_INVALID })
  t.alike(await snapshot(historyPath), { 'foreign.txt': 'foreign' })
  const [parkedName] = await fs.promises.readdir(linearized.layout.publications)
  t.alike(
    await snapshot(path.join(linearized.layout.publications, parkedName)),
    shape(TREE_A),
    'the old tree is still safe at its private path'
  )
})

test('a recovery that is itself interrupted converges on the next attempt', async (t) => {
  const crash = await crashReplacement(t, 'swapped', false)
  // First recovery: the exchange back happens and then the process stops.
  const stops: { armed: boolean; crashed: boolean } = { armed: true, crashed: false }
  const storage = createStorage({
    beforeOperation(name) {
      if (stops.crashed && MUTATIONS.has(name)) throw new Error('process stopped during recovery')
    },
    afterOperation(name) {
      if (stops.armed && !stops.crashed && name === 'swap') {
        stops.crashed = true
        throw new Error('crash during recovery')
      }
    }
  })
  const sessions = await restart(crash.layout)
  const commits = new CommitStore({
    layout: crash.layout,
    storage,
    logger: { warn() {} },
    legacyDirectoryTrees: true
  })
  await t.exception(() =>
    recoverStorage({
      layout: crash.layout,
      sessionStore: sessions,
      commitStore: commits,
      logger: { warn() {} }
    })
  )
  await sessions.close()
  t.is(stops.crashed, true)

  const second = await recover(crash.layout)
  t.is(second.results[0].status, 'RESUMABLE')
  t.alike(await snapshot(path.join(crash.layout.root, NAME)), shape(TREE_A))
  t.alike(await snapshot(path.join(crash.layout.staging, `${crash.nextId}.tree`)), shape(TREE_B))
  await second.sessions.close()
})

test('a failed fsync after the exchange rolls the replacement back and leaves the old tree', async (t) => {
  let armed = false
  let swapped = false
  let failures = 0
  const storage = createStorage({
    afterOperation(name) {
      if (name === 'swap') swapped = true
    },
    // One failure, right after the exchange; the rollback that follows must be able to sync.
    failSyncFor: (filePath) =>
      armed && swapped && filePath.endsWith('publications') && failures++ < 1
  })
  const harness = await createHarness(t, storage)
  const old = await harness.publish(NAME, TREE_A)
  const session = await harness.stageTree(NAME, TREE_B)
  await harness.commits.supportsAtomicSwap()
  swapped = false
  armed = true
  await t.exception(() => harness.commits.commit(session, { replace: ALLOW }))
  armed = false
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_A))
  t.is(await exists(path.join(harness.layout.root, historyName(old.transferId))), false)
  t.alike(await snapshot(path.join(harness.layout.staging, `${session.id}.tree`)), shape(TREE_B))
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(await fs.promises.readdir(harness.layout.publications), [])
  t.alike(
    (await harness.commits.list()).map((record) => record.name),
    [NAME]
  )
})

test('an aborted replacement restores everything, a returning history copy included', async (t) => {
  const controller = { aborted: false }
  const signal = {
    get aborted() {
      return controller.aborted
    },
    addEventListener() {},
    removeEventListener() {}
  }
  let armed = false
  const storage = createStorage({
    // The abort arrives right after the exchange itself.
    afterOperation(name) {
      if (armed && name === 'swap') controller.aborted = true
    }
  })
  const harness = await createHarness(t, storage)
  const a = await harness.publish(NAME, TREE_A)
  await harness.replace(NAME, TREE_B)
  const parked = await readRecord(path.join(harness.layout.commits, `${a.transferId}.json`))
  const session = await harness.stageTree(NAME, TREE_A)
  armed = true
  await t.exception(() => harness.commits.commit(session, { replace: ALLOW, signal }), {
    code: ERRORS.ABORTED
  })
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_B))
  t.alike(
    await snapshot(path.join(harness.layout.root, historyName(a.transferId))),
    shape(TREE_A),
    'the returning history copy is back at its name'
  )
  t.alike(await readRecord(path.join(harness.layout.commits, `${a.transferId}.json`)), parked)
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(await fs.promises.readdir(harness.layout.publications), [])
})

test('a replacement keeps the replaced name through its own retention pass, and allowing it pins nothing', async (t) => {
  const clock = { time: 1_000, now: () => clock.time }
  const layoutRoot = await createTempDir(t)
  const storage = createStorage()
  const harness = await createHarness(t, storage, layoutRoot)
  const commits = new CommitStore({
    layout: harness.layout,
    storage,
    clock,
    logger: { warn() {} },
    legacyDirectoryTrees: true
  })
  const retention = new RetentionManager({
    layout: harness.layout,
    sessionStore: harness.sessions as never,
    commitStore: commits as never,
    storage,
    maxAge: 500,
    clock,
    isSessionActive: () => false
  })
  const publishWith = async (name: string, spec: TreeSpec, replace?: ReplacePermission) => {
    const session = await harness.stageTree(name, spec)
    const record = await commits.commit(session, {
      retentionManager: retention as never,
      deferPostCommitRetention: true,
      ...(replace ? { replace } : {})
    })
    await harness.sessions.retireCommitted(session.transferId)
    return record
  }
  const old = await publishWith(NAME, TREE_A)
  clock.time += 1_000

  // The pre-commit pass would age the old current record out; the replaced name is held.
  const record = await publishWith(NAME, TREE_B, ALLOW)
  t.alike(await snapshot(path.join(harness.layout.root, NAME)), shape(TREE_B))
  t.alike(
    await snapshot(path.join(harness.layout.root, historyName(old.transferId))),
    shape(TREE_A),
    'the replaced tree survived the pass and is the history copy'
  )

  // Nothing pins the new current artifact afterwards: it ages out like any other.
  clock.time += 1_000
  await retention.run()
  t.is(await exists(path.join(harness.layout.root, NAME)), false, 'allowing a name pins nothing')
  t.is(await exists(path.join(harness.layout.root, historyName(old.transferId))), false)
  t.alike(await commits.list(), [])
  t.is(typeof record.transferId, 'string')
})

test('retention neither deletes nor purges what an unfinished replacement owns', async (t) => {
  const crash = await crashReplacement(t, 'current-sidecar', false)
  const { layout, oldRecord, nextId } = crash
  const clock = { time: Date.now() + 10_000, now: () => clock.time }
  const sessions = await restart(layout)
  const commits = new CommitStore({
    layout,
    clock,
    logger: { warn() {} },
    legacyDirectoryTrees: true
  })
  const retention = new RetentionManager({
    layout,
    sessionStore: sessions as never,
    commitStore: commits as never,
    maxAge: 1,
    clock,
    isSessionActive: () => false
  })
  t.alike(
    [...(await commits.pendingReplacementPins())].sort(),
    [nextId, oldRecord.transferId].sort()
  )
  await retention.run()
  t.is(
    await exists(path.join(layout.commits, `${oldRecord.transferId}.json`)),
    true,
    'the old record was not purged although its tree is parked at a private path'
  )
  t.is(await exists(path.join(layout.commits, `${nextId}.json`)), true)
  const [parkedName] = await fs.promises.readdir(layout.publications)
  t.alike(await snapshot(path.join(layout.publications, parkedName)), shape(TREE_A))
  t.is(await exists(path.join(layout.journals, `${nextId}.json`)), true)
  await sessions.close()

  // Recovery then finishes the job, and from then on nothing is owned.
  const finished = await recover(layout)
  t.is(finished.results[0].status, 'COMMITTED')
  t.alike([...(await finished.commits.pendingReplacementPins())], [])
  await finished.sessions.close()
})

test('a history directory is removed like any managed directory', async (t) => {
  const harness = await createHarness(t)
  const old = await harness.publish(NAME, TREE_A)
  await harness.replace(NAME, TREE_B)
  const records = await harness.commits.list()
  const history = records.find((record) => record.name === historyName(old.transferId))
  if (history === undefined) throw new Error('missing history record')
  t.is(history.version, 4)
  t.is(await harness.commits.delete(history), true)
  t.is(await exists(path.join(harness.layout.root, history.name)), false)
  t.is(await exists(path.join(harness.layout.commits, `${old.transferId}.json`)), false)
  t.alike(await fs.promises.readdir(harness.layout.trash), [])
  t.alike(
    (await harness.commits.list()).map((record) => record.name),
    [NAME]
  )
})

test('different names are replaced independently and the same name one after another', async (t) => {
  const harness = await createHarness(t)
  await harness.publish('one', TREE_A)
  await harness.publish('two', TREE_A)
  const [first, second] = await Promise.all([
    harness.replace('one', TREE_B),
    harness.replace('two', TREE_B)
  ])
  t.is(first.name, 'one')
  t.is(second.name, 'two')
  t.alike(await snapshot(path.join(harness.layout.root, 'one')), shape(TREE_B))
  t.alike(await snapshot(path.join(harness.layout.root, 'two')), shape(TREE_B))

  // One name admits one session at a time: a second offer for it is FILE_BUSY until the first is
  // retired, and that guard is the server's, not something to route around. So the same name is
  // replaced one after another (stage, commit, retire, then the next), never two staged at once.
  const x1 = { 'x.bin': 'x1' }
  const x2 = { 'x.bin': 'x2' }
  const pending = await harness.stageTree('one', x1)
  await t.exception(
    () => harness.stageTree('one', x2),
    { code: ERRORS.FILE_BUSY },
    'a second session for a name that has an active one is refused at admission'
  )
  t.alike(
    await snapshot(path.join(harness.layout.root, 'one')),
    shape(TREE_B),
    'the refused offer changed nothing'
  )
  const afterX1 = await harness.commits.commit(pending, { replace: ALLOW })
  await harness.sessions.retireCommitted(pending.transferId)
  t.alike(await snapshot(path.join(harness.layout.root, 'one')), shape(x1))

  const afterX2 = await harness.replace('one', x2)
  t.alike(await snapshot(path.join(harness.layout.root, 'one')), shape(x2))
  t.alike(
    await snapshot(path.join(harness.layout.root, historyName(first.transferId))),
    shape(TREE_B),
    'the first replaced tree is a history copy'
  )
  t.alike(
    await snapshot(path.join(harness.layout.root, historyName(afterX1.transferId))),
    shape(x1),
    'and so is the second'
  )
  t.not(afterX1.transferId, afterX2.transferId)
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike(await fs.promises.readdir(harness.layout.publications), [])
  const names = (await harness.commits.list()).map((record) => record.name)
  t.is(names.filter((name) => name === 'one').length, 1, 'exactly one current artifact')
})

async function stageFile(
  t: Assert,
  sessions: TarSessionStore,
  name: string,
  content: string
): Promise<TarSession> {
  const sourceRoot = await createTempDir(t)
  const releaseRoot = path.join(sourceRoot, 'release')
  await fs.promises.mkdir(releaseRoot)
  const source = path.join(releaseRoot, name)
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

test('a file replacement under a permission holds the replaced name through its own retention pass', async (t) => {
  const clock = { time: 1_000, now: () => clock.time }
  const storage = createStorage()
  const harness = await createHarness(t, storage)
  const commits = new CommitStore({ layout: harness.layout, storage, clock, logger: { warn() {} } })
  const retention = new RetentionManager({
    layout: harness.layout,
    sessionStore: harness.sessions as never,
    commitStore: commits as never,
    storage,
    maxAge: 500,
    clock,
    isSessionActive: () => false
  })
  const publishFile = async (content: string, replace?: ReplacePermission) => {
    const session = await stageFile(t, harness.sessions, 'notes.txt', content)
    const record = await commits.commit(session, {
      retentionManager: retention as never,
      deferPostCommitRetention: true,
      ...(replace ? { replace } : {})
    })
    await harness.sessions.retireCommitted(session.transferId)
    return record
  }
  const old = await publishFile('one')
  clock.time += 1_000

  // Without anything pinning it, the old current file would age out in the pre-commit pass.
  const record = await publishFile('two', ALLOW)
  const root = harness.layout.root
  t.is(await fs.promises.readFile(path.join(root, 'notes.txt'), 'utf8'), 'two')
  t.is(
    await fs.promises.readFile(path.join(root, historyName(old.transferId)), 'utf8'),
    'one',
    'the replaced file survived the pass and is the history copy'
  )
  t.is(record.version, 2)

  clock.time += 1_000
  await retention.run()
  t.is(await exists(path.join(root, 'notes.txt')), false, 'allowing a name pins nothing')
  t.alike(await commits.list(), [])
})

test('a file under a permission is refused while busy and replaced once it is not', async (t) => {
  let busy = true
  const permission: ReplacePermission = { allows: () => true, busy: () => busy }
  const harness = await createHarness(t)
  const first = await stageFile(t, harness.sessions, 'notes.txt', 'one')
  await harness.commits.commit(first)
  // A name admits one session at a time: the committed one is retired before the next is staged.
  await harness.sessions.retireCommitted(first.transferId)
  const second = await stageFile(t, harness.sessions, 'notes.txt', 'two')
  const offer = {
    name: 'notes.txt',
    kind: 'file' as const,
    size: second.size,
    digest: second.digest,
    transferId: second.transferId
  }
  t.alike(await harness.commits.inspect('notes.txt', offer, { replace: permission }), {
    status: 'BUSY'
  })
  await t.exception(() => harness.commits.commit(second, { replace: permission }), {
    code: ERRORS.FILE_BUSY
  })
  t.is(await fs.promises.readFile(path.join(harness.layout.root, 'notes.txt'), 'utf8'), 'one')
  t.alike(await fs.promises.readdir(harness.layout.journals), [])

  busy = false
  const record = await harness.commits.commit(second, { replace: permission })
  await harness.sessions.retireCommitted(second.transferId)
  t.is(record.name, 'notes.txt')
  t.is(await fs.promises.readFile(path.join(harness.layout.root, 'notes.txt'), 'utf8'), 'two')
  t.alike(
    stateRecord(harness.layout),
    { version: 1, root: harness.layout.root },
    'no barrier for a file'
  )
})

test('an unmanaged file and a link are never replaced by a file, whatever is allowed', async (t) => {
  const harness = await createHarness(t)
  const root = harness.layout.root
  await fs.promises.writeFile(path.join(root, 'mine.txt'), 'mine')
  await fs.promises.mkdir(path.join(root, 'elsewhere'))
  await fs.promises.symlink('elsewhere', path.join(root, 'linked'))
  for (const name of ['mine.txt', 'linked']) {
    const session = await stageFile(t, harness.sessions, name, 'new')
    await t.exception(
      () => harness.commits.commit(session, { replace: ALLOW }),
      { code: ERRORS.FILE_EXISTS },
      name
    )
  }
  t.is(await fs.promises.readFile(path.join(root, 'mine.txt'), 'utf8'), 'mine')
  t.is(await fs.promises.readlink(path.join(root, 'linked')), 'elsewhere')
})

/** Whether `directory` is on a volume where two spellings of one name are a single entry. */
async function isCaseInsensitive(directory: string): Promise<boolean> {
  const probe = path.join(directory, 'Case-Probe')
  await fs.promises.mkdir(probe)
  try {
    return await exists(path.join(directory, 'case-probe'))
  } finally {
    await fs.promises.rmdir(probe)
  }
}

/** Every commit record file as written, by file name: the exact bytes the next start would read. */
async function recordFiles(layout: StorageLayout): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of (await fs.promises.readdir(layout.commits)).sort()) {
    out[name] = await fs.promises.readFile(path.join(layout.commits, name), 'utf8')
  }
  return out
}

function offerOf(session: TarSession) {
  return {
    name: session.name,
    kind: session.kind,
    size: session.size,
    digest: session.digest,
    transferId: session.transferId,
    entryCount: session.entryCount
  }
}

test('a differently cased name never aliases, adopts or overwrites a managed artifact', async (t) => {
  const harness = await createHarness(t)
  const { layout } = harness
  const root = layout.root
  const insensitive = await isCaseInsensitive(root)
  t.pass(
    insensitive
      ? 'case-insensitive volume: two spellings are one entry, so the aliasing guard is exercised'
      : 'NOT EXERCISED: this volume is case-sensitive, so the spellings are separate names; only their independence is checked'
  )

  const managedDirectory = await harness.publish('CaseName', TREE_A)
  const managedFileSession = await stageFile(t, harness.sessions, 'CaseFile', 'file-one')
  const managedFile = await harness.commits.commit(managedFileSession)
  await harness.sessions.retireCommitted(managedFileSession.transferId)

  const observe = async () => ({
    tree: await snapshot(root),
    records: await recordFiles(layout),
    journals: await fs.promises.readdir(layout.journals),
    publications: await fs.promises.readdir(layout.publications)
  })
  const before = await observe()
  t.alike(
    Object.keys(before.records).sort(),
    [`${managedDirectory.transferId}.json`, `${managedFile.transferId}.json`].sort()
  )

  // Each case: what is offered under the other spelling, and the managed name it collides with.
  const attempts: Array<{
    label: string
    kind: 'file' | 'directory'
    name: string
    stage: () => Promise<TarSession>
  }> = [
    {
      label: 'a directory over a managed directory',
      kind: 'directory',
      name: 'casename',
      stage: () => harness.stageTree('casename', TREE_B)
    },
    {
      label: 'a file over a managed directory',
      kind: 'file',
      name: 'casename',
      stage: () => stageFile(t, harness.sessions, 'casename', 'file-two')
    },
    {
      label: 'a file over a managed file',
      kind: 'file',
      name: 'casefile',
      stage: () => stageFile(t, harness.sessions, 'casefile', 'file-two')
    },
    {
      label: 'a directory over a managed file',
      kind: 'directory',
      name: 'casefile',
      stage: () => harness.stageTree('casefile', TREE_B)
    }
  ]

  if (insensitive) {
    // The very same content under the other spelling is another name's upload, not the managed
    // artifact's: it is never reported as already committed, replaceable or available.
    for (const [label, offer] of [
      ['the same content as the managed directory', await harness.offerFor('casename', TREE_A)],
      ['other content', await harness.offerFor('casename', TREE_B)]
    ] as const) {
      t.alike(
        await harness.commits.inspect('casename', offer, { replace: ALLOW }),
        { status: 'FILE_EXISTS' },
        `a directory offer of ${label}`
      )
    }
    for (const attempt of attempts) {
      const session = await attempt.stage()
      t.alike(
        await harness.commits.inspect(attempt.name, offerOf(session), { replace: ALLOW }),
        { status: 'FILE_EXISTS' },
        `${attempt.label}: inspected`
      )
      await t.exception(
        () => harness.commits.commit(session, { replace: ALLOW }),
        { code: ERRORS.FILE_EXISTS },
        `${attempt.label}: refused under the global permission`
      )
      await harness.sessions.delete(session.transferId)
    }
    t.alike(await observe(), before, 'content, records, journals and parked trees are untouched')
    t.alike(
      (await fs.promises.readdir(root)).sort(),
      ['CaseFile', 'CaseName'],
      'no second spelling appeared'
    )
    t.alike(
      stateRecord(layout),
      { version: 1, root },
      'nothing began, so the state is not marked for a replacement'
    )
  } else {
    // Separate names on this volume: each is its own artifact and the permission reaches only
    // the exact name it is asked about. Files only, so no two commits claim one new name.
    for (const attempt of attempts.filter((entry) => entry.kind === 'file')) {
      const session = await attempt.stage()
      t.alike(
        await harness.commits.inspect(attempt.name, offerOf(session), { replace: ALLOW }),
        { status: 'AVAILABLE' },
        `${attempt.label}: another name`
      )
      const record = await harness.commits.commit(session, { replace: ALLOW })
      await harness.sessions.retireCommitted(session.transferId)
      t.is(record.name, attempt.name)
    }
    const after = await observe()
    for (const [name, content] of Object.entries(before.tree)) {
      t.is(after.tree[name], content, `${name} is unchanged`)
    }
    for (const [file, bytes] of Object.entries(before.records)) {
      t.is(after.records[file], bytes, `${file} is unchanged`)
    }
  }

  // The exact spelling still replaces its own managed directory, so the refusals above are about
  // the spelling and not about replacement being broken.
  const replaced = await harness.replace('CaseName', TREE_B)
  t.is(replaced.name, 'CaseName')
  t.alike(await snapshot(path.join(root, 'CaseName')), shape(TREE_B))
  t.alike(
    await snapshot(path.join(root, historyName(managedDirectory.transferId))),
    shape(TREE_A),
    'the replaced tree is the history copy'
  )
  t.is(
    await fs.promises.readFile(path.join(root, 'CaseFile'), 'utf8'),
    'file-one',
    'the managed file was never touched'
  )

  if (insensitive) {
    // The history copy is managed too. Its name in another case is a legal artifact name that,
    // on this volume, is the same entry, and the reserved-name check is exact-case: the guard
    // that matters is that no record owns that spelling.
    const alias = `History-${managedDirectory.transferId}`
    const settled = await observe()
    for (const stage of [
      () => stageFile(t, harness.sessions, alias, 'file-three'),
      () => harness.stageTree(alias, TREE_B)
    ]) {
      const session = await stage()
      t.alike(
        await harness.commits.inspect(alias, offerOf(session), { replace: ALLOW }),
        { status: 'FILE_EXISTS' },
        `a ${session.kind} offered as the history copy's other spelling: inspected`
      )
      await t.exception(
        () => harness.commits.commit(session, { replace: ALLOW }),
        { code: ERRORS.FILE_EXISTS },
        `a ${session.kind} offered as the history copy's other spelling: refused`
      )
      await harness.sessions.delete(session.transferId)
    }
    t.alike(await observe(), settled, 'the history copy and its record are untouched')
  }
})

/**
 * The root-record reader of releases through 0.7, copied from that release: what a downgraded
 * server runs first, at startup, before it reads a journal, a sidecar or a session.
 */
function legacyReadBinding(marker: string): string | null {
  const stat = (() => {
    try {
      return fs.lstatSync(marker)
    } catch {
      return null
    }
  })()
  if (stat === null) return null
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024) {
    throw legacyError(`Unsafe storage file: ${marker}`)
  }
  let bound: unknown
  try {
    bound = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch (error: unknown) {
    throw legacyError(`Malformed state directory record: ${marker}`, error)
  }
  const owner = typeof bound === 'object' && bound !== null && 'root' in bound ? bound.root : null
  if (typeof owner !== 'string') throw legacyError(`Malformed state directory record: ${marker}`)
  return owner
}

function legacyError(message: string, cause: unknown = null): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code: ERRORS.PROTOCOL_INVALID })
}
