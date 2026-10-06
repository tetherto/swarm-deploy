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

/**
 * Runs `action` immediately before the `nth` lstat of `target`. Tree operations
 * capture an identity first and verify it again before mutating, so the second
 * lstat is the verification that precedes the destructive call.
 */
function onNthLstat(
  target: string,
  nth: number,
  action: () => Promise<void>
): StorageOperationHook {
  let seen = 0
  return async (name, operationTarget) => {
    if (name === 'lstat' && operationTarget === target && ++seen === nth) await action()
  }
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

test('removal re-verifies identities before each destructive call and never deletes an unmanaged target', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await fs.promises.mkdir(path.join(outside, 'a'))
  await fs.promises.writeFile(path.join(outside, 'keep.bin'), 'keep')
  await fs.promises.writeFile(path.join(outside, 'a', 'b.bin'), 'keep')

  // The tree directory itself is swapped for a symlink between capture and mutation.
  const swappedRoot = path.join(layout.trash, 'one.tree')
  await writeTree(swappedRoot, { 'a/b.bin': 'x' })
  let storage = createStorage({
    beforeOperation: onNthLstat(swappedRoot, 2, () => swapForSymlink(swappedRoot, outside))
  })
  let error = await rejection(() => removeTree(swappedRoot, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.ok(
    await exists(path.join(`${swappedRoot}.moved`, 'a', 'b.bin')),
    'the parked tree is untouched'
  )

  // A nested directory is swapped after the child was classified but before it is unlinked.
  const nestedRoot = path.join(layout.trash, 'two.tree')
  await writeTree(nestedRoot, { 'a/b.bin': 'x' })
  storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'lstat' && target === path.join(nestedRoot, 'a', 'b.bin')) {
        await swapForSymlink(path.join(nestedRoot, 'a'), path.join(outside, 'a'))
      }
    }
  })
  error = await rejection(() => removeTree(nestedRoot, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)

  // The managed parent is swapped for a symlink to a directory holding a same-named tree.
  const holder = path.join(await createTempDir(t), 'holder')
  await fs.promises.mkdir(holder)
  await writeTree(path.join(holder, 'three.tree'), { 'c.bin': 'x' })
  const decoy = await createTempDir(t)
  await writeTree(path.join(decoy, 'three.tree'), { 'c.bin': 'decoy' })
  storage = createStorage({
    beforeOperation: onNthLstat(holder, 2, () => swapForSymlink(holder, decoy))
  })
  error = await rejection(() => removeTree(path.join(holder, 'three.tree'), holder, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)
  t.ok(await exists(path.join(decoy, 'three.tree', 'c.bin')), 'the decoy tree survives')

  // The directory is swapped before it is listed; the listing of the outside target is discarded.
  const listedRoot = path.join(layout.trash, 'four.tree')
  await writeTree(listedRoot, { 'd.bin': 'x' })
  storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'readdir' && target === listedRoot) await swapForSymlink(listedRoot, outside)
    }
  })
  error = await rejection(() => removeTree(listedRoot, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)

  // The directory is swapped immediately before the final rmdir: rmdir of a symlink fails.
  const lastRoot = path.join(layout.trash, 'five.tree')
  await writeTree(lastRoot, { 'e.bin': 'x' })
  storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'rmdir' && target === lastRoot) await swapForSymlink(lastRoot, outside)
    }
  })
  error = await rejection(() => removeTree(lastRoot, layout.trash, storage))
  t.is(error.code, ERRORS.CLEANUP_FAILED)

  t.ok((await fs.promises.lstat(path.join(outside, 'keep.bin'))).isFile())
  t.ok((await fs.promises.lstat(path.join(outside, 'a', 'b.bin'))).isFile())
  t.is(await fs.promises.readFile(path.join(outside, 'a', 'b.bin'), 'utf8'), 'keep')
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

test('tree storage failures use stable error codes with the original cause', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const plain = createStorage()

  let error = await rejection(() =>
    createTreeRoot(path.join(layout.staging, 'dup.tree'), layout.staging, plain).then(() =>
      createTreeRoot(path.join(layout.staging, 'dup.tree'), layout.staging, plain)
    )
  )
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EEXIST')

  const tree = path.join(layout.staging, 'dup.tree')
  await createTreeSubdirectory(tree, 'sub', plain)
  error = await rejection(() => createTreeSubdirectory(tree, 'sub', plain))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EEXIST')
  error = await rejection(() => createTreeSubdirectory(tree, 'missing/child', plain))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)

  const injected = (operation: string, target?: string): TestStorage =>
    createStorage({
      beforeOperation: (name, operationTarget) => {
        if (name === operation && (target === undefined || operationTarget === target)) {
          throw failure('EIO')
        }
      }
    })

  error = await rejection(() => inspectTreePath(tree, layout.staging, injected('lstat', tree)))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EIO')
  error = await rejection(() => walkTree(tree, injected('readdir', tree)))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EIO')
  error = await rejection(() => syncTreeDirectories(tree, injected('open')))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EIO')

  const file = path.join(tree, 'sub', 'f.bin')
  const handle = await openTreeFile(tree, 'sub/f.bin', plain)
  await handle.write(b4a.from('data'), 0, 4, 0)
  await handle.close()
  error = await rejection(() => digestTree(tree, injected('read', file)))
  t.is(error.code, ERRORS.PROTOCOL_INVALID)
  t.is(causeCode(error), 'EIO')
})

