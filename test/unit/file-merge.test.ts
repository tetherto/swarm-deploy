/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import { ERRORS } from '../../dist/errors.js'
import {
  MAX_CATALOG_RECEIPTS,
  ownedDigest,
  snapshotId,
  subsetDigest
} from '../../dist/storage/file-catalog.js'
import {
  incomingFromDigest,
  observationPaths,
  planFileMerge,
  planOwnedCleanup,
  type ConflictReason,
  type IncomingEntry,
  type Observation
} from '../../dist/storage/file-merge.js'
import {
  Disk,
  accepted,
  deepFreeze,
  facts,
  fresh,
  hexId,
  incomingOf,
  merge,
  plan,
  refused,
  sha,
  writerOf
} from '../helpers/file-merge.js'

const FLATPAK = {
  'flatpak/app.flatpak': 'flatpak bytes',
  'flatpak/meta/appdata.xml': '<xml/>',
  'flatpak/empty/': ''
}
const SNAP = {
  'snap/app.snap': 'snap bytes',
  'snap/meta/snap.yaml': 'name: app',
  'snap/zero.bin': ''
}
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const label = (outcome: { actions: ReadonlyArray<{ op: string; path: string }> }): string[] =>
  outcome.actions.map((action) => `${action.op}:${action.path}`)

test('a Snap upload joins a folder that holds Flatpak and foreign files, with no permission and no adoption', (t) => {
  const foreign = {
    'README.txt': 'operator readme',
    'flatpak/notes.txt': 'operator note',
    'snap/stray.bin': 'someone elses'
  }
  const disk = new Disk(foreign)

  const first = merge(disk, fresh(), FLATPAK, { writer: writerOf(1) })
  t.alike(label(first.outcome), ['add:flatpak/app.flatpak', 'add:flatpak/meta/appdata.xml'])
  t.alike(
    first.outcome.directories,
    ['flatpak/meta'],
    'only the parent of an added file is created; flatpak/ was already there and flatpak/empty/ is no resource'
  )
  t.is(disk.nodes.has('flatpak/empty'), false, 'the empty directory was never published')
  t.alike(
    first.catalog.files.map((file) => file.path),
    ['flatpak/app.flatpak', 'flatpak/meta/appdata.xml']
  )

  // A different client uploads Snap into the same folder, without any replace permission.
  const second = merge(disk, first.catalog, SNAP, { writer: writerOf(2), allowReplace: false })
  t.alike(label(second.outcome), [
    'add:snap/app.snap',
    'add:snap/meta/snap.yaml',
    'add:snap/zero.bin'
  ])
  t.alike(
    second.outcome.directories,
    ['snap/meta'],
    'snap/ existed already (a foreign file is in it)'
  )
  t.alike(
    second.catalog.files.map((file) => file.path),
    [
      'flatpak/app.flatpak',
      'flatpak/meta/appdata.xml',
      'snap/app.snap',
      'snap/meta/snap.yaml',
      'snap/zero.bin'
    ],
    'both platforms are owned, file by file'
  )
  for (const [path, content] of Object.entries(foreign)) {
    t.is(disk.read(path), content, `${path} is untouched`)
    t.is(
      second.catalog.files.some((file) => file.path === path),
      false,
      `${path} is not adopted`
    )
  }

  // The identity of what is published is the owned files, written out by hand; the identity of what
  // was uploaded is the Snap subset. Neither is the other.
  t.is(
    second.outcome.result.digest,
    ownedDigest([
      facts('flatpak/app.flatpak', 'flatpak bytes'),
      facts('flatpak/meta/appdata.xml', '<xml/>'),
      facts('snap/app.snap', 'snap bytes'),
      facts('snap/meta/snap.yaml', 'name: app'),
      facts('snap/zero.bin', '')
    ])
  )
  t.is(
    second.outcome.subset,
    subsetDigest([
      facts('snap/app.snap', 'snap bytes'),
      facts('snap/meta/snap.yaml', 'name: app'),
      facts('snap/zero.bin', '')
    ])
  )
  t.not(second.outcome.subset, second.outcome.result.digest)
  t.is(second.outcome.previous.digest, first.outcome.result.digest, 'the state it started from')
  t.is(second.outcome.result.files, 5)
  t.is(second.outcome.result.bytes, 13 + 6 + 10 + 9)
  t.is(second.catalog.generation, 2)
  t.alike(
    second.catalog.receipts.map((receipt) => [receipt.transferId, receipt.added, receipt.skipped]),
    [
      [hexId(1), 2, 0],
      [hexId(2), 3, 0]
    ]
  )
})

