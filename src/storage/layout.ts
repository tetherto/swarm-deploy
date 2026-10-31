import b4a from 'b4a'
import { errorCode } from '../error-code.js'
import fs from '#fs'
import os from '#os'
import path from '#path'
import process from '#process'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import type {
  StorageAdapter,
  StorageFileHandle,
  StorageIdentity,
  StorageLayout,
  StorageStat
} from './types.js'

const MAX_LOCK_OWNER_BYTES = 1024
type SafeFileAccess = 'create' | 'write' | 'read'
interface LockOwner {
  pid: number
  startedAt: number
  token: string
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertDirectorySync(directory: string, create = true): void {
  let stat: StorageStat
  try {
    stat = fs.lstatSync(directory)
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error
    if (!create) throw storageError(`Missing storage directory: ${directory}`, error)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    stat = fs.lstatSync(directory)
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${directory}`)
  }
}

export async function assertSafeDirectory(
  directory: string,
  storage: StorageAdapter = fs.promises
): Promise<StorageStat> {
  let stat: StorageStat
  try {
    stat = await storage.lstat(directory)
  } catch (error: unknown) {
    throw storageError(`Missing storage directory: ${directory}`, error)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${directory}`)
  }
  return stat
}

export async function assertSafeFile(
  filePath: string,
  storage: StorageAdapter = fs.promises
): Promise<StorageStat> {
  let stat: StorageStat
  try {
    stat = await storage.lstat(filePath)
  } catch (error: unknown) {
    throw storageError(`Missing storage file: ${filePath}`, error)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw storageError(`Unsafe storage file: ${filePath}`)
  }
  return stat
}

/** Directory under the user's home that holds default private state, one entry per output root. */
export const STATE_HOME_NAME = '.swarm-deploy'
/** Where releases before 0.6.1 kept private state: inside the output root, where it can be served. */
export const LEGACY_STATE_NAME = '.swarm-deploy'
/**
 * Private record of the output root a state directory belongs to. The leading dot
 * keeps it from ever being a valid artifact name, so an output root cannot hold one.
 */
export const STATE_ROOT_NAME = '.swarm-deploy-state.json'
export const RESET_PENDING_NAME = 'reset-pending.json'
/** The private metadata directories, in the order a reset archives them. */
export const METADATA_DIRECTORY_NAMES = [
  'staging',
  'sessions',
  'commits',
  'journals',
  'publications',
  'links',
  'trash'
] as const

const MAX_STATE_ROOT_BYTES = 4 * 1024
const STATE_ENTRIES = new Set<string>([
  ...METADATA_DIRECTORY_NAMES,
  'archive',
  'lock',
  RESET_PENDING_NAME,
  STATE_ROOT_NAME
])

/** Refuse recovery against metadata only partly moved by an interrupted reset. */
export async function assertNoPendingStorageReset(
  layout: StorageLayout,
  storage: StorageAdapter = fs.promises
): Promise<void> {
  try {
    await storage.lstat(path.join(layout.internal, RESET_PENDING_NAME))
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  throw storageError(
    'Storage reset is incomplete; finish reset-storage --apply before starting the server'
  )
}

/**
 * Computes every layout path without touching the filesystem. `internal` is the
 * private state directory; it is never under `root`, which holds only published
 * artifacts and managed links.
 */
export function resolveLayout(storageDir: string, stateDir: string): StorageLayout {
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw storageError('Invalid storage directory')
  }
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw storageError('Invalid state directory')
  }

  const root = path.resolve(storageDir)
  const internal = path.resolve(stateDir)
  return {
    root,
    internal,
    staging: path.join(internal, 'staging'),
    sessions: path.join(internal, 'sessions'),
    commits: path.join(internal, 'commits'),
    journals: path.join(internal, 'journals'),
    publications: path.join(internal, 'publications'),
    links: path.join(internal, 'links'),
    trash: path.join(internal, 'trash'),
    lock: path.join(internal, 'lock')
  }
}

