/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import {
  CONTROL_VERSION,
  decodeAnyMetadataRecord,
  decodeMetadataRecord,
  decodeTreeMetadataRecord,
  encodeAnyMetadataRecord,
  encodeControlFrame,
  encodeMetadataRecord,
  encodeTreeMetadataRecord,
  isTreeMetadata,
  MAX_CONTROL_RECORD_BYTES,
  type MetadataRecord,
  type TreeMetadataRecord
} from '../../dist/tar-protocol/controls.js'
import { decodeDirectMetadata, writeMetadata } from '../../dist/tar-protocol/direct-wire.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import {
  assertTreeMetadataTransferId,
  buildTreeManifest,
  computeTreeTransferId,
  regenerateTreeTarSuffix,
  TREE_TRANSFER_DOMAIN,
  treeMetadataFromManifest,
  type TreeManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import {
  buildTarManifest,
  computeTarTransferId,
  metadataFromManifest,
  TAR_TRANSFER_DOMAIN
} from '../../dist/tar-protocol/manifest.js'
import { MAX_TREE_ENTRIES } from '../../dist/tar-protocol/tree.js'
import { deterministicTreeTarSize } from '../../dist/tar-protocol/ustar.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 31)
const FIXED_MTIME = new Date(1_700_000_000_000)

async function collect(
  manifest: TreeManifest,
  offset = 0,
  options: Parameters<typeof regenerateTreeTarSuffix>[3] = {}
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const result = await regenerateTreeTarSuffix(
    manifest,
    offset,
    (chunk) => {
      chunks.push(b4a.from(chunk))
    },
    options
  )
  if (result.status !== 'MATCH') throw new Error('Unexpected reset')
  return b4a.concat(chunks)
}

/** Pins an explicit millisecond mtime so a later rewrite is detectable without timing luck. */
async function pinMtime(file: string, date = FIXED_MTIME): Promise<void> {
  await fs.promises.utimes(file, date, date)
}

function treeRecord(overrides: Record<string, unknown> = {}): TreeMetadataRecord {
  return {
    v: CONTROL_VERSION,
    kind: 'directory',
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256: 'a'.repeat(64),
    tarSize: 512 * 2 + 512 + 1024,
    tarSha256: 'b'.repeat(64),
    transferId: 'c'.repeat(64),
    reset: false,
    ...overrides
  } as TreeMetadataRecord
}

function fileRecord(overrides: Record<string, unknown> = {}): MetadataRecord {
  return {
    v: CONTROL_VERSION,
    name: 'payload.bin',
    fileSize: 7,
    fileSha256: '01'.repeat(32),
    tarSize: 2048,
    tarSha256: '02'.repeat(32),
    transferId: 'd'.repeat(64),
    reset: false,
    ...overrides
  } as MetadataRecord
}

function rawRecord(value: unknown): Buffer {
  return b4a.from(JSON.stringify(value))
}

test('file metadata stays byte-identical and never carries a kind', async (t) => {
  const root = await createTempDir(t)
  const file = path.join(root, 'payload.bin')
  await fs.promises.writeFile(file, 'payload')
  const record = metadataFromManifest(await buildTarManifest(file, OWNER))
  t.absent('kind' in record)
  t.alike(encodeAnyMetadataRecord(record), encodeMetadataRecord(record))
  t.alike(decodeAnyMetadataRecord(encodeMetadataRecord(record)), record)
  t.is(isTreeMetadata(decodeAnyMetadataRecord(encodeMetadataRecord(record))), false)
})

