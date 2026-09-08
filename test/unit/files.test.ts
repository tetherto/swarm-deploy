/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/index.js'
import {
  validateBasename,
  selectUploadPaths,
  buildFileManifest,
  historyName,
  isReservedHistoryName,
  validateReplaceNames,
  type BuildFileManifestOptions
} from '../../dist/files.js'
import { createAbortController } from '../../dist/abort.js'
import {
  CHUNK_SIZE,
  createTempDir,
  expectedManifest,
  writeDeterministicFile
} from '../helpers/files.js'
import {
  blockManifestAfterFirstRead,
  settledError,
  settlePromptly
} from '../helpers/cancellation.js'

interface ErrnoError extends Error {
  code?: string
}

/** The stream members the read-stream patches wrap. */
interface PatchableStream {
  on(event: string, listener: (chunk: Buffer) => void): unknown
  destroy(): void
  emit(event: string): boolean
}

/** A mutable view of the members these tests replace on the runtime `fs`. */
interface PatchableFs {
  createReadStream(filePath: string, options?: Record<string, unknown>): PatchableStream
  promises: {
    lstat(lstatPath: string, options?: unknown): Promise<unknown>
  }
}

const patchable = fs as unknown as PatchableFs

/** Chunk sizes the manifest builder must reject, including a non-number. */
function invalidChunkSize(value: number | string): BuildFileManifestOptions {
  return { chunkSize: value } as unknown as BuildFileManifestOptions
}

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

test('isReservedHistoryName reserves only the exact history prefix', (t) => {
  t.is(isReservedHistoryName('history-a'), true)
  t.is(isReservedHistoryName('history-'), true)
  t.is(isReservedHistoryName(`history-${'a'.repeat(64)}`), true)
  t.is(isReservedHistoryName('history'), false)
  t.is(isReservedHistoryName('historyx'), false)
  t.is(isReservedHistoryName('release.tar.gz'), false)
})

test('historyName derives a valid basename from a full transfer ID', (t) => {
  const id = 'a'.repeat(64)

  t.is(historyName(id), `history-${id}`)
  t.is(validateBasename(historyName(id)), `history-${id}`)
  t.is(isReservedHistoryName(historyName(id)), true)
  for (const invalid of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '']) {
    t.exception(() => historyName(invalid), {
      name: 'SwarmDeployError',
      code: ERRORS.PROTOCOL_INVALID
    })
  }
})

