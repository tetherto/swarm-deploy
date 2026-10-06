/**
 * Safe recursive tree primitives over a {@link StorageAdapter}.
 *
 * Guarantees, stated precisely:
 *
 * - Containment is absolute. A tree root must be a normalized absolute path that
 *   is a valid, direct child of its managed parent and is never a protected
 *   layout directory. Tree-relative paths are validated component by component,
 *   so no traversal, absolute path, or separator ever reaches the adapter.
 * - Symbolic links, hard links, special files, and directory cycles are rejected
 *   or never followed: members are classified with `lstat`, file opens use
 *   `O_NOFOLLOW`, and removal unlinks links instead of traversing them.
 * - Concurrent replacement of a directory is **detected, not prevented**. The
 *   adapter is path-based (there is no `openat`), so a local actor swapping a
 *   directory between a check and the following call cannot be excluded. Every
 *   operation therefore captures the identity (`dev:ino`) of each ancestor it
 *   relies on, verifies the whole chain immediately before and after each
 *   mutating call, and fails closed when any identity changed. A mutation that
 *   lands inside that unavoidable window is reported, not silently accepted.
 *   Local actors remain outside the threat model; remote input can only reach
 *   these functions through validated relative paths.
 */
import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { validateBasename } from '../files.js'
import { SodiumSha256 } from '../tar-protocol/hash.js'
import {
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  classifyTreeEntry,
  compareTreePaths,
  treeDigest,
  type TreeDigestEntry,
  type TreeEntry
} from '../tar-protocol/tree.js'
import { openSafeRegularFile, protectedDirectories } from './layout.js'
import type {
  StorageAdapter,
  StorageFileHandle,
  StorageLayout,
  StorageStats,
  SymlinkCapableStorage
} from './types.js'

const READ_BYTES = 64 * 1024
const INTERNAL_NAME = '.swarm-deploy'

export type TreePathState = 'MISSING' | 'DIRECTORY' | 'UNMANAGED'

export interface TreeDigestResult {
  entries: TreeEntry[]
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
}

/** Optional exact protection: pass the layout to forbid every protected directory by identity. */
export interface TreeContainmentOptions {
  layout?: StorageLayout
}

type ErrorCode = (typeof ERRORS)[keyof typeof ERRORS]

interface Anchor {
  path: string
  dev: number | bigint
  ino: number | bigint
}

interface TreeIdentityStamp {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs?: number
}

interface WalkedEntry extends TreeEntry {
  identity: TreeIdentityStamp
}

interface WalkResult {
  root: Anchor
  entries: WalkedEntry[]
}

function treeError(code: ErrorCode, message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(code, message, cause)
}

/** Keeps a stable coded error as is and wraps anything else, keeping it as the cause. */
function coded(error: unknown, code: ErrorCode, message: string): SwarmDeployError {
  return error instanceof SwarmDeployError ? error : treeError(code, message, error)
}

export function assertSymlinkCapable(
  storage: StorageAdapter
): asserts storage is SymlinkCapableStorage {
  if (typeof storage.symlink !== 'function' || typeof storage.readlink !== 'function') {
    throw treeError(ERRORS.UNSUPPORTED_STORAGE, 'Storage adapter does not support symbolic links')
  }
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

function assertNormalizedAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw treeError(ERRORS.PROTOCOL_INVALID, `Tree ${label} must be a normalized absolute path`)
  }
  return value
}

function isProtectedPath(target: string, options: TreeContainmentOptions): boolean {
  if (path.basename(target) === INTERNAL_NAME) return true
  if (path.basename(path.dirname(target)) === INTERNAL_NAME) return true
  const { layout } = options
  if (!layout) return false
  if ([...protectedDirectories(layout), layout.lock].includes(target)) return true
  // Never address an ancestor of the storage root: that would contain everything.
  const prefix = target.endsWith(path.sep) ? target : `${target}${path.sep}`
  return layout.root === target || layout.root.startsWith(prefix)
}

/** A mutable tree root: normalized, absolute, and not itself a protected directory. */
function assertTreeRoot(treePath: unknown, options: TreeContainmentOptions): string {
  const root = assertNormalizedAbsolute(treePath, 'root')
  if (isProtectedPath(root, options)) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree root is a protected storage directory')
  }
  return root
}

