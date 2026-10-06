import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import type { ArtifactKind } from '../types.js'
import { SodiumSha256 } from './hash.js'
import { MAX_USTAR_FILE_BYTES } from './ustar.js'

export const TREE_DIGEST_DOMAIN = 'swarm-deploy/tree/v1'
export const MAX_TREE_DEPTH = 32
export const MAX_TREE_ENTRIES = 10_000
export const MAX_TREE_NAME_BYTES = 100

export interface TreeEntry {
  kind: ArtifactKind
  /** Relative POSIX path inside the artifact, with no leading or trailing `/`. */
  path: string
  /** Regular-file byte length; always `0` for a directory. */
  size: number
}

export interface TreeIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs: number
}

export interface TreeSnapshotEntry extends TreeEntry {
  absolutePath: string
  identity: TreeIdentity
}

export interface TreeSnapshot {
  rootPath: string
  root: TreeIdentity
  entries: TreeSnapshotEntry[]
  entryCount: number
  payloadBytes: number
}

export interface TreeDigestEntry {
  entry: TreeEntry
  /** Required for a file entry and forbidden for a directory entry. */
  sha256?: Uint8Array
}

export interface TreeSnapshotOptions {
  signal?: AbortSignalLike | null
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function unsafeName(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.INVALID_FILENAME, message)
}

function fileBusy(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.FILE_BUSY, message)
}

function isTreeFileDigest(value: unknown): value is Buffer {
  if (!b4a.isBuffer(value) || value.byteLength !== 32) return false
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true
  return value.constructor.name === 'Buffer'
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/** The exact TAR name field for an entry: directories carry a trailing `/`. */
export function tarEntryName(entry: Pick<TreeEntry, 'kind' | 'path'>): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path
}

export function assertTreeEntryPath(value: unknown, kind: ArtifactKind): string {
  if (typeof value !== 'string' || value.length === 0) throw unsafeName('Invalid tree entry path')
  if (value.includes('\\') || value.includes('\u0000')) throw unsafeName('Invalid tree entry path')
  const components = value.split('/')
  if (components.length > MAX_TREE_DEPTH) throw unsafeName('Tree entry path is too deep')
  for (const component of components) {
    if (component.length === 0) throw unsafeName('Invalid tree entry path')
    validateBasename(component)
    if (isReservedHistoryName(component)) throw unsafeName('Reserved tree entry path')
  }
  const stored = b4a.from(tarEntryName({ kind, path: value }))
  if (stored.byteLength > MAX_TREE_NAME_BYTES) throw unsafeName('Tree entry path is too long')
  return value
}

/** Bytewise order. A parent is a proper prefix, so it always sorts first. */
export function compareTreePaths(left: string, right: string): number {
  return b4a.compare(b4a.from(left), b4a.from(right))
}

export function assertCanonicalTreeEntries(entries: readonly TreeEntry[]): void {
  if (!Array.isArray(entries)) throw invalid('Invalid tree entry list')
  if (entries.length > MAX_TREE_ENTRIES) throw invalid('Tree has too many entries')
  const directories = new Set<string>()
  const folded = new Set<string>()
  let previous: string | null = null
  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      throw invalid('Invalid tree entry kind')
    }
    if (entry.kind === 'directory' && entry.size !== 0) throw invalid('Invalid tree directory size')
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw invalid('Invalid tree entry size')
    }
    if (entry.kind === 'file' && entry.size > MAX_USTAR_FILE_BYTES) {
      throw invalid('Tree file exceeds canonical USTAR capacity')
    }
    assertTreeEntryPath(entry.path, entry.kind)
    if (previous !== null && compareTreePaths(previous, entry.path) >= 0) {
      throw invalid('Noncanonical tree entry order')
    }
    const fold = entry.path.toLowerCase()
    if (folded.has(fold)) throw invalid('Case-folded duplicate tree entry path')
    folded.add(fold)
    const separator = entry.path.lastIndexOf('/')
    if (separator !== -1 && !directories.has(entry.path.slice(0, separator))) {
      throw invalid('Tree entry has no parent directory entry')
    }
    if (entry.kind === 'directory') directories.add(entry.path)
    previous = entry.path
  }
}

/** Length-prefixed, labelled field framing shared by tree digests and tree transfer IDs. */
export function hashField(
  hash: SodiumSha256,
  label: string,
  value: Uint8Array | string | number
): void {
  const valueBytes = typeof value === 'number' ? b4a.from(String(value)) : b4a.from(value)
  hash
    .update(b4a.from(`${label}\u0000`))
    .update(b4a.from(`${valueBytes.byteLength}:`))
    .update(valueBytes)
}

export function treeDigest(entries: readonly TreeDigestEntry[]): Buffer {
  assertCanonicalTreeEntries(entries.map((value) => value.entry))
  const hash = new SodiumSha256()
  hashField(hash, 'domain', TREE_DIGEST_DOMAIN)
  hashField(hash, 'entryCount', entries.length)
  for (const { entry, sha256 } of entries) {
    hashField(hash, 'kind', entry.kind)
    hashField(hash, 'path', entry.path)
    hashField(hash, 'size', entry.size)
    if (entry.kind === 'directory') {
      if (sha256 !== undefined) throw invalid('Unexpected tree directory digest')
      continue
    }
    if (!isTreeFileDigest(sha256)) throw invalid('Invalid tree file digest')
    hashField(hash, 'sha256', sha256)
  }
  return hash.digest()
}