function statOrNull(target: string): StorageStat | null {
  try {
    return fs.statSync(target)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
    throw error
  }
}

function unsafeStatePath(target: string, cause: unknown = null): SwarmDeployError {
  return storageError(`Unsafe state directory path: ${target}`, cause)
}

/** The real path of `target`; symlinks in every existing ancestor are resolved and a missing tail is kept. */
function canonicalPath(target: string): string {
  const tail: string[] = []
  for (let current = target; ; current = path.dirname(current)) {
    let present = true
    try {
      fs.lstatSync(current)
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') throw error
      present = false
    }
    if (present) {
      try {
        return path.join(fs.realpathSync(current), ...tail)
      } catch (error: unknown) {
        // A dangling symlink exists but resolves nowhere yet, so it could point anywhere later.
        throw unsafeStatePath(target, error)
      }
    }
    if (path.dirname(current) === current) throw unsafeStatePath(target)
    tail.unshift(path.basename(current))
  }
}

/** True when `candidate`, or a directory above it, is the very directory `container` names. */
function isWithin(candidate: string, container: StorageIdentity): boolean {
  for (let current = candidate; ; current = path.dirname(current)) {
    const stat = statOrNull(current)
    if (stat !== null) {
      const found = directoryIdentity(stat, current)
      if (found.dev === container.dev && found.ino === container.ino) return true
    }
    if (path.dirname(current) === current) return false
  }
}

/** Identifies an output root by its real path, so every alias of it shares one state directory. */
function rootId(canonicalRoot: string): string {
  const digest = b4a.allocUnsafe(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, b4a.from(canonicalRoot))
  return b4a.toString(digest, 'hex').slice(0, 32)
}

/**
 * Where private state lives when no state directory is configured: under the
 * home directory of the user running the process, keyed by the real path of the
 * output root. It never depends on the working directory.
 */
export function defaultStateDirectory(canonicalRoot: string): string {
  const home = os.homedir()
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw storageError('Unable to determine the home directory for private state; pass --state-dir')
  }
  return path.join(home, STATE_HOME_NAME, rootId(canonicalRoot))
}

function legacyStateError(legacy: string, state: string): SwarmDeployError {
  return storageError(
    [
      `Legacy private state found inside the output root: ${legacy}`,
      'Releases before 0.6.1 kept it there, where a web server that serves the output root can expose it.',
      'This release does not read, move, or delete it. Stop every swarm-deploy server and reset-storage for this root, then move it out of the output root:',
      `  mkdir -p "${path.dirname(state)}" && mv "${legacy}" "${state}"`,
      `To roll back, stop the server and move "${state}" back to "${legacy}" before starting an older release.`,
      'The destination must not exist yet and must be on the same filesystem as the output root; pass --state-dir to choose another location.'
    ].join('\n')
  )
}

function crossDeviceError(root: string, state: string): SwarmDeployError {
  return storageError(
    `Private state directory ${state} is on a different filesystem than the output root ${root}. ` +
      'Publication, link replacement, and retention move files between the two with atomic renames and hard links, which cannot cross filesystems. ' +
      'Pass --state-dir (ServerOptions.stateDir) a directory outside the output root on the same filesystem.'
  )
}