/** `treePath` must be a valid direct child of `parent`, and neither may be protected. */
function assertManagedChild(
  treePath: unknown,
  parent: unknown,
  options: TreeContainmentOptions
): { treePath: string; parent: string } {
  const child = assertNormalizedAbsolute(treePath, 'root')
  const managedParent = assertNormalizedAbsolute(parent, 'parent')
  if (child === managedParent) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree root cannot be its managed parent')
  }
  if (isProtectedPath(child, options)) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree root is a protected storage directory')
  }
  if (path.dirname(child) !== managedParent) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree root must be a direct child of its parent')
  }
  validateBasename(path.basename(child))
  return { treePath: child, parent: managedParent }
}

// ---------------------------------------------------------------------------
// Identity anchors
// ---------------------------------------------------------------------------

function isIdentityValue(value: unknown): value is number | bigint {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n)
  )
}

function anchorFrom(directory: string, stat: StorageStats, code: ErrorCode): Anchor {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw treeError(code, 'Unsafe tree directory')
  }
  if (!isIdentityValue(stat.dev) || !isIdentityValue(stat.ino)) {
    throw treeError(code, 'Tree directory identity is unavailable')
  }
  return { path: directory, dev: stat.dev, ino: stat.ino }
}

async function captureAnchor(
  directory: string,
  storage: StorageAdapter,
  code: ErrorCode
): Promise<Anchor> {
  let stat: StorageStats
  try {
    stat = await storage.lstat(directory)
  } catch (error: unknown) {
    throw treeError(code, 'Unable to inspect tree directory', error)
  }
  return anchorFrom(directory, stat, code)
}

async function verifyAnchors(
  anchors: readonly Anchor[],
  storage: StorageAdapter,
  code: ErrorCode
): Promise<void> {
  for (const anchor of anchors) {
    const actual = await captureAnchor(anchor.path, storage, code)
    if (actual.dev !== anchor.dev || actual.ino !== anchor.ino) {
      throw treeError(code, 'Tree directory was replaced during the operation')
    }
  }
}

/**
 * Runs one adapter call between two verifications of every ancestor identity.
 * An error raised by the call itself always wins over a verification failure
 * that follows it, and is kept as the cause of the stable error.
 */
async function guarded<T>(
  anchors: readonly Anchor[],
  storage: StorageAdapter,
  code: ErrorCode,
  message: string,
  operation: () => Promise<T> | T
): Promise<T> {
  await verifyAnchors(anchors, storage, code)
  let result: T
  try {
    result = await operation()
  } catch (error: unknown) {
    await verifyAnchors(anchors, storage, code).catch(() => {})
    throw coded(error, code, message)
  }
  await verifyAnchors(anchors, storage, code)
  return result
}

/**
 * Like {@link guarded}, for a leaf call whose own target may legitimately vanish.
 * Only an ENOENT raised by the call itself is reported as `missing`, and only
 * after the whole ancestor chain was verified again: if any ancestor, the root,
 * or the managed parent is gone or replaced, verification throws instead.
 */
async function guardedLeaf<T>(
  anchors: readonly Anchor[],
  storage: StorageAdapter,
  code: ErrorCode,
  message: string,
  operation: () => Promise<T> | T
): Promise<{ missing: true } | { missing: false; value: T }> {
  await verifyAnchors(anchors, storage, code)
  let value: T
  try {
    value = await operation()
  } catch (error: unknown) {
    if (isMissing(error)) {
      await verifyAnchors(anchors, storage, code)
      return { missing: true }
    }
    await verifyAnchors(anchors, storage, code).catch(() => {})
    throw coded(error, code, message)
  }
  await verifyAnchors(anchors, storage, code)
  return { missing: false, value }
}