function identityOf(stat: fs.Stats): TreeIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function classify(stat: fs.Stats): ArtifactKind {
  if (stat.isSymbolicLink()) throw unsafeName('Tree entries cannot be symbolic links')
  if (stat.isDirectory()) return 'directory'
  if (!stat.isFile()) throw unsafeName('Tree entries must be regular files or directories')
  if (typeof stat.nlink === 'number' && stat.nlink > 1) {
    throw unsafeName('Tree entries cannot be hard links')
  }
  return 'file'
}

/**
 * Walks `rootPath` recursively and returns the canonical entry list with one
 * snapshotted identity per entry. Any unsafe or non-regular member rejects the
 * whole directory; nothing is ever silently dropped.
 */
export async function snapshotTree(
  rootPath: string,
  { signal = null }: TreeSnapshotOptions = {}
): Promise<TreeSnapshot> {
  throwIfAborted(signal)
  const rootStat = await fs.promises.lstat(rootPath)
  if (classify(rootStat) !== 'directory') throw unsafeName('Tree root must be a directory')
  const seen = new Set<string>([`${rootStat.dev}:${rootStat.ino}`])
  const entries: TreeSnapshotEntry[] = []
  let payloadBytes = 0

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = await fs.promises.readdir(absolute)
    names.sort((left, right) => compareTreePaths(left, right))
    for (const name of names) {
      throwIfAborted(signal)
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const entryAbsolute = path.join(absolute, name)
      const stat = await fs.promises.lstat(entryAbsolute)
      const kind = classify(stat)
      assertTreeEntryPath(entryPath, kind)
      if (entries.length >= MAX_TREE_ENTRIES) throw invalid('Tree has too many entries')
      if (kind === 'directory') {
        const identity = `${stat.dev}:${stat.ino}`
        if (seen.has(identity)) throw unsafeName('Tree contains a filesystem cycle')
        seen.add(identity)
        entries.push({
          kind,
          path: entryPath,
          size: 0,
          absolutePath: entryAbsolute,
          identity: identityOf(stat)
        })
        await walk(entryAbsolute, entryPath)
        continue
      }
      if (stat.size > MAX_USTAR_FILE_BYTES) {
        throw invalid('Tree file exceeds canonical USTAR capacity')
      }
      if (payloadBytes > Number.MAX_SAFE_INTEGER - stat.size) {
        throw invalid('Tree payload exceeds safe integer range')
      }
      payloadBytes += stat.size
      entries.push({
        kind,
        path: entryPath,
        size: stat.size,
        absolutePath: entryAbsolute,
        identity: identityOf(stat)
      })
    }
  }

  await walk(rootPath, '')
  entries.sort((left, right) => compareTreePaths(left.path, right.path))
  assertCanonicalTreeEntries(entries)
  return {
    rootPath,
    root: identityOf(rootStat),
    entries,
    entryCount: entries.length,
    payloadBytes
  }
}

export function assertSameTreeIdentity(
  expected: TreeIdentity,
  actual: fs.Stats,
  message: string
): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, message)
  }
}

/** Reproves every snapshotted identity before a resume regenerates the archive. */
function classifyForRevalidate(stat: fs.Stats): ArtifactKind {
  try {
    return classify(stat)
  } catch (error) {
    if (error instanceof SwarmDeployError && error.code === ERRORS.INVALID_FILENAME) {
      throw fileBusy('Tree entry changed during TAR generation')
    }
    throw error
  }
}

export async function revalidateTreeSnapshot(
  snapshot: TreeSnapshot,
  { signal = null }: TreeSnapshotOptions = {}
): Promise<void> {
  throwIfAborted(signal)
  let rootStat: fs.Stats
  try {
    rootStat = await fs.promises.lstat(snapshot.rootPath)
  } catch (error) {
    if (isEnoent(error)) throw fileBusy('Tree root changed during TAR generation')
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw fileBusy('Tree root changed during TAR generation')
  }
  if (rootStat.dev !== snapshot.root.dev || rootStat.ino !== snapshot.root.ino) {
    throw fileBusy('Tree root changed during TAR generation')
  }
  for (const entry of snapshot.entries) {
    throwIfAborted(signal)
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(entry.absolutePath)
    } catch (error) {
      if (isEnoent(error)) throw fileBusy('Tree entry changed during TAR generation')
      throw error
    }
    const kind = classifyForRevalidate(stat)
    if (kind !== entry.kind) {
      throw fileBusy('Tree entry kind changed during TAR generation')
    }
    if (entry.kind === 'directory') {
      if (stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino) {
        throw fileBusy('Tree directory changed during TAR generation')
      }
      continue
    }
    assertSameTreeIdentity(entry.identity, stat, 'Tree entry changed during TAR generation')
  }
  const refreshed = await snapshotTree(snapshot.rootPath, { signal })
  if (refreshed.entryCount !== snapshot.entryCount) {
    throw fileBusy('Tree listing changed during TAR generation')
  }
  for (let index = 0; index < refreshed.entries.length; index++) {
    if (
      refreshed.entries[index].path !== snapshot.entries[index].path ||
      refreshed.entries[index].kind !== snapshot.entries[index].kind
    ) {
      throw fileBusy('Tree listing changed during TAR generation')
    }
  }
}
