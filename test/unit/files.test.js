'use strict'

const test = require('brittle')
const fs = require('#fs')
const path = require('#path')
const {
  SwarmDeployError,
  ERRORS,
  validateBasename,
  selectUploadPaths,
  buildFileManifest
} = require('../..')
const {
  CHUNK_SIZE,
  createTempDir,
  expectedManifest,
  writeDeterministicFile
} = require('../helpers/files')

test('validateBasename accepts safe names and rejects unsafe names', (t) => {
  t.is(validateBasename('artifact-linux-x64.tar.gz'), 'artifact-linux-x64.tar.gz')
  t.exception(() => validateBasename('../artifact'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
  t.exception(() => validateBasename('.swarm-deploy'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
  t.exception(() => validateBasename('artifact name'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
  t.exception(() => validateBasename('é'), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
})

test('buildFileManifest hashes boundary sizes with logical chunks', async (t) => {
  const dir = await createTempDir(t)
  const sizes = [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 17]

  for (const size of sizes) {
    const name = `file-${size}.bin`
    const filePath = path.join(dir, name)
    await writeDeterministicFile(filePath, size)

    const manifest = await buildFileManifest(filePath)
    const expected = expectedManifest(size)

    t.is(manifest.path, filePath)
    t.is(manifest.name, name)
    t.is(manifest.size, expected.size)
    t.alike(manifest.digest, expected.digest)
    t.is(manifest.chunkCount, expected.chunkCount)
    t.is(manifest.chunkSize, expected.chunkSize)
    t.is(manifest.chunkDigests.length, expected.chunkDigests.length)
    for (let i = 0; i < expected.chunkDigests.length; i++) {
      t.alike(manifest.chunkDigests[i], expected.chunkDigests[i], `chunk ${i} for size ${size}`)
    }
    t.is(manifest.stat.size, size)
    t.is(typeof manifest.stat.mtimeMs, 'number')
    t.is(typeof manifest.stat.ino, 'number')
  }
})

test('buildFileManifest assembles logical chunks independent of stream size', async (t) => {
  const dir = await createTempDir(t)
  const size = CHUNK_SIZE + 1
  const filePath = path.join(dir, 'stream-chunks.bin')
  await writeDeterministicFile(filePath, size)

  const original = fs.createReadStream
  fs.createReadStream = function patchedCreateReadStream(p, opts = {}) {
    return original.call(fs, p, { ...opts, highWaterMark: 17 })
  }
  t.teardown(() => {
    fs.createReadStream = original
  })

  const manifest = await buildFileManifest(filePath)
  const expected = expectedManifest(size)
  t.alike(manifest.digest, expected.digest)
  t.is(manifest.chunkCount, expected.chunkCount)
  t.alike(manifest.chunkDigests, expected.chunkDigests)
})

test('buildFileManifest rejects mutation during hashing', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'mutable.bin')
  await writeDeterministicFile(filePath, 8 * CHUNK_SIZE)

  const original = fs.createReadStream
  let chunks = 0
  fs.createReadStream = function patchedCreateReadStream(p, opts) {
    const stream = original.call(fs, p, opts)
    stream.on('data', () => {
      chunks++
      if (chunks === 2) {
        fs.utimesSync(p, new Date(), new Date(Date.now() + 1000))
      }
    })
    return stream
  }
  t.teardown(() => {
    fs.createReadStream = original
  })

  await t.exception(() => buildFileManifest(filePath), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_BUSY
  })
})

test('selectUploadPaths selects sorted regular files and skips others', async (t) => {
  const dir = await createTempDir(t)
  await writeDeterministicFile(path.join(dir, 'b.bin'), 1)
  await writeDeterministicFile(path.join(dir, 'a.bin'), 1)
  await fs.promises.mkdir(path.join(dir, 'nested'))
  await fs.promises.writeFile(path.join(dir, 'nested', 'inside.bin'), 'x')
  await fs.promises.symlink('a.bin', path.join(dir, 'link.bin'))
  await fs.promises.symlink(path.join(dir, 'nested'), path.join(dir, 'dir-link'))

  const selection = await selectUploadPaths(dir)

  t.alike(
    selection.paths.map((p) => path.basename(p)),
    ['a.bin', 'b.bin']
  )
  t.is(selection.skipped.length, 3)
  t.alike(
    selection.skipped.map((entry) => entry.name).sort(),
    ['dir-link', 'link.bin', 'nested']
  )
  for (const entry of selection.skipped) {
    t.ok(entry.path.startsWith(dir))
    t.ok(entry.reason === 'directory' || entry.reason === 'symlink')
  }
})

test('selectUploadPaths accepts a regular file and rejects a symlink input', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'solo.bin')
  await writeDeterministicFile(filePath, 3)

  const fileSelection = await selectUploadPaths(filePath)
  t.alike(fileSelection.paths, [filePath])
  t.alike(fileSelection.skipped, [])

  await fs.promises.symlink(filePath, path.join(dir, 'solo-link'))
  await t.exception(() => selectUploadPaths(path.join(dir, 'solo-link')), {
    name: 'SwarmDeployError'
  })
})