async function syncDirectory(
  directory: string,
  anchors: readonly Anchor[],
  storage: StorageAdapter,
  code: ErrorCode
): Promise<void> {
  await guarded(anchors, storage, code, 'Unable to synchronize tree directory', async () => {
    const handle = await storage.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Validates `relativePath`, then captures the identity of the tree root and of
 * every intermediate directory, rejecting symbolic links and missing members.
 */
async function resolveParent(
  treePath: string,
  relativePath: string,
  kind: 'file' | 'directory',
  storage: StorageAdapter,
  options: TreeContainmentOptions
): Promise<{ anchors: Anchor[]; parent: string; target: string }> {
  const root = assertTreeRoot(treePath, options)
  assertTreeEntryPath(relativePath, kind)
  const components = relativePath.split('/')
  const anchors = [await captureAnchor(root, storage, ERRORS.PROTOCOL_INVALID)]
  let parent = root
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component)
    anchors.push(await captureAnchor(parent, storage, ERRORS.PROTOCOL_INVALID))
  }
  return { anchors, parent, target: path.join(parent, components[components.length - 1]) }
}

export async function createTreeRoot(
  treePath: string,
  parent: string,
  storage: StorageAdapter,
  options: TreeContainmentOptions = {}
): Promise<void> {
  const managed = assertManagedChild(treePath, parent, options)
  const anchors = [await captureAnchor(managed.parent, storage, ERRORS.PROTOCOL_INVALID)]
  await guarded(anchors, storage, ERRORS.PROTOCOL_INVALID, 'Unable to create tree root', () =>
    storage.mkdir(managed.treePath, { mode: 0o700 })
  )
  await syncDirectory(managed.parent, anchors, storage, ERRORS.PROTOCOL_INVALID)
}

export async function createTreeSubdirectory(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter,
  options: TreeContainmentOptions = {}
): Promise<void> {
  const { anchors, target } = await resolveParent(
    treePath,
    relativePath,
    'directory',
    storage,
    options
  )
  await guarded(anchors, storage, ERRORS.PROTOCOL_INVALID, 'Unable to create tree directory', () =>
    storage.mkdir(target, { mode: 0o700 })
  )
}

export async function openTreeFile(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter,
  options: TreeContainmentOptions = {}
): Promise<StorageFileHandle> {
  const { anchors, target } = await resolveParent(treePath, relativePath, 'file', storage, options)
  await verifyAnchors(anchors, storage, ERRORS.PROTOCOL_INVALID)
  let handle: StorageFileHandle
  try {
    handle = await openSafeRegularFile(target, 'create', storage)
  } catch (error: unknown) {
    await verifyAnchors(anchors, storage, ERRORS.PROTOCOL_INVALID).catch(() => {})
    throw coded(error, ERRORS.PROTOCOL_INVALID, 'Unable to create tree file')
  }
  try {
    await verifyAnchors(anchors, storage, ERRORS.PROTOCOL_INVALID)
  } catch (error: unknown) {
    await handle.close().catch(() => {})
    throw error
  }
  return handle
}

/** Synchronizes every directory in the tree, deepest first. */
export async function syncTreeDirectories(
  treePath: string,
  storage: StorageAdapter
): Promise<void> {
  const { root, entries } = await walkIdentities(treePath, storage)
  const directories: Anchor[] = [root]
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      directories.push({
        path: path.join(root.path, ...entry.path.split('/')),
        dev: entry.identity.dev,
        ino: entry.identity.ino
      })
    }
  }
  for (const directory of directories.reverse()) {
    await syncDirectory(directory.path, [directory], storage, ERRORS.PROTOCOL_INVALID)
  }
}

// ---------------------------------------------------------------------------
// Walking and digesting
// ---------------------------------------------------------------------------

