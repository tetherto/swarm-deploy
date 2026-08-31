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

async function readLockOwner(lockPath, storage) {
  await assertSafeDirectory(lockPath, storage)
  const ownerPath = path.join(lockPath, 'owner.json')
  await assertSafeFile(ownerPath, storage)

  let owner
  try {
    owner = JSON.parse(await storage.readFile(ownerPath, 'utf8'))
  } catch (err) {
    throw storageError('Malformed storage lock', err)
  }

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
}

async function removeMovedLock(lockPath, token, storage) {
  let current
  try {
    current = await readLockOwner(lockPath, storage)
  } catch (err) {
    if (err.cause?.code === 'ENOENT') return
    throw err
  }
  if (current.token !== token) return

  const moved = `${lockPath}.release-${token}-${randomToken()}`
  try {
    await storage.rename(lockPath, moved)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }

  let owner
  try {
    owner = await readLockOwner(moved, storage)
  } catch (err) {
    return
  }
  if (owner.token !== token) return
  await storage.rm(moved, { recursive: true, force: true })
}

async function recoverDeadLock(lockPath, owner, storage) {
  const stale = `${lockPath}.stale-${owner.token}-${randomToken()}`
  try {
    await storage.rename(lockPath, stale)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }

  let movedOwner
  try {
    movedOwner = await readLockOwner(stale, storage)
  } catch (err) {
    return
  }
  if (movedOwner.token !== owner.token) return
  await storage.rm(stale, { recursive: true, force: true })
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
  const ownerPath = path.join(layout.lock, 'owner.json')
  for (;;) {
    try {
      await storage.mkdir(layout.lock, { mode: 0o700 })
      try {
        await storage.writeFile(ownerPath, JSON.stringify({ pid, startedAt: Date.now(), token }), {
          mode: 0o600,
          flag: 'wx'
        })
      } catch (err) {
        await storage.rm(layout.lock, { recursive: true, force: true }).catch(() => {})
        throw err
      }
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }

    const owner = await readLockOwner(layout.lock, storage)
    if (isProcessAlive(owner.pid)) {
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Storage is already locked')
    }
    await recoverDeadLock(layout.lock, owner, storage)
  }

  return async function releaseStorageLock() {
    await removeMovedLock(layout.lock, token, storage)
  }
}

module.exports = {
  initLayout,
  acquireStorageLock,
  assertSafeDirectory,
  assertSafeFile
}