test('file control bytes and file transfer IDs are pinned exactly', (t) => {
  const withParent: MetadataRecord = {
    v: CONTROL_VERSION,
    name: 'payload.bin',
    sourceParent: 'releases',
    fileSize: 7,
    fileSha256: '01'.repeat(32),
    tarSize: 2048,
    tarSha256: '02'.repeat(32),
    transferId: '1cd6704623ebcd92c6af25b9028da85f50d38b3ec71abce4b636a94ec6eb1136',
    reset: false
  }
  const expectedBytes =
    '{"v":1,"name":"payload.bin","sourceParent":"releases","fileSize":7,' +
    `"fileSha256":"${'01'.repeat(32)}","tarSize":2048,"tarSha256":"${'02'.repeat(32)}",` +
    '"transferId":"1cd6704623ebcd92c6af25b9028da85f50d38b3ec71abce4b636a94ec6eb1136","reset":false}'
  t.is(b4a.toString(encodeMetadataRecord(withParent)), expectedBytes)
  t.is(b4a.toString(encodeAnyMetadataRecord(withParent)), expectedBytes)
  t.alike(decodeDirectMetadata(b4a.from(expectedBytes)), withParent)
  t.alike(decodeAnyMetadataRecord(b4a.from(expectedBytes)), withParent)

  const fileSha256 = b4a.alloc(32, 1)
  const tarSha256 = b4a.alloc(32, 2)
  t.is(
    b4a.toString(
      computeTarTransferId(OWNER, {
        name: 'payload.bin',
        sourceParent: 'releases',
        fileSize: 7,
        fileSha256,
        tarSize: 2048,
        tarSha256
      }),
      'hex'
    ),
    '1cd6704623ebcd92c6af25b9028da85f50d38b3ec71abce4b636a94ec6eb1136'
  )
  t.is(
    b4a.toString(
      computeTarTransferId(OWNER, {
        name: 'payload.bin',
        fileSize: 7,
        fileSha256,
        tarSize: 2048,
        tarSha256
      }),
      'hex'
    ),
    '9627c7611afb2e626c7dcfc343df9a6ef95a7f99aec5803cb554151a7fae9712'
  )
})