async function walkIdentities(treePath: string, storage: StorageAdapter): Promise<WalkResult> {
  const code = ERRORS.PROTOCOL_INVALID
  const rootPath = assertNormalizedAbsolute(treePath, 'root')
  const root = await captureAnchor(rootPath, storage, code)
  const seen = new Set<string>([`${root.dev}:${root.ino}`])
  const entries: WalkedEntry[] = []

  const walk = async (chain: readonly Anchor[], prefix: string): Promise<void> => {
    const directory = chain[chain.length - 1].path
    const names = await guarded(chain, storage, code, 'Unable to read tree directory', () =>
      storage.readdir(directory)
    )
    names.sort((left, right) => compareTreePaths(left, right))
    for (const name of names) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const entryAbsolute = path.join(directory, name)
      let stat: StorageStats
      try {
        stat = await storage.lstat(entryAbsolute)
      } catch (error: unknown) {
        throw treeError(code, 'Unable to inspect tree entry', error)
      }
      const kind = classifyTreeEntry(stat)
      assertTreeEntryPath(entryPath, kind)
      if (entries.length >= MAX_TREE_ENTRIES) throw treeError(code, 'Tree has too many entries')
      const identity: TreeIdentityStamp = {
        dev: stat.dev,
        ino: stat.ino,
        size: kind === 'directory' ? 0 : stat.size,
        ...(typeof stat.mtimeMs === 'number' ? { mtimeMs: stat.mtimeMs } : {})
      }
      if (kind === 'directory') {
        const key = `${stat.dev}:${stat.ino}`
        if (seen.has(key)) {
          throw treeError(ERRORS.INVALID_FILENAME, 'Tree contains a filesystem cycle')
        }
        seen.add(key)
        const child = anchorFrom(entryAbsolute, stat, code)
        entries.push({ kind, path: entryPath, size: 0, identity })
        await walk([...chain, child], entryPath)
        continue
      }
      entries.push({ kind, path: entryPath, size: stat.size, identity })
    }
    await verifyAnchors(chain, storage, code)
  }

  await walk([root], '')
  // Depth-first order is not bytewise order (`a-x` sorts before `a/c`), so the
  // canonical order is established over full paths, as the snapshot does.
  entries.sort((left, right) => compareTreePaths(left.path, right.path))
  assertCanonicalTreeEntries(entries)
  return { root, entries }
}

export async function walkTree(treePath: string, storage: StorageAdapter): Promise<TreeEntry[]> {
  const { entries } = await walkIdentities(treePath, storage)
  return entries.map(({ kind, path: entryPath, size }) => ({ kind, path: entryPath, size }))
}

function busy(message: string, cause: unknown = null): SwarmDeployError {
  return treeError(ERRORS.FILE_BUSY, message, cause)
}

function sameStamp(left: TreeIdentityStamp, right: TreeIdentityStamp): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    (left.mtimeMs === undefined || right.mtimeMs === undefined || left.mtimeMs === right.mtimeMs)
  )
}

async function digestTreeFile(
  filePath: string,
  entry: WalkedEntry,
  anchors: readonly Anchor[],
  storage: StorageAdapter
): Promise<Buffer> {
  await verifyAnchors(anchors, storage, ERRORS.FILE_BUSY)
  let handle: StorageFileHandle
  try {
    handle = await openSafeRegularFile(filePath, 'read', storage)
  } catch (error: unknown) {
    if (isMissing(error)) throw busy('Tree file changed during digest', error)
    throw coded(error, ERRORS.PROTOCOL_INVALID, 'Unable to open tree file')
  }
  let outcome: Buffer
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw busy('Tree file changed during digest')
    if (typeof before.nlink === 'number' && before.nlink > 1) {
      throw treeError(ERRORS.INVALID_FILENAME, 'Tree entries cannot be hard links')
    }
    if (!sameStamp(entry.identity, before)) throw busy('Tree file changed during digest')
    const hash = new SodiumSha256()
    let position = 0
    while (position < entry.size) {
      const bytes = b4a.alloc(Math.min(READ_BYTES, entry.size - position))
      let offset = 0
      while (offset < bytes.byteLength) {
        let read: number | { bytesRead: number }
        try {
          read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
        } catch (error: unknown) {
          throw treeError(ERRORS.PROTOCOL_INVALID, 'Unable to read tree file', error)
        }
        const count = typeof read === 'number' ? read : read.bytesRead
        if (!Number.isSafeInteger(count) || count <= 0) throw busy('Tree file was truncated')
        offset += count
      }
      hash.update(bytes)
      position += bytes.byteLength
    }
    const after = await handle.stat()
    if (!after.isFile() || !sameStamp(entry.identity, after)) {
      throw busy('Tree file changed during digest')
    }
    outcome = hash.digest()
  } catch (error: unknown) {
    await handle.close().catch(() => {})
    throw coded(error, ERRORS.PROTOCOL_INVALID, 'Unable to digest tree file')
  }
  try {
    await handle.close()
  } catch (error: unknown) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Unable to close tree file', error)
  }
  await verifyAnchors(anchors, storage, ERRORS.FILE_BUSY)
  return outcome
}

