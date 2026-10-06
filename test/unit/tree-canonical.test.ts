/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { pack } from 'tar-stream'
import { ERRORS } from '../../dist/errors.js'
import {
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  TREE_DIGEST_DOMAIN,
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  compareTreePaths,
  hashField,
  revalidateTreeSnapshot,
  snapshotTree,
  tarEntryName,
  treeDigest,
  type TreeEntry
} from '../../dist/tar-protocol/tree.js'
import {
  MAX_USTAR_FILE_BYTES,
  canonicalUstarHeader,
  canonicalUstarTreeHeader,
  deterministicTreeTarSize
} from '../../dist/tar-protocol/ustar.js'
import { SodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createAbortController } from '../../dist/abort.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const FILE_DIGEST = b4a.alloc(32, 7)

function entry(kind: 'file' | 'directory', treePath: string, size = 0): TreeEntry {
  return { kind, path: treePath, size }
}

test('tree entry paths reject traversal, absolute, reserved, and overlong components', (t) => {
  t.is(assertTreeEntryPath('a/b/c.bin', 'file'), 'a/b/c.bin')
  t.is(assertTreeEntryPath('a', 'directory'), 'a')
  for (const value of [
    '',
    '.',
    '..',
    'a/..',
    '../a',
    '/a',
    'a/',
    'a//b',
    'a\\b',
    'a/\u0000b',
    '.hidden',
    '-leading',
    'history-deadbeef',
    `${'a'.repeat(101)}`,
    Array.from({ length: MAX_TREE_DEPTH + 1 }, () => 'd').join('/')
  ]) {
    t.exception(() => assertTreeEntryPath(value, 'file'), { code: ERRORS.INVALID_FILENAME }, value)
  }
  // A directory stores a trailing slash, so its path is bounded one byte tighter.
  t.is(assertTreeEntryPath('a'.repeat(99), 'directory'), 'a'.repeat(99))
  t.exception(() => assertTreeEntryPath('a'.repeat(100), 'directory'), {
    code: ERRORS.INVALID_FILENAME
  })
})

test('tree ordering is bytewise with parents before children', (t) => {
  t.ok(compareTreePaths('a', 'a-b') < 0)
  t.ok(compareTreePaths('a-b', 'a/b') < 0)
  t.ok(compareTreePaths('a', 'a/b') < 0)
  t.is(compareTreePaths('a/b', 'a/b'), 0)
  assertCanonicalTreeEntries([
    entry('directory', 'a'),
    entry('file', 'a-b.bin', 1),
    entry('file', 'a.json', 1),
    entry('file', 'a/b.bin', 2),
    entry('directory', 'a/c'),
    entry('file', 'a/c/d.bin', 3)
  ])
  for (const entries of [
    [entry('file', 'b.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'a.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'A.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'missing/child.bin', 1)],
    [entry('file', 'a', 1), entry('file', 'a/child.bin', 1)],
    [entry('directory', 'a', 1)]
  ]) {
    t.exception(() => assertCanonicalTreeEntries(entries), { code: ERRORS.PROTOCOL_INVALID })
  }
})

test('tree snapshots interleave directory children with sibling paths in compareTreePaths order', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, {
    'a/': '',
    'a-b.bin': '1',
    'a.json': '2',
    'a/b.bin': '3'
  })
  const snapshot = await snapshotTree(root)
  t.alike(
    snapshot.entries.map((value) => `${value.kind}:${value.path}`),
    ['directory:a', 'file:a-b.bin', 'file:a.json', 'file:a/b.bin']
  )
})

test('tree digest golden vector pins domain framing and file payload', (t) => {
  const sha256 = b4a.alloc(32, 7)
  const expected = b4a.from(
    'bd5aa376418cdd15c25f3b4cdfc9f04b7f7e95e2d250764e10367d9c19425461',
    'hex'
  )
  t.alike(
    treeDigest([
      { entry: entry('directory', 'a') },
      { entry: entry('file', 'a/b.bin', 3), sha256 }
    ]),
    expected
  )
  const independent = new SodiumSha256()
  hashField(independent, 'domain', TREE_DIGEST_DOMAIN)
  hashField(independent, 'entryCount', 2)
  hashField(independent, 'kind', 'directory')
  hashField(independent, 'path', 'a')
  hashField(independent, 'size', 0)
  hashField(independent, 'kind', 'file')
  hashField(independent, 'path', 'a/b.bin')
  hashField(independent, 'size', 3)
  hashField(independent, 'sha256', sha256)
  t.alike(independent.digest(), expected)
  t.alike(
    treeDigest([]),
    b4a.from('1e6ce64486eeac9c74187ddb7464a1e91df2483ece429e58bece32f176c0ea16', 'hex')
  )
})