test('the file decoder stays exact-key and the any-decoder never widens it', (t) => {
  const valid = fileRecord()
  t.alike(decodeMetadataRecord(encodeMetadataRecord(valid)), valid)
  for (const invalid of [
    { ...valid, kind: 'file' },
    { ...valid, kind: 'directory' },
    { ...valid, extra: 1 }
  ]) {
    t.exception(() => decodeMetadataRecord(rawRecord(invalid)), { code: ERRORS.PROTOCOL_INVALID })
    t.exception(() => decodeAnyMetadataRecord(rawRecord(invalid)), {
      code: ERRORS.PROTOCOL_INVALID
    })
    t.exception(() => encodeAnyMetadataRecord(invalid as MetadataRecord), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  // A directory record whose kind was dropped is read as a file record and fails its exact keys.
  const missingKind = rawRecord({ ...treeRecord(), kind: undefined })
  t.exception(() => decodeAnyMetadataRecord(missingKind), { code: ERRORS.PROTOCOL_INVALID })
  t.exception(() => encodeAnyMetadataRecord({ ...valid, kind: undefined } as never), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => decodeAnyMetadataRecord(rawRecord({ ...valid, fileSize: 1.5 })), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('directory metadata is a distinct key set an exact-key file decoder rejects', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a/b.bin': 'bb', 'c.bin': 'c' })
  const manifest = await buildTreeManifest(source, OWNER)
  const record = treeMetadataFromManifest(manifest)
  t.is(record.kind, 'directory')
  t.is(record.name, '0.18.1')
  t.is(record.entryCount, 3)
  t.is(record.payloadBytes, 3)
  t.is(record.tarSize, manifest.tarSize)
  t.is(isTreeMetadata(decodeAnyMetadataRecord(encodeTreeMetadataRecord(record))), true)
  t.alike(decodeAnyMetadataRecord(encodeTreeMetadataRecord(record)), record)
  t.alike(decodeTreeMetadataRecord(encodeTreeMetadataRecord(record)), record)
  t.alike(encodeAnyMetadataRecord(record), encodeTreeMetadataRecord(record))
  t.exception(() => decodeMetadataRecord(encodeTreeMetadataRecord(record)), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('directory metadata has an exact key set and a pinned encoding', (t) => {
  const withParent = treeRecord({ sourceParent: 'releases' })
  const expected =
    '{"v":1,"kind":"directory","name":"0.18.1","entryCount":2,"payloadBytes":10,' +
    `"treeSha256":"${'a'.repeat(64)}","tarSize":2560,"tarSha256":"${'b'.repeat(64)}",` +
    `"transferId":"${'c'.repeat(64)}","reset":false,"sourceParent":"releases"}`
  t.is(b4a.toString(encodeTreeMetadataRecord(withParent)), expected)
  t.alike(decodeAnyMetadataRecord(b4a.from(expected)), withParent)

  const base = treeRecord()
  const required = Object.keys(base)
  t.is(required.length, 10, 'ten required keys without sourceParent')
  t.ok(required.includes('kind'))
  t.absent('sourceParent' in base)
  for (const key of required) {
    const missing: Record<string, unknown> = { ...base }
    delete missing[key]
    t.exception(() => decodeAnyMetadataRecord(rawRecord(missing)), {
      code: ERRORS.PROTOCOL_INVALID
    })
    t.exception(() => decodeTreeMetadataRecord(rawRecord(missing)), {
      code: ERRORS.PROTOCOL_INVALID
    })
    t.exception(() => encodeTreeMetadataRecord(missing as unknown as TreeMetadataRecord), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  for (const extra of [{ extra: 1 }, { fileSize: 1 }, { fileSha256: 'a'.repeat(64) }]) {
    t.exception(() => decodeAnyMetadataRecord(rawRecord({ ...base, ...extra })), {
      code: ERRORS.PROTOCOL_INVALID
    })
    t.exception(() => encodeTreeMetadataRecord({ ...base, ...extra } as TreeMetadataRecord), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  // A directory offer is never a file offer, whichever optional key is present.
  t.exception(() => decodeMetadataRecord(rawRecord(withParent)), { code: ERRORS.PROTOCOL_INVALID })
  for (const bad of [null, [], 'directory', 7]) {
    t.exception(() => decodeAnyMetadataRecord(rawRecord(bad)), { code: ERRORS.PROTOCOL_INVALID })
  }
  t.exception(() => decodeAnyMetadataRecord(b4a.alloc(0)), { code: ERRORS.PROTOCOL_INVALID })
  t.exception(() => decodeAnyMetadataRecord(b4a.from('{')), { code: ERRORS.PROTOCOL_INVALID })
  t.exception(() => decodeAnyMetadataRecord(b4a.alloc(MAX_CONTROL_RECORD_BYTES + 1, 32)), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('directory metadata validation bounds every field', (t) => {
  const base = treeRecord()
  t.alike(decodeAnyMetadataRecord(encodeTreeMetadataRecord(base)), base)
  for (const invalid of [
    { ...base, kind: 'file' },
    { ...base, kind: 'Directory' },
    { ...base, v: 2 },
    { ...base, v: '1' },
    { ...base, name: 'history-aa' },
    { ...base, name: '' },
    { ...base, name: 'a/b' },
    { ...base, name: '.hidden' },
    { ...base, name: 'a'.repeat(101) },
    { ...base, entryCount: -1 },
    { ...base, entryCount: 10_001 },
    { ...base, entryCount: 1.5 },
    { ...base, entryCount: '2' },
    { ...base, entryCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, payloadBytes: 1.5 },
    { ...base, payloadBytes: -1 },
    { ...base, payloadBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, treeSha256: 'Z'.repeat(64) },
    { ...base, treeSha256: 'a'.repeat(63) },
    { ...base, treeSha256: 'A'.repeat(64) },
    { ...base, tarSize: base.tarSize + 1 },
    { ...base, tarSize: 1024 },
    { ...base, tarSize: 512 * 4096 },
    { ...base, tarSize: -512 },
    { ...base, tarSha256: 'b'.repeat(65) },
    { ...base, transferId: 'c'.repeat(63) },
    { ...base, transferId: 5 },
    { ...base, reset: 'no' },
    { ...base, reset: 0 },
    { ...base, sourceParent: '../escape' },
    { ...base, sourceParent: '' },
    { ...base, sourceParent: 'a'.repeat(101) },
    { ...base, sourceParent: 7 },
    { ...base, entryCount: 0, payloadBytes: 1, tarSize: 1024 + 512 },
    { ...base, entryCount: 0, payloadBytes: 0, tarSize: 2560 }
  ]) {
    t.exception(() => encodeTreeMetadataRecord(invalid as TreeMetadataRecord), {
      code: /INVALID_FILENAME|PROTOCOL_INVALID/
    })
    t.exception(() => decodeAnyMetadataRecord(rawRecord(invalid)), {
      code: /INVALID_FILENAME|PROTOCOL_INVALID/
    })
  }
  const valid = [
    { ...base, name: 'a'.repeat(100) },
    { ...base, sourceParent: 'a'.repeat(100) },
    { ...base, sourceParent: 'rel+1.0_x-y' },
    { ...base, entryCount: 0, payloadBytes: 0, tarSize: 1024 },
    { ...base, entryCount: 1, payloadBytes: 0, tarSize: 1024 + 512 },
    { ...base, entryCount: 1, payloadBytes: 512, tarSize: 1024 + 512 + 512 },
    { ...base, entryCount: 2, payloadBytes: 10, tarSize: 1024 + 1024 + 512 },
    {
      ...base,
      entryCount: MAX_TREE_ENTRIES,
      payloadBytes: 0,
      tarSize: 1024 + 512 * MAX_TREE_ENTRIES
    }
  ]
  for (const record of valid) {
    t.alike(
      decodeAnyMetadataRecord(encodeTreeMetadataRecord(record as TreeMetadataRecord)),
      record,
      `valid ${record.entryCount}/${record.payloadBytes}`
    )
  }
})

test('directory metadata TAR size window is exactly the canonical bound', (t) => {
  // Three entries carrying 100 payload bytes: one padded file (3072) up to three padded files (4096).
  const entryCount = 3
  const payloadBytes = 100
  const accepted: number[] = []
  for (let size = 0; size <= 8192; size++) {
    try {
      encodeTreeMetadataRecord(treeRecord({ entryCount, payloadBytes, tarSize: size }))
      accepted.push(size)
    } catch {}
  }
  t.alike(accepted, [3072, 3584, 4096])
})

test('a tree transfer ID commits to every directory metadata field', (t) => {
  const immutable = {
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256: b4a.alloc(32, 1),
    tarSize: 2560,
    tarSha256: b4a.alloc(32, 2)
  }
  const base = computeTreeTransferId(OWNER, immutable)
  t.is(base.byteLength, 32)
  for (const changed of [
    { ...immutable, name: '0.18.2' },
    { ...immutable, entryCount: 3 },
    { ...immutable, payloadBytes: 11 },
    { ...immutable, treeSha256: b4a.alloc(32, 3) },
    { ...immutable, tarSize: 3072 },
    { ...immutable, tarSha256: b4a.alloc(32, 4) },
    { ...immutable, sourceParent: 'releases' }
  ]) {
    t.absent(b4a.equals(base, computeTreeTransferId(OWNER, changed)))
  }
  t.absent(b4a.equals(base, computeTreeTransferId(b4a.alloc(32, 32), immutable)))
  const parentA = computeTreeTransferId(OWNER, { ...immutable, sourceParent: 'a' })
  const parentB = computeTreeTransferId(OWNER, { ...immutable, sourceParent: 'b' })
  t.absent(b4a.equals(parentA, parentB))
})

test('a tree transfer ID is domain separated and matches an independent reference', (t) => {
  t.is(TREE_TRANSFER_DOMAIN, 'swarm-deploy/direct-tree/v1')
  t.is(TAR_TRANSFER_DOMAIN, 'swarm-deploy/direct-tar/v1')
  t.not(TREE_TRANSFER_DOMAIN as string, TAR_TRANSFER_DOMAIN as string)
  const treeSha256 = b4a.alloc(32, 1)
  const tarSha256 = b4a.alloc(32, 2)
  const field = (label: string, value: Uint8Array | string | number): Buffer => {
    const bytes = typeof value === 'number' ? b4a.from(String(value)) : b4a.from(value)
    return b4a.concat([b4a.from(`${label}\u0000`), b4a.from(`${bytes.byteLength}:`), bytes])
  }
  const reference = (sourceParent?: string): Buffer =>
    sodiumSha256(
      b4a.concat([
        field('domain', 'swarm-deploy/direct-tree/v1'),
        field('clientPublicKey', OWNER),
        field('kind', 'directory'),
        field('name', '0.18.1'),
        ...(sourceParent === undefined ? [] : [field('sourceParent', sourceParent)]),
        field('entryCount', 2),
        field('payloadBytes', 10),
        field('treeSha256', treeSha256),
        field('tarSize', 2560),
        field('tarSha256', tarSha256),
        field('fileMode', 0o644),
        field('directoryMode', 0o755),
        field('uid', 0),
        field('gid', 0),
        field('mtimeMs', 0),
        field('uname', ''),
        field('gname', ''),
        field('maxDepth', 32),
        field('maxEntries', 10_000),
        field('pax', 'none')
      ])
    )
  const immutable = {
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256,
    tarSize: 2560,
    tarSha256
  }
  t.alike(computeTreeTransferId(OWNER, immutable), reference())
  t.alike(
    computeTreeTransferId(OWNER, { ...immutable, sourceParent: 'releases' }),
    reference('releases')
  )
  t.is(
    b4a.toString(computeTreeTransferId(OWNER, immutable), 'hex'),
    b4a.toString(reference(), 'hex')
  )

  const asFile = computeTarTransferId(OWNER, {
    name: '0.18.1',
    fileSize: 10,
    fileSha256: treeSha256,
    tarSize: 2560,
    tarSha256
  })
  t.absent(b4a.equals(asFile, computeTreeTransferId(OWNER, immutable)))
})

test('a tree transfer ID rejects malformed inputs', (t) => {
  const good = {
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256: b4a.alloc(32, 1),
    tarSize: 2560,
    tarSha256: b4a.alloc(32, 2)
  }
  t.exception(() => computeTreeTransferId(b4a.alloc(31), good), { code: ERRORS.PROTOCOL_INVALID })
  for (const bad of [
    { ...good, entryCount: -1 },
    { ...good, entryCount: 1.5 },
    { ...good, payloadBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, tarSize: -1 },
    { ...good, treeSha256: b4a.alloc(31) },
    { ...good, tarSha256: b4a.alloc(33) }
  ]) {
    t.exception(() => computeTreeTransferId(OWNER, bad), { code: ERRORS.PROTOCOL_INVALID })
  }
  t.exception(() => computeTreeTransferId(OWNER, { ...good, sourceParent: '../x' }), {
    code: ERRORS.INVALID_FILENAME
  })
})

test('a generated tree archive is deterministic, resumable, and self-describing', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'releases', '0.18.1')
  await writeTree(source, { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'zzz' })
  const manifest = await buildTreeManifest(source, OWNER)
  t.is(manifest.sourceParent, 'releases')
  t.is(manifest.entryCount, 4)
  t.is(manifest.tarSize, deterministicTreeTarSize(manifest.snapshot.entries))
  const whole = await collect(manifest)
  t.is(whole.byteLength, manifest.tarSize)
  t.alike(sodiumSha256(whole), manifest.tarSha256)
  const rebuilt = await buildTreeManifest(source, OWNER)
  t.alike(rebuilt.tarSha256, manifest.tarSha256)
  t.alike(rebuilt.treeSha256, manifest.treeSha256)
  t.alike(rebuilt.transferId, manifest.transferId)
  for (const offset of [0, 512, 1024, manifest.tarSize - 1024, manifest.tarSize]) {
    const suffix = await collect(manifest, offset)
    t.alike(suffix, whole.subarray(offset))
  }
  assertTreeMetadataTransferId(OWNER, treeMetadataFromManifest(manifest))
  const forged = { ...treeMetadataFromManifest(manifest), entryCount: manifest.entryCount + 1 }
  t.exception(() => assertTreeMetadataTransferId(OWNER, forged), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('the transfer ID authenticates every field and the client key', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'releases', '0.18.1')
  await writeTree(source, { 'a.bin': 'aaa', 'b/': '' })
  const manifest = await buildTreeManifest(source, OWNER)
  const record = treeMetadataFromManifest(manifest)
  assertTreeMetadataTransferId(OWNER, record)
  t.exception(() => assertTreeMetadataTransferId(b4a.alloc(32, 99), record), {
    code: ERRORS.PROTOCOL_INVALID
  })
  const flipped = (hex: string): string => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`
  for (const forged of [
    { ...record, name: '0.18.2' },
    { ...record, sourceParent: 'other' },
    { ...record, payloadBytes: record.payloadBytes + 1 },
    { ...record, entryCount: record.entryCount - 1 },
    { ...record, treeSha256: flipped(record.treeSha256) },
    { ...record, tarSha256: flipped(record.tarSha256) },
    { ...record, transferId: flipped(record.transferId) }
  ]) {
    t.exception(() => assertTreeMetadataTransferId(OWNER, forged as TreeMetadataRecord), {
      code: /PROTOCOL_INVALID|INVALID_FILENAME/
    })
  }
  const withoutParent = { ...record }
  delete withoutParent.sourceParent
  t.exception(() => assertTreeMetadataTransferId(OWNER, withoutParent), {
    code: ERRORS.PROTOCOL_INVALID
  })
  // The reset flag is not part of the immutable identity.
  assertTreeMetadataTransferId(OWNER, treeMetadataFromManifest(manifest, true))
  t.is(treeMetadataFromManifest(manifest, true).reset, true)
})

test('an empty directory and an opted-out parent still produce a valid artifact', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'empty')
  await fs.promises.mkdir(source)
  const manifest = await buildTreeManifest(source, OWNER, { includeSourceParent: false })
  t.is(manifest.entryCount, 0)
  t.is(manifest.payloadBytes, 0)
  t.is(manifest.tarSize, 1024)
  t.is(manifest.sourceParent, undefined)
  t.absent('sourceParent' in treeMetadataFromManifest(manifest))
  t.alike(await collect(manifest), b4a.alloc(1024))
  const withParent = await buildTreeManifest(source, OWNER)
  t.is(withParent.sourceParent, path.basename(root))
  t.absent(b4a.equals(withParent.transferId, manifest.transferId), 'the parent is authenticated')
})

test('manifest construction rejects reserved names, bad keys, and non-directories', async (t) => {
  const root = await createTempDir(t)
  const reserved = path.join(root, 'history-abc')
  await fs.promises.mkdir(reserved)
  await t.exception(() => buildTreeManifest(reserved, OWNER), { code: ERRORS.INVALID_FILENAME })
  const ok = path.join(root, 'ok')
  await writeTree(ok, { 'f.bin': 'x' })
  await t.exception(() => buildTreeManifest(ok, b4a.alloc(31)), { code: ERRORS.PROTOCOL_INVALID })
  await t.exception(() => buildTreeManifest(path.join(ok, 'f.bin'), OWNER), {
    code: ERRORS.INVALID_FILENAME
  })
  const aborted = { aborted: true } as unknown as AbortSignal
  await t.exception(() => buildTreeManifest(ok, OWNER, { signal: aborted }), {
    code: ERRORS.ABORTED
  })
})

test('a tree with a symlink is rejected before any manifest exists', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'linked')
  await writeTree(source, { 'real.bin': 'x' })
  await fs.promises.symlink('real.bin', path.join(source, 'alias.bin'))
  await t.exception(() => buildTreeManifest(source, OWNER), { code: ERRORS.INVALID_FILENAME })
})

test('arbitrary resume offsets replay the exact suffix and a matching prefix digest', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'releases', '0.18.1')
  await writeTree(source, {
    'a/b.bin': 'b'.repeat(700),
    'a/empty/': '',
    'c.bin': 'c',
    'd.bin': '',
    'e/f/g.bin': 'g'.repeat(512)
  })
  const manifest = await buildTreeManifest(source, OWNER)
  const whole = await collect(manifest)
  t.is(whole.byteLength, manifest.tarSize)
  const offsets = new Set<number>([0, 1, manifest.tarSize - 1, manifest.tarSize])
  for (let block = 0; block <= manifest.tarSize; block += 512) {
    for (const delta of [-1, 0, 1, 255]) {
      const offset = block + delta
      if (offset >= 0 && offset <= manifest.tarSize) offsets.add(offset)
    }
  }
  let state = 0x2f6e2b1
  for (let index = 0; index < 40; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    offsets.add(state % (manifest.tarSize + 1))
  }
  let matches = 0
  for (const offset of [...offsets].sort((left, right) => left - right)) {
    const prefix = sodiumSha256(whole.subarray(0, offset))
    const chunks: Buffer[] = []
    const result = await regenerateTreeTarSuffix(
      manifest,
      offset,
      (chunk) => {
        chunks.push(b4a.from(chunk))
      },
      { expectedPrefixSha256: prefix }
    )
    if (
      result.status !== 'MATCH' ||
      !b4a.equals(result.prefixSha256, prefix) ||
      result.bytesSent !== manifest.tarSize - offset ||
      !b4a.equals(b4a.concat(chunks), whole.subarray(offset))
    ) {
      t.fail(`offset ${offset} did not replay exactly`)
      return
    }
    matches++
  }
  t.is(matches, offsets.size, 'every sampled byte offset matched')
  t.ok(matches > 60)
})

test('a reset digest mismatch sends nothing at any offset and a match is exact', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a.bin': 'a'.repeat(900), 'b.bin': 'b'.repeat(40), 'c/': '' })
  const manifest = await buildTreeManifest(source, OWNER)
  const whole = await collect(manifest)
  const offsets = [
    0,
    1,
    511,
    512,
    513,
    1024,
    1536,
    manifest.tarSize - 1025,
    manifest.tarSize - 1,
    manifest.tarSize
  ]
  for (const offset of offsets) {
    const prefix = sodiumSha256(whole.subarray(0, offset))
    const wrong = b4a.from(prefix)
    wrong[0] ^= 0x01
    let writes = 0
    const reset = await regenerateTreeTarSuffix(
      manifest,
      offset,
      () => {
        writes++
      },
      { expectedPrefixSha256: wrong }
    )
    t.is(reset.status, 'RESET_REQUIRED', `reset at ${offset}`)
    t.is(reset.bytesSent, 0)
    t.is(writes, 0, `no bytes written on reset at ${offset}`)
    t.alike(reset.prefixSha256, prefix, `the server learns the true prefix at ${offset}`)

    const ok = await regenerateTreeTarSuffix(manifest, offset, () => {}, {
      expectedPrefixSha256: prefix
    })
    t.is(ok.status, 'MATCH')
    t.is(ok.bytesSent, manifest.tarSize - offset)
  }
  // The offset 0 prefix is the digest of the empty string.
  const empty = await regenerateTreeTarSuffix(manifest, 0, () => {}, {
    expectedPrefixSha256: sodiumSha256(b4a.alloc(0))
  })
  t.is(empty.status, 'MATCH')
  const notEmpty = await regenerateTreeTarSuffix(manifest, 0, () => {}, {
    expectedPrefixSha256: b4a.alloc(32, 7)
  })
  t.is(notEmpty.status, 'RESET_REQUIRED')
  t.is(notEmpty.bytesSent, 0)
})

test('a resume rejects invalid offsets, writers, prefix digests, and aborts', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a.bin': 'aaaa' })
  const manifest = await buildTreeManifest(source, OWNER)
  const noop = (): void => {}
  for (const offset of [-1, 1.5, Number.NaN, manifest.tarSize + 1, Number.MAX_SAFE_INTEGER + 1]) {
    await t.exception(() => regenerateTreeTarSuffix(manifest, offset, noop), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  await t.exception(() => regenerateTreeTarSuffix(manifest, 0, null as unknown as () => void), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => regenerateTreeTarSuffix(null as unknown as TreeManifest, 0, noop), {
    code: ERRORS.PROTOCOL_INVALID
  })
  for (const bad of [b4a.alloc(31), b4a.alloc(33)]) {
    await t.exception(
      () =>
        regenerateTreeTarSuffix(manifest, 0, noop, {
          expectedPrefixSha256: bad as Buffer
        }),
      { code: ERRORS.PROTOCOL_INVALID }
    )
  }
  const aborted = { aborted: true } as unknown as AbortSignal
  await t.exception(() => regenerateTreeTarSuffix(manifest, 0, noop, { signal: aborted }), {
    code: ERRORS.ABORTED
  })
})

test('a resume detects a mutated file, a mutated listing, and a prefix mismatch', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a.bin': 'aaaa', 'b.bin': 'bbbb' })
  const manifest = await buildTreeManifest(source, OWNER)
  const reset = await regenerateTreeTarSuffix(manifest, 512, () => {}, {
    expectedPrefixSha256: b4a.alloc(32, 9)
  })
  t.is(reset.status, 'RESET_REQUIRED')
  t.is(reset.bytesSent, 0)

  await fs.promises.writeFile(path.join(source, 'a.bin'), 'cccc')
  await t.exception(() => collect(manifest), { code: ERRORS.FILE_BUSY })

  const listing = await createTempDir(t)
  const second = path.join(listing, '0.18.2')
  await writeTree(second, { 'a.bin': 'aaaa' })
  const stable = await buildTreeManifest(second, OWNER)
  await fs.promises.writeFile(path.join(second, 'added.bin'), 'x')
  await t.exception(() => collect(stable), { code: ERRORS.FILE_BUSY })
})

test('every source mutation or listing change fails closed at every resume offset', async (t) => {
  const mutations: Record<string, (source: string) => Promise<void>> = {
    'same-size rewrite with a changed mtime': async (source) => {
      const file = path.join(source, 'a', 'b.bin')
      await fs.promises.writeFile(file, 'XX')
      await pinMtime(file, new Date(FIXED_MTIME.getTime() + 60_000))
    },
    'same-size same-mtime content swap': async (source) => {
      const file = path.join(source, 'a', 'b.bin')
      await fs.promises.writeFile(file, 'XX')
      await pinMtime(file)
    },
    'file growth': async (source) => {
      const file = path.join(source, 'z.bin')
      await fs.promises.writeFile(file, 'zzzzzz')
      await pinMtime(file)
    },
    'file truncation': async (source) => {
      const file = path.join(source, 'z.bin')
      await fs.promises.writeFile(file, 'z')
      await pinMtime(file)
    },
    'file removed': async (source) => {
      await fs.promises.unlink(path.join(source, 'z.bin'))
    },
    'file replaced by a new inode': async (source) => {
      const file = path.join(source, 'z.bin')
      await fs.promises.writeFile(`${file}.new`, 'zzz')
      await pinMtime(`${file}.new`)
      await fs.promises.rename(`${file}.new`, file)
    },
    'file replaced by a symlink': async (source) => {
      const file = path.join(source, 'z.bin')
      await fs.promises.unlink(file)
      await fs.promises.symlink('a/b.bin', file)
    },
    'file renamed': async (source) => {
      await fs.promises.rename(path.join(source, 'z.bin'), path.join(source, 'y.bin'))
    },
    'file added': async (source) => {
      await fs.promises.writeFile(path.join(source, 'added.bin'), 'x')
    },
    'file added in a nested directory': async (source) => {
      await fs.promises.writeFile(path.join(source, 'a', 'empty', 'added.bin'), '')
    },
    'empty directory added': async (source) => {
      await fs.promises.mkdir(path.join(source, 'new-dir'))
    },
    'empty directory removed': async (source) => {
      await fs.promises.rmdir(path.join(source, 'a', 'empty'))
    },
    'directory replaced by a file': async (source) => {
      const dir = path.join(source, 'a', 'empty')
      await fs.promises.rmdir(dir)
      await fs.promises.writeFile(dir, '')
    },
    'whole root replaced': async (source) => {
      await fs.promises.rename(source, `${source}.moved`)
      await fs.promises.mkdir(source)
    }
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const root = await createTempDir(t)
    const source = path.join(root, '0.18.1')
    await writeTree(source, { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'zzz' })
    for (const file of ['a/b.bin', 'z.bin']) await pinMtime(path.join(source, file))
    const manifest = await buildTreeManifest(source, OWNER)
    await mutate(source)
    for (const offset of [0, 512, 1024, manifest.tarSize]) {
      await t.exception(
        () => collect(manifest, offset),
        { code: ERRORS.FILE_BUSY },
        `${label} @${offset}`
      )
    }
  }
})

test('a mutation made while the archive streams fails the resume', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a.bin': 'aaaa', 'b.bin': 'bbbb', 'c.bin': 'cccc' })
  for (const file of ['a.bin', 'b.bin', 'c.bin']) await pinMtime(path.join(source, file))
  const manifest = await buildTreeManifest(source, OWNER)

  let mutated = false
  await t.exception(
    () =>
      regenerateTreeTarSuffix(manifest, 0, async () => {
        if (mutated) return
        mutated = true
        const file = path.join(source, 'c.bin')
        await fs.promises.writeFile(file, 'dddd')
        await pinMtime(file, new Date(FIXED_MTIME.getTime() + 60_000))
      }),
    { code: ERRORS.FILE_BUSY }
  )
  t.ok(mutated)

  await pinMtime(path.join(source, 'c.bin'))
  const restored = await buildTreeManifest(source, OWNER)
  let listed = false
  await t.exception(
    () =>
      regenerateTreeTarSuffix(restored, 0, async () => {
        if (listed) return
        listed = true
        await fs.promises.writeFile(path.join(source, 'late.bin'), 'x')
      }),
    { code: ERRORS.FILE_BUSY }
  )
  t.ok(listed)
})

test('a changed tree changes the identity and a restored tree restores it', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'releases', '0.18.1')
  await writeTree(source, { 'a.bin': 'aaaa', 'b/': '' })
  const first = await buildTreeManifest(source, OWNER)
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'aaab')
  const changed = await buildTreeManifest(source, OWNER)
  t.absent(b4a.equals(first.transferId, changed.transferId))
  t.absent(b4a.equals(first.treeSha256, changed.treeSha256))
  t.is(first.tarSize, changed.tarSize)
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'aaaa')
  const restored = await buildTreeManifest(source, OWNER)
  t.alike(restored.transferId, first.transferId)
  t.alike(restored.tarSha256, first.tarSha256)

  const sameContent = path.join(root, 'releases', '0.18.2')
  await writeTree(sameContent, { 'a.bin': 'aaaa', 'b/': '' })
  const renamed = await buildTreeManifest(sameContent, OWNER)
  t.absent(b4a.equals(renamed.transferId, first.transferId), 'name is part of identity')
  t.alike(renamed.treeSha256, first.treeSha256, 'the tree digest ignores the artifact name')
})

test('directory offers cross the direct wire framed and decoded by the any-decoder', async (t) => {
  const writes: Buffer[] = []
  const socket = {
    write(bytes: Uint8Array): boolean {
      writes.push(b4a.from(bytes))
      return true
    },
    on() {
      return this
    },
    removeListener() {
      return this
    },
    destroy() {}
  }
  const tree = treeRecord({ sourceParent: 'releases' })
  const file = fileRecord()
  await writeMetadata(socket as never, tree)
  await writeMetadata(socket as never, file)
  t.alike(writes[0], encodeControlFrame(encodeTreeMetadataRecord(tree)))
  t.alike(writes[1], encodeControlFrame(encodeMetadataRecord(file)))
  const body = (frame: Buffer): Buffer => frame.subarray(4)
  t.alike(decodeDirectMetadata(body(writes[0])), tree)
  t.alike(decodeDirectMetadata(body(writes[1])), file)
  t.is(isTreeMetadata(decodeDirectMetadata(body(writes[0]))), true)
  t.is(isTreeMetadata(decodeDirectMetadata(body(writes[1]))), false)
  await t.exception(() => writeMetadata(socket as never, { ...tree, kind: 'file' } as never), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is(writes.length, 2, 'an invalid record never reaches the socket')
})