/**
 * Recomputes the canonical tree digest from the extracted contents alone, then
 * walks the tree again and requires the same entries and identities, so an
 * addition, removal, or replacement during hashing fails with FILE_BUSY.
 */
export async function digestTree(
  treePath: string,
  storage: StorageAdapter
): Promise<TreeDigestResult> {
  const first = await walkIdentities(treePath, storage)
  const directories = new Map<string, Anchor>([['', first.root]])
  for (const entry of first.entries) {
    if (entry.kind === 'directory') {
      directories.set(entry.path, {
        path: path.join(first.root.path, ...entry.path.split('/')),
        dev: entry.identity.dev,
        ino: entry.identity.ino
      })
    }
  }

  const digests: TreeDigestEntry[] = []
  let payloadBytes = 0
  for (const entry of first.entries) {
    if (entry.kind === 'directory') {
      digests.push({ entry: { kind: 'directory', path: entry.path, size: 0 } })
      continue
    }
    const components = entry.path.split('/')
    const anchors: Anchor[] = []
    for (let depth = 0; depth < components.length; depth++) {
      const anchor = directories.get(components.slice(0, depth).join('/'))
      if (!anchor) throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree entry has no parent directory')
      anchors.push(anchor)
    }
    const absolute = path.join(first.root.path, ...components)
    const sha256 = await digestTreeFile(absolute, entry, anchors, storage)
    if (payloadBytes > Number.MAX_SAFE_INTEGER - entry.size) {
      throw treeError(ERRORS.PROTOCOL_INVALID, 'Tree payload exceeds safe integer range')
    }
    payloadBytes += entry.size
    digests.push({ entry: { kind: 'file', path: entry.path, size: entry.size }, sha256 })
  }

  let second: WalkResult
  try {
    second = await walkIdentities(treePath, storage)
  } catch (error: unknown) {
    throw busy('Tree changed during digest', error)
  }
  const unchanged =
    second.root.dev === first.root.dev &&
    second.root.ino === first.root.ino &&
    second.entries.length === first.entries.length &&
    second.entries.every((entry, index) => {
      const original = first.entries[index]
      return (
        entry.path === original.path &&
        entry.kind === original.kind &&
        sameStamp(entry.identity, original.identity)
      )
    })
  if (!unchanged) throw busy('Tree changed during digest')

  const entries = first.entries.map(({ kind, path: entryPath, size }) => ({
    kind,
    path: entryPath,
    size
  }))
  return {
    entries,
    entryCount: entries.length,
    payloadBytes,
    treeSha256: treeDigest(digests)
  }
}

// ---------------------------------------------------------------------------
// Inspection and removal
// ---------------------------------------------------------------------------

async function inspect(
  treePath: string,
  parent: string,
  storage: StorageAdapter,
  code: ErrorCode,
  options: TreeContainmentOptions
): Promise<{ state: TreePathState; anchors: Anchor[]; tree: Anchor | null }> {
  const managed = assertManagedChild(treePath, parent, options)
  const anchors = [await captureAnchor(managed.parent, storage, code)]
  let stat: StorageStats | null = null
  try {
    stat = await guarded(anchors, storage, code, 'Unable to inspect tree path', async () => {
      try {
        return await storage.lstat(managed.treePath)
      } catch (error: unknown) {
        if (isMissing(error)) return null
        throw error
      }
    })
  } catch (error: unknown) {
    throw coded(error, code, 'Unable to inspect tree path')
  }
  if (stat === null) return { state: 'MISSING', anchors, tree: null }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { state: 'UNMANAGED', anchors, tree: null }
  }
  return { state: 'DIRECTORY', anchors, tree: anchorFrom(managed.treePath, stat, code) }
}

export async function inspectTreePath(
  treePath: string,
  parent: string,
  storage: StorageAdapter,
  options: TreeContainmentOptions = {}
): Promise<TreePathState> {
  return (await inspect(treePath, parent, storage, ERRORS.PROTOCOL_INVALID, options)).state
}

interface RemovalFrame {
  anchor: Anchor
  depth: number
  names: string[] | null
  index: number
}