test('without permission any differing collision refuses the whole upload and applies nothing', (t) => {
  const disk = new Disk()
  const owned = merge(disk, fresh(), FLATPAK).catalog
  const upload = {
    'flatpak/app.flatpak': 'flatpak bytes',
    'flatpak/meta/appdata.xml': '<xml version="2"/>',
    'snap/new.bin': 'new'
  }
  const before = disk.snapshot()
  const catalog = deepFreeze(owned)
  const incoming = deepFreeze(incomingOf(upload))
  const observed = disk.observe(observationPaths(incoming))
  for (const observation of observed.values()) deepFreeze(observation)

  const outcome = refused(
    planFileMerge({ catalog, incoming, observed, allowReplace: false, writer: writerOf(2) })
  )
  t.alike(outcome.conflicts, [{ path: 'flatpak/meta/appdata.xml', reason: 'DIFFERS_NOT_ALLOWED' }])
  t.is(outcome.totalConflicts, 1)
  t.is(
    'actions' in outcome,
    false,
    'a refused plan carries nothing to apply, not even the new file'
  )
  t.is(disk.snapshot(), before)

  // The same upload with the permission: the identical file is skipped as owned, the differing owned
  // file is replaced, the new file is added.
  const allowed = accepted(
    planFileMerge({ catalog, incoming, observed, allowReplace: true, writer: writerOf(2) })
  )
  t.alike(label(allowed), [
    'skip:flatpak/app.flatpak',
    'replace:flatpak/meta/appdata.xml',
    'add:snap/new.bin'
  ])
  t.alike(allowed.actions[0], {
    op: 'skip',
    path: 'flatpak/app.flatpak',
    size: 13,
    sha256: sha('flatpak bytes'),
    owned: true
  })
  t.alike((allowed.actions[1] as { previous: unknown }).previous, {
    size: 6,
    sha256: sha('<xml/>')
  })
})

test('a permitted merge replaces only the differing owned files, keeps the rest and records who wrote what', (t) => {
  const disk = new Disk({ 'flatpak/operator.txt': 'operator' })
  const one = merge(disk, fresh(), FLATPAK, { writer: writerOf(1) })
  const two = merge(disk, one.catalog, { 'snap/app.snap': 'snap bytes' }, { writer: writerOf(2) })
  const three = merge(
    disk,
    two.catalog,
    { 'flatpak/app.flatpak': 'flatpak bytes v2', 'snap/extra.snap': 'extra' },
    { writer: writerOf(3), allowReplace: true }
  )

  t.alike(label(three.outcome), ['replace:flatpak/app.flatpak', 'add:snap/extra.snap'])
  t.is(disk.read('flatpak/app.flatpak'), 'flatpak bytes v2')
  t.is(disk.read('flatpak/meta/appdata.xml'), '<xml/>', 'an omitted owned file stays')
  t.is(disk.read('snap/app.snap'), 'snap bytes', 'so does the other platform')
  t.is(disk.read('flatpak/operator.txt'), 'operator', 'and so does a foreign file')
  const writers = Object.fromEntries(
    three.catalog.files.map((file) => [file.path, file.writer.transferId])
  )
  t.alike(writers, {
    'flatpak/app.flatpak': hexId(3),
    'flatpak/meta/appdata.xml': hexId(1),
    'snap/app.snap': hexId(2),
    'snap/extra.snap': hexId(3)
  })
  t.alike(three.outcome.released, [])
})

test('an untracked or externally changed file is never overwritten, whatever is allowed', (t) => {
  const disk = new Disk({ 'snap/foreign.bin': 'operator content' })
  const owned = merge(disk, fresh(), FLATPAK).catalog

  // An untracked file with other bytes than the upload.
  const untracked = refused(
    plan(disk, owned, { 'snap/foreign.bin': 'upload content' }, { allowReplace: true })
  )
  t.alike(untracked.conflicts, [{ path: 'snap/foreign.bin', reason: 'UNTRACKED_DIFFERS' }])

  // An owned file that somebody then changed on disk.
  disk.put('flatpak/app.flatpak', 'tampered by an operator')
  const changed = refused(
    plan(disk, owned, { 'flatpak/app.flatpak': 'flatpak bytes v2' }, { allowReplace: true })
  )
  t.alike(changed.conflicts, [{ path: 'flatpak/app.flatpak', reason: 'EXTERNALLY_MODIFIED' }])
  t.is(disk.read('flatpak/app.flatpak'), 'tampered by an operator')
  t.is(disk.read('snap/foreign.bin'), 'operator content')
})

