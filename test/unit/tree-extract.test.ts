/// <reference path="../types/brittle.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { createAbortController } from '../../dist/abort.js'
import { ERRORS } from '../../dist/errors.js'
import {
  treeMetadataFromManifest,
  buildTreeManifest,
  regenerateTreeTarSuffix
} from '../../dist/tar-protocol/tree-manifest.js'
import {
  validateAndExtractTreeTar,
  type TreeExtractionTarget
} from '../../dist/tar-protocol/tree-extract.js'
import { canonicalUstarTreeHeader } from '../../dist/tar-protocol/ustar.js'
import type { TreeMetadataRecord } from '../../dist/tar-protocol/controls.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 57)
const BLOCK = 512

interface MemoryTarget extends TreeExtractionTarget {
  directories: string[]
  files: Map<string, Buffer>
  aborted: unknown
  aborts: number
  openSinks: number
  completed: boolean
}

function memoryTarget(): MemoryTarget {
  const directories: string[] = []
  const files = new Map<string, Buffer>()
  const target: MemoryTarget = {
    directories,
    files,
    aborted: null,
    aborts: 0,
    openSinks: 0,
    completed: false,
    createDirectory(relativePath) {
      directories.push(relativePath)
      return Promise.resolve()
    },
    createFile(relativePath) {
      const chunks: Buffer[] = []
      target.openSinks++
      return Promise.resolve({
        write(chunk) {
          chunks.push(b4a.from(chunk))
          return Promise.resolve()
        },
        close() {
          target.openSinks--
          files.set(relativePath, b4a.concat(chunks))
          return Promise.resolve()
        }
      })
    },
    complete() {
      target.completed = true
      return Promise.resolve()
    },
    abort(error) {
      target.aborts++
      target.aborted = error
      return Promise.resolve()
    }
  }
  return target
}

async function fixture(
  t: Assert,
  spec: Record<string, string>
): Promise<{ metadata: TreeMetadataRecord; archive: Buffer }> {
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(source)
  await writeTree(source, spec)
  const manifest = await buildTreeManifest(source, OWNER)
  const chunks: Buffer[] = []
  await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { metadata: treeMetadataFromManifest(manifest), archive: b4a.concat(chunks) }
}

function feed(archive: Buffer, size = 97): Buffer[] {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < archive.byteLength; offset += size) {
    chunks.push(archive.subarray(offset, Math.min(offset + size, archive.byteLength)))
  }
  return chunks
}

/** Recomputes a header checksum so a mutation is judged on its own merit, not on the checksum. */
function seal(block: Buffer): Buffer {
  block.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.set(b4a.from(`${sum.toString(8).padStart(6, '0')} `), 148)
  block[155] = 0
  return block
}

/** A header for `name` that the canonical builder would refuse, with a valid checksum. */
function rawHeader(name: string, kind: 'file' | 'directory', size: number): Buffer {
  const header = canonicalUstarTreeHeader(kind === 'directory' ? 'x/' : 'x', kind, size)
  header.fill(0, 0, 100)
  header.set(b4a.from(name), 0)
  return seal(header)
}

function payload(size: number): Buffer[] {
  if (size === 0) return []
  return [b4a.alloc(size, 7), b4a.alloc((BLOCK - (size % BLOCK)) % BLOCK)].filter(
    (chunk) => chunk.byteLength > 0
  )
}

/** Builds an archive and offer from raw parts; digests are never reached by these cases. */
function crafted(
  parts: Buffer[],
  entryCount: number,
  payloadBytes: number
): { metadata: TreeMetadataRecord; archive: Buffer } {
  const archive = b4a.concat([...parts, b4a.alloc(2 * BLOCK)])
  return {
    archive,
    metadata: {
      v: 1,
      kind: 'directory',
      name: '0.18.1',
      entryCount,
      payloadBytes,
      treeSha256: 'a'.repeat(64),
      tarSize: archive.byteLength,
      tarSha256: 'b'.repeat(64),
      transferId: 'c'.repeat(64),
      reset: false
    }
  }
}

async function rejects(
  t: Assert,
  input: { metadata: TreeMetadataRecord; archive: Buffer },
  code: RegExp | string,
  chunkSize = 97
): Promise<MemoryTarget> {
  const target = memoryTarget()
  await t.exception(
    () => validateAndExtractTreeTar(feed(input.archive, chunkSize), input.metadata, target),
    { code }
  )
  t.is(target.aborts, 1, 'the target is aborted exactly once')
  t.is(target.completed, false)
  t.is(target.openSinks, 0, 'no file sink is left open')
  return target
}

