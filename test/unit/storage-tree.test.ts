/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { initLayout, protectedDirectories } from '../../dist/storage/layout.js'
import {
  assertSymlinkCapable,
  createTreeRoot,
  createTreeSubdirectory,
  digestTree,
  inspectTreePath,
  openTreeFile,
  removeTree,
  syncTreeDirectories,
  walkTree
} from '../../dist/storage/tree-fs.js'
import { treeDigest } from '../../dist/tar-protocol/tree.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'
import { writeTree } from '../helpers/trees.js'

test('the layout creates and protects the private links and trash directories', async (t) => {
  const layout = initLayout(await createTempDir(t))
  t.is(layout.links, path.join(layout.internal, 'links'))
  t.is(layout.trash, path.join(layout.internal, 'trash'))
  for (const directory of [layout.links, layout.trash]) {
    t.ok((await fs.promises.lstat(directory)).isDirectory())
    t.ok(protectedDirectories(layout).includes(directory))
  }
})

test('symlink capability is required explicitly', (t) => {
  const storage = createStorage()
  t.exception(() => assertSymlinkCapable({ ...storage, symlink: undefined, readlink: undefined }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })
  const capable = {
    ...storage,
    symlink: () => Promise.resolve(),
    readlink: () => Promise.resolve('target')
  }
  t.is(assertSymlinkCapable(capable), undefined)
})

test('tree creation validates every component and never follows a symlink', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const treePath = path.join(layout.staging, 'aa.tree')
  await createTreeRoot(treePath, layout.staging, storage)
  await createTreeSubdirectory(treePath, 'nested', storage)
  const handle = await openTreeFile(treePath, 'nested/file.bin', storage)
  await handle.write(b4a.from('payload'), 0, 7, 0)
  await handle.sync()
  await handle.close()
  await syncTreeDirectories(treePath, storage)

  for (const unsafe of ['../escape', '/abs', 'nested/../escape', 'nested//x', 'a\\b']) {
    await t.exception(() => createTreeSubdirectory(treePath, unsafe, storage), {
      code: ERRORS.INVALID_FILENAME
    })
    await t.exception(() => openTreeFile(treePath, unsafe, storage), {
      code: ERRORS.INVALID_FILENAME
    })
  }

  await fs.promises.symlink(layout.root, path.join(treePath, 'nested', 'escape'))
  await t.exception(() => createTreeSubdirectory(treePath, 'nested/escape/evil', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => openTreeFile(treePath, 'nested/escape/evil.bin', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('walking and digesting a tree reproduces the canonical digest', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'b.bin': 'bb', 'a/c.bin': 'ccc', 'a/empty/': '' })
  const entries = await walkTree(root, storage)
  t.alike(
    entries.map((entry) => `${entry.kind}:${entry.path}:${entry.size}`),
    ['directory:a:0', 'file:a/c.bin:3', 'directory:a/empty:0', 'file:b.bin:2']
  )
  const result = await digestTree(root, storage)
  t.is(result.entryCount, 4)
  t.is(result.payloadBytes, 5)
  t.alike(
    result.treeSha256,
    treeDigest([
      { entry: { kind: 'directory', path: 'a', size: 0 } },
      { entry: { kind: 'file', path: 'a/c.bin', size: 3 }, sha256: sodiumSha256(b4a.from('ccc')) },
      { entry: { kind: 'directory', path: 'a/empty', size: 0 } },
      { entry: { kind: 'file', path: 'b.bin', size: 2 }, sha256: sodiumSha256(b4a.from('bb')) }
    ])
  )
})

test('digesting a tree rejects a symlink, a device, and an unsafe name', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'ok.bin': 'ok' })
  await fs.promises.symlink(path.join(root, 'ok.bin'), path.join(root, 'link.bin'))
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
  await fs.promises.unlink(path.join(root, 'link.bin'))
  await fs.promises.writeFile(path.join(root, '-bad'), 'bad')
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
})

test('removing a tree unlinks symlinks without following them and reports residue', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'keep.bin'), 'keep')
  const treePath = path.join(layout.trash, 'bb.tree')
  await writeTree(treePath, { 'a/b.bin': 'x', 'a/empty/': '' })
  await fs.promises.symlink(outside, path.join(treePath, 'a', 'escape'))

  t.is(await removeTree(treePath, layout.trash, storage), true)
  t.is(await inspectTreePath(treePath, layout.trash, storage), 'MISSING')
  t.ok((await fs.promises.lstat(path.join(outside, 'keep.bin'))).isFile())
  t.is(await removeTree(treePath, layout.trash, storage), false)
})

test('inspecting a tree path distinguishes managed directories from unmanaged paths', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  t.is(await inspectTreePath(path.join(layout.root, 'absent'), layout.root, storage), 'MISSING')
  await fs.promises.mkdir(path.join(layout.root, 'tree'))
  t.is(await inspectTreePath(path.join(layout.root, 'tree'), layout.root, storage), 'DIRECTORY')
  await fs.promises.writeFile(path.join(layout.root, 'file.bin'), 'x')
  t.is(await inspectTreePath(path.join(layout.root, 'file.bin'), layout.root, storage), 'UNMANAGED')
  await fs.promises.symlink('tree', path.join(layout.root, 'link'))
  t.is(await inspectTreePath(path.join(layout.root, 'link'), layout.root, storage), 'UNMANAGED')
})

test('walking a tree orders entries bytewise by full path, not by traversal', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'a/c.bin': 'c', 'a-x.bin': 'x', 'a.bin': 'y' })
  const entries = await walkTree(root, storage)
  t.alike(
    entries.map((entry) => entry.path),
    ['a', 'a-x.bin', 'a.bin', 'a/c.bin']
  )
  t.is((await digestTree(root, storage)).entryCount, 4)
})

test('removing a tree refuses unmanaged paths and leaves them untouched', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'keep.bin'), 'keep')
  await fs.promises.writeFile(path.join(layout.trash, 'file.bin'), 'x')
  await fs.promises.symlink(outside, path.join(layout.trash, 'link'))

  for (const name of ['file.bin', 'link']) {
    await t.exception(() => removeTree(path.join(layout.trash, name), layout.trash, storage), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  t.ok((await fs.promises.lstat(path.join(layout.trash, 'file.bin'))).isFile())
  t.ok((await fs.promises.lstat(path.join(layout.trash, 'link'))).isSymbolicLink())
  t.ok((await fs.promises.lstat(path.join(outside, 'keep.bin'))).isFile())
})

test('tree removal never uses recursive rm', async (t) => {
  const calls: string[] = []
  const storage = createStorage({ beforeOperation: (name) => void calls.push(name) })
  const layout = initLayout(await createTempDir(t))
  const treePath = path.join(layout.trash, 'cc.tree')
  await writeTree(treePath, { 'a/b.bin': 'x' })
  t.is(await removeTree(treePath, layout.trash, storage), true)
  t.absent(calls.includes('rm'))
  t.ok(calls.includes('rmdir'))
})
