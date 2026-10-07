/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../../dist/errors.js'
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
  walkTree,
  type TreeContainmentOptions
} from '../../dist/storage/tree-fs.js'
import { treeDigest } from '../../dist/tar-protocol/tree.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir } from '../helpers/files.js'
import { createMemoryStorage } from '../helpers/memory-storage.js'
import { createStorage, type StorageOperationHook, type TestStorage } from '../helpers/storage.js'
import type { StorageStats } from '../../dist/storage/types.js'
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

test('symlink capability requires both symlink and readlink', async (t) => {
  const storage = createStorage()
  for (const incomplete of [
    { ...storage, symlink: undefined, readlink: undefined },
    { ...storage, readlink: undefined },
    { ...storage, symlink: undefined }
  ]) {
    await t.exception(() => assertSymlinkCapable(incomplete), {
      code: ERRORS.UNSUPPORTED_STORAGE
    })
  }
  t.is(assertSymlinkCapable(storage), undefined)
  t.is(assertSymlinkCapable({ ...storage, symlink: () => Promise.resolve() }), undefined)
})

test('tree creation validates every component and rejects a symlinked directory', async (t) => {
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

test('digesting a tree rejects a symlink and an unsafe name', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'ok.bin': 'ok' })
  await fs.promises.symlink(path.join(root, 'ok.bin'), path.join(root, 'link.bin'))
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
  await fs.promises.unlink(path.join(root, 'link.bin'))
  await fs.promises.writeFile(path.join(root, '-bad'), 'bad')
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
})

test('removing a tree unlinks nested symlinks without following them', async (t) => {
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

// ---------------------------------------------------------------------------
// Review fixes: containment, hardening, race detection, errors, bounds
// ---------------------------------------------------------------------------

const STABLE_CODES = new Set<string>(Object.values(ERRORS))

async function rejection(operation: () => Promise<unknown>): Promise<SwarmDeployError> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof SwarmDeployError) {
      if (!STABLE_CODES.has(error.code)) throw new Error(`Unstable code ${error.code}`)
      return error
    }
    throw error
  }
  throw new Error('Expected the operation to reject with a SwarmDeployError')
}

function causeCode(error: SwarmDeployError): string | null {
  const cause = error.cause as { code?: unknown } | null
  return cause && typeof cause.code === 'string' ? cause.code : null
}

function failure(code: string): Error {
  return Object.assign(new Error(`Injected ${code}`), { code })
}

/** Replaces `directory` with a symlink to `outside`, parking the real directory aside. */
async function swapForSymlink(directory: string, outside: string): Promise<void> {
  await fs.promises.rename(directory, `${directory}.moved`)
  await fs.promises.symlink(outside, directory)
}