test('a canonical tree archive extracts with an independently recomputed digest', async (t) => {
  const { metadata, archive } = await fixture(t, {
    'a/b.bin': 'bb',
    'a/empty/': '',
    'z.bin': 'zzz'
  })
  const target = memoryTarget()
  const result = await validateAndExtractTreeTar(feed(archive), metadata, target)
  t.is(result.entryCount, metadata.entryCount)
  t.is(result.payloadBytes, metadata.payloadBytes)
  t.is(result.tarSize, metadata.tarSize)
  t.is(b4a.toString(result.treeSha256, 'hex'), metadata.treeSha256)
  t.is(b4a.toString(result.tarSha256, 'hex'), metadata.tarSha256)
  t.alike(target.directories, ['a', 'a/empty'])
  t.alike([...target.files.keys()].sort(), ['a/b.bin', 'z.bin'])
  t.alike(target.files.get('a/b.bin'), b4a.from('bb'))
  t.is(target.completed, true)
  t.is(target.aborted, null)
  t.is(target.aborts, 0)
})

test('extraction is independent of how the archive is chunked', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a/b.bin': 'x'.repeat(1300), 'z.bin': '' })
  for (const size of [1, 7, 511, 512, 513, archive.byteLength]) {
    const target = memoryTarget()
    const result = await validateAndExtractTreeTar(feed(archive, size), metadata, target)
    t.is(b4a.toString(result.treeSha256, 'hex'), metadata.treeSha256)
    t.alike(target.files.get('a/b.bin'), b4a.from('x'.repeat(1300)))
    t.alike(target.files.get('z.bin'), b4a.alloc(0))
  }
})

test('an empty directory artifact extracts to no entries', async (t) => {
  const { metadata, archive } = await fixture(t, {})
  const target = memoryTarget()
  const result = await validateAndExtractTreeTar([archive], metadata, target)
  t.is(result.entryCount, 0)
  t.is(result.tarSize, 1024)
  t.alike(target.directories, [])
  t.is(target.files.size, 0)
  t.is(target.completed, true)
})

test('extraction rejects a tampered header in a real archive', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a/b.bin': 'bb', 'z.bin': 'zzz' })
  // Block layout: 0 a/, 512 a/b.bin, 1024 payload, 1536 z.bin, 2048 payload, 2560 end.
  const mutate = async (offset: number, change: (block: Buffer) => void): Promise<void> => {
    const bytes = b4a.from(archive)
    const block = bytes.subarray(offset, offset + BLOCK)
    change(block)
    seal(block)
    await rejects(t, { metadata, archive: bytes }, /PROTOCOL_INVALID/)
  }

  // Link, device, FIFO and PAX typeflags are never accepted.
  for (const typeflag of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K', '7']) {
    await mutate(0, (block) => {
      block[156] = typeflag.charCodeAt(0)
    })
    await mutate(BLOCK, (block) => {
      block[156] = typeflag.charCodeAt(0)
    })
  }
  // Non-canonical metadata fields, each re-checksummed so only the field is at fault.
  await mutate(BLOCK, (block) => block.set(b4a.from('000777 '), 100))
  await mutate(BLOCK, (block) => block.set(b4a.from('000001 '), 108))
  await mutate(BLOCK, (block) => block.set(b4a.from('000001 '), 116))
  await mutate(BLOCK, (block) => block.set(b4a.from('12345670000 '), 136))
  await mutate(BLOCK, (block) => block.set(b4a.from('evil'), 345))
  await mutate(BLOCK, (block) => block.set(b4a.from('root'), 265))
  await mutate(BLOCK, (block) => block.set(b4a.from('root'), 297))
  await mutate(BLOCK, (block) => block.set(b4a.from('ustar  '), 257))
  // A stale checksum.
  await rejects(
    t,
    {
      metadata,
      archive: (() => {
        const bytes = b4a.from(archive)
        bytes[BLOCK + 148] = 0x37
        return bytes
      })()
    },
    /PROTOCOL_INVALID/
  )
  // A directory whose name lost its trailing slash, and a file that gained one.
  await mutate(0, (block) => {
    block[1] = 0
  })
  await mutate(BLOCK, (block) => {
    block.fill(0, 0, 100)
    block.set(b4a.from('a/b.bin/'), 0)
  })
  // A name field with bytes after its terminator.
  await mutate(BLOCK, (block) => {
    block[50] = 0x41
  })
  // A directory that claims a payload.
  await mutate(0, (block) => block.set(b4a.from('00000000002 '), 124))
  // A file size that disagrees with the offered payload total.
  await mutate(BLOCK, (block) => block.set(b4a.from('00000000100 '), 124))
})

