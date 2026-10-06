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
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  compareTreePaths,
  snapshotTree,
  tarEntryName,
  treeDigest,
  type TreeEntry
} from '../../dist/tar-protocol/tree.js'
import {
  canonicalUstarHeader,
  canonicalUstarTreeHeader,
  deterministicTreeTarSize
} from '../../dist/tar-protocol/ustar.js'
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

test('tree digest is order sensitive and ignores nothing', (t) => {
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

test('tree snapshots reject an over-count tree without reading every file', async (t) => {
  const root = await createTempDir(t)
  const spec: Record<string, string> = {}
  for (let index = 0; index <= MAX_TREE_ENTRIES; index++) spec[`f${index}.bin`] = 'x'
  await writeTree(root, spec)
  await t.exception(() => snapshotTree(root), { code: ERRORS.PROTOCOL_INVALID })
})