test('an untracked identical file is skipped and never adopted', (t) => {
  const disk = new Disk({ 'snap/app.snap': 'snap bytes' })
  const catalog = fresh()

  const only = accepted(plan(disk, catalog, { 'snap/app.snap': 'snap bytes' }))
  t.is(only.changed, false, 'nothing to publish')
  t.is(only.next, catalog, 'the very same catalog')
  t.alike(only.actions, [
    { op: 'skip', path: 'snap/app.snap', size: 10, sha256: sha('snap bytes'), owned: false }
  ])

  const mixed = merge(
    disk,
    catalog,
    { 'snap/app.snap': 'snap bytes', 'snap/new.snap': 'new' },
    { writer: writerOf(4) }
  )
  t.alike(label(mixed.outcome), ['skip:snap/app.snap', 'add:snap/new.snap'])
  t.alike(
    mixed.catalog.files.map((file) => file.path),
    ['snap/new.snap'],
    'only the file Swarm wrote is owned'
  )
  t.alike(
    mixed.catalog.receipts.map((receipt) => [receipt.added, receipt.replaced, receipt.skipped]),
    [[1, 0, 1]],
    'the receipt says what happened, including the skipped file'
  )
})

test('an owned file changed on disk into the uploaded bytes is released, not adopted again', (t) => {
  const disk = new Disk()
  const owned = merge(disk, fresh(), { 'a/file.bin': 'original' }, { writer: writerOf(1) }).catalog
  disk.put('a/file.bin', 'edited')

  const outcome = accepted(plan(disk, owned, { 'a/file.bin': 'edited' }, { writer: writerOf(2) }))
  t.alike(outcome.released, [{ path: 'a/file.bin', reason: 'MODIFIED' }])
  t.is(outcome.changed, true, 'the catalog stops claiming it')
  t.alike(outcome.next.files, [])
  t.alike(outcome.actions, [
    { op: 'skip', path: 'a/file.bin', size: 6, sha256: sha('edited'), owned: false }
  ])
  t.is(disk.read('a/file.bin'), 'edited', 'the file itself is untouched')

  // Planning again from the result is a no-change plan.
  const again = accepted(
    plan(disk, outcome.next, { 'a/file.bin': 'edited' }, { writer: writerOf(2) })
  )
  t.is(again.changed, false)
})