function withLstat(
  base: TestStorage,
  override: (target: string, stat: StorageStats) => StorageStats | null
): TestStorage {
  return {
    ...base,
    lstat: async (target: string): Promise<StorageStats> => {
      const stat = await base.lstat(target)
      return override(target, stat) ?? stat
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

test('tree-root operations refuse every target that is not a safe direct child of the parent', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  const victim = path.join(outside, 'victim.tree')
  await writeTree(victim, { 'a/keep.bin': 'keep' })
  const dotDot = `${layout.trash}${path.sep}..`

  // [label, treePath, parent, code, requires the layout option]
  const cases: Array<[string, string, string, string, boolean]> = [
    ['self', layout.trash, layout.trash, ERRORS.PROTOCOL_INVALID, false],
    ['dot-dot', dotDot, layout.trash, ERRORS.PROTOCOL_INVALID, false],
    ['relative', 'rel.tree', layout.trash, ERRORS.PROTOCOL_INVALID, false],
    ['relative parent', path.join(layout.trash, 'x.tree'), 'trash', ERRORS.PROTOCOL_INVALID, false],
    ['absolute escape', victim, layout.trash, ERRORS.PROTOCOL_INVALID, false],
    [
      'grandchild',
      path.join(layout.trash, 'x', 'y.tree'),
      layout.trash,
      ERRORS.PROTOCOL_INVALID,
      false
    ],
    ['parent of the parent', layout.internal, layout.trash, ERRORS.PROTOCOL_INVALID, false],
    [
      'unsafe basename',
      path.join(layout.trash, '-bad'),
      layout.trash,
      ERRORS.INVALID_FILENAME,
      false
    ],
    ['internal directory', layout.internal, layout.root, ERRORS.PROTOCOL_INVALID, false],
    ['staging', layout.staging, layout.internal, ERRORS.PROTOCOL_INVALID, false],
    ['sessions', layout.sessions, layout.internal, ERRORS.PROTOCOL_INVALID, false],
    ['links', layout.links, layout.internal, ERRORS.PROTOCOL_INVALID, false],
    ['trash', layout.trash, layout.internal, ERRORS.PROTOCOL_INVALID, false],
    ['lock', layout.lock, layout.internal, ERRORS.PROTOCOL_INVALID, false],
    ['storage root', layout.root, path.dirname(layout.root), ERRORS.PROTOCOL_INVALID, true]
  ]
  const operations: Array<
    [string, (...args: [string, string, TestStorage, TreeContainmentOptions]) => Promise<unknown>]
  > = [
    ['createTreeRoot', createTreeRoot],
    ['inspectTreePath', inspectTreePath],
    ['removeTree', removeTree]
  ]

  for (const [label, treePath, parent, code, needsLayout] of cases) {
    for (const options of [{}, { layout }]) {
      for (const [name, operation] of operations) {
        // Without the layout, only removal can recognise a storage root (by its
        // private directory); creation and inspection need the layout to know.
        if (needsLayout && name !== 'removeTree' && !('layout' in options)) continue
        await t.exception(
          () => operation(treePath, parent, storage, options),
          { code },
          `${name} refuses ${label}`
        )
      }
    }
  }

  for (const directory of protectedDirectories(layout)) {
    t.ok(await exists(directory), `${directory} is intact`)
  }
  t.ok((await fs.promises.lstat(path.join(victim, 'a', 'keep.bin'))).isFile())
  t.absent(await exists(path.join(outside, 'new.tree')))
  await createTreeRoot(path.join(outside, 'new.tree'), outside, storage)
  t.ok(await exists(path.join(outside, 'new.tree')), 'a plain direct child is still created')
})

test('mutating a tree whose root is a protected layout directory is refused', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  for (const protectedRoot of [layout.internal, layout.staging, layout.links, layout.trash]) {
    await t.exception(() => createTreeSubdirectory(protectedRoot, 'planted', storage), {
      code: ERRORS.PROTOCOL_INVALID
    })
    await t.exception(() => openTreeFile(protectedRoot, 'planted.bin', storage), {
      code: ERRORS.PROTOCOL_INVALID
    })
    t.absent(await exists(path.join(protectedRoot, 'planted')))
    t.absent(await exists(path.join(protectedRoot, 'planted.bin')))
  }
  await t.exception(() => createTreeSubdirectory(layout.root, 'planted', storage, { layout }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  for (const relative of ['relative/tree', `${layout.staging}${path.sep}..`]) {
    await t.exception(() => createTreeSubdirectory(relative, 'x', storage), {
      code: ERRORS.PROTOCOL_INVALID
    })
    await t.exception(() => walkTree(relative, storage), { code: ERRORS.PROTOCOL_INVALID })
  }
})

test('removal reports the operation error when identity revalidation also fails', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'keep.bin'), 'keep')
  const tree = path.join(layout.trash, 'op.tree')
  await writeTree(tree, { 'a/b.bin': 'x' })
  const storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'unlink' && target === path.join(tree, 'a', 'b.bin')) {
        await swapForSymlink(path.join(tree, 'a'), outside)
        throw failure('EBUSY')
      }
    }
  })
  const error = await rejection(() => removeTree(tree, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.is(causeCode(error), 'EBUSY', 'the operation error is preserved as the cause')
  t.ok((await fs.promises.lstat(path.join(outside, 'keep.bin'))).isFile())
})

test('removal tolerates children that disappear and reports stable cleanup errors', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const tree = path.join(layout.trash, 'gone.tree')
  await writeTree(tree, { 'a/b.bin': 'x', 'a/c.bin': 'y' })
  const storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'lstat' && target === path.join(tree, 'a', 'b.bin')) {
        await fs.promises.unlink(target)
      }
      if (name === 'unlink' && target === path.join(tree, 'a', 'c.bin')) {
        await fs.promises.unlink(target)
      }
    }
  })
  t.is(await removeTree(tree, layout.trash, storage), true)
  t.absent(await exists(tree))

  const stuck = path.join(layout.trash, 'stuck.tree')
  await writeTree(stuck, { 'a.bin': 'x' })
  for (const operation of ['readdir', 'unlink', 'rmdir'] as const) {
    const failing = createStorage({
      beforeOperation: (name) => {
        if (name === operation) throw failure('EIO')
      }
    })
    const error = await rejection(() => removeTree(stuck, layout.trash, failing))
    t.is(error.code, ERRORS.CLEANUP_FAILED, `${operation} failure is a cleanup failure`)
    t.is(causeCode(error), 'EIO')
  }
  t.ok(await exists(stuck), 'the tree is left in place as residue')
})

