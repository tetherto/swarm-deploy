'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { assertSafeDirectory } = require('./layout')

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
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
  await assertSafeDirectory(directory, storage)
  await assertRegularOrAbsent(filePath, storage)

  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomSuffix()}.tmp`)
  let handle = null
  try {
    handle = await storage.open(temporary, 'wx', 0o600)
    await writeAll(handle, bytes)
    await handle.sync()
    await handle.close()
    handle = null

    await assertRegularOrAbsent(filePath, storage)
    await storage.rename(temporary, filePath)
    await syncDirectory(directory, storage)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await storage.unlink(temporary).catch(() => {})
    throw err
  }
}

async function readJson(filePath, storage = fs.promises) {
  await assertRegularOrAbsent(filePath, storage)
  let parsed
  try {
    parsed = JSON.parse(await storage.readFile(filePath, 'utf8'))
  } catch (err) {
    throw storageError(`Malformed metadata file: ${filePath}`, err)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw storageError(`Malformed metadata file: ${filePath}`)
  }
  return parsed
}

module.exports = {
  writeAtomic,
  readJson
}
