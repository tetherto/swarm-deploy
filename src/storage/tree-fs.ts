import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { SodiumSha256 } from '../tar-protocol/hash.js'
import {
  MAX_TREE_ENTRIES,
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  compareTreePaths,
  treeDigest,
  type TreeDigestEntry,
  type TreeEntry
} from '../tar-protocol/tree.js'
import { openSafeRegularFile, withSafeDirectoryIdentity } from './layout.js'
import type {
  StorageAdapter,
  StorageFileHandle,
  StorageStats,
  SymlinkCapableStorage
} from './types.js'

const READ_BYTES = 64 * 1024

export type TreePathState = 'MISSING' | 'DIRECTORY' | 'UNMANAGED'

export interface TreeDigestResult {
  entries: TreeEntry[]
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
}

function storageError(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function unsafeName(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.INVALID_FILENAME, message)
}

export function assertSymlinkCapable(
  storage: StorageAdapter
): asserts storage is SymlinkCapableStorage {
  if (typeof storage.symlink !== 'function' || typeof storage.readlink !== 'function') {
    throw new SwarmDeployError(
      ERRORS.UNSUPPORTED_STORAGE,
      'Storage adapter does not support symbolic links'
    )
  }
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Resolves `relativePath` inside `treePath` one validated component at a time,
 * revalidating each parent's directory identity. Nothing is concatenated
 * without validation and no component may be a symbolic link.
 */
async function resolveParent(
  treePath: string,
  relativePath: string,
  kind: 'file' | 'directory',
  storage: StorageAdapter
): Promise<{ parent: string; target: string }> {
  assertTreeEntryPath(relativePath, kind)
  const components = relativePath.split('/')
  let parent = treePath
  for (const component of components.slice(0, -1)) {
    const next = path.join(parent, component)
    await withSafeDirectoryIdentity(parent, storage, async () => {
      let stat: StorageStats
      try {
        stat = await storage.lstat(next)
      } catch (error: unknown) {
        throw storageError('Unsafe tree directory', error)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw storageError('Unsafe tree directory')
      }
    })
    parent = next
  }
  return { parent, target: path.join(parent, components[components.length - 1]) }
}

export async function createTreeRoot(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<void> {
  await withSafeDirectoryIdentity(parent, storage, () => storage.mkdir(treePath, { mode: 0o700 }))
  await withSafeDirectoryIdentity(parent, storage, () => syncDirectory(parent, storage))
}

export async function createTreeSubdirectory(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter
): Promise<void> {
  const { parent, target } = await resolveParent(treePath, relativePath, 'directory', storage)
  await withSafeDirectoryIdentity(parent, storage, () => storage.mkdir(target, { mode: 0o700 }))
}

export async function openTreeFile(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter
): Promise<StorageFileHandle> {
  const { parent, target } = await resolveParent(treePath, relativePath, 'file', storage)
  return withSafeDirectoryIdentity(parent, storage, () =>
    openSafeRegularFile(target, 'create', storage)
  )
}

/** Synchronizes every directory in the tree, deepest first. */
export async function syncTreeDirectories(
  treePath: string,
  storage: StorageAdapter
): Promise<void> {
  const directories = [treePath]
  for (const entry of await walkTree(treePath, storage)) {
    if (entry.kind === 'directory') directories.push(path.join(treePath, ...entry.path.split('/')))
  }
  for (const directory of directories.reverse()) {
    await withSafeDirectoryIdentity(directory, storage, () => syncDirectory(directory, storage))
  }
}

export async function walkTree(treePath: string, storage: StorageAdapter): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = await withSafeDirectoryIdentity(absolute, storage, () =>
      storage.readdir(absolute)
    )
    names.sort((left, right) => compareTreePaths(left, right))
    for (const name of names) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const entryAbsolute = path.join(absolute, name)
      const stat = await storage.lstat(entryAbsolute)
      if (stat.isSymbolicLink()) throw unsafeName('Tree entries cannot be symbolic links')
      if (entries.length >= MAX_TREE_ENTRIES) {
        throw storageError('Tree has too many entries')
      }
      if (stat.isDirectory()) {
        assertTreeEntryPath(entryPath, 'directory')
        entries.push({ kind: 'directory', path: entryPath, size: 0 })
        await walk(entryAbsolute, entryPath)
        continue
      }
      if (!stat.isFile()) throw unsafeName('Tree entries must be regular files or directories')
      assertTreeEntryPath(entryPath, 'file')
      entries.push({ kind: 'file', path: entryPath, size: stat.size })
    }
  }
  await walk(treePath, '')
  // Depth-first order is not bytewise order (`a-x` sorts before `a/c`), so the
  // canonical order is established over full paths, as the snapshot does.
  entries.sort((left, right) => compareTreePaths(left.path, right.path))
  assertCanonicalTreeEntries(entries)
  return entries
}