/**
 * Removes `treePath` iteratively using only `lstat`, `unlink`, and `rmdir`; it
 * never calls a recursive remove. A symbolic link inside the tree is unlinked,
 * never traversed. Depth and entry count are bounded by the canonical tree
 * limits; exceeding either, or any failure, throws CLEANUP_FAILED and leaves
 * the remaining tree in place as residue. Only the leaf entry a call targets may
 * vanish concurrently (ENOENT), and only after the whole identity chain was
 * verified again; a missing or moved root, directory, or parent is never a
 * vanished member and throws CLEANUP_FAILED. Returns `false` only when the path
 * was already absent; `true` means the original path is gone and the parent
 * still matches its captured identity.
 *
 * Before and after every mutating call the identity of the parent, the tree
 * root, and every directory above the entry is verified; a replaced directory
 * aborts the removal (detected, not prevented — see the module guarantee).
 */
export async function removeTree(
  treePath: string,
  parent: string,
  storage: StorageAdapter,
  options: TreeContainmentOptions = {}
): Promise<boolean> {
  const code = ERRORS.CLEANUP_FAILED
  const found = await inspect(treePath, parent, storage, code, options)
  if (found.state === 'MISSING') return false
  if (found.state === 'UNMANAGED' || found.tree === null) {
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Refusing to remove an unmanaged tree path')
  }
  const [parentAnchor] = found.anchors
  const rootAnchor = found.tree
  const stack: RemovalFrame[] = [{ anchor: rootAnchor, depth: 0, names: null, index: 0 }]

  // A directory holding the private storage directory is a storage root, never a tree.
  try {
    await storage.lstat(path.join(found.tree.path, INTERNAL_NAME))
    throw treeError(ERRORS.PROTOCOL_INVALID, 'Refusing to remove a storage root')
  } catch (error: unknown) {
    if (!isMissing(error)) throw coded(error, code, 'Unable to inspect tree root')
  }

  const chain = (): Anchor[] => [parentAnchor, ...stack.map((frame) => frame.anchor)]
  let visited = 0

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.names === null) {
      // The directory is part of the verified chain, so a listing that reports
      // it missing is never a vanished member: it fails the removal.
      frame.names = await guarded(
        chain(),
        storage,
        code,
        'Unable to read tree directory for removal',
        () => storage.readdir(frame.anchor.path)
      )
      frame.names.sort()
    }

    if (frame.index < frame.names.length) {
      const child = path.join(frame.anchor.path, frame.names[frame.index++])
      visited++
      if (visited > MAX_TREE_ENTRIES) {
        throw treeError(code, 'Tree has too many entries to remove')
      }
      // Only the leaf's own target may vanish, and only while the chain still matches.
      const inspected = await guardedLeaf(
        chain(),
        storage,
        code,
        'Unable to inspect tree entry',
        () => storage.lstat(child)
      )
      if (inspected.missing) continue
      const stat = inspected.value
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        if (frame.depth + 1 > MAX_TREE_DEPTH) throw treeError(code, 'Tree is too deep to remove')
        stack.push({
          anchor: anchorFrom(child, stat, code),
          depth: frame.depth + 1,
          names: null,
          index: 0
        })
        continue
      }
      await guardedLeaf(chain(), storage, code, 'Unable to remove tree entry', () =>
        storage.unlink(child)
      )
      continue
    }

    // The directory itself disappears with the call, so only its ancestors can
    // be verified afterwards; the directory is verified immediately before. A
    // directory that is already missing here was moved, not removed.
    const ancestors = chain().slice(0, -1)
    await verifyAnchors([...ancestors, frame.anchor], storage, code)
    await guarded(ancestors, storage, code, 'Unable to remove tree directory', () =>
      storage.rmdir(frame.anchor.path)
    )
    stack.pop()
  }

  // `true` is only returned once the original path is observably gone while the
  // managed parent still matches its captured identity.
  const remaining = await guardedLeaf(
    [parentAnchor],
    storage,
    code,
    'Unable to confirm tree removal',
    () => storage.lstat(rootAnchor.path)
  )
  if (!remaining.missing) throw treeError(code, 'Tree path still exists after removal')
  await syncDirectory(parentAnchor.path, [parentAnchor], storage, code)
  return true
}