test('extraction rejects nonzero padding, terminator, payload, and digest drift', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a/b.bin': 'bb', 'z.bin': 'zzz' })
  const change = (offset: number, value: number): Buffer => {
    const bytes = b4a.from(archive)
    bytes[offset] = value
    return bytes
  }

  // Padding after the first file's two payload bytes.
  await rejects(t, { metadata, archive: change(BLOCK * 2 + 2, 1) }, /PROTOCOL_INVALID/)
  await rejects(t, { metadata, archive: change(BLOCK * 2 + BLOCK - 1, 1) }, /PROTOCOL_INVALID/)
  // Either terminator block.
  await rejects(t, { metadata, archive: change(archive.byteLength - 1, 1) }, /PROTOCOL_INVALID/)
  await rejects(t, { metadata, archive: change(archive.byteLength - 1024, 1) }, /PROTOCOL_INVALID/)
  // Payload corruption passes every structural rule and is caught by the digests.
  await rejects(t, { metadata, archive: change(BLOCK * 2, 0x42) }, ERRORS.CHECKSUM_MISMATCH)
  // A forged tree digest and a forged TAR digest.
  await rejects(
    t,
    { metadata: { ...metadata, treeSha256: 'f'.repeat(64) }, archive },
    ERRORS.CHECKSUM_MISMATCH
  )
  await rejects(
    t,
    { metadata: { ...metadata, tarSha256: 'f'.repeat(64) }, archive },
    ERRORS.CHECKSUM_MISMATCH
  )
})

test('extraction rejects a truncated archive and trailing data', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a/b.bin': 'bb', 'z.bin': 'zzz' })
  await rejects(
    t,
    { metadata, archive: archive.subarray(0, archive.byteLength - 1024) },
    ERRORS.PROTOCOL_INVALID
  )
  await rejects(t, { metadata, archive: archive.subarray(0, archive.byteLength - 1) }, /PROTOCOL/)
  // Cut inside a file payload: the open sink must be closed before the abort.
  await rejects(t, { metadata, archive: archive.subarray(0, BLOCK * 2 + 1) }, /PROTOCOL/)
  await rejects(t, { metadata, archive: archive.subarray(0, 1) }, /PROTOCOL/)
  await rejects(
    t,
    { metadata, archive: b4a.concat([archive, b4a.alloc(BLOCK)]) },
    ERRORS.PROTOCOL_INVALID
  )
  await rejects(
    t,
    { metadata, archive: b4a.concat([archive, b4a.from('x')]) },
    ERRORS.PROTOCOL_INVALID
  )
})

test('extraction rejects unsafe names even with a valid checksum', async (t) => {
  const names = [
    '../escape',
    '/etc/passwd',
    'a\\b.bin',
    './x',
    'a//b',
    'a/../b',
    '..',
    '.',
    '-leading',
    'history-deadbeef'
  ]
  for (const name of names) {
    await rejects(
      t,
      crafted([rawHeader(name, 'file', 1), ...payload(1)], 1, 1),
      /INVALID_FILENAME|PROTOCOL_INVALID/
    )
  }
  const deep = `${'d/'.repeat(33)}f`
  await rejects(t, crafted([rawHeader(deep, 'file', 1), ...payload(1)], 1, 1), /INVALID|PROTOCOL/)
  // A directory name carrying a NUL, and a file that is only a slash.
  await rejects(t, crafted([rawHeader('a\u0000b/', 'directory', 0)], 1, 0), /INVALID|PROTOCOL/)
  await rejects(t, crafted([rawHeader('/', 'directory', 0)], 1, 0), /INVALID|PROTOCOL/)
})

test('extraction rejects duplicate, case-colliding, and misordered entries', async (t) => {
  const dir = (name: string): Buffer => canonicalUstarTreeHeader(`${name}/`, 'directory', 0)
  await rejects(t, crafted([dir('a'), dir('a')], 2, 0), ERRORS.PROTOCOL_INVALID)
  await rejects(t, crafted([dir('b'), dir('a')], 2, 0), ERRORS.PROTOCOL_INVALID)
  await rejects(t, crafted([dir('A'), dir('a')], 2, 0), ERRORS.PROTOCOL_INVALID)
  await rejects(
    t,
    crafted(
      [
        dir('a'),
        canonicalUstarTreeHeader('a/B', 'file', 0),
        canonicalUstarTreeHeader('a/b', 'file', 0)
      ],
      3,
      0
    ),
    ERRORS.PROTOCOL_INVALID
  )
  // A file may not be given a child, and a directory and file cannot share a path.
  await rejects(
    t,
    crafted(
      [canonicalUstarTreeHeader('a', 'file', 0), canonicalUstarTreeHeader('a/b', 'file', 0)],
      2,
      0
    ),
    ERRORS.PROTOCOL_INVALID
  )
  await rejects(
    t,
    crafted([canonicalUstarTreeHeader('a', 'file', 0), dir('a')], 2, 0),
    ERRORS.PROTOCOL_INVALID
  )
})