test('a conflict of any kind refuses the whole upload without a single action', (t) => {
  const cases: Array<{
    name: string
    setup: (disk: Disk) => void
    upload: Record<string, string>
    path: string
    reason: ConflictReason
  }> = [
    {
      name: 'a file where a directory is',
      setup: (disk) => disk.put('pkg/lib/x', 'x'),
      upload: { 'pkg/lib': 'now a file' },
      path: 'pkg/lib',
      reason: 'KIND_CONFLICT'
    },
    {
      name: 'a directory where a file is',
      setup: (disk) => disk.put('pkg', 'a file'),
      upload: { 'pkg/x': 'x' },
      path: 'pkg/x',
      reason: 'KIND_CONFLICT'
    },
    {
      name: 'a symlinked container',
      setup: (disk) => disk.symlink('pkg'),
      upload: { 'pkg/x': 'x' },
      path: 'pkg/x',
      reason: 'SYMLINK'
    },
    {
      name: 'a symlink where a file goes',
      setup: (disk) => disk.symlink('pkg/x'),
      upload: { 'pkg/x': 'x' },
      path: 'pkg/x',
      reason: 'SYMLINK'
    },
    {
      name: 'a special file where a file goes',
      setup: (disk) => disk.special('pkg/dev'),
      upload: { 'pkg/dev': 'x' },
      path: 'pkg/dev',
      reason: 'SPECIAL'
    },
    {
      name: 'a special file as a container',
      setup: (disk) => disk.special('pkg'),
      upload: { 'pkg/x': 'x' },
      path: 'pkg/x',
      reason: 'SPECIAL'
    },
    {
      name: 'a name that differs only in case from a file',
      setup: (disk) => disk.put('pkg/Readme.md', 'r'),
      upload: { 'pkg/readme.md': 'r' },
      path: 'pkg/readme.md',
      reason: 'CASE_ALIAS'
    },
    {
      name: 'a container that differs only in case',
      setup: (disk) => disk.put('Pkg/x', 'x'),
      upload: { 'pkg/y': 'y' },
      path: 'pkg/y',
      reason: 'CASE_ALIAS'
    }
  ]
  for (const entry of cases) {
    const disk = new Disk()
    entry.setup(disk)
    const before = disk.snapshot()
    // A harmless new file in the same upload must not be published either.
    const outcome = refused(plan(disk, fresh(), { ...entry.upload, 'other/new.bin': 'new' }))
    t.alike(outcome.conflicts, [{ path: entry.path, reason: entry.reason }], entry.name)
    t.is('actions' in outcome, false, `${entry.name}: nothing to apply`)
    t.is(disk.snapshot(), before, `${entry.name}: the container is as it was`)
  }

  // A listing taken while somebody else is creating the container is not trusted.
  const incoming = incomingOf({ 'pkg/x': 'x' })
  const racing = new Map<string, Observation>([
    ['pkg', { kind: 'missing' }],
    ['pkg/x', { kind: 'file', size: 1, sha256: sha('x') }]
  ])
  t.alike(
    refused(
      planFileMerge({
        catalog: fresh(),
        incoming,
        observed: racing,
        allowReplace: true,
        writer: writerOf(1)
      })
    ).conflicts,
    [{ path: 'pkg/x', reason: 'OBSERVATION_CHANGED' }]
  )
})

test('every conflict is reported in path order, bounded, with the true total', (t) => {
  const spec: Record<string, string> = {}
  const disk = new Disk()
  for (let index = 0; index < 150; index++) {
    const path = `dir/f${String(index).padStart(3, '0')}.bin`
    disk.put(path, 'operator')
    spec[path] = 'upload'
  }
  const outcome = refused(plan(disk, fresh(), spec, { allowReplace: true }))
  t.is(outcome.totalConflicts, 150)
  t.is(outcome.conflicts.length, 100)
  t.is(outcome.conflicts[0].path, 'dir/f000.bin')
  t.is(outcome.conflicts[99].path, 'dir/f099.bin')
  t.ok(outcome.conflicts.every((conflict) => conflict.reason === 'UNTRACKED_DIFFERS'))
})

test('an invalid, traversing or non-canonical upload is a conflict and never an exception', (t) => {
  const file = (path: string, content = 'x'): IncomingEntry => ({
    kind: 'file',
    path,
    size: content.length,
    sha256: sha(content)
  })
  const dir = (path: string): IncomingEntry => ({ kind: 'directory', path, size: 0 })
  const history = `history-${'a'.repeat(64)}`
  const deep = Array.from({ length: 33 }, () => 'd').join('/')
  const cases: Array<[string, IncomingEntry[]]> = [
    ['a traversing path', [file('../escape')]],
    ['a traversal inside a path', [dir('a'), file('a/../b')]],
    ['an absolute path', [file('/etc/passwd')]],
    ['a backslash', [file('a\\b')]],
    ['an empty component', [dir('a'), file('a//b')]],
    ['a NUL byte', [file('a\u0000b')]],
    ['a reserved history name', [dir(history), file(`${history}/x`)]],
    ['a path past the depth limit', incomingOf({ [`${deep}/f`]: 'x' })],
    ['a path past the name limit', [file('x'.repeat(101))]],
    ['a missing parent directory entry', [file('a/b')]],
    ['entries out of order', [file('b'), file('a')]],
    ['a duplicate entry', [file('a'), file('a')]],
    ['names that differ only in case', [file('A'), file('a')]],
    ['a file and a directory of one name', [dir('a'), file('a')]],
    ['a directory with a size', [{ kind: 'directory', path: 'a', size: 3 }]],
    ['a directory with a digest', [{ kind: 'directory', path: 'a', size: 0, sha256: sha('x') }]],
    ['a file without a digest', [{ kind: 'file', path: 'a', size: 1 }]],
    ['an upper-case digest', [{ kind: 'file', path: 'a', size: 1, sha256: sha('x').toUpperCase() }]]
  ]
  for (const [name, incoming] of cases) {
    const outcome = refused(
      planFileMerge({
        catalog: fresh(),
        incoming,
        observed: new Map(),
        allowReplace: true,
        writer: writerOf(1)
      })
    )
    t.ok(
      outcome.totalConflicts >= 1 &&
        outcome.conflicts.every((conflict) => conflict.reason === 'INVALID_INCOMING'),
      name
    )
    t.is('actions' in outcome, false, `${name}: nothing to apply`)
  }
})