test('validateReplaceNames copies exact upload names and rejects reserved input', (t) => {
  t.alike(validateReplaceNames(), new Set())
  t.alike(validateReplaceNames(undefined), new Set())
  t.alike(
    validateReplaceNames(['release.tar.gz', 'manifest.json']),
    new Set(['release.tar.gz', 'manifest.json'])
  )

  function* names(): Generator<string> {
    yield 'release.tar.gz'
  }
  t.alike(validateReplaceNames(names()), new Set(['release.tar.gz']))

  const source = ['release.tar.gz']
  const copied = validateReplaceNames(source)
  source.push('manifest.json')
  t.alike(copied, new Set(['release.tar.gz']))

  for (const invalid of [['history-a'], [`history-${'a'.repeat(64)}`], ['.swarm-deploy'], ['']]) {
    t.exception(() => validateReplaceNames(invalid), {
      name: 'SwarmDeployError',
      code: ERRORS.INVALID_FILENAME
    })
  }
  t.exception(() => validateReplaceNames(['release.tar.gz', 'release.tar.gz']), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  for (const invalid of ['release.tar.gz', 7, {}, [1]]) {
    t.exception(() => validateReplaceNames(invalid as unknown as Iterable<string>), {
      name: 'SwarmDeployError'
    })
  }
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
  const chunkSize = 128
  const size = chunkSize + 1
  const filePath = path.join(dir, 'stream-chunks.bin')
  await writeDeterministicFile(filePath, size)

  const original = patchable.createReadStream
  patchable.createReadStream = function patchedCreateReadStream(p, opts = {}) {
    return original.call(patchable, p, { ...opts, highWaterMark: 17 })
  }
  t.teardown(() => {
    patchable.createReadStream = original
  })

  const manifest = await buildFileManifest(filePath, { chunkSize })
  const expected = expectedManifest(size, chunkSize)
  t.alike(manifest.digest, expected.digest)
  t.is(manifest.chunkCount, expected.chunkCount)
  t.alike(manifest.chunkDigests, expected.chunkDigests)
})

test('buildFileManifest rejects mutation during hashing', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'mutable.bin')
  await writeDeterministicFile(filePath, 8 * CHUNK_SIZE)

  const original = patchable.createReadStream
  let chunks = 0
  patchable.createReadStream = function patchedCreateReadStream(p, opts) {
    const stream = original.call(patchable, p, opts)
    stream.on('data', () => {
      chunks++
      if (chunks === 2) {
        fs.utimesSync(p, new Date(), new Date(Date.now() + 1000))
      }
    })
    return stream
  }
  t.teardown(() => {
    patchable.createReadStream = original
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

test('selectUploadPaths rejects direct history names and skips them in batches', async (t) => {
  const dir = await createTempDir(t)
  const reserved = path.join(dir, 'history-private.bin')
  const accepted = path.join(dir, 'release.bin')
  await writeDeterministicFile(reserved, 1)
  await writeDeterministicFile(accepted, 1)

  await t.exception(() => selectUploadPaths(reserved), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })

  const selection = await selectUploadPaths(dir)
  t.alike(selection.paths, [accepted])
  t.alike(
    selection.skipped.map((entry) => [entry.name, entry.reason]),
    [['history-private.bin', 'reserved-history']]
  )
  t.alike(
    selection.entries.map((entry) => [entry.name, entry.kind]),
    [
      ['history-private.bin', 'skipped'],
      ['release.bin', 'selected']
    ]
  )
})

test('buildFileManifest rejects invalid chunkSize values', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'chunk.bin')
  await writeDeterministicFile(filePath, 1)

  for (const chunkSize of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '1024']) {
    await t.exception(
      () => buildFileManifest(filePath, invalidChunkSize(chunkSize)),
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

test('buildFileManifest rejects an initial symlink before opening', async (t) => {
  const dir = await createTempDir(t)
  const targetPath = path.join(dir, 'target.bin')
  const linkPath = path.join(dir, 'link.bin')
  await writeDeterministicFile(targetPath, 4)
  await fs.promises.symlink(targetPath, linkPath)

  await t.exception(() => buildFileManifest(linkPath), {
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
})

test('buildFileManifest maps ELOOP from no-follow open to INVALID_FILENAME', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'swap.bin')
  const otherPath = path.join(dir, 'other.bin')
  await writeDeterministicFile(filePath, 5)
  await writeDeterministicFile(otherPath, 5)

  const originalLstat = patchable.promises.lstat
  let lstatCalls = 0
  patchable.promises.lstat = async function patchedLstat(
    this: unknown,
    lstatPath: string,
    opts?: unknown
  ) {
    const stat = await originalLstat.call(this, lstatPath, opts)
    if (lstatPath === filePath && lstatCalls++ === 0) {
      await fs.promises.rename(filePath, path.join(dir, 'moved.bin'))
      await fs.promises.symlink(otherPath, filePath)
    }
    return stat
  }
  t.teardown(() => {
    patchable.promises.lstat = originalLstat
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

  const original = patchable.createReadStream
  patchable.createReadStream = function patchedCreateReadStream(p, opts = {}) {
    const stream = original.call(patchable, p, opts)
    const origOn = stream.on.bind(stream)
    stream.on = function (event, listener) {
      if (event === 'data') {
        return origOn(event, (chunk) => {
          listener(chunk.subarray(0, 5))
          stream.destroy()
          stream.emit('end')
        })
      }
      return origOn(event, listener)
    }
    return stream
  }
  t.teardown(() => {
    patchable.createReadStream = original
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
    name: 'SwarmDeployError',
    code: ERRORS.INVALID_FILENAME
  })
})

test('selectUploadPaths records unreadable directory entries and continues lexically', async (t) => {
  const dir = await createTempDir(t)
  const blocked = path.join(dir, 'a-blocked.bin')
  const good = path.join(dir, 'b-good.bin')
  await writeDeterministicFile(blocked, 1)
  await writeDeterministicFile(good, 1)
  const original = patchable.promises.lstat
  patchable.promises.lstat = function patchedLstat(
    this: unknown,
    entryPath: string,
    opts?: unknown
  ) {
    if (entryPath === blocked) {
      const error: ErrnoError = new Error('denied')
      error.code = 'EACCES'
      throw error
    }
    return original.call(this, entryPath, opts)
  }
  t.teardown(() => {
    patchable.promises.lstat = original
  })

  const selection = await selectUploadPaths(dir)
  t.alike(selection.paths, [good])
  t.alike(
    selection.failed.map((entry) => [entry.name, entry.reason, entry.code]),
    [['a-blocked.bin', 'unreadable', 'EACCES']]
  )
})

test('file selection and hashing abort with a typed error', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'abort.bin')
  await writeDeterministicFile(filePath, 1024)
  const controller = createAbortController()
  controller.abort()

  await t.exception(() => selectUploadPaths(dir, { signal: controller.signal }), {
    name: 'SwarmDeployError',
    code: 'ABORTED'
  })
  await t.exception(() => buildFileManifest(filePath, { signal: controller.signal }), {
    name: 'SwarmDeployError',
    code: 'ABORTED'
  })
})

test('buildFileManifest aborts an active hash and closes its stream and descriptor', async (t) => {
  const dir = await createTempDir(t)
  const filePath = path.join(dir, 'active-abort.bin')
  await writeDeterministicFile(filePath, 4 * CHUNK_SIZE)
  const blocked = blockManifestAfterFirstRead(t, filePath)
  const controller = createAbortController()
  const hashing = buildFileManifest(filePath, { signal: controller.signal })

  await blocked.started
  t.is(blocked.state.reads, 1)
  controller.abort()

  const [hashResult] = await settlePromptly([hashing, blocked.streamClosed])
  t.is(hashResult.status, 'rejected')
  t.is(settledError(hashResult).name, 'SwarmDeployError')
  t.is(settledError(hashResult).code, ERRORS.ABORTED)
  t.ok(blocked.state.streamClosed)
  t.ok(blocked.state.descriptorCloseAttempted)
  await t.exception(() => blocked.state.descriptor?.stat?.(), { code: 'EBADF' })
})