test('creation fails closed when an ancestor is replaced before or during the operation', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)

  // Detected before the mutating call: nothing is created outside.
  const root = path.join(layout.staging, 'race.tree')
  await createTreeRoot(root, layout.staging, createStorage())
  await createTreeSubdirectory(root, 'nested', createStorage())
  const nested = path.join(root, 'nested')
  let storage = createStorage({
    beforeOperation: onNthLstat(nested, 2, () => swapForSymlink(nested, outside))
  })
  await t.exception(() => createTreeSubdirectory(root, 'nested/evil', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readdir(outside), [], 'no directory was created outside')

  await fs.promises.rm(`${nested}.moved`, { recursive: true, force: true })
  await fs.promises.rm(nested, { force: true })
  await createTreeSubdirectory(root, 'nested', createStorage())
  storage = createStorage({
    beforeOperation: onNthLstat(nested, 2, () => swapForSymlink(nested, outside))
  })
  await t.exception(() => openTreeFile(root, 'nested/evil.bin', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readdir(outside), [], 'no file was created outside')

  const holder = path.join(layout.staging, 'holder')
  await fs.promises.mkdir(holder)
  storage = createStorage({
    beforeOperation: onNthLstat(holder, 2, () => swapForSymlink(holder, outside))
  })
  await t.exception(() => createTreeRoot(path.join(holder, 'new.tree'), holder, storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readdir(outside), [], 'no tree root was created outside')

  // A swap inside the mutating call itself cannot be prevented with path-based
  // storage; it is still detected afterwards and fails closed.
  const late = path.join(layout.staging, 'late.tree')
  await createTreeRoot(late, layout.staging, createStorage())
  await createTreeSubdirectory(late, 'inner', createStorage())
  const inner = path.join(late, 'inner')
  storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'mkdir' && target === path.join(inner, 'child')) {
        await swapForSymlink(inner, outside)
      }
    }
  })
  await t.exception(() => createTreeSubdirectory(late, 'inner/child', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('walking and digesting fail closed when a directory is replaced mid-operation', async (t) => {
  const outside = await createTempDir(t)
  const root = await createTempDir(t)
  await writeTree(root, { 'a/one.bin': '1', 'b.bin': 'b' })
  const dir = path.join(root, 'a')

  let storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'readdir' && target === dir) await swapForSymlink(dir, outside)
    }
  })
  await t.exception(() => walkTree(root, storage), { code: ERRORS.PROTOCOL_INVALID })

  await fs.promises.rm(dir, { force: true })
  await fs.promises.rename(`${dir}.moved`, dir)
  storage = createStorage({
    beforeOperation: async (name, target) => {
      if (name === 'open' && target === path.join(dir, 'one.bin')) {
        await swapForSymlink(dir, outside)
      }
    }
  })
  await t.exception(() => digestTree(root, storage), { code: ERRORS.FILE_BUSY })
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
  const mutations: Array<[string, (root: string) => Promise<void>]> = [
    ['an added file', (root) => fs.promises.writeFile(path.join(root, 'added.bin'), 'new')],
    ['an added directory', (root) => fs.promises.mkdir(path.join(root, 'added'))],
    ['a removed unhashed file', (root) => fs.promises.unlink(path.join(root, 'c.bin'))],
    ['a removed hashed file', (root) => fs.promises.unlink(path.join(root, 'a.bin'))],
    [
      'a replaced hashed file',
      async (root) => {
        await fs.promises.writeFile(path.join(root, 'replacement.tmp'), 'x')
        await fs.promises.rename(path.join(root, 'replacement.tmp'), path.join(root, 'a.bin'))
      }
    ],
    ['a grown hashed file', (root) => fs.promises.appendFile(path.join(root, 'a.bin'), 'more')]
  ]
  for (const [label, mutate] of mutations) {
    const root = await createTempDir(t)
    await writeTree(root, { 'a.bin': 'x', 'b.bin': 'y', 'c.bin': 'z' })
    // Mutate while the second file is opened, after the first one was hashed.
    const storage = createStorage({
      beforeOperation: async (name, target) => {
        if (name === 'open' && target === path.join(root, 'b.bin')) await mutate(root)
      }
    })
    await t.exception(() => digestTree(root, storage), { code: ERRORS.FILE_BUSY }, label)
  }
})
