import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import os from '#os'
import path from '#path'
import process from '#process'
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

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertDirectorySync(directory: string): void {
  let stat: StorageStat
  try {
    stat = fs.lstatSync(directory)
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error
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

export function initLayout(storageDir: string): StorageLayout {
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw storageError('Invalid storage directory')
  }

  const root = path.resolve(storageDir)
  const internal = path.join(root, '.swarm-deploy')
  const layout = {
    root,
    internal,
    staging: path.join(internal, 'staging'),
    sessions: path.join(internal, 'sessions'),
    commits: path.join(internal, 'commits'),
    journals: path.join(internal, 'journals'),
    lock: path.join(internal, 'lock')
  }

  assertDirectorySync(root)
  assertDirectorySync(internal)
  assertDirectorySync(layout.staging)
  assertDirectorySync(layout.sessions)
  assertDirectorySync(layout.commits)
  assertDirectorySync(layout.journals)

  return layout
}

function randomToken(): string {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function currentPid(): number {
  return process.pid
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return errorCode(error) === 'EPERM'
  }
}

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
  for (const directory of [
    layout.root,
    layout.internal,
    layout.staging,
    layout.sessions,
    layout.commits,
    layout.journals
  ]) {
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
