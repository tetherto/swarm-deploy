'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const process = require('#process')
const { SwarmDeployError, ERRORS } = require('../errors')

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertDirectorySync(directory) {
  let stat
  try {
    stat = fs.lstatSync(directory)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    stat = fs.lstatSync(directory)
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${directory}`)
  }
}

async function assertSafeDirectory(directory, storage = fs.promises) {
  let stat
  try {
    stat = await storage.lstat(directory)
  } catch (err) {
    throw storageError(`Missing storage directory: ${directory}`, err)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${directory}`)
  }
}

async function assertSafeFile(filePath, storage = fs.promises) {
  let stat
  try {
    stat = await storage.lstat(filePath)
  } catch (err) {
    throw storageError(`Missing storage file: ${filePath}`, err)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw storageError(`Unsafe storage file: ${filePath}`)
  }
  return stat
}

function initLayout(storageDir) {
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

function randomToken() {
  return b4a.toString(crypto.randomBytes(32), 'hex')
}

function currentPid() {
  return process.pid
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function noFollowFlag() {
  if (fs.constants?.O_NOFOLLOW !== undefined) return fs.constants.O_NOFOLLOW
  if (process.platform === 'darwin') return 0x100
  if (process.platform === 'linux') return 0x20000
  throw storageError('Safe lock owner open is unsupported on this platform')
}

function ownerReadFlags() {
  return (fs.constants?.O_RDONLY ?? 0) | noFollowFlag()
}

function isRenameConflict(err) {
  return err.code === 'EEXIST' || err.code === 'ENOTEMPTY'
}

async function writeAll(handle, bytes) {
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

async function readAll(handle, size) {
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

async function syncDirectory(directory, storage) {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readLockOwner(lockPath, storage) {
  let lockStat
  try {
    lockStat = await storage.lstat(lockPath)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw storageError('Unable to inspect storage lock', err)
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw storageError(`Unsafe storage directory: ${lockPath}`)
  }

  const ownerPath = path.join(lockPath, 'owner.json')
  let ownerStat
  try {
    ownerStat = await storage.lstat(ownerPath)
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        await storage.lstat(lockPath)
      } catch (lockErr) {
        if (lockErr.code === 'ENOENT') return null
        throw lockErr
      }
    }
    throw storageError('Malformed storage lock', err)
  }
  if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
    throw storageError('Malformed storage lock')
  }

  let handle = null
  try {
    handle = await storage.open(ownerPath, ownerReadFlags())
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || openedStat.size <= 0 || openedStat.size > 1024) {
      throw storageError('Malformed storage lock')
    }
    const bytes = await readAll(handle, openedStat.size)
    const owner = JSON.parse(b4a.toString(bytes, 'utf8'))
    if (
      !owner ||
      typeof owner !== 'object' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !Number.isSafeInteger(owner.startedAt) ||
      owner.startedAt < 0 ||
      typeof owner.token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(owner.token)
    ) {
      throw storageError('Malformed storage lock')
    }
    return owner
  } catch (err) {
    if (err instanceof SwarmDeployError) throw err
    throw storageError('Malformed storage lock', err)
  } finally {
    if (handle) await handle.close()
  }
}

async function createLockCandidate(layout, owner, storage) {
  const candidate = `${layout.lock}.candidate-${owner.token}`
  const ownerPath = path.join(candidate, 'owner.json')
  let candidateCreated = false
  let handle = null
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
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    if (candidateCreated) {
      await storage.rm(candidate, { recursive: true, force: true }).catch(() => {})
      await syncDirectory(layout.internal, storage).catch(() => {})
    }
    throw err
  }
}

async function discardCandidate(candidate, internal, storage) {
  await storage.rm(candidate, { recursive: true, force: true })
  await syncDirectory(internal, storage)
}

async function retireObservedLock(lockPath, token, storage) {
  const tombstone = `${lockPath}.retired-${token}`
  try {
    await storage.rename(lockPath, tombstone)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    if (isRenameConflict(err)) {
      const current = await readLockOwner(lockPath, storage)
      if (current === null || current.token !== token) return false
      throw storageError('Storage lock tombstone already exists', err)
    }
    throw err
  }
  await syncDirectory(path.dirname(lockPath), storage)
  return true
}

async function assertLayout(layout, storage) {
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

async function acquireStorageLock(
  layout,
  { pid = currentPid(), isProcessAlive = defaultIsProcessAlive, storage = fs.promises } = {}
) {
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
      } catch (err) {
        if (isRenameConflict(err)) continue
        throw err
      }
      candidatePublished = true
      await syncDirectory(layout.internal, storage)
      break
    }
  } finally {
    if (!candidatePublished) await discardCandidate(candidate, layout.internal, storage)
  }

  return async function releaseStorageLock() {
    const current = await readLockOwner(layout.lock, storage)
    if (current === null || current.token !== token) return
    await retireObservedLock(layout.lock, token, storage)
  }
}

module.exports = {
  initLayout,
  acquireStorageLock,
  assertSafeDirectory,
  assertSafeFile
}