test('extraction rejects a child before its parent and count or size bombs', async (t) => {
  await rejects(
    t,
    crafted([canonicalUstarTreeHeader('a/b.bin', 'file', 1), b4a.alloc(BLOCK)], 1, 1),
    ERRORS.PROTOCOL_INVALID
  )
  await rejects(
    t,
    crafted([canonicalUstarTreeHeader('a/b.bin', 'file', 0)], 1, 0),
    ERRORS.PROTOCOL_INVALID
  )

  // More entries than offered, with a TAR size that still fits the offered window.
  const headers: Buffer[] = []
  for (let index = 0; index < 4; index++) {
    headers.push(canonicalUstarTreeHeader(`d${index}/`, 'directory', 0))
  }
  const bomb = crafted(headers, 2, 0)
  await rejects(
    t,
    { archive: bomb.archive, metadata: { ...bomb.metadata, tarSize: 2 * BLOCK + 2 * BLOCK } },
    ERRORS.PROTOCOL_INVALID,
    BLOCK
  )
  // Fewer entries than offered.
  const sparse = crafted([canonicalUstarTreeHeader('d0/', 'directory', 0)], 1, 0)
  await rejects(
    t,
    { archive: sparse.archive, metadata: { ...sparse.metadata, entryCount: 2, tarSize: 2048 } },
    ERRORS.PROTOCOL_INVALID
  )
  // A file larger than the offered payload budget.
  await rejects(
    t,
    crafted([canonicalUstarTreeHeader('big', 'file', 600), ...payload(600)], 1, 600),
    ERRORS.CHECKSUM_MISMATCH
  )
  const oversized = crafted([canonicalUstarTreeHeader('big', 'file', 600), ...payload(600)], 1, 600)
  await rejects(
    t,
    { archive: oversized.archive, metadata: { ...oversized.metadata, payloadBytes: 513 } },
    ERRORS.PROTOCOL_INVALID
  )
  // A file size beyond the USTAR range never reaches the sink.
  const huge = rawHeader('huge', 'file', 1)
  huge.set(b4a.from('77777777777 '), 124)
  seal(huge)
  const hugeTarget = await rejects(t, crafted([huge, ...payload(1)], 1, 1), ERRORS.PROTOCOL_INVALID)
  t.is(hugeTarget.files.size, 0)
})

test('extraction rejects a malformed offer or target before any write', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a.bin': 'a' })
  const target = memoryTarget()
  await t.exception(
    () => validateAndExtractTreeTar([archive], { ...metadata, entryCount: 1.5 }, target),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  await t.exception(
    () =>
      validateAndExtractTreeTar([archive], metadata, {
        ...target,
        abort: undefined
      } as unknown as TreeExtractionTarget),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.is(target.directories.length + target.files.size, 0)
  t.is(target.aborts, 0)
})

test('extraction honours an abort signal and still aborts the target', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a.bin': 'a'.repeat(2000) })
  const controller = createAbortController()
  const target = memoryTarget()
  let delivered = 0
  async function* source(): AsyncGenerator<Buffer> {
    for (const chunk of feed(archive, 400)) {
      delivered++
      if (delivered === 2) controller.abort()
      yield chunk
    }
  }
  await t.exception(
    () => validateAndExtractTreeTar(source(), metadata, target, { signal: controller.signal }),
    { code: ERRORS.ABORTED }
  )
  t.is(target.aborts, 1)
  t.is(target.openSinks, 0)
  t.is(target.completed, false)
})

test('a failing target is surfaced as a stable error and aborted once', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a.bin': 'a' })
  const target = memoryTarget()
  target.createFile = () => Promise.reject(new Error('EACCES: /private/absolute/path'))
  let thrown: unknown = null
  try {
    await validateAndExtractTreeTar([archive], metadata, target)
  } catch (error) {
    thrown = error
  }
  t.is((thrown as { code?: string }).code, ERRORS.PROTOCOL_INVALID)
  t.absent(/EACCES|private/.test((thrown as Error).message))
  t.is(target.aborts, 1)
})
