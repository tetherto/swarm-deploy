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
  t.alike(selection.skipped.map((entry) => entry.name).sort(), ['dir-link', 'link.bin', 'nested'])
  for (const entry of selection.skipped) {
    t.ok(entry.path.startsWith(dir))
    t.ok(entry.reason === 'directory' || entry.reason === 'symlink')
  }
})

test('buildFileManifest rejects invalid chunkSize values', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'chunk.bin')
  await writeDeterministicFile(filePath, 1)

  for (const chunkSize of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '1024']) {
    await t.exception(
      () => buildFileManifest(filePath, { chunkSize }),
      {
        name: 'SwarmDeployError',
        code: ERRORS.PROTOCOL_INVALID
      },
      `chunkSize ${String(chunkSize)}`
    )
  }
})

test('selectUploadPaths skips regular files with invalid basenames', async (t) => {
  const dir = await createTempDir(t)
  await writeDeterministicFile(path.join(dir, 'good.bin'), 1)
  await writeDeterministicFile(path.join(dir, '.hidden'), 1)
  await writeDeterministicFile(path.join(dir, 'bad name'), 1)

  const selection = await selectUploadPaths(dir)

  t.alike(
    selection.paths.map((p) => path.basename(p)),
    ['good.bin']
  )
  t.is(selection.skipped.length, 2)
  t.alike(selection.skipped.map((entry) => entry.name).sort(), ['.hidden', 'bad name'])
  for (const entry of selection.skipped) {
    t.is(entry.reason, 'invalid-filename')
  }
})

test('buildFileManifest opens files with O_NOFOLLOW', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'nofollow.bin')
  await writeDeterministicFile(filePath, 8)

  const originalOpen = fs.promises.open
  let seenFlags = null
  fs.promises.open = async function patchedOpen(openPath, flags, mode) {
    seenFlags = flags
    return originalOpen.call(this, openPath, flags, mode)
  }
  t.teardown(() => {
    fs.promises.open = originalOpen
  })

  await buildFileManifest(filePath)

  const O_NOFOLLOW = fs.constants?.O_NOFOLLOW ?? 0x100
  t.ok((seenFlags & O_NOFOLLOW) !== 0, 'open flags include O_NOFOLLOW')
})

test('buildFileManifest rejects symlink swapped after lstat', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'swap.bin')
  const otherPath = path.join(dir, 'other.bin')
  await writeDeterministicFile(filePath, 5)
  await writeDeterministicFile(otherPath, 5)

  const originalLstat = fs.promises.lstat
  let lstatCalls = 0
  fs.promises.lstat = async function patchedLstat(lstatPath, opts) {
    const stat = await originalLstat.call(this, lstatPath, opts)
    if (lstatPath === filePath && lstatCalls++ === 0) {
      await fs.promises.rename(filePath, path.join(dir, 'moved.bin'))
      await fs.promises.symlink(otherPath, filePath)
    }
    return stat
  }
  t.teardown(() => {
    fs.promises.lstat = originalLstat
  })

  await t.exception(() => buildFileManifest(filePath), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
})

test('buildFileManifest rejects when bytes read mismatch initial size', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'short-read.bin')
  await writeDeterministicFile(filePath, 10)

  const originalLstat = fs.promises.lstat
  let calls = 0
  fs.promises.lstat = async function patchedLstat(lstatPath, opts) {
    const stat = await originalLstat.call(this, lstatPath, opts)
    if (lstatPath === filePath && ++calls === 1) {
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        size: stat.size + 5
      })
    }
    return stat
  }
  t.teardown(() => {
    fs.promises.lstat = originalLstat
  })

  await t.exception(() => buildFileManifest(filePath), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_BUSY
  })
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