function assertNoLegacyState(root: string, state: string): void {
  const legacy = path.join(root, LEGACY_STATE_NAME)
  try {
    fs.lstatSync(legacy)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  throw legacyStateError(legacy, state)
}

/** The state directory must not be the output root, inside it, above it, or reach it through a symlink. */
function assertStateOutsideRoot(root: string, canonicalRoot: string, state: string): void {
  const rootStat = statOrNull(root)
  if (rootStat === null) throw storageError(`Missing storage directory: ${root}`)
  const rootIdentity = directoryIdentity(rootStat, root)
  for (const candidate of new Set([state, canonicalPath(state)])) {
    if (isWithin(candidate, rootIdentity)) {
      throw storageError(
        `Private state directory ${state} must be outside the output root ${root}; it is the root, inside it, or reaches it through a symlink. Pass a different --state-dir`
      )
    }
  }
  const stateStat = statOrNull(state)
  if (stateStat !== null && isWithin(canonicalRoot, directoryIdentity(stateStat, state))) {
    throw storageError(
      `Private state directory ${state} must not contain the output root ${root}. Pass a different --state-dir`
    )
  }
}

/** Compares the device of `target`, or of its nearest existing ancestor, with the output root's. */
function assertSameFilesystem(root: string, target: string, state: string): void {
  const device = directoryIdentity(fs.statSync(root), root).dev
  for (let current = target; ; current = path.dirname(current)) {
    const stat = statOrNull(current)
    if (stat !== null) {
      if (directoryIdentity(stat, current).dev !== device) throw crossDeviceError(root, state)
      return
    }
    if (path.dirname(current) === current) return
  }
}

function restrictToOwner(directory: string): void {
  if ((fs.lstatSync(directory).mode & 0o077) === 0) return
  try {
    fs.chmodSync(directory, 0o700)
  } catch (error: unknown) {
    throw storageError(
      `Private state directory is accessible to other users and could not be restricted to its owner: ${directory}`,
      error
    )
  }
}

function isStateEntry(name: string): boolean {
  return (
    STATE_ENTRIES.has(name) || name.startsWith('lock.') || name.startsWith(`${STATE_ROOT_NAME}.`)
  )
}

/**
 * A state directory serves exactly one output root. An existing record must name
 * this root; a directory without one is adopted only when it is empty or holds
 * nothing but Swarm Deploy state, such as a migrated legacy directory.
 */
function bindStateRoot(state: string, canonicalRoot: string, write: boolean): void {
  const marker = path.join(state, STATE_ROOT_NAME)
  let stat: StorageStat | null = null
  try {
    stat = fs.lstatSync(marker)
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE_ROOT_BYTES) {
      throw storageError(`Unsafe storage file: ${marker}`)
    }
    let bound: unknown
    try {
      bound = JSON.parse(fs.readFileSync(marker, 'utf8'))
    } catch (error: unknown) {
      throw storageError(`Malformed state directory record: ${marker}`, error)
    }
    const owner = typeof bound === 'object' && bound !== null && 'root' in bound ? bound.root : null
    if (typeof owner !== 'string') throw storageError(`Malformed state directory record: ${marker}`)
    if (owner !== canonicalRoot) {
      throw storageError(
        `State directory ${state} belongs to output root ${owner}, not ${canonicalRoot}. Give every output root its own --state-dir`
      )
    }
    return
  }
  const foreign = fs.readdirSync(state).find((name) => !isStateEntry(name))
  if (foreign !== undefined) {
    throw storageError(
      `State directory ${state} is not empty and does not hold Swarm Deploy state (found ${foreign}). Choose an empty directory`
    )
  }
  if (!write) return
  const temporary = `${marker}.${randomToken().slice(0, 16)}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, root: canonicalRoot }), {
    flag: 'wx',
    mode: 0o600
  })
  fs.renameSync(temporary, marker)
}

/**
 * Resolves and validates where state lives for an output root. With `create` it
 * makes the output root, the private state directory, and its metadata
 * directories; without it nothing is written and a missing state directory is
 * an error. Either way it refuses before touching state when the output root
 * still holds legacy state, when the state directory is not safely outside the
 * root on the same filesystem, or when it already serves another root.
 */
function locateLayout(
  storageDir: string,
  stateDir: string | undefined,
  create: boolean
): StorageLayout {
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw storageError('Invalid storage directory')
  }
  if (
    stateDir !== undefined &&
    (typeof stateDir !== 'string' || stateDir.length === 0 || !path.isAbsolute(stateDir))
  ) {
    throw storageError('Invalid state directory: it must be an absolute path')
  }

  const root = path.resolve(storageDir)
  assertDirectorySync(root, create)
  if (statOrNull(path.join(root, STATE_ROOT_NAME)) !== null) {
    throw storageError(`Refusing to use a private state directory as the output root: ${root}`)
  }
  const canonicalRoot = fs.realpathSync(root)
  const state =
    stateDir === undefined ? defaultStateDirectory(canonicalRoot) : path.resolve(stateDir)
  assertNoLegacyState(root, state)

  const present = (() => {
    try {
      return fs.lstatSync(state)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  })()
  if (present !== null && (present.isSymbolicLink() || !present.isDirectory())) {
    throw storageError(`Unsafe storage directory: ${state}`)
  }
  if (present === null && !create) {
    throw storageError(
      `Not an initialized storage root: ${root} (no private state at ${state}; pass --state-dir if it lives elsewhere)`
    )
  }
  assertStateOutsideRoot(root, canonicalRoot, state)
  assertSameFilesystem(root, state, state)

  if (present === null) assertDirectorySync(state)
  if (create) restrictToOwner(state)
  bindStateRoot(state, canonicalRoot, create)

  const layout = resolveLayout(root, state)
  if (create) {
    for (const name of METADATA_DIRECTORY_NAMES) {
      assertDirectorySync(layout[name])
      assertSameFilesystem(root, layout[name], state)
    }
  }
  return layout
}

/** Creates the output root and the private state directory when missing; used by the server. */
export function initLayout(storageDir: string, stateDir?: string): StorageLayout {
  return locateLayout(storageDir, stateDir, true)
}

/** Resolves an existing layout without creating or changing anything; used by reset-storage. */
export function findLayout(storageDir: string, stateDir?: string): StorageLayout {
  return locateLayout(storageDir, stateDir, false)
}

/** Every protected directory a storage operation revalidates before mutating. */
export function protectedDirectories(layout: StorageLayout): string[] {
  return [
    layout.root,
    layout.internal,
    layout.staging,
    layout.sessions,
    layout.commits,
    layout.journals,
    layout.publications,
    layout.links,
    layout.trash
  ]
}

function randomToken(): string {
  const bytes = b4a.allocUnsafe(32)
  sodium.randombytes_buf(bytes)
  return b4a.toString(bytes, 'hex')
}

function currentPid(): number {
  return process.pid
}

/**
 * Existence check only: a live PID proves nothing about which program owns
 * it, so callers must never treat it as proof of storage-root ownership.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return errorCode(error) === 'EPERM'
  }
}

const defaultIsProcessAlive = isProcessAlive

function noFollowFlag() {
  if (fs.constants?.O_NOFOLLOW !== undefined) return fs.constants.O_NOFOLLOW
  const platform = os.platform()
  if (platform === 'darwin') return 0x100
  if (platform === 'linux') return 0x20000
  throw storageError('Safe file open is unsupported on this platform')
}

export function safeFileOpenFlags(access: SafeFileAccess): number {
  const constants = fs.constants || {}
  const noFollow = noFollowFlag()
  if (access === 'create') {
    return (
      (constants.O_WRONLY ?? 1) |
      (constants.O_CREAT ?? 0o100) |
      (constants.O_EXCL ?? 0o200) |
      noFollow
    )
  }
  if (access === 'write') return (constants.O_RDWR ?? 2) | noFollow
  if (access === 'read') return (constants.O_RDONLY ?? 0) | noFollow
  throw storageError('Invalid safe file open access')
}

export async function openSafeRegularFile(
  filePath: string,
  access: SafeFileAccess,
  storage: StorageAdapter = fs.promises
): Promise<StorageFileHandle> {
  let handle: StorageFileHandle | null = null
  try {
    handle = await storage.open(filePath, safeFileOpenFlags(access))
    const stat = await handle.stat()
    if (!stat.isFile()) throw storageError(`Unsafe storage file: ${filePath}`)
    return handle
  } catch (error: unknown) {
    if (handle) await handle.close().catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw storageError(`Unsafe storage file: ${filePath}`, error)
  }
}

function isIdentityValue(value: unknown): value is number | bigint {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'bigint' && value >= 0n)
  )
}

function directoryIdentity(stat: StorageStat, directory: string): StorageIdentity {
  if (!isIdentityValue(stat.dev) || !isIdentityValue(stat.ino)) {
    throw storageError(`Storage directory identity is unavailable: ${directory}`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

async function captureSafeDirectory(
  directory: string,
  storage: StorageAdapter
): Promise<StorageIdentity> {
  return directoryIdentity(await assertSafeDirectory(directory, storage), directory)
}

async function revalidateSafeDirectory(
  directory: string,
  expected: StorageIdentity,
  storage: StorageAdapter
): Promise<void> {
  const actual = await directoryIdentity(await assertSafeDirectory(directory, storage), directory)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw storageError(`Storage directory was replaced: ${directory}`)
  }
}

// Local users able to replace directories that are already open are outside the
// remote-client threat scope. Path-based namespace operations still capture and
// revalidate their parent identity, so every detected replacement fails closed.
export async function withSafeDirectoryIdentity<T>(
  directory: string,
  storage: StorageAdapter,
  operation: () => Promise<T> | T
): Promise<T> {
  const expected = await captureSafeDirectory(directory, storage)
  const outcome: { succeeded: true; result: T } | { succeeded: false; error: unknown } =
    await (async () => {
      try {
        return { succeeded: true as const, result: await operation() }
      } catch (error: unknown) {
        return { succeeded: false as const, error }
      }
    })()
  await revalidateSafeDirectory(directory, expected, storage)
  if (!outcome.succeeded) throw outcome.error
  return outcome.result
}

function isRenameConflict(error: unknown): boolean {
  return errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOTEMPTY'
}

async function writeAll(handle: StorageFileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write storage lock owner')
    }
    offset += count
  }
}

async function readAll(handle: StorageFileHandle, size: number): Promise<Buffer> {
  const bytes = b4a.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Truncated storage lock owner')
    }
    offset += count
  }
  return bytes
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readLockOwner(lockPath: string, storage: StorageAdapter): Promise<LockOwner | null> {
  let lockStat: StorageStat
  try {
    lockStat = await storage.lstat(lockPath)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null
    throw storageError('Unable to inspect storage lock', error)
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${lockPath}`)
  }

  const ownerPath = path.join(lockPath, 'owner.json')
  let handle: StorageFileHandle | null = null
  try {
    handle = await openSafeRegularFile(ownerPath, 'read', storage)
    const openedStat = await handle.stat()
    // Lock owner records are fixed, small control metadata, never arbitrary JSON.
    if (openedStat.size <= 0 || openedStat.size > MAX_LOCK_OWNER_BYTES) {
      throw storageError('Malformed storage lock')
    }
    const bytes = await readAll(handle, openedStat.size)
    const owner: unknown = JSON.parse(b4a.toString(bytes, 'utf8'))
    if (
      !owner ||
      typeof owner !== 'object' ||
      !('pid' in owner) ||
      !('startedAt' in owner) ||
      !('token' in owner)
    ) {
      throw storageError('Malformed storage lock')
    }
    const { pid, startedAt, token } = owner
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof startedAt !== 'number' ||
      !Number.isSafeInteger(startedAt) ||
      startedAt < 0 ||
      typeof token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(token)
    ) {
      throw storageError('Malformed storage lock')
    }
    return { pid, startedAt, token }
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'cause' in error &&
      errorCode(error.cause) === 'ENOENT'
    ) {
      try {
        await storage.lstat(lockPath)
      } catch (lockError: unknown) {
        if (errorCode(lockError) === 'ENOENT') return null
        throw lockError
      }
    }
    if (error instanceof SwarmDeployError) throw error
    throw storageError('Malformed storage lock', error)
  } finally {
    if (handle) await handle.close()
  }
}

