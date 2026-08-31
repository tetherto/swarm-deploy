'use strict'

const fs = require('#fs')
const path = require('#path')
const crypto = require('#crypto')
const { SwarmDeployError, ERRORS } = require('./errors')

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DEFAULT_CHUNK_SIZE = 1024 * 1024

function platformName() {
  if (typeof Bare !== 'undefined') {
    return require('bare-os').platform()
  }
  return require('os').platform()
}

function noFollowFlag() {
  if (fs.constants?.O_NOFOLLOW !== undefined) {
    return fs.constants.O_NOFOLLOW
  }

  const platform = platformName()
  if (platform === 'darwin') return 0x100
  if (platform === 'linux') return 0x20000

  throw new SwarmDeployError(
    ERRORS.PROTOCOL_INVALID,
    'Safe file open is unsupported on this platform'
  )
}

function openReadFlags() {
  const O_RDONLY = fs.constants?.O_RDONLY ?? 0
  return O_RDONLY | noFollowFlag()
}

function validatePositiveSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
  return value
}

function resolveChunkSize(opts = {}) {
  if (opts.chunkSize === undefined) return DEFAULT_CHUNK_SIZE
  return validatePositiveSafeInteger(opts.chunkSize, 'chunkSize')
}

function validateBasename(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid filename')
  }
  return name
}

function snapshotStat(stat) {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino
  }
}

function assertStableStat(before, after) {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'File changed during pre-hash')
  }
}

function classifyEntry(entryPath, stat) {
  if (stat.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink' }
  }
  if (stat.isDirectory()) {
    return { kind: 'skipped', reason: 'directory' }
  }
  if (!stat.isFile()) {
    return { kind: 'skipped', reason: 'not-regular-file' }
  }

  const name = path.basename(entryPath)
  try {
    validateBasename(name)
  } catch (err) {
    return { kind: 'skipped', reason: 'invalid-filename', error: err }
  }

  return { kind: 'selected', name }
}

async function selectUploadPaths(inputPath) {
  const rootStat = await fs.promises.lstat(inputPath)

  if (rootStat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }

  if (rootStat.isFile()) {
    validateBasename(path.basename(inputPath))
    return { paths: [inputPath], skipped: [] }
  }

  if (!rootStat.isDirectory()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file or directory')
  }

  const names = await fs.promises.readdir(inputPath)
  names.sort()

  const paths = []
  const skipped = []

  for (const name of names) {
    const entryPath = path.join(inputPath, name)
    const entryStat = await fs.promises.lstat(entryPath)
    const classified = classifyEntry(entryPath, entryStat)

    if (classified.kind === 'selected') {
      paths.push(entryPath)
      continue
    }

    skipped.push({
      name,
      path: entryPath,
      reason: classified.reason
    })
  }

  return { paths, skipped }
}

async function openRegularFileNoFollow(filePath) {
  try {
    return await fs.promises.open(filePath, openReadFlags())
  } catch (err) {
    if (err && err.code === 'ELOOP') {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported', err)
    }
    throw err
  }
}

async function buildFileManifest(filePath, opts = {}) {
  const chunkSize = resolveChunkSize(opts)
  const initialStat = await fs.promises.lstat(filePath)

  if (initialStat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }
  if (!initialStat.isFile()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }

  const name = validateBasename(path.basename(filePath))
  const before = snapshotStat(initialStat)
  const handle = await openRegularFileNoFollow(filePath)

  const wholeHash = crypto.createHash('sha256')
  const chunkDigests = []
  let pending = Buffer.alloc(0)
  let bytesRead = 0

  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { fd: handle.fd, autoClose: false })

      stream.on('data', (chunk) => {
        bytesRead += chunk.length
        wholeHash.update(chunk)

        if (pending.length > 0) {
          const combined = Buffer.allocUnsafe(pending.length + chunk.length)
          pending.copy(combined, 0)
          chunk.copy(combined, pending.length)
          pending = combined
        } else {
          pending = Buffer.from(chunk)
        }

        while (pending.length >= chunkSize) {
          const logical = pending.subarray(0, chunkSize)
          chunkDigests.push(crypto.createHash('sha256').update(logical).digest())
          pending = pending.subarray(chunkSize)
        }
      })

      stream.on('error', reject)
      stream.on('end', () => {
        if (pending.length > 0) {
          chunkDigests.push(crypto.createHash('sha256').update(pending).digest())
        }
        resolve()
      })
    })
  } finally {
    await handle.close().catch(() => {})
  }

  if (bytesRead !== before.size) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'File size mismatch during pre-hash')
  }

  const finalStat = await fs.promises.lstat(filePath)
  assertStableStat(before, snapshotStat(finalStat))

  return {
    path: filePath,
    name,
    size: before.size,
    digest: wholeHash.digest(),
    chunkDigests,
    chunkCount: chunkDigests.length,
    chunkSize,
    stat: before
  }
}

module.exports = {
  validateBasename,
  selectUploadPaths,
  buildFileManifest
}
