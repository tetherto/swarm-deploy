'use strict'

const fs = require('#fs')
const path = require('#path')
const crypto = require('#crypto')
const { SwarmDeployError, ERRORS } = require('./errors')

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DEFAULT_CHUNK_SIZE = 1024 * 1024

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

async function buildFileManifest(filePath, opts = {}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE
  const initialStat = await fs.promises.lstat(filePath)

  if (initialStat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }
  if (!initialStat.isFile()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }

  const name = validateBasename(path.basename(filePath))
  const before = snapshotStat(initialStat)

  const wholeHash = crypto.createHash('sha256')
  const chunkDigests = []
  let pending = Buffer.alloc(0)

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)

    stream.on('data', (chunk) => {
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