export type StorageLockState =
  | { status: 'free' }
  | { status: 'held'; pid: number; startedAt: number; token: string }
  | { status: 'malformed' }
  | { status: 'unsafe' }

/**
 * Reads the published lock without acquiring or retiring it. `malformed` is a
 * lock directory whose owner record cannot be parsed; `unsafe` is a lock path
 * that is not a plain directory. Either may hide a live owner, so reset must refuse both states.
 */
export async function inspectStorageLock(
  layout: StorageLayout,
  storage: StorageAdapter = fs.promises
): Promise<StorageLockState> {
  try {
    const owner = await readLockOwner(layout.lock, storage)
    return owner === null ? { status: 'free' } : { status: 'held', ...owner }
  } catch (error: unknown) {
    if (!(error instanceof SwarmDeployError)) throw error
    if (error.message.startsWith('Unsafe storage directory')) return { status: 'unsafe' }
    if (error.message === 'Malformed storage lock') return { status: 'malformed' }
    throw error
  }
}

async function createLockCandidate(
  layout: StorageLayout,
  owner: LockOwner,
  storage: StorageAdapter
): Promise<string> {
  const candidate = `${layout.lock}.candidate-${owner.token}`
  const ownerPath = path.join(candidate, 'owner.json')
  let candidateCreated = false
  let handle: StorageFileHandle | null = null
  try {
    await storage.mkdir(candidate, { mode: 0o700 })
    candidateCreated = true
    handle = await storage.open(ownerPath, 'wx', 0o600)
    await writeAll(handle, b4a.from(JSON.stringify(owner)))
    await handle.sync()
    await handle.close()
    handle = null
    await syncDirectory(candidate, storage)
    await syncDirectory(layout.internal, storage)
    return candidate
  } catch (error: unknown) {
    if (handle) await handle.close().catch(() => {})
    if (candidateCreated) {
      await storage.rm(candidate, { recursive: true, force: true }).catch(() => {})
      await syncDirectory(layout.internal, storage).catch(() => {})
    }
    throw error
  }
}

