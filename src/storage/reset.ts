import b4a from 'b4a'
import { errorCode, isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import process from '#process'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { readJson, writeAtomic } from './atomic-file.js'
import { assertCommitRecord, MAX_COMMIT_METADATA_BYTES } from './commit-journal.js'
import {
  INTERNAL_DIRECTORY_NAME,
  RESET_PENDING_NAME,
  acquireStorageLock,
  assertSafeDirectory,
  inspectStorageLock,
  isProcessAlive as defaultIsProcessAlive,
  resolveLayout
} from './layout.js'
import type { StorageAdapter, StorageLayout, StorageStats } from './types.js'

/** Every private metadata directory a reset archives, in archive order. */
export const METADATA_DIRECTORIES = [
  'staging',
  'sessions',
  'commits',
  'journals',
  'publications',
  'links',
  'trash'
] as const

export type MetadataDirectoryName = (typeof METADATA_DIRECTORIES)[number]

export const ARCHIVE_DIRECTORY_NAME = 'archive'
export const ARCHIVE_MARKER_NAME = 'reset.json'
const ARCHIVE_LOCKS_NAME = 'locks'
const MAX_MARKER_BYTES = 16 * 1024
const MAX_LINK_RECORD_BYTES = 4 * 1024
const DEFAULT_POLL_INTERVAL = 250
const METADATA_RECORD = /^[0-9a-f]{64}\.json$/
/** Lock residue no running server can own: retired tombstones and abandoned candidates. */
const OBSOLETE_LOCK = /^lock\.(?:retired|candidate)-[0-9a-f]+$/

export interface StorageResetOptions {
  storageDir: string
  /** Archive the metadata. Without it the reset is a read-only preview. */
  apply?: boolean
  /** Milliseconds to keep polling a live lock before failing closed. */
  wait?: number
  storage?: StorageAdapter
  isProcessAlive?: (pid: number) => boolean
  clock?: { now(): number }
  pid?: number
  pollInterval?: number
  sleep?: (ms: number) => Promise<void>
}

export type ResetLockState =
  | { status: 'free' }
  | { status: 'held'; pid: number; ageMs: number }
  | { status: 'stale'; pid: number; ageMs: number }
  | { status: 'malformed' }
  | { status: 'unsafe' }

export interface ArchiveSummary {
  name: string
  path: string
  status: 'completed' | 'in-progress' | 'unknown'
}

export interface StorageResetReport {
  root: string
  applied: boolean
  lock: ResetLockState
  /** Entry counts per private metadata directory before the reset. */
  metadata: Record<MetadataDirectoryName, number>
  commits: { records: number; missingPayloads: string[]; invalid: number }
  links: { records: number; invalid: number }
  obsoleteLocks: number
  /** Entries in the internal directory the reset does not recognise and leaves alone. */
  unknownInternal: string[]
  archives: ArchiveSummary[]
  /** Visible root entries the reset never touches; they stay after the reset. */
  remaining: { payloads: string[]; symlinks: string[]; other: string[] }
  /** True only when nothing visible remains, so the next server really starts empty. */
  freshStart: boolean
  resetPending: boolean
  /** The archive this run created, when applied. */
  archive: string | null
}

interface Settings {
  layout: StorageLayout
  storage: StorageAdapter
  isProcessAlive: (pid: number) => boolean
  clock: { now(): number }
  pid: number
  wait: number
  pollInterval: number
  sleep: (ms: number) => Promise<void>
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function busyError(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.FILE_BUSY, message)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomSuffix(bytes = 4): string {
  const buffer = b4a.allocUnsafe(bytes)
  sodium.randombytes_buf(buffer)
  return b4a.toString(buffer, 'hex')
}

function settle({
  storageDir,
  wait = 0,
  storage = fs.promises,
  isProcessAlive = defaultIsProcessAlive,
  clock = Date,
  pid = process.pid,
  pollInterval = DEFAULT_POLL_INTERVAL,
  sleep = defaultSleep
}: StorageResetOptions): Settings {
  const layout = resolveLayout(storageDir)
  if (!Number.isSafeInteger(wait) || wait < 0) throw storageError('Invalid reset wait')
  if (!Number.isSafeInteger(pid) || pid <= 0) throw storageError('Invalid reset PID')
  if (!Number.isSafeInteger(pollInterval) || pollInterval <= 0) {
    throw storageError('Invalid reset poll interval')
  }
  return { layout, storage, isProcessAlive, clock, pid, wait, pollInterval, sleep }
}

/** The root must be a real directory that is neither a filesystem root nor the internal directory. */
function assertSafeRootPath(root: string): void {
  if (path.dirname(root) === root) {
    throw storageError(`Refusing to reset a filesystem root: ${root}`)
  }
  if (path.basename(root) === INTERNAL_DIRECTORY_NAME) {
    throw storageError(`Refusing to reset an internal directory as a storage root: ${root}`)
  }
}

async function safeDirectoryOrMissing(
  directory: string,
  storage: StorageAdapter
): Promise<boolean> {
  try {
    await assertSafeDirectory(directory, storage)
    return true
  } catch (error: unknown) {
    if (isMissing(error)) return false
    throw error
  }
}

async function lstatOrNull(target: string, storage: StorageAdapter): Promise<StorageStats | null> {
  try {
    return await storage.lstat(target)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
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

async function validateLayout(layout: StorageLayout, storage: StorageAdapter): Promise<void> {
  assertSafeRootPath(layout.root)
  await assertSafeDirectory(layout.root, storage)
  for (
    let parent = path.dirname(layout.root);
    path.dirname(parent) !== parent;
    parent = path.dirname(parent)
  ) {
    await assertSafeDirectory(parent, storage)
  }
  try {
    await assertSafeDirectory(layout.internal, storage)
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
    throw storageError(`Not an initialized storage root: ${layout.root}`, error)
  }
  // A missing metadata directory is an interrupted reset the server recreates;
  // a symlink or file at one of these paths is unsafe and fails closed.
  for (const name of METADATA_DIRECTORIES) await safeDirectoryOrMissing(layout[name], storage)
}

async function countEntries(directory: string, storage: StorageAdapter): Promise<number> {
  if (!(await safeDirectoryOrMissing(directory, storage))) return 0
  return (await storage.readdir(directory)).length
}

async function inspectCommits(
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<StorageResetReport['commits']> {
  const result = { records: 0, missingPayloads: [] as string[], invalid: 0 }
  if (!(await safeDirectoryOrMissing(layout.commits, storage))) return result
  for (const name of (await storage.readdir(layout.commits)).sort()) {
    if (!METADATA_RECORD.test(name)) continue
    let recordName: string
    try {
      const record = assertCommitRecord(
        await readJson(path.join(layout.commits, name), storage, MAX_COMMIT_METADATA_BYTES)
      )
      if (`${record.transferId}.json` !== name) throw storageError('Foreign commit record')
      recordName = record.name
    } catch {
      result.invalid++
      continue
    }
    result.records++
    if ((await lstatOrNull(path.join(layout.root, recordName), storage)) === null) {
      result.missingPayloads.push(recordName)
    }
  }
  return result
}

async function inspectLinks(
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<StorageResetReport['links']> {
  const result = { records: 0, invalid: 0 }
  if (!(await safeDirectoryOrMissing(layout.links, storage))) return result
  for (const name of (await storage.readdir(layout.links)).sort()) {
    if (!METADATA_RECORD.test(name)) continue
    try {
      await readJson(path.join(layout.links, name), storage, MAX_LINK_RECORD_BYTES)
      result.records++
    } catch {
      result.invalid++
    }
  }
  return result
}

async function inspectRoot(
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<StorageResetReport['remaining']> {
  const remaining = { payloads: [] as string[], symlinks: [] as string[], other: [] as string[] }
  for (const name of (await storage.readdir(layout.root)).sort()) {
    if (name === INTERNAL_DIRECTORY_NAME) continue
    const stat = await lstatOrNull(path.join(layout.root, name), storage)
    if (stat === null) continue
    if (stat.isSymbolicLink()) remaining.symlinks.push(name)
    else if (stat.isFile() || stat.isDirectory()) remaining.payloads.push(name)
    else remaining.other.push(name)
  }
  return remaining
}

async function archiveStatus(
  archive: string,
  storage: StorageAdapter
): Promise<ArchiveSummary['status']> {
  try {
    const marker = await readJson(
      path.join(archive, ARCHIVE_MARKER_NAME),
      storage,
      MAX_MARKER_BYTES
    )
    if (marker.status === 'completed') return 'completed'
    if (marker.status === 'in-progress') return 'in-progress'
  } catch {}
  return 'unknown'
}

async function listArchives(
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<ArchiveSummary[]> {
  const directory = path.join(layout.internal, ARCHIVE_DIRECTORY_NAME)
  if (!(await safeDirectoryOrMissing(directory, storage))) return []
  const archives: ArchiveSummary[] = []
  for (const name of (await storage.readdir(directory)).sort()) {
    const full = path.join(directory, name)
    const stat = await lstatOrNull(full, storage)
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue
    archives.push({ name, path: full, status: await archiveStatus(full, storage) })
  }
  return archives
}

async function lockState(settings: Settings): Promise<ResetLockState> {
  const { layout, storage, isProcessAlive, clock } = settings
  const state = await inspectStorageLock(layout, storage)
  if (state.status !== 'held') return state
  const ageMs = Math.max(0, clock.now() - state.startedAt)
  const alive = isProcessAlive(state.pid)
  return { status: alive ? 'held' : 'stale', pid: state.pid, ageMs }
}

async function inspect(settings: Settings): Promise<StorageResetReport> {
  const { layout, storage } = settings
  await validateLayout(layout, storage)
  const metadata = {} as Record<MetadataDirectoryName, number>
  for (const name of METADATA_DIRECTORIES) {
    metadata[name] = await countEntries(layout[name], storage)
  }
  let obsoleteLocks = 0
  const unknownInternal: string[] = []
  for (const name of (await storage.readdir(layout.internal)).sort()) {
    if ((METADATA_DIRECTORIES as readonly string[]).includes(name)) continue
    if (
      name === path.basename(layout.lock) ||
      name === ARCHIVE_DIRECTORY_NAME ||
      name === RESET_PENDING_NAME
    ) {
      continue
    }
    if (OBSOLETE_LOCK.test(name)) obsoleteLocks++
    else unknownInternal.push(name)
  }
  const remaining = await inspectRoot(layout, storage)
  return {
    root: layout.root,
    applied: false,
    lock: await lockState(settings),
    metadata,
    commits: await inspectCommits(layout, storage),
    links: await inspectLinks(layout, storage),
    obsoleteLocks,
    unknownInternal,
    archives: await listArchives(layout, storage),
    remaining,
    resetPending:
      (await lstatOrNull(path.join(layout.internal, RESET_PENDING_NAME), storage)) !== null,
    freshStart:
      remaining.payloads.length + remaining.symlinks.length + remaining.other.length === 0,
    archive: null
  }
}

function lockAge(ageMs: number): string {
  return `${Math.round(ageMs / 1000)}s`
}

/**
 * Blocks until no live server holds the lock, then takes it. A live holder is
 * never signalled: this version cannot prove which process owns the root, so
 * stopping it is the operator's job and the reset only waits for the release.
 */
async function acquireExclusive(settings: Settings): Promise<() => Promise<void>> {
  const { layout, storage, clock, pid, wait, isProcessAlive, pollInterval, sleep } = settings
  const deadline = clock.now() + wait
  for (;;) {
    const state = await lockState(settings)
    if (state.status === 'unsafe') throw storageError(`Unsafe storage lock path: ${layout.lock}`)
    if (state.status === 'held') {
      if (clock.now() >= deadline) {
        throw busyError(
          `Storage is locked by pid ${state.pid} (lock age ${lockAge(state.ageMs)}); ` +
            'stop that server and retry, or wait for it with --wait'
        )
      }
      await sleep(pollInterval)
      continue
    }
    if (state.status === 'malformed') {
      throw busyError(
        'Storage lock is unreadable; stop the server and reconcile its lock before resetting'
      )
    }
    for (const name of METADATA_DIRECTORIES) {
      if (!(await safeDirectoryOrMissing(layout[name], storage))) {
        await storage.mkdir(layout[name], { mode: 0o700 })
      }
    }
    try {
      return await acquireStorageLock(layout, {
        pid,
        storage,
        isProcessAlive
      })
    } catch (error: unknown) {
      if (errorCode(error) !== ERRORS.FILE_BUSY) throw error
      if (clock.now() >= deadline) throw busyError('Storage became locked while resetting')
      await sleep(pollInterval)
    }
  }
}

async function releaseExclusive(settings: Settings, release: () => Promise<void>): Promise<void> {
  const { layout, storage, pid } = settings
  const own = await inspectStorageLock(layout, storage).catch(() => null)
  await release()
  // Our own retired tombstone is not operator metadata; drop it so the next
  // preview does not report lock residue this command created.
  if (own?.status === 'held' && own.pid === pid) {
    await storage.rm(`${layout.lock}.retired-${own.token}`, { recursive: true, force: true })
  }
}

function archiveName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '')
  return `reset-${stamp}-${randomSuffix()}`
}

async function writeMarker(
  archive: string,
  marker: Record<string, unknown>,
  storage: StorageAdapter
): Promise<void> {
  await writeAtomic(
    path.join(archive, ARCHIVE_MARKER_NAME),
    b4a.from(JSON.stringify(marker)),
    storage
  )
}

async function archiveMetadata(settings: Settings): Promise<string> {
  const { layout, storage, clock, pid } = settings
  const archives = path.join(layout.internal, ARCHIVE_DIRECTORY_NAME)
  if (!(await safeDirectoryOrMissing(archives, storage))) {
    await storage.mkdir(archives, { mode: 0o700 })
  }
  const pending = path.join(layout.internal, RESET_PENDING_NAME)
  if ((await lstatOrNull(pending, storage)) !== null) {
    const prior = await readJson(pending, storage, MAX_MARKER_BYTES)
    if (
      prior.kind !== 'storage-reset' ||
      prior.version !== 1 ||
      typeof prior.archive !== 'string' ||
      !/^reset-[0-9TZ]+-[0-9a-f]+$/.test(prior.archive)
    ) {
      throw storageError('Unrecognized pending reset marker; reconcile it before resetting')
    }
  }
  const startedAt = clock.now()
  const archive = path.join(archives, archiveName(startedAt))
  await storage.mkdir(archive, { mode: 0o700 })
  const marker: Record<string, unknown> = {
    version: 1,
    status: 'in-progress',
    root: layout.root,
    startedAt,
    pid,
    moved: [] as string[]
  }
  await writeMarker(archive, marker, storage)
  await syncDirectory(archives, storage)
  await writeAtomic(
    pending,
    b4a.from(
      JSON.stringify({ kind: 'storage-reset', version: 1, archive: path.basename(archive) })
    ),
    storage
  )
  await syncDirectory(layout.internal, storage)
  const moved: string[] = []
  marker.moved = moved
  try {
    for (const name of METADATA_DIRECTORIES) {
      const source = layout[name]
      if (await safeDirectoryOrMissing(source, storage)) {
        await storage.rename(source, path.join(archive, name))
        moved.push(name)
      }
      await storage.mkdir(source, { mode: 0o700 })
      await syncDirectory(layout.internal, storage)
    }
    let locks: string | null = null
    for (const name of (await storage.readdir(layout.internal)).sort()) {
      if (!OBSOLETE_LOCK.test(name)) continue
      if (locks === null) {
        locks = path.join(archive, ARCHIVE_LOCKS_NAME)
        await storage.mkdir(locks, { mode: 0o700 })
      }
      await storage.rename(path.join(layout.internal, name), path.join(locks, name))
      moved.push(`${ARCHIVE_LOCKS_NAME}/${name}`)
    }
    await syncDirectory(layout.internal, storage)
    await writeMarker(
      archive,
      { ...marker, status: 'completed', completedAt: clock.now(), moved },
      storage
    )
    await syncDirectory(archive, storage)
    await storage.unlink(pending)
    await syncDirectory(layout.internal, storage)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    await writeMarker(archive, { ...marker, moved, failed: reason }, storage).catch(() => {})
    throw error
  }
  return archive
}

/** Read-only inspection of a storage root: never creates, moves, or locks anything. */
export function inspectStorageReset(options: StorageResetOptions): Promise<StorageResetReport> {
  try {
    return inspect(settle(options))
  } catch (error: unknown) {
    return Promise.reject(error)
  }
}

/**
 * Archives every private metadata directory of a storage root into
 * `.swarm-deploy/archive/<reset-stamp>/` and recreates them empty, under the
 * storage lock. Visible payloads and symlinks in the root are never touched,
 * and nothing is deleted: the archive is restorable by moving it back.
 */
export async function resetStorage(options: StorageResetOptions): Promise<StorageResetReport> {
  const settings = settle(options)
  const { layout, storage } = settings
  const preview = await inspect(settings)
  if (preview.lock.status === 'unsafe') {
    throw storageError(`Unsafe storage lock path: ${layout.lock}`)
  }
  const release = await acquireExclusive(settings)
  let archive: string
  let before: StorageResetReport
  try {
    before = await inspect(settings)
    archive = await archiveMetadata(settings)
  } finally {
    await releaseExclusive(settings, release)
  }
  return {
    ...before,
    lock: preview.lock,
    resetPending: false,
    applied: true,
    archives: await listArchives(layout, storage),
    archive
  }
}
