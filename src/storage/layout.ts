import b4a from 'b4a'
import { errorCode } from '../error-code.js'
import fs from '#fs'
import os from '#os'
import path from '#path'
import process from '#process'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { mountFor, readMountInfo, type MountEntry } from './mounts.js'
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

/**
 * True when `candidate`, or a directory above it, is the very directory `container` names.
 * `container` is a validated identity. An ancestor whose device or inode number cannot be
 * represented exactly (some macOS system volumes) can never equal it, so it is simply not
 * the same directory and needs no validation of its own.
 */
function isWithin(candidate: string, container: StorageIdentity): boolean {
  for (let current = candidate; ; current = path.dirname(current)) {
    const stat = statOrNull(current)
    if (stat !== null && stat.dev === container.dev && stat.ino === container.ino) return true
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

/**
 * One POSIX shell word that is exactly `value`: inside single quotes nothing is expanded,
 * and a single quote itself is written as `'\''`. Every path in a printed command goes
 * through this, so an unusual directory name can never run or become another argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function lstatOrNull(target: string): StorageStat | null {
  try {
    return fs.lstatSync(target)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
    throw error
  }
}

function legacyStateError(legacy: string, state: string): SwarmDeployError {
  const [quotedLegacy, quotedState] = [shellQuote(legacy), shellQuote(state)]
  const header = [
    `Legacy private state found inside the output root: ${legacy}`,
    'Releases before 0.6.1 kept it there, where a web server that serves the output root can expose it.'
  ]
  if (lstatOrNull(state) !== null) {
    // `mv` would move the legacy directory inside an existing destination and hide its records.
    return storageError(
      [
        ...header,
        `The planned private state location already exists, so moving the legacy directory there would nest it inside: ${state}`,
        'This release does not read, move, or delete either one. Choose a location that does not exist: stop every swarm-deploy server and reset-storage for this root, then pass --state-dir a new absolute path and run the command printed for it.',
        `If that existing location is an empty directory you created for this purpose, you may remove it first (the command fails if it is not empty): rmdir -- ${quotedState}`
      ].join('\n')
    )
  }
  return storageError(
    [
      ...header,
      'This release does not read, move, or delete it. Stop every swarm-deploy server and reset-storage for this root, then run this POSIX shell command. Each path is a quoted literal, and it refuses to run if the destination already exists, so it can never nest the directory:',
      `  [ ! -e ${quotedState} ] && [ ! -L ${quotedState} ] && mkdir -p -- ${shellQuote(path.dirname(state))} && mv -- ${quotedLegacy} ${quotedState}`,
      'The moved directory has no record of its output root yet, so start the server once with --initialize-state to bind it; leave that flag out of normal startup afterwards.',
      'To roll back, stop the server and run this before starting an older release (it refuses if the legacy path exists again):',
      `  [ ! -e ${quotedLegacy} ] && [ ! -L ${quotedLegacy} ] && mv -- ${quotedState} ${quotedLegacy}`,
      'The destination must be on the same filesystem and mount as the output root; pass --state-dir to choose another location.'
    ].join('\n')
  )
}

function crossDeviceError(root: string, state: string): SwarmDeployError {
  return storageError(
    `Private state directory ${state} is on a different filesystem than the output root ${root}. ` +
      'Publication, link replacement, and retention move files between the two with atomic renames and hard links, which cannot cross filesystems. ' +
      'Pass --state-dir (ServerOptions.stateDir) a directory outside the output root on the same filesystem and mount.'
  )
}

function crossMountError(
  root: string,
  state: string,
  rootMount: MountEntry,
  stateMount: MountEntry
): SwarmDeployError {
  return storageError(
    `Private state directory ${state} is on a different mount (${stateMount.mountPoint}) than the output root ${root} (${rootMount.mountPoint}), although both report the same filesystem. ` +
      'Linux rename(2) and link(2) fail with EXDEV between distinct mount points even of one filesystem, so publication, link replacement, and retention would fail after an upload was received. ' +
      'Pass --state-dir a directory outside the output root on the same mount (not a separate bind mount or volume).'
  )
}

function assertNoLegacyState(root: string, state: string): void {
  const legacy = path.join(root, LEGACY_STATE_NAME)
  if (lstatOrNull(legacy) !== null) throw legacyStateError(legacy, state)
}

/**
 * Whether legacy private state is in the output root now. Used while a server runs: an
 * older release, or another writer, can recreate it after startup checked, and that is a
 * second writer to refuse and report, never an unknown entry to ignore.
 */
export function legacyStatePresent(root: string): boolean {
  return lstatOrNull(path.join(root, LEGACY_STATE_NAME)) !== null
}

/**
 * The same adapter, except that a `rename` or `link` refused with EXDEV tells
 * `onCrossMount` before the error is rethrown unchanged. It is how a publication that fails
 * across a filesystem or mount boundary, which no startup check can rule out in every
 * environment, is reported with the way out instead of as a generic failure.
 */
export function diagnoseCrossMount(
  storage: StorageAdapter,
  onCrossMount: () => void
): StorageAdapter {
  const diagnosed = Object.create(storage) as StorageAdapter
  for (const name of ['rename', 'link'] as const) {
    diagnosed[name] = async (from: string, to: string): Promise<void> => {
      try {
        await storage[name](from, to)
      } catch (error: unknown) {
        if (errorCode(error) === 'EXDEV') onCrossMount()
        throw error
      }
    }
  }
  return diagnosed
}

/** What a running server says when legacy state reappears. It names no path. */
export const LEGACY_REAPPEARED_MESSAGE =
  'Legacy private state reappeared in the output root; another writer or an older release is using it. Stop every instance and migrate it as described in the README'

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

/**
 * On Linux, `rename` and `link` also fail between two mounts of one filesystem, which share
 * a device number. When the mount table is known, the root and `canonicalTarget` must be on
 * the same mount; a path the table cannot place is left to the device check.
 */
export function assertSameMount(
  canonicalRoot: string,
  canonicalTarget: string,
  state: string,
  mounts: readonly MountEntry[]
): void {
  const rootMount = mountFor(mounts, canonicalRoot)
  const targetMount = mountFor(mounts, canonicalTarget)
  if (rootMount === null || targetMount === null || rootMount.id === targetMount.id) return
  throw crossMountError(canonicalRoot, state, rootMount, targetMount)
}

/**
 * `target`, or its nearest existing ancestor, must be on the output root's filesystem and,
 * where the mount table is known, on its mount. Only the root's own identity has to be
 * representable: another path whose device number cannot be represented exactly is a
 * different device from the root's, which is what the operator needs to hear, not an
 * identity error.
 */
function assertSameFilesystem(
  root: string,
  canonicalRoot: string,
  target: string,
  state: string,
  mounts: readonly MountEntry[] | null
): void {
  const device = directoryIdentity(fs.statSync(root), root).dev
  for (let current = target; ; current = path.dirname(current)) {
    const stat = statOrNull(current)
    if (stat !== null) {
      if (stat.dev !== device) throw crossDeviceError(root, state)
      break
    }
    if (path.dirname(current) === current) break
  }
  if (mounts !== null) assertSameMount(canonicalRoot, canonicalPath(target), state, mounts)
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

type Binding = 'bound' | 'unbound'

function boundElsewhereError(
  state: string,
  owner: string,
  canonicalRoot: string
): SwarmDeployError {
  return storageError(
    `State directory ${state} belongs to output root ${owner}, not ${canonicalRoot}. Give every output root its own --state-dir`
  )
}

/** The output root a state directory records, or null when it has no record yet. */
function readBinding(marker: string): string | null {
  const stat = lstatOrNull(marker)
  if (stat === null) return null
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
  return owner
}

function nestedLegacyError(state: string): SwarmDeployError {
  const nested = path.join(state, LEGACY_STATE_NAME)
  const aside = `${state}.migrating`
  return storageError(
    [
      `Legacy private state is nested inside the state directory: ${nested}`,
      'An earlier move put the pre-0.6.1 directory inside a destination that already existed, so its records are not where this release looks for them. This release does not read, move, or delete either directory.',
      'Stop every swarm-deploy server and reset-storage for this root. If the state directory holds nothing else you need, this POSIX shell command puts the nested directory in place (it refuses if the temporary name exists, and stops at rmdir if the state directory still holds other entries):',
      `  [ ! -e ${shellQuote(aside)} ] && [ ! -L ${shellQuote(aside)} ] && mv -- ${shellQuote(nested)} ${shellQuote(aside)} && rmdir -- ${shellQuote(state)} && mv -- ${shellQuote(aside)} ${shellQuote(state)}`,
      `If it stops there, the legacy directory is at ${aside}: merge it with the state directory by hand, keeping every record, or choose a new --state-dir.`
    ].join('\n')
  )
}

/**
 * Read-only. Says whether `state` is already bound to this output root and throws for
 * anything that must never be adopted: a record naming another root, an unreadable record,
 * a nested legacy directory, or contents that are not Swarm Deploy state. A directory
 * without a record is `unbound` only when it is empty or holds nothing but state, such as
 * a migrated legacy directory.
 */
function inspectBinding(state: string, canonicalRoot: string): Binding {
  if (lstatOrNull(path.join(state, LEGACY_STATE_NAME)) !== null) throw nestedLegacyError(state)
  const owner = readBinding(path.join(state, STATE_ROOT_NAME))
  if (owner !== null) {
    if (owner !== canonicalRoot) throw boundElsewhereError(state, owner, canonicalRoot)
    return 'bound'
  }
  const foreign = fs.readdirSync(state).find((name) => !isStateEntry(name))
  if (foreign !== undefined) {
    throw storageError(
      `State directory ${state} is not empty and does not hold Swarm Deploy state (found ${foreign}). Choose an empty directory`
    )
  }
  return 'unbound'
}

/**
 * Starting unbound state is refused for a root that already holds entries, or when the
 * state itself is not empty (a migrated or restored directory), unless the operator said so.
 * Settings that differ from the instance that has been managing a root would otherwise
 * quietly create a second, independent writer for the same files.
 */
function assertInitializationAcknowledged(
  root: string,
  state: string,
  stateExists: boolean,
  acknowledged: boolean
): void {
  if (acknowledged) return
  const reasons: string[] = []
  if (fs.readdirSync(root).length > 0) reasons.push('the output root already holds entries')
  if (stateExists && fs.readdirSync(state).length > 0) {
    reasons.push('the state directory already holds entries')
  }
  if (reasons.length === 0) return
  throw storageError(
    `Private state at ${state} is not bound to the output root ${root} yet, and ${reasons.join(' and ')}. ` +
      'Starting with state settings that differ from the instance that has been managing this root (another --state-dir, user, or HOME) would create a second, independent writer for the same files. ' +
      'If this is intended because the state was deleted or a migrated or restored directory is being bound for the first time, stop every instance for this root and start once with --initialize-state (ServerOptions.initializeState), then remove that flag. ' +
      'Published files are never adopted or deleted: without their old records they stay unmanaged.'
  )
}

/**
 * An explicit state location must not fork the state this user's default location already
 * keeps for this root: that would give one output root two independent sets of ownership
 * records, and nothing locks them against each other.
 */
export function assertNoDefaultStateConflict(
  canonicalRoot: string,
  state: string,
  defaultState: string
): void {
  const stateStat = statOrNull(state)
  const defaultStat = statOrNull(defaultState)
  if (defaultStat === null || !defaultStat.isDirectory()) return
  const sameDirectory =
    stateStat !== null && stateStat.dev === defaultStat.dev && stateStat.ino === defaultStat.ino
  if (sameDirectory) return
  let owner: string | null
  try {
    owner = readBinding(path.join(defaultState, STATE_ROOT_NAME))
  } catch {
    return
  }
  if (owner !== canonicalRoot) return
  throw storageError(
    `A private state directory for this output root already exists at ${defaultState}, the default for this user, but --state-dir chose ${state}. ` +
      'Using both would give the root two independent sets of state. ' +
      'Omit --state-dir or pass the default location, or stop every instance and move or remove that default directory deliberately first.'
  )
}

/** Marker temporaries older than this belong to an initializer that never finished. */
const CLAIM_TEMPORARY_MAX_AGE = 10 * 60 * 1000
const CLAIM_TEMPORARY = /^\.swarm-deploy-state\.json\.[0-9a-f]{16}\.tmp$/

/**
 * Removes marker temporaries an interrupted initializer left behind. A recent one may
 * belong to an initializer that is about to publish it, so only old regular files go.
 */
export function sweepClaimTemporaries(
  state: string,
  now: number = Date.now(),
  olderThan: number = CLAIM_TEMPORARY_MAX_AGE
): number {
  let removed = 0
  for (const name of fs.readdirSync(state)) {
    if (!CLAIM_TEMPORARY.test(name)) continue
    const target = path.join(state, name)
    const stat = lstatOrNull(target)
    if (stat === null || !stat.isFile() || now - (stat.mtimeMs ?? now) < olderThan) continue
    try {
      fs.unlinkSync(target)
      removed++
    } catch {}
  }
  return removed
}

function syncDirectoryEntries(directory: string): void {
  const fd = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Records the output root in a state directory without ever replacing a record another
 * initializer published first. The record is written and synced under a private name, then
 * hard-linked into place: `link` fails with EEXIST rather than overwrite, so exactly one
 * initializer wins. The directory is synced so the name survives a crash, and the record
 * actually in place is read back and must name this root. A different winner is refused.
 */
function claimStateRoot(state: string, canonicalRoot: string): void {
  const marker = path.join(state, STATE_ROOT_NAME)
  const temporary = `${marker}.${randomToken().slice(0, 16)}.tmp`
  const bytes = b4a.from(JSON.stringify({ version: 1, root: canonicalRoot }))
  try {
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try {
        let written = 0
        while (written < bytes.byteLength) {
          written += fs.writeSync(fd, bytes, written, bytes.byteLength - written)
        }
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      try {
        fs.linkSync(temporary, marker)
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
    } finally {
      // Only this call's own temporary, whether or not it was published.
      try {
        fs.unlinkSync(temporary)
      } catch {}
    }
    syncDirectoryEntries(state)
  } catch (error: unknown) {
    if (error instanceof SwarmDeployError) throw error
    throw storageError(
      `Unable to record the output root in the private state directory ${state}; hard links and fsync are required`,
      error
    )
  }
  const owner = readBinding(marker)
  if (owner !== canonicalRoot) {
    throw owner === null
      ? storageError(`Malformed state directory record: ${marker}`)
      : boundElsewhereError(state, owner, canonicalRoot)
  }
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
  create: boolean,
  initializeState: boolean
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
  if (stateDir !== undefined) {
    let defaultState: string | null = null
    try {
      defaultState = defaultStateDirectory(canonicalRoot)
    } catch {
      // No home directory is known, so there is no default location to conflict with.
    }
    if (defaultState !== null) assertNoDefaultStateConflict(canonicalRoot, state, defaultState)
  }

  const present = lstatOrNull(state)
  if (present !== null && (present.isSymbolicLink() || !present.isDirectory())) {
    throw storageError(`Unsafe storage directory: ${state}`)
  }
  if (present === null && !create) {
    throw storageError(
      `Not an initialized storage root: ${root} (no private state at ${state}; pass --state-dir if it lives elsewhere)`
    )
  }
  assertStateOutsideRoot(root, canonicalRoot, state)
  const mounts = readMountInfo()
  assertSameFilesystem(root, canonicalRoot, state, state, mounts)

  // Nothing below changes an existing directory until it is known to be this root's state:
  // the read-only inspection runs first, and permissions are restricted only after it.
  const existed = present !== null
  let binding: Binding = existed ? inspectBinding(state, canonicalRoot) : 'unbound'
  if (create && binding === 'unbound') {
    assertInitializationAcknowledged(root, state, existed, initializeState)
  }
  if (!existed) {
    assertDirectorySync(state)
    binding = inspectBinding(state, canonicalRoot)
  }
  if (create) {
    restrictToOwner(state)
    if (binding === 'unbound') claimStateRoot(state, canonicalRoot)
  }

  const layout = resolveLayout(root, state)
  if (create) {
    for (const name of METADATA_DIRECTORY_NAMES) {
      assertDirectorySync(layout[name])
      assertSameFilesystem(root, canonicalRoot, layout[name], state, mounts)
    }
    try {
      sweepClaimTemporaries(state)
    } catch {
      // Residue from an interrupted initializer is harmless; it never blocks startup.
    }
  }
  return layout
}

export interface InitLayoutOptions {
  /**
   * Acknowledges that unbound state may be started for a root that already holds entries, or
   * from a directory that already holds entries. One-time: bound state needs no flag.
   */
  initializeState?: boolean
}

/** Creates the output root and the private state directory when missing; used by the server. */
export function initLayout(
  storageDir: string,
  stateDir?: string,
  options: InitLayoutOptions = {}
): StorageLayout {
  return locateLayout(storageDir, stateDir, true, options.initializeState === true)
}

/** Resolves an existing layout without creating or changing anything; used by reset-storage. */
export function findLayout(storageDir: string, stateDir?: string): StorageLayout {
  return locateLayout(storageDir, stateDir, false, false)
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