async function discardCandidate(
  candidate: string,
  internal: string,
  storage: StorageAdapter
): Promise<void> {
  await storage.rm(candidate, { recursive: true, force: true })
  await syncDirectory(internal, storage)
}

async function retireObservedLock(
  lockPath: string,
  token: string,
  storage: StorageAdapter
): Promise<boolean> {
  const tombstone = `${lockPath}.retired-${token}`
  try {
    await storage.rename(lockPath, tombstone)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false
    if (isRenameConflict(error)) {
      const current = await readLockOwner(lockPath, storage)
      if (current === null || current.token !== token) return false
      throw storageError('Storage lock tombstone already exists', error)
    }
    throw error
  }
  await syncDirectory(path.dirname(lockPath), storage)
  return true
}

async function assertLayout(layout: StorageLayout, storage: StorageAdapter): Promise<void> {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  for (const directory of protectedDirectories(layout)) {
    await assertSafeDirectory(directory, storage)
  }
}

export async function acquireStorageLock(
  layout: StorageLayout,
  {
    pid = currentPid(),
    isProcessAlive = defaultIsProcessAlive,
    storage = fs.promises
  }: {
    pid?: number
    isProcessAlive?: (pid: number) => boolean
    storage?: StorageAdapter
  } = {}
): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof isProcessAlive !== 'function') {
    throw storageError('Invalid storage lock options')
  }
  await assertLayout(layout, storage)

  const token = randomToken()
  const owner = { pid, startedAt: Date.now(), token }
  const candidate = await createLockCandidate(layout, owner, storage)
  let candidatePublished = false
  try {
    for (;;) {
      const current = await readLockOwner(layout.lock, storage)
      if (current !== null) {
        if (isProcessAlive(current.pid)) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Storage is already locked')
        }
        await retireObservedLock(layout.lock, current.token, storage)
        continue
      }

      try {
        await storage.rename(candidate, layout.lock)
      } catch (error: unknown) {
        if (isRenameConflict(error)) continue
        throw error
      }
      candidatePublished = true
      await syncDirectory(layout.internal, storage)
      break
    }
  } finally {
    if (!candidatePublished) await discardCandidate(candidate, layout.internal, storage)
  }

  return async function () {
    const current = await readLockOwner(layout.lock, storage)
    if (current === null || current.token !== token) return
    await retireObservedLock(layout.lock, token, storage)
  }
}