test('an upload of empty directories only is no resource and no change', (t) => {
  const disk = new Disk()
  const upload = { 'a/b/': '', 'c/': '' }
  t.alike(observationPaths(incomingOf(upload)), [], 'nothing needs observing')
  const outcome = accepted(plan(disk, fresh(), upload))
  t.is(outcome.changed, false)
  t.alike(outcome.actions, [])
  t.alike(outcome.directories, [])
  t.is(outcome.subset, subsetDigest([]), 'the subset is the empty file set')

  // Beside a file, an empty directory is still not created; only the file's parents are.
  const mixed = accepted(plan(disk, fresh(), { 'x/empty/': '', 'x/f': 'f' }))
  t.alike(label(mixed), ['add:x/f'])
  t.alike(mixed.directories, ['x'])
  t.alike(observationPaths(incomingOf({ 'x/empty/': '', 'x/f': 'f' })), ['x', 'x/f'])
})

test('a zero-length file is a file: added, owned, skipped when identical, replaced when it differs', (t) => {
  const disk = new Disk()
  const added = merge(disk, fresh(), { 'zero.bin': '' }, { writer: writerOf(1) })
  t.alike(added.outcome.actions, [{ op: 'add', path: 'zero.bin', size: 0, sha256: EMPTY_SHA256 }])
  t.alike(
    added.catalog.files.map((file) => [file.path, file.size, file.sha256]),
    [['zero.bin', 0, EMPTY_SHA256]]
  )
  t.is(added.outcome.result.digest, ownedDigest([facts('zero.bin', '')]))
  t.not(added.outcome.result.digest, ownedDigest([]), 'an owned empty file is not nothing')

  t.is(accepted(plan(disk, added.catalog, { 'zero.bin': '' })).changed, false, 'identical: skipped')
  t.alike(
    refused(plan(disk, added.catalog, { 'zero.bin': 'now text' })).conflicts,
    [{ path: 'zero.bin', reason: 'DIFFERS_NOT_ALLOWED' }],
    'a non-empty replacement needs the permission'
  )
  const replaced = merge(disk, added.catalog, { 'zero.bin': 'now text' }, { allowReplace: true })
  t.alike(label(replaced.outcome), ['replace:zero.bin'])
  t.is(disk.read('zero.bin'), 'now text')
})

test('planning is idempotent and the published identity does not depend on the order of merges', (t) => {
  const run = (order: Array<[Record<string, string>, number]>) => {
    const disk = new Disk({ 'README.txt': 'operator' })
    let catalog = fresh()
    const outcomes = []
    for (const [spec, transfer] of order) {
      const step = merge(disk, catalog, spec, { writer: writerOf(transfer) })
      catalog = step.catalog
      outcomes.push(step.outcome)
    }
    return { disk, catalog, outcomes }
  }
  const flatpakFirst = run([
    [FLATPAK, 1],
    [SNAP, 2]
  ])
  const snapFirst = run([
    [SNAP, 2],
    [FLATPAK, 1]
  ])
  t.is(flatpakFirst.outcomes[1].result.digest, snapFirst.outcomes[1].result.digest)
  t.is(flatpakFirst.outcomes[1].result.snapshotId, snapFirst.outcomes[1].result.snapshotId)
  t.alike(flatpakFirst.disk.files(), snapFirst.disk.files())
  t.is(flatpakFirst.catalog.generation, 2)

  // Planning either upload again from the final state changes nothing, however late.
  for (const result of [flatpakFirst, snapFirst]) {
    for (const spec of [FLATPAK, SNAP]) {
      const retry = accepted(plan(result.disk, result.catalog, spec))
      t.is(retry.changed, false)
      t.is(retry.next, result.catalog, 'the catalog itself, receipts and generation untouched')
      t.is(retry.result.snapshotId, retry.previous.snapshotId)
    }
  }
})