async function digestTreeFile(
  filePath: string,
  size: number,
  storage: StorageAdapter
): Promise<Buffer> {
  const handle = await openSafeRegularFile(filePath, 'read', storage)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== size) {
      throw storageError('Tree file changed during digest')
    }
    const hash = new SodiumSha256()
    let position = 0
    while (position < size) {
      const bytes = b4a.alloc(Math.min(READ_BYTES, size - position))
      let offset = 0
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
        const count = typeof read === 'number' ? read : read.bytesRead
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw storageError('Truncated tree file')
        }
        offset += count
      }
      hash.update(bytes)
      position += bytes.byteLength
    }
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.size !== size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw storageError('Tree file changed during digest')
    }
    return hash.digest()
  } finally {
    await handle.close()
  }
}

/** Recomputes the canonical tree digest from the extracted contents alone. */
export async function digestTree(
  treePath: string,
  storage: StorageAdapter
): Promise<TreeDigestResult> {
  const entries = await walkTree(treePath, storage)
  const digests: TreeDigestEntry[] = []
  let payloadBytes = 0
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      digests.push({ entry })
      continue
    }
    const absolute = path.join(treePath, ...entry.path.split('/'))
    const parent = path.dirname(absolute)
    const sha256 = await withSafeDirectoryIdentity(parent, storage, () =>
      digestTreeFile(absolute, entry.size, storage)
    )
    if (payloadBytes > Number.MAX_SAFE_INTEGER - entry.size) {
      throw storageError('Tree payload exceeds safe integer range')
    }
    payloadBytes += entry.size
    digests.push({ entry, sha256 })
  }
  return {
    entries,
    entryCount: entries.length,
    payloadBytes,
    treeSha256: treeDigest(digests)
  }
}

export function inspectTreePath(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<TreePathState> {
  return withSafeDirectoryIdentity(parent, storage, async () => {
    let stat: StorageStats
    try {
      stat = await storage.lstat(treePath)
    } catch (error: unknown) {
      if (isMissing(error)) return 'MISSING'
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'UNMANAGED'
    return 'DIRECTORY'
  })
}

/**
 * Removes `treePath` recursively using only `lstat`, `unlink`, and `rmdir`. A
 * symbolic link inside the tree is unlinked, never traversed, so nothing
 * outside the tree can be reached. Returns `false` when the path was absent.
 */
export async function removeTree(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<boolean> {
  const state = await inspectTreePath(treePath, parent, storage)
  if (state === 'MISSING') return false
  if (state === 'UNMANAGED') throw storageError('Refusing to remove an unmanaged tree path')

  const removeDirectory = async (absolute: string): Promise<void> => {
    const names = await withSafeDirectoryIdentity(absolute, storage, () =>
      storage.readdir(absolute)
    )
    for (const name of names.sort()) {
      const child = path.join(absolute, name)
      const stat = await storage.lstat(child)
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        await removeDirectory(child)
        continue
      }
      await withSafeDirectoryIdentity(absolute, storage, () => storage.unlink(child))
    }
    await withSafeDirectoryIdentity(path.dirname(absolute), storage, () => storage.rmdir(absolute))
  }

  await removeDirectory(treePath)
  await withSafeDirectoryIdentity(parent, storage, () => syncDirectory(parent, storage))
  return true
}
