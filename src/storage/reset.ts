import b4a from 'b4a'
import { errorCode, isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import process from '#process'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { SodiumSha256 } from '../tar-protocol/hash.js'
import { MAX_SESSION_METADATA_BYTES, readJson, writeAtomic } from './atomic-file.js'
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
/** Verbatim copy of a version 1 marker, kept when a retry upgrades it to the bounded format. */
export const ARCHIVE_LEGACY_MARKER_NAME = 'reset.v1.json'
const ARCHIVE_LOCKS_NAME = 'locks'
/** The pending pointer is fixed-size: a kind, a version, and one archive name. */
const MAX_PENDING_BYTES = 16 * 1024
/**
 * Read bound for archive markers. Version 1 markers listed every lock residue
 * entry and so grew without limit; the shared metadata bound keeps those
 * readable while still capping allocation.
 */
const MAX_ARCHIVE_MARKER_BYTES = MAX_SESSION_METADATA_BYTES
/**
 * Write bound for archive markers. The capped fields below keep the worst case
 * (a 4 KiB root and sixteen fully escaped failures) far inside this, so
 * reaching it is a programming error, never an operating condition.
 */
const MAX_MARKER_WRITE_BYTES = 64 * 1024
const MARKER_VERSION = 2
/** Newest attempts kept in a marker; the first is the top-level `startedAt`/`pid`. */
const MAX_ATTEMPTS_KEPT = 16
const MAX_FAILURE_CHARS = 256
/** Lock residue moves between marker writes; the archive itself is the exact record. */
const LOCK_PROGRESS_BATCH = 32
const MAX_LINK_RECORD_BYTES = 4 * 1024
const DEFAULT_POLL_INTERVAL = 250
const METADATA_RECORD = /^[0-9a-f]{64}\.json$/
const ARCHIVE_NAME = /^reset-[0-9TZ]+-[0-9a-f]+$/
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

/** What an archive physically holds. Lock residue is counted; its names stay in `locks/`. */
export interface ArchiveHoldings {
  directories: string[]
  lockEntries: number
}

export interface ArchiveSummary {
  name: string
  path: string
  /** What the marker claims; an `in-progress` marker can lag the archive after a hard stop. */
  status: 'completed' | 'in-progress' | 'unknown'
  /** What the archive physically holds, read from the filesystem rather than the marker. */
  held: ArchiveHoldings
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
  /** The archive an interrupted reset left pending, which the next apply resumes. */
  pendingArchive: string | null
  /** The archive this run created or resumed, when applied. */
  archive: string | null
  /** What a resumed archive already held before this run; null when a new archive was made. */
  resumed: ArchiveHoldings | null
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
      MAX_ARCHIVE_MARKER_BYTES
    )
    if (marker.status === 'completed') return 'completed'
    if (marker.status === 'in-progress') return 'in-progress'
  } catch {}
  return 'unknown'
}

interface Holdings {
  directories: string[]
  /** Sorted names of the lock residue directories inside `locks/`. */
  locks: string[]
}

const NO_HOLDINGS: Holdings = { directories: [], locks: [] }

function summarize(held: Holdings): ArchiveHoldings {
  return { directories: held.directories, lockEntries: held.locks.length }
}

/**
 * What an archive physically holds: the metadata directories and lock residue
 * moved into it. This is the truth about a reset's progress; a marker is only
 * a record of it that a hard stop can leave behind.
 */
async function archiveContents(archive: string, storage: StorageAdapter): Promise<Holdings> {
  const names = new Set(await storage.readdir(archive))
  const held: Holdings = {
    directories: METADATA_DIRECTORIES.filter((name) => names.has(name)),
    locks: []
  }
  if (names.has(ARCHIVE_LOCKS_NAME)) {
    const locks = path.join(archive, ARCHIVE_LOCKS_NAME)
    if (await safeDirectoryOrMissing(locks, storage)) {
      held.locks = (await storage.readdir(locks)).sort()
    }
  }
  return held
}

/**
 * SHA-256 over each sorted lock residue name followed by a newline, so an
 * operator can verify it with `ls locks | LC_ALL=C sort | sha256sum`.
 */