test('returning content (A, B, A) has the same published identity, a newer generation and its own writer', (t) => {
  const disk = new Disk()
  const a = merge(disk, fresh(), { 'f.bin': 'one' }, { writer: writerOf(1) })
  const b = merge(disk, a.catalog, { 'f.bin': 'two' }, { writer: writerOf(2), allowReplace: true })
  const again = merge(
    disk,
    b.catalog,
    { 'f.bin': 'one' },
    { writer: writerOf(1, 9_000), allowReplace: true }
  )

  t.is(b.outcome.result.digest !== a.outcome.result.digest, true)
  t.is(again.outcome.result.digest, a.outcome.result.digest, 'the same content, the same digest')
  t.is(again.outcome.result.snapshotId, a.outcome.result.snapshotId)
  t.alike([a.catalog.generation, b.catalog.generation, again.catalog.generation], [1, 2, 3])
  t.is(again.catalog.files[0].writer.committedAt, 9_000, 'written again, so written by this upload')
  t.alike(
    again.catalog.receipts.map((receipt) => receipt.transferId),
    [hexId(2), hexId(1)],
    'the retried transfer has one receipt, the newest, not two'
  )
  t.is(again.catalog.receipts[1].generation, 3, 'and it says which generation it produced')
})

test('an upload must carry the release identity the owned files have', (t) => {
  const disk = new Disk()
  const release = { series: 'beta', version: '1.2.3' }
  const one = merge(disk, fresh('beta-1.2.3', release), FLATPAK, { release })
  t.alike(one.catalog.release, release)

  const reasons = (
    upload: Record<string, string>,
    uploadRelease?: { series: string; version?: string }
  ) =>
    refused(
      plan(disk, one.catalog, upload, {
        ...(uploadRelease === undefined ? {} : { release: uploadRelease })
      })
    ).conflicts
  t.alike(reasons(SNAP, { series: 'beta', version: '1.2.4' }), [
    { path: '', reason: 'RELEASE_MISMATCH' }
  ])
  t.alike(reasons(SNAP, { series: 'beta' }), [{ path: '', reason: 'RELEASE_MISMATCH' }])
  t.alike(reasons(SNAP), [{ path: '', reason: 'RELEASE_MISMATCH' }], 'none is not the same release')
  t.is(accepted(plan(disk, one.catalog, SNAP, { release })).changed, true)

  // A catalog that owns nothing adopts the release of the first upload.
  const empty = accepted(plan(new Disk(), fresh(), FLATPAK, { release }))
  t.alike(empty.next.release, release)
  t.is(accepted(plan(new Disk(), fresh(), FLATPAK)).next.release, undefined)

  // The same content under another release, or another name, is another published identity.
  const digest = ownedDigest([facts('a', 'x')])
  const base = snapshotId('beta-1.2.3', release, digest)
  t.not(base, snapshotId('beta-1.2.3', { series: 'beta', version: '1.2.4' }, digest))
  t.not(base, snapshotId('beta-1.2.3', { series: 'beta' }, digest))
  t.not(base, snapshotId('beta-1.2.3', undefined, digest))
  t.not(base, snapshotId('beta-1.2.4', release, digest))
  t.is(base, snapshotId('beta-1.2.3', { version: '1.2.3', series: 'beta' }, digest))
})

test('limits count only owned files and owned bytes, never the foreign ones', (t) => {
  const foreign: Record<string, string> = {}
  for (let index = 0; index < 20; index++) foreign[`operator/f${index}.bin`] = 'operator'
  const disk = new Disk(foreign)
  const one = merge(disk, fresh(), { 'a/1': '1', 'a/2': '22' }, { writer: writerOf(1) })

  t.is(
    accepted(plan(disk, one.catalog, { 'a/3': '3' }, { limits: { maxFiles: 3 } })).changed,
    true,
    'twenty foreign files do not count'
  )
  t.alike(
    refused(plan(disk, one.catalog, { 'a/3': '3', 'a/4': '4' }, { limits: { maxFiles: 3 } }))
      .conflicts,
    [{ path: '', reason: 'TOO_MANY_FILES' }],
    'the merged owned set is what is bounded'
  )
  t.alike(
    refused(plan(disk, one.catalog, { 'a/3': '3333' }, { limits: { maxPayloadBytes: 6 } }))
      .conflicts,
    [{ path: '', reason: 'TOO_LARGE' }],
    'owned bytes (3) plus the upload (4) are over the limit'
  )
  t.is(
    accepted(plan(disk, one.catalog, { 'a/3': '333' }, { limits: { maxPayloadBytes: 6 } })).changed,
    true
  )
})