test('removal is bounded to the canonical depth and entry limits and leaves residue', async (t) => {
  const memory = createMemoryStorage()
  memory.mkdirp('/m')

  memory.mkdirp(`/m/ok${'/d'.repeat(32)}`)
  t.is(await removeTree('/m/ok', '/m', memory), true, 'depth 32 is removed')
  t.absent(memory.exists('/m/ok'))

  memory.mkdirp(`/m/deep${'/d'.repeat(33)}`)
  let error = await rejection(() => removeTree('/m/deep', '/m', memory))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.ok(memory.exists('/m/deep'), 'residue is left in place')

  memory.mkdirp('/m/full')
  for (let index = 0; index < 10_000; index++) memory.addFile(`/m/full/f${index}`)
  t.is(await removeTree('/m/full', '/m', memory), true, '10000 entries are removed')
  t.absent(memory.exists('/m/full'))

  memory.mkdirp('/m/over')
  for (let index = 0; index < 10_001; index++) memory.addFile(`/m/over/f${index}`)
  error = await rejection(() => removeTree('/m/over', '/m', memory))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.ok(memory.exists('/m/over'), 'residue is left in place')
  t.is(memory.count('/m/over'), 1, 'exactly the entry past the limit remains')
})

test('walking rejects hard links, special files, and filesystem cycles', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'a.bin': 'x' })
  await fs.promises.link(path.join(root, 'a.bin'), path.join(root, 'b.bin'))
  await t.exception(() => walkTree(root, storage), { code: ERRORS.INVALID_FILENAME })
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
  await fs.promises.unlink(path.join(root, 'b.bin'))
  t.is((await walkTree(root, storage)).length, 1)

  const special = withLstat(storage, (target, stat) =>
    target === path.join(root, 'a.bin')
      ? (Object.create(stat, {
          isFile: { value: () => false },
          isDirectory: { value: () => false },
          isSymbolicLink: { value: () => false }
        }) as StorageStats)
      : null
  )
  await t.exception(() => walkTree(root, special), { code: ERRORS.INVALID_FILENAME })

  const cyclic = await createTempDir(t)
  await writeTree(cyclic, { 'loop/inner.bin': 'x' })
  const rootStat = await fs.promises.lstat(cyclic)
  const cycle = withLstat(storage, (target, stat) =>
    target === path.join(cyclic, 'loop')
      ? (Object.create(stat, {
          dev: { value: rootStat.dev },
          ino: { value: rootStat.ino }
        }) as StorageStats)
      : null
  )
  await t.exception(() => walkTree(cyclic, cycle), { code: ERRORS.INVALID_FILENAME })
})

test('digesting rejects a file that gains a hard link after the walk', async (t) => {
  const root = await createTempDir(t)
  const outside = await createTempDir(t)
  await writeTree(root, { 'a.bin': 'x' })
  const storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'open' && target === path.join(root, 'a.bin')) {
        await fs.promises.link(target, path.join(outside, 'alias.bin'))
      }
    }
  })
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
})

test('digesting fails with FILE_BUSY when the tree changes while it is hashed', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, { 'a.bin': 'x', 'b.bin': 'y', 'c.bin': 'z' })
  const storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'open' && target === path.join(root, 'b.bin')) {
        await fs.promises.writeFile(path.join(root, 'added.bin'), 'new')
      }
    }
  })
  await t.exception(() => digestTree(root, storage), { code: ERRORS.FILE_BUSY })
})

test('removal fails with CLEANUP_FAILED when the tree root moves mid-removal', async (t) => {
  const base = await createTempDir(t)
  const parent = path.join(base, 'p')
  const treePath = path.join(parent, 't.tree')
  await fs.promises.mkdir(parent)
  await writeTree(treePath, { 'a/b.bin': 'x' })
  const trigger = path.join(parent, 't.tree')
  let fired = false
  const storage = createStorage({
    beforeOperation: async (name, target) => {
      if (!fired && name === 'readdir' && target === trigger) {
        fired = true
        await fs.promises.rename(treePath, `${treePath}.moved`)
      }
    }
  })
  const error = await rejection(() => removeTree(treePath, parent, storage))
  t.ok(fired)
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.ok(await exists(`${treePath}.moved`))
  t.ok(await exists(path.join(`${treePath}.moved`, 'a', 'b.bin')))
})

test('removal returns true only when the original tree path is gone and the parent is intact', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const tree = path.join(layout.trash, 'done.tree')
  await writeTree(tree, { 'a/b.bin': 'x', 'c.bin': 'y' })
  t.is(await removeTree(tree, layout.trash, createStorage()), true)
  t.absent(await exists(tree))
  t.ok((await fs.promises.lstat(layout.trash)).isDirectory())

  // Something recreates the path while removal finishes: success must not be reported.
  const again = path.join(layout.trash, 'again.tree')
  await writeTree(again, { 'a.bin': 'x' })
  const storage = createStorage({
    afterOperation: async (name, target) => {
      if (name === 'rmdir' && target === again) await fs.promises.mkdir(again)
    }
  })
  const error = await rejection(() => removeTree(again, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
})