function lockDigest(names: string[]): string {
  const hash = new SodiumSha256()
  for (const name of names) hash.update(b4a.from(`${name}\n`))
  return b4a.toString(hash.digest(), 'hex')
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
    archives.push({
      name,
      path: full,
      status: await archiveStatus(full, storage),
      held: summarize(await archiveContents(full, storage).catch(() => NO_HOLDINGS))
    })
  }
  return archives
}

/**
 * Reads the pending-reset marker. `archive` is null when the marker exists but
 * is not one this version wrote, which every caller must treat as unsafe.
 */
async function readPendingReset(
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<{ present: boolean; archive: string | null }> {
  const file = path.join(layout.internal, RESET_PENDING_NAME)
  if ((await lstatOrNull(file, storage)) === null) return { present: false, archive: null }
  try {
    const marker = await readJson(file, storage, MAX_PENDING_BYTES)
    if (
      marker.kind === 'storage-reset' &&
      marker.version === 1 &&
      typeof marker.archive === 'string' &&
      ARCHIVE_NAME.test(marker.archive)
    ) {
      return { present: true, archive: marker.archive }
    }
  } catch {}
  return { present: true, archive: null }
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
  const pending = await readPendingReset(layout, storage)
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
    resetPending: pending.present,
    pendingArchive: pending.archive,
    freshStart:
      remaining.payloads.length + remaining.symlinks.length + remaining.other.length === 0,
    archive: null,
    resumed: null
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

interface Attempt {
  startedAt: number
  pid: number
  failed?: string
}

/**
 * Everything a retry needs from an archive marker. The marker is bounded by
 * construction: the full per-entry evidence lives in the archive itself, and
 * the marker keeps only the first attempt, the newest few, and a total count.
 */
interface MarkerState {
  root: string
  startedAt: number
  pid: number
  attempts: Attempt[]
  attemptCount: number
}

function isSafeCount(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function clip(reason: string): string {
  return reason.length > MAX_FAILURE_CHARS ? `${reason.slice(0, MAX_FAILURE_CHARS - 3)}...` : reason
}

function parseAttempt(value: unknown): Attempt | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { startedAt, pid, failed } = value as Record<string, unknown>
  if (!isSafeCount(startedAt, 0) || !isSafeCount(pid, 1)) return null
  if (failed === undefined) return { startedAt, pid }
  return typeof failed === 'string' ? { startedAt, pid, failed: clip(failed) } : null
}

/**
 * Reads a marker this tool wrote, in the bounded version 2 shape or the
 * version 1 shape (whose `moved` list held every lock residue entry and whose
 * latest failure sat beside `attempts`). Returns null for anything else, which
 * every caller treats as unsafe. Nothing is carried over except these fields.
 */
function parseMarker(raw: Record<string, unknown>): MarkerState | null {
  if (raw.version !== 1 && raw.version !== MARKER_VERSION) return null
  if (raw.status !== 'in-progress' && raw.status !== 'completed') return null
  const { root, startedAt, pid } = raw
  if (typeof root !== 'string' || !isSafeCount(startedAt, 0) || !isSafeCount(pid, 1)) return null
  let attempts: Attempt[]
  if (raw.attempts === undefined) {
    attempts = [{ startedAt, pid }]
  } else {
    if (!Array.isArray(raw.attempts) || raw.attempts.length === 0) return null
    attempts = []
    for (const entry of raw.attempts) {
      const attempt = parseAttempt(entry)
      if (attempt === null) return null
      attempts.push(attempt)
    }
  }
  const last = attempts.length - 1
  if (typeof raw.failed === 'string' && attempts[last].failed === undefined) {
    attempts[last] = { ...attempts[last], failed: clip(raw.failed) }
  }
  const attemptCount = raw.attemptCount === undefined ? attempts.length : raw.attemptCount
  if (!isSafeCount(attemptCount, attempts.length)) return null
  return { root, startedAt, pid, attempts: attempts.slice(-MAX_ATTEMPTS_KEPT), attemptCount }
}

function nextAttempt(state: MarkerState, attempt: Attempt): MarkerState {
  return {
    ...state,
    attempts: [...state.attempts, attempt].slice(-MAX_ATTEMPTS_KEPT),
    attemptCount: state.attemptCount + 1
  }
}

function failLatest(state: MarkerState, reason: string): MarkerState {
  const last = state.attempts.length - 1
  return {
    ...state,
    attempts: state.attempts.map((attempt, index) =>
      index === last ? { ...attempt, failed: clip(reason) } : attempt
    )
  }
}

/**
 * Writes the bounded marker. `moved` names only the metadata directories, at
 * most seven; lock residue is summarized by a count and a digest of its names,
 * which stay physically in the archive's `locks/` directory.
 */
async function writeMarker(
  archive: string,
  state: MarkerState,
  status: 'in-progress' | 'completed',
  held: Holdings,
  storage: StorageAdapter,
  completedAt?: number
): Promise<void> {
  const bytes = b4a.from(
    JSON.stringify({
      version: MARKER_VERSION,
      status,
      root: state.root,
      startedAt: state.startedAt,
      pid: state.pid,
      attemptCount: state.attemptCount,
      attempts: state.attempts,
      moved: held.directories,
      locks: { count: held.locks.length, sha256: lockDigest(held.locks) },
      ...(completedAt === undefined ? {} : { completedAt })
    })
  )
  if (bytes.byteLength > MAX_MARKER_WRITE_BYTES) {
    throw storageError('Reset marker exceeds its size bound')
  }
  await writeAtomic(path.join(archive, ARCHIVE_MARKER_NAME), bytes, storage)
}

/**
 * Opens the archive a pending reset names so the retry continues it. The archive
 * must be a plain directory with a marker this tool wrote; anything else means
 * an operator changed it and the retry fails closed rather than starting a
 * second archive that would hide where the first one's data went.
 */
async function openPendingArchive(
  archive: string,
  storage: StorageAdapter
): Promise<{ raw: Record<string, unknown>; state: MarkerState }> {
  const name = path.basename(archive)
  let raw: Record<string, unknown>
  try {
    await assertSafeDirectory(archive, storage)
    raw = await readJson(path.join(archive, ARCHIVE_MARKER_NAME), storage, MAX_ARCHIVE_MARKER_BYTES)
  } catch (error: unknown) {
    throw storageError(
      `Pending reset archive ${name} is missing or unreadable; restore it or reconcile ` +
        `${RESET_PENDING_NAME} by hand before resetting`,
      error
    )
  }
  const state = parseMarker(raw)
  if (state === null) {
    throw storageError(
      `Pending reset archive ${name} has an unrecognized marker; reconcile it before resetting`
    )
  }
  return { raw, state }
}

/** Keeps a version 1 marker's full entry list before the bounded format replaces it. */
async function preserveLegacyMarker(
  archive: string,
  raw: Record<string, unknown>,
  storage: StorageAdapter
): Promise<void> {
  if (raw.version !== 1) return
  const file = path.join(archive, ARCHIVE_LEGACY_MARKER_NAME)
  if ((await lstatOrNull(file, storage)) !== null) return
  await writeAtomic(file, b4a.from(JSON.stringify(raw)), storage)
}

/**
 * Archives the metadata, or resumes the archive an interrupted reset left
 * pending. Every move is a rename, so after a hard stop each directory is
 * either still live or already inside the archive; progress is therefore
 * reconciled from what the archive holds, never trusted from the marker.
 */
async function archiveMetadata(
  settings: Settings
): Promise<{ archive: string; resumed: ArchiveHoldings | null }> {
  const { layout, storage, clock, pid } = settings
  const archives = path.join(layout.internal, ARCHIVE_DIRECTORY_NAME)
  if (!(await safeDirectoryOrMissing(archives, storage))) {
    await storage.mkdir(archives, { mode: 0o700 })
  }
  const pendingFile = path.join(layout.internal, RESET_PENDING_NAME)
  const pending = await readPendingReset(layout, storage)
  if (pending.present && pending.archive === null) {
    throw storageError('Unrecognized pending reset marker; reconcile it before resetting')
  }
  const startedAt = clock.now()
  const attempt: Attempt = { startedAt, pid }
  let archive: string
  let state: MarkerState
  let held: Holdings = NO_HOLDINGS
  let resumed: ArchiveHoldings | null = null
  if (pending.archive !== null) {
    archive = path.join(archives, pending.archive)
    const prior = await openPendingArchive(archive, storage)
    held = await archiveContents(archive, storage)
    resumed = summarize(held)
    // Refuse before moving anything if the archive and the live directory both hold data.
    for (const name of METADATA_DIRECTORIES) {
      if (!held.directories.includes(name)) continue
      await assertSafeDirectory(path.join(archive, name), storage)
      if (
        (await safeDirectoryOrMissing(layout[name], storage)) &&
        (await storage.readdir(layout[name])).length > 0
      ) {
        throw storageError(
          `Reset archive ${pending.archive} already holds ${name} but the live ${name} ` +
            'directory is not empty; reconcile the two by hand before resetting'
        )
      }
    }
    await preserveLegacyMarker(archive, prior.raw, storage)
    state = nextAttempt(prior.state, attempt)
    await writeMarker(archive, state, 'in-progress', held, storage)
  } else {
    archive = path.join(archives, archiveName(startedAt))
    await storage.mkdir(archive, { mode: 0o700 })
    state = { root: layout.root, startedAt, pid, attempts: [attempt], attemptCount: 1 }
    await writeMarker(archive, state, 'in-progress', held, storage)
    await syncDirectory(archives, storage)
    await writeAtomic(
      pendingFile,
      b4a.from(
        JSON.stringify({ kind: 'storage-reset', version: 1, archive: path.basename(archive) })
      ),
      storage
    )
    await syncDirectory(layout.internal, storage)
  }
  const recordProgress = async (): Promise<void> => {
    held = await archiveContents(archive, storage)
    await writeMarker(archive, state, 'in-progress', held, storage)
  }
  try {
    for (const name of METADATA_DIRECTORIES) {
      const source = layout[name]
      let live = await safeDirectoryOrMissing(source, storage)
      if (live && !held.directories.includes(name)) {
        await storage.rename(source, path.join(archive, name))
        live = false
        await recordProgress()
      }
      if (!live) await storage.mkdir(source, { mode: 0o700 })
      await syncDirectory(layout.internal, storage)
    }
    const locks = path.join(archive, ARCHIVE_LOCKS_NAME)
    let sinceRecord = 0
    for (const name of (await storage.readdir(layout.internal)).sort()) {
      if (!OBSOLETE_LOCK.test(name)) continue
      if (!(await safeDirectoryOrMissing(locks, storage))) {
        await storage.mkdir(locks, { mode: 0o700 })
      }
      await storage.rename(path.join(layout.internal, name), path.join(locks, name))
      // Residue is recorded in batches: the archive holds the exact list, so a
      // marker that lags by one batch after a hard stop is reconciled, not trusted.
      if (++sinceRecord % LOCK_PROGRESS_BATCH === 0) await recordProgress()
    }
    await syncDirectory(layout.internal, storage)
    held = await archiveContents(archive, storage)
    await writeMarker(archive, state, 'completed', held, storage, clock.now())
    await syncDirectory(archive, storage)
    await storage.unlink(pendingFile)
    await syncDirectory(layout.internal, storage)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    const moved = await archiveContents(archive, storage).catch(() => held)
    await writeMarker(archive, failLatest(state, reason), 'in-progress', moved, storage).catch(
      () => {}
    )
    throw error
  }
  return { archive, resumed }
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
  let result: { archive: string; resumed: ArchiveHoldings | null }
  let before: StorageResetReport
  try {
    before = await inspect(settings)
    result = await archiveMetadata(settings)
  } finally {
    await releaseExclusive(settings, release)
  }
  return {
    ...before,
    lock: preview.lock,
    resetPending: false,
    pendingArchive: null,
    applied: true,
    archives: await listArchives(layout, storage),
    archive: result.archive,
    resumed: result.resumed
  }
}