test('receipts are a bounded ring of the newest transfers', (t) => {
  const disk = new Disk()
  let catalog = fresh()
  for (let index = 1; index <= MAX_CATALOG_RECEIPTS + 4; index++) {
    catalog = merge(
      disk,
      catalog,
      { [`f${index}.bin`]: `content ${index}` },
      {
        writer: writerOf(index)
      }
    ).catalog
  }
  t.is(catalog.generation, MAX_CATALOG_RECEIPTS + 4)
  t.is(catalog.receipts.length, MAX_CATALOG_RECEIPTS)
  t.is(catalog.receipts[0].transferId, hexId(5), 'the four oldest are gone')
  t.is(catalog.receipts[MAX_CATALOG_RECEIPTS - 1].transferId, hexId(MAX_CATALOG_RECEIPTS + 4))
  t.is(
    catalog.files.length,
    MAX_CATALOG_RECEIPTS + 4,
    'the files they described are all still owned'
  )
  for (const receipt of catalog.receipts) {
    t.is(receipt.generation, Number.parseInt(receipt.transferId.slice(0, 2), 16))
  }
})

test('unusable input from the caller is an exception, not a plan', (t) => {
  const incoming = incomingOf({ 'a/b': 'x' })
  const base = { catalog: fresh(), incoming, allowReplace: false, writer: writerOf(1) }
  const observed = new Disk().observe(observationPaths(incoming))
  t.is(accepted(planFileMerge({ ...base, observed })).changed, true)

  const bad: Array<[string, () => unknown]> = [
    ['a missing observation', () => planFileMerge({ ...base, observed: new Map() })],
    [
      'a missing ancestor observation',
      () => planFileMerge({ ...base, observed: new Map([['a/b', { kind: 'missing' as const }]]) })
    ],
    [
      'a file observation without a digest',
      () =>
        planFileMerge({
          ...base,
          observed: new Map<string, Observation>([
            ['a', { kind: 'directory' }],
            ['a/b', { kind: 'file', size: 1 }]
          ])
        })
    ],
    [
      'a directory observation with a size',
      () =>
        planFileMerge({
          ...base,
          observed: new Map<string, Observation>([
            ['a', { kind: 'directory', size: 1 }],
            ['a/b', { kind: 'missing' }]
          ])
        })
    ],
    [
      'a case variant that is the path itself',
      () =>
        planFileMerge({
          ...base,
          observed: new Map<string, Observation>([
            ['a', { kind: 'missing' }],
            ['a/b', { kind: 'missing', caseVariants: ['a/b'] }]
          ])
        })
    ],
    [
      'a writer that is not hex',
      () => planFileMerge({ ...base, observed, writer: { ...writerOf(1), transferId: 'nope' } })
    ],
    [
      'a writer with a negative time',
      () => planFileMerge({ ...base, observed, writer: { ...writerOf(1), committedAt: -1 } })
    ],
    [
      'a permission that is not a boolean',
      () => planFileMerge({ ...base, observed, allowReplace: 'yes' as never })
    ],
    [
      'a release that is not valid',
      () => planFileMerge({ ...base, observed, release: { series: '' } })
    ],
    ['a negative limit', () => planFileMerge({ ...base, observed, limits: { maxFiles: -1 } })],
    [
      'a catalog that is not canonical',
      () =>
        planFileMerge({
          ...base,
          observed,
          catalog: {
            ...fresh(),
            files: [
              { ...facts('b', 'b'), writer: writerOf(1) },
              { ...facts('a', 'a'), writer: writerOf(1) }
            ]
          }
        })
    ]
  ]
  for (const [name, call] of bad) {
    try {
      call()
      t.fail(`${name} was accepted`)
    } catch (error) {
      t.is((error as { code?: string }).code, ERRORS.PROTOCOL_INVALID, name)
    }
  }
})

