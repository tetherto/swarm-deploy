'use strict'

const fs = require('#fs')
const path = require('#path')
const crypto = require('#crypto')

const CHUNK_SIZE = 1024 * 1024

function systemTmpdir() {
  if (typeof Bare !== 'undefined') {
    return require('bare-os').tmpdir()
  }
  return require('os').tmpdir()
}

async function createTempDir(t) {
  const root = await fs.promises.realpath(systemTmpdir())
  const dir = path.join(root, `swarm-deploy-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.promises.mkdir(dir, { recursive: true })
  if (t) t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

function deterministicByte(index) {
  return index & 0xff
}

function digestBuffer(data) {
  return crypto.createHash('sha256').update(data).digest()
}

function expectedManifest(size, chunkSize = CHUNK_SIZE) {
  const whole = crypto.createHash('sha256')
  const chunkDigests = []
  let offset = 0

  while (offset < size) {
    const end = Math.min(offset + chunkSize, size)
    const chunk = Buffer.allocUnsafe(end - offset)
    for (let i = offset; i < end; i++) {
      chunk[i - offset] = deterministicByte(i)
    }
    whole.update(chunk)
    chunkDigests.push(digestBuffer(chunk))
    offset = end
  }

  return {
    size,
    digest: whole.digest(),
    chunkDigests,
    chunkCount: chunkDigests.length,
    chunkSize
  }
}

async function writeDeterministicFile(filePath, size) {
  const fd = await fs.promises.open(filePath, 'w')
  try {
    const chunkLen = 64 * 1024
    let offset = 0
    while (offset < size) {
      const end = Math.min(offset + chunkLen, size)
      const chunk = Buffer.allocUnsafe(end - offset)
      for (let i = offset; i < end; i++) {
        chunk[i - offset] = deterministicByte(i)
      }
      await fd.write(chunk, 0, chunk.byteLength)
      offset = end
    }
  } finally {
    await fd.close()
  }
}

module.exports = {
  CHUNK_SIZE,
  createTempDir,
  deterministicByte,
  digestBuffer,
  expectedManifest,
  writeDeterministicFile
}
