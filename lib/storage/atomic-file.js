'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { withSafeDirectoryIdentity, openSafeRegularFile } = require('./layout')

// Enough for 262,144 hex chunk digests while bounding untrusted on-disk reads.
const MAX_SESSION_METADATA_BYTES = 32 * 1024 * 1024
const ATOMIC_WRITE_PHASE = Object.freeze({
  BEFORE_RENAME: 'before-rename',
  AFTER_RENAME: 'after-rename'
})

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function markAtomicWriteError(err, phase) {
  err.atomicWritePhase = phase
  return err
}

function atomicWriteRenamed(err) {
  return err?.atomicWritePhase === ATOMIC_WRITE_PHASE.AFTER_RENAME
}

function randomSuffix() {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

async function assertRegularOrAbsent(filePath, storage) {
  try {
    const stat = await storage.lstat(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storageError(`Unsafe metadata file: ${filePath}`)
    }
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write atomic metadata')
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
      throw storageError('Truncated metadata file')
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

async function writeAtomic(filePath, bytes, storage = fs.promises) {
  if (!(b4a.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    throw storageError('Atomic metadata must be bytes')
  }

  const directory = path.dirname(filePath)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomSuffix()}.tmp`)
  let renamed = false
  try {
    await withSafeDirectoryIdentity(directory, storage, () =>
      assertRegularOrAbsent(filePath, storage)
    )
    await withSafeDirectoryIdentity(directory, storage, async () => {
      const handle = await storage.open(temporary, 'wx', 0o600)
      try {
        await writeAll(handle, bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })

    await withSafeDirectoryIdentity(directory, storage, () =>
      assertRegularOrAbsent(filePath, storage)
    )
    await withSafeDirectoryIdentity(directory, storage, async () => {
      await storage.rename(temporary, filePath)
      renamed = true
    })
    await withSafeDirectoryIdentity(directory, storage, () => syncDirectory(directory, storage))
  } catch (err) {
    if (!renamed) {
      await withSafeDirectoryIdentity(directory, storage, () => storage.unlink(temporary)).catch(
        () => {}
      )
    }
    throw markAtomicWriteError(
      err,
      renamed ? ATOMIC_WRITE_PHASE.AFTER_RENAME : ATOMIC_WRITE_PHASE.BEFORE_RENAME
    )
  }
}

async function readJson(filePath, storage = fs.promises, maxBytes = MAX_SESSION_METADATA_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw storageError('Invalid metadata size limit')
  }
  const directory = path.dirname(filePath)
  return withSafeDirectoryIdentity(directory, storage, async () => {
    let handle = null
    try {
      handle = await openSafeRegularFile(filePath, 'read', storage)
      const stat = await handle.stat()
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
        throw storageError(`Metadata file exceeds ${maxBytes} byte limit`)
      }
      const parsed = JSON.parse(b4a.toString(await readAll(handle, stat.size), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw storageError(`Malformed metadata file: ${filePath}`)
      }
      return parsed
    } catch (err) {
      if (err instanceof SwarmDeployError) throw err
      throw storageError(`Malformed metadata file: ${filePath}`, err)
    } finally {
      if (handle) await handle.close()
    }
  })
}

module.exports = {
  writeAtomic,
  readJson,
  MAX_SESSION_METADATA_BYTES,
  ATOMIC_WRITE_PHASE,
  atomicWriteRenamed
}