test('the observations a plan needs are the uploaded files and their ancestors, parents first', (t) => {
  const incoming = incomingOf({
    'b/c/d.bin': 'd',
    'b/e.bin': 'e',
    'a.bin': 'a',
    'only/dirs/': ''
  })
  t.alike(observationPaths(incoming), ['a.bin', 'b', 'b/c', 'b/c/d.bin', 'b/e.bin'])
  t.alike(observationPaths([]), [])
})

test('an uploaded tree digest becomes the incoming entries, and a file without a digest is refused', (t) => {
  const entries = incomingFromDigest({
    entries: [
      { kind: 'directory', path: 'a', size: 0 },
      { kind: 'file', path: 'a/f', size: 1 }
    ],
    files: [{ path: 'a/f', size: 1, sha256: b4a.from(sha('f'), 'hex') }]
  })
  t.alike(entries, [
    { kind: 'directory', path: 'a', size: 0 },
    { kind: 'file', path: 'a/f', size: 1, sha256: sha('f') }
  ])
  try {
    incomingFromDigest({ entries: [{ kind: 'file', path: 'x', size: 1 }], files: [] })
    t.fail('a file without a digest was accepted')
  } catch (error) {
    t.is((error as { code?: string }).code, ERRORS.PROTOCOL_INVALID)
  }
})

test('cleanup removes only owned files that are still exactly what Swarm wrote', (t) => {
  const disk = new Disk({ 'a/foreign.txt': 'operator', 'README.txt': 'operator' })
  const owned = merge(
    disk,
    fresh(),
    { 'a/x.bin': 'x', 'a/y.bin': 'y', 'b/z.bin': 'z', 'c/w.bin': 'w', 'd/keep.bin': 'k' },
    { writer: writerOf(1) }
  ).catalog
  disk.put('a/y.bin', 'edited by an operator')
  disk.nodes.delete('b/z.bin')
  disk.nodes.set('c/w.bin', { kind: 'directory' })

  const paths = owned.files.map((file) => file.path)
  const observed = disk.observe(paths)
  const cleanup = planOwnedCleanup(owned, observed, (file) => file.path !== 'd/keep.bin')
  t.alike(cleanup.remove, ['a/x.bin'], 'the one file still exactly as written')
  t.alike(cleanup.release, [
    { path: 'a/y.bin', reason: 'MODIFIED' },
    { path: 'b/z.bin', reason: 'MISSING' },
    { path: 'c/w.bin', reason: 'REPLACED' }
  ])
  t.alike(cleanup.keep, ['d/keep.bin'])
  t.alike(cleanup.prune, ['a'], 'only the container of a removed file is a candidate')
  t.is(cleanup.changed, true)
  t.alike(
    cleanup.next.files.map((file) => file.path),
    ['d/keep.bin'],
    'ownership of the released files ends too'
  )
  t.is(cleanup.next.generation, owned.generation + 1)
  t.alike(cleanup.next.receipts, owned.receipts)
  // The observations handed in covered only the catalog's files: files Swarm does not own were
  // never needed, and so can neither be removed nor released.
  t.is(cleanup.remove.includes('a/foreign.txt'), false)
  t.is(disk.read('a/foreign.txt'), 'operator')
  t.is(disk.read('README.txt'), 'operator')
})

test('cleanup of nothing selected changes nothing, and an unobserved selected file is refused', (t) => {
  const disk = new Disk()
  const owned = merge(disk, fresh(), { 'a/x': 'x' }).catalog
  const none = planOwnedCleanup(owned, new Map(), () => false)
  t.is(none.changed, false)
  t.is(none.next, owned)
  t.alike(none.keep, ['a/x'])
  try {
    planOwnedCleanup(owned, new Map())
    t.fail('an unobserved selected file was accepted')
  } catch (error) {
    t.is((error as { code?: string }).code, ERRORS.PROTOCOL_INVALID)
  }

  // Nested containers are listed deepest first so a non-recursive rmdir can climb.
  const deep = merge(new Disk(), fresh(), { 'p/q/r/f': 'f', 'p/g': 'g' }).catalog
  const all = planOwnedCleanup(
    deep,
    new Disk({ 'p/q/r/f': 'f', 'p/g': 'g' }).observe(['p/g', 'p/q/r/f'])
  )
  t.alike(all.prune, ['p/q/r', 'p/q', 'p'])
  t.is(all.next.files.length, 0)
})