test('tree digest is order sensitive and rejects invalid file digests', (t) => {
  const base = treeDigest([
    { entry: entry('directory', 'a') },
    { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST }
  ])
  t.is(base.byteLength, 32)
  t.alike(
    base,
    treeDigest([
      { entry: entry('directory', 'a') },
      { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST }
    ])
  )
  t.absent(
    b4a.equals(
      base,
      treeDigest([
        { entry: entry('directory', 'a') },
        { entry: entry('file', 'a/c.bin', 3), sha256: FILE_DIGEST }
      ])
    )
  )
  t.absent(
    b4a.equals(
      base,
      treeDigest([
        { entry: entry('directory', 'a') },
        { entry: entry('file', 'a/b.bin', 4), sha256: FILE_DIGEST }
      ])
    )
  )
  t.absent(b4a.equals(base, treeDigest([{ entry: entry('directory', 'a') }])))
  t.exception(
    () =>
      treeDigest([
        { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST },
        { entry: entry('directory', 'a') }
      ]),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.absent(
    b4a.equals(
      base,
      treeDigest([
        { entry: entry('directory', 'a') },
        { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST },
        { entry: entry('file', 'a/c.bin', 1), sha256: FILE_DIGEST }
      ])
    )
  )
  t.exception(
    () =>
      treeDigest([
        { entry: entry('directory', 'a'), sha256: FILE_DIGEST },
        { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST }
      ]),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.exception(() => treeDigest([{ entry: entry('file', 'solo.bin', 1) }]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => treeDigest([{ entry: entry('file', 'solo.bin', 1), sha256: b4a.alloc(31) }]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () => treeDigest([{ entry: entry('file', 'solo.bin', 1), sha256: new Uint8Array(32) }]),
    { code: ERRORS.PROTOCOL_INVALID }
  )
})

test('canonical tree model rejects direct boundary violations', (t) => {
  const depth32 = Array.from({ length: MAX_TREE_DEPTH }, () => 'a').join('/')
  t.is(assertTreeEntryPath(depth32, 'directory'), depth32)
  t.exception(() => assertTreeEntryPath(`${depth32}/extra`, 'file'), {
    code: ERRORS.INVALID_FILENAME
  })

  const maxEntries: TreeEntry[] = []
  for (let index = 0; index < MAX_TREE_ENTRIES; index++) {
    maxEntries.push(entry('file', `e${String(index).padStart(5, '0')}.bin`, 0))
  }
  assertCanonicalTreeEntries(maxEntries)
  t.exception(() => assertCanonicalTreeEntries([...maxEntries, entry('file', 'one-more.bin', 0)]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => assertCanonicalTreeEntries(null as unknown as TreeEntry[]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => assertCanonicalTreeEntries([entry('directory', 'a', 1)]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => assertCanonicalTreeEntries([entry('link' as 'file', 'a.bin', 0)]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () => assertCanonicalTreeEntries([entry('file', 'big.bin', MAX_USTAR_FILE_BYTES + 1)]),
    {
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  assertCanonicalTreeEntries([entry('file', 'max.bin', MAX_USTAR_FILE_BYTES)])

  const maxFile = MAX_USTAR_FILE_BYTES
  const maxPadding = (512 - (maxFile % 512)) % 512
  t.is(
    deterministicTreeTarSize([entry('file', 'max.bin', maxFile)]),
    512 + maxFile + maxPadding + 1024
  )
  t.exception(
    () => deterministicTreeTarSize([entry('file', 'big.bin', MAX_USTAR_FILE_BYTES + 1)]),
    {
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  t.exception(() => deterministicTreeTarSize([{ kind: 'directory', size: 1 }]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => deterministicTreeTarSize([{ kind: 'symlink' as 'file', size: 0 }]), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () =>
      deterministicTreeTarSize(
        Array(1_048_576).fill({ kind: 'file' as const, size: MAX_USTAR_FILE_BYTES })
      ),
    { code: ERRORS.PROTOCOL_INVALID }
  )

  const name100 = 'n'.repeat(100)
  t.alike(canonicalUstarTreeHeader(name100, 'file', 0), canonicalUstarHeader(name100, 0))
  t.exception(() => canonicalUstarTreeHeader(`${name100}x`, 'file', 0), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('a canonical tree file header is byte-identical to the single-file header', (t) => {
  t.alike(
    canonicalUstarTreeHeader('payload.bin', 'file', 1234),
    canonicalUstarHeader('payload.bin', 1234)
  )
  t.is(tarEntryName(entry('directory', 'nested')), 'nested/')
  t.is(tarEntryName(entry('file', 'nested/x.bin', 1)), 'nested/x.bin')
  t.exception(() => canonicalUstarTreeHeader('nested/', 'directory', 1), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => canonicalUstarTreeHeader('nested', 'directory', 0), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => canonicalUstarTreeHeader('nested/', 'file', 0), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => canonicalUstarTreeHeader('a\u0000b', 'file', 0), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('a canonical tree directory header matches tar-stream USTAR framing', async (t) => {
  const output = pack()
  output.entry({
    name: 'nested/',
    type: 'directory',
    size: 0,
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    uname: '',
    gname: ''
  })
  output.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of output as AsyncIterable<Uint8Array>) chunks.push(b4a.from(chunk))
  t.alike(b4a.concat(chunks).subarray(0, 512), canonicalUstarTreeHeader('nested/', 'directory', 0))
})

test('deterministic tree TAR size accounts for every header, payload, and pad block', (t) => {
  t.is(deterministicTreeTarSize([]), 1024)
  t.is(deterministicTreeTarSize([entry('directory', 'a')]), 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 1)]), 512 + 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 512)]), 512 + 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 513)]), 512 + 1024 + 1024)
})

test('tree snapshots are canonical, keep empty directories, and reject unsafe entries', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, {
    'b.bin': 'bb',
    'a/deep/c.bin': 'ccc',
    'a/empty/': '',
    'A.bin': 'A'
  })
  const snapshot = await snapshotTree(root)
  t.alike(
    snapshot.entries.map((value) => `${value.kind}:${value.path}`),
    [
      'file:A.bin',
      'directory:a',
      'directory:a/deep',
      'file:a/deep/c.bin',
      'directory:a/empty',
      'file:b.bin'
    ]
  )
  t.is(snapshot.entryCount, 6)
  t.is(snapshot.payloadBytes, 1 + 3 + 2)
  t.ok(snapshot.entries.every((value) => typeof value.absolutePath === 'string'))

  const unsafe = await createTempDir(t)
  await writeTree(unsafe, { 'ok.bin': 'ok' })
  await fs.promises.symlink(path.join(unsafe, 'ok.bin'), path.join(unsafe, 'link.bin'))
  await t.exception(() => snapshotTree(unsafe), { code: ERRORS.INVALID_FILENAME })

  const hardlinked = await createTempDir(t)
  await writeTree(hardlinked, { 'ok.bin': 'ok' })
  await fs.promises.link(path.join(hardlinked, 'ok.bin'), path.join(hardlinked, 'same.bin'))
  await t.exception(() => snapshotTree(hardlinked), { code: ERRORS.INVALID_FILENAME })

  const named = await createTempDir(t)
  await writeTree(named, { '-invalid': 'x' })
  await t.exception(() => snapshotTree(named), { code: ERRORS.INVALID_FILENAME })
})

test('tree snapshots reject files larger than canonical USTAR capacity', async (t) => {
  const root = await createTempDir(t)
  const target = path.join(root, 'too-big.bin')
  await fs.promises.writeFile(target, b4a.alloc(1))
  await fs.promises.truncate(target, MAX_USTAR_FILE_BYTES + 1)
  await t.exception(() => snapshotTree(root), { code: ERRORS.PROTOCOL_INVALID })
})

test('depth-32 empty directories snapshot and validate', async (t) => {
  const root = await createTempDir(t)
  const nested = `${Array.from({ length: MAX_TREE_DEPTH - 1 }, () => 'a').join('/')}/leaf/`
  await writeTree(root, { [nested]: '' })
  const snapshot = await snapshotTree(root)
  const leaf = snapshot.entries.find(
    (value) => value.kind === 'directory' && value.path.endsWith('leaf')
  )
  t.ok(leaf)
  t.is(leaf!.path.split('/').length, MAX_TREE_DEPTH)
})

test('revalidateTreeSnapshot detects source changes as FILE_BUSY', async (t) => {
  const mtimeRoot = await createTempDir(t)
  await writeTree(mtimeRoot, { 'dir/': '', 'dir/x.bin': 'x' })
  const mtimeSnap = await snapshotTree(mtimeRoot)
  const fileEntry = mtimeSnap.entries.find((value) => value.path === 'dir/x.bin')!
  await fs.promises.utimes(fileEntry.absolutePath, new Date(), new Date(Date.now() + 60_000))
  await t.exception(() => revalidateTreeSnapshot(mtimeSnap), { code: ERRORS.FILE_BUSY })

  const truncateRoot = await createTempDir(t)
  await writeTree(truncateRoot, { 'solo.bin': 'solo' })
  const truncateSnap = await snapshotTree(truncateRoot)
  await fs.promises.truncate(truncateSnap.entries[0].absolutePath, 0)
  await t.exception(() => revalidateTreeSnapshot(truncateSnap), { code: ERRORS.FILE_BUSY })

  const inodeRoot = await createTempDir(t)
  await writeTree(inodeRoot, { 'dir/': '' })
  const inodeSnap = await snapshotTree(inodeRoot)
  const dirEntry = inodeSnap.entries[0]
  await fs.promises.rm(dirEntry.absolutePath, { recursive: true })
  await fs.promises.mkdir(dirEntry.absolutePath)
  await t.exception(() => revalidateTreeSnapshot(inodeSnap), { code: ERRORS.FILE_BUSY })

  const symlinkRoot = await createTempDir(t)
  await writeTree(symlinkRoot, { 'target.bin': 't', 'link.bin': 'l' })
  const symlinkSnap = await snapshotTree(symlinkRoot)
  const linkEntry = symlinkSnap.entries.find((value) => value.path === 'link.bin')!
  await fs.promises.unlink(linkEntry.absolutePath)
  await fs.promises.symlink(path.join(symlinkRoot, 'target.bin'), linkEntry.absolutePath)
  await t.exception(() => revalidateTreeSnapshot(symlinkSnap), { code: ERRORS.FILE_BUSY })

  const addedRoot = await createTempDir(t)
  await writeTree(addedRoot, { 'keep.bin': 'k' })
  const addedSnap = await snapshotTree(addedRoot)
  await fs.promises.writeFile(path.join(addedRoot, 'added.bin'), 'n')
  await t.exception(() => revalidateTreeSnapshot(addedSnap), { code: ERRORS.FILE_BUSY })

  const removedRoot = await createTempDir(t)
  await writeTree(removedRoot, { 'gone.bin': 'g' })
  const removedSnap = await snapshotTree(removedRoot)
  await fs.promises.unlink(removedSnap.entries[0].absolutePath)
  await t.exception(() => revalidateTreeSnapshot(removedSnap), { code: ERRORS.FILE_BUSY })

  const abortRoot = await createTempDir(t)
  await writeTree(abortRoot, { 'wait.bin': 'w' })
  const abortSnap = await snapshotTree(abortRoot)
  const controller = createAbortController()
  controller.abort()
  await t.exception(() => revalidateTreeSnapshot(abortSnap, { signal: controller.signal }), {
    code: ERRORS.ABORTED
  })

  const rootSwap = await createTempDir(t)
  await writeTree(rootSwap, { 'only.bin': 'o' })
  const rootSnap = await snapshotTree(rootSwap)
  await fs.promises.rm(rootSwap, { recursive: true, force: true })
  await fs.promises.symlink('/tmp', rootSwap)
  await t.exception(() => revalidateTreeSnapshot(rootSnap), { code: ERRORS.FILE_BUSY })

  const dirSymlinkRoot = await createTempDir(t)
  await writeTree(dirSymlinkRoot, { 'inner/': '', 'inner/a.bin': 'a' })
  const dirSymlinkSnap = await snapshotTree(dirSymlinkRoot)
  const innerDir = dirSymlinkSnap.entries.find((value) => value.path === 'inner')!
  await fs.promises.rm(innerDir.absolutePath, { recursive: true })
  await fs.promises.symlink('/tmp', innerDir.absolutePath)
  await t.exception(() => revalidateTreeSnapshot(dirSymlinkSnap), { code: ERRORS.FILE_BUSY })
})

test('tree snapshots reject an over-count tree without reading every file', async (t) => {
  const root = await createTempDir(t)
  const spec: Record<string, string> = {}
  for (let index = 0; index <= MAX_TREE_ENTRIES; index++) spec[`f${index}.bin`] = 'x'
  await writeTree(root, spec)
  await t.exception(() => snapshotTree(root), { code: ERRORS.PROTOCOL_INVALID })
})
