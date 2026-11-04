/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import {
  CorruptCatalogError,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_FILES,
  catalogGroupId,
  catalogSnapshotId,
  commitFileCatalog,
  decodeFileCatalog,
  emptyFileCatalog,
  fileCatalogPath,
  filePathProblem,
  importLegacyDirectory,
  ownedDigest,
  parseFileCatalog,
  readFileCatalog,
  removeFileCatalog,
  serializeFileCatalog,
  subsetDigest,
  type FileCatalog,
  type LegacyDirectoryRecord,
  type PathProblem
} from '../../dist/storage/file-catalog.js'
import {
  STATE_FEATURE_DIRECTORY_REPLACEMENT,
  STATE_FEATURE_FILE_CATALOG,
  STATE_ROOT_NAME,
  findLayout,
  requireStateFeature,
  stateRequiresFeature
} from '../../dist/storage/layout.js'
import { digestTree } from '../../dist/storage/tree-fs.js'
import { treeDigest, type TreeDigestEntry } from '../../dist/tar-protocol/tree.js'
import { createTempDir } from '../helpers/files.js'
import { Disk, facts, fresh, hexId, merge, sha, writerOf } from '../helpers/file-merge.js'
import { initLayout } from '../helpers/layout.js'
import { createStorage } from '../helpers/storage.js'
import { writeTree } from '../helpers/trees.js'

type Raw = Record<string, unknown>
const RELEASE = { series: 'beta', version: '1.2.3' }

/** A valid catalog of two writers, four files, two receipts and a release, built by real merges. */
function sample(withRelease = true): FileCatalog {
  const release = withRelease ? RELEASE : undefined
  const disk = new Disk()
  const options = release === undefined ? {} : { release }
  const one = merge(
    disk,
    fresh('beta-1.2.3', release),
    { 'flatpak/app.flatpak': 'flatpak bytes', 'flatpak/meta/appdata.xml': '<xml/>' },
    { writer: writerOf(1), ...options }
  )
  return merge(
    disk,
    one.catalog,
    { 'snap/app.snap': 'snap bytes', 'snap/zero.bin': '' },
    { writer: writerOf(2), ...options }
  ).catalog
}

function raw(catalog: FileCatalog = sample()): Raw {
  return JSON.parse(b4a.toString(serializeFileCatalog(catalog))) as Raw
}

const list = (value: Raw, key: string): Raw[] => value[key] as Raw[]

/** A minimal raw catalog over `paths`, one writer, for the path rules. */
function over(paths: string[]): Raw {
  return {
    version: 1,
    name: 'x',
    generation: 1,
    writers: [{ transferId: hexId(1), uploader: hexId(2), committedAt: 1 }],
    files: paths.map((filePath) => ({ path: filePath, size: 1, sha256: sha('x'), writer: 0 })),
    receipts: []
  }
}

test('a catalog serializes canonically and parses back to the same catalog', (t) => {
  const catalog = sample()
  const bytes = serializeFileCatalog(catalog)
  const parsed = decodeFileCatalog(bytes)
  t.alike(parsed, catalog)
  t.alike(serializeFileCatalog(parsed), bytes, 'one catalog, one serialization')

  const object = JSON.parse(b4a.toString(bytes)) as Raw
  t.alike(Object.keys(object), [
    'version',
    'name',
    'generation',
    'release',
    'writers',
    'files',
    'receipts'
  ])
  t.is(list(object, 'writers').length, 2, 'each writer is stored once')
  t.alike(
    list(object, 'files').map((file) => file.writer),
    [0, 0, 1, 1],
    'and referenced by index, in order of first use'
  )
  t.is('release' in raw(sample(false)), false, 'no release, no key')
  t.alike(decodeFileCatalog(serializeFileCatalog(sample(false))), sample(false))

  // Equal writers that are different objects are still one writer on disk.
  const cloned: FileCatalog = {
    ...catalog,
    files: catalog.files.map((file) => ({ ...file, writer: { ...file.writer } }))
  }
  t.alike(serializeFileCatalog(cloned), bytes)
})

test('parsing is strict about every key, every value and every cap', async (t) => {
  const mutations: Array<[string, (value: Raw) => void]> = [
    ['an unknown top-level key', (value) => void (value.extra = 1)],
    ['a missing top-level key', (value) => void Reflect.deleteProperty(value, 'receipts')],
    ['another version', (value) => void (value.version = 2)],
    ['a name that is not a string', (value) => void (value.name = 5)],
    ['a name that is not a basename', (value) => void (value.name = '../x')],
    ['a reserved history name', (value) => void (value.name = `history-${'a'.repeat(64)}`)],
    ['a fractional generation', (value) => void (value.generation = 1.5)],
    ['a negative generation', (value) => void (value.generation = -1)],
    ['an invalid release', (value) => void (value.release = { series: '' })],
    ['a release with an extra key', (value) => void (value.release = { series: 'beta', extra: 1 })],
    ['writers that are not a list', (value) => void (value.writers = {})],
    ['an unknown writer key', (value) => void (list(value, 'writers')[0].extra = 1)],
    [
      'an upper-case writer uploader',
      (value) => void (list(value, 'writers')[0].uploader = 'C8'.repeat(32))
    ],
    ['a short writer uploader', (value) => void (list(value, 'writers')[0].uploader = 'abcd')],
    ['a negative writer time', (value) => void (list(value, 'writers')[0].committedAt = -1)],
    [
      'a duplicate writer',
      (value) => void (list(value, 'writers')[1] = { ...list(value, 'writers')[0] })
    ],
    [
      'an unreferenced writer',
      (value) =>
        void list(value, 'writers').push({
          transferId: hexId(9),
          uploader: hexId(9),
          committedAt: 5
        })
    ],
    ['a writer index out of range', (value) => void (list(value, 'files')[0].writer = 9)],
    ['writers out of order of first use', (value) => void (list(value, 'files')[0].writer = 1)],
    ['a negative writer index', (value) => void (list(value, 'files')[0].writer = -1)],
    ['a fractional writer index', (value) => void (list(value, 'files')[0].writer = 0.5)],
    ['an unknown file key', (value) => void (list(value, 'files')[0].extra = 1)],
    [
      'a file without a size',
      (value) => void Reflect.deleteProperty(list(value, 'files')[0], 'size')
    ],
    ['a negative size', (value) => void (list(value, 'files')[0].size = -1)],
    ['a fractional size', (value) => void (list(value, 'files')[0].size = 1.5)],
    [
      'a size past the USTAR limit',
      (value) => void (list(value, 'files')[0].size = 0o77777777777 + 1)
    ],
    ['an upper-case digest', (value) => void (list(value, 'files')[0].sha256 = 'A'.repeat(64))],
    ['a short digest', (value) => void (list(value, 'files')[0].sha256 = 'ab')],
    ['a path that is not a string', (value) => void (list(value, 'files')[0].path = 5)],
    ['a traversing path', (value) => void (list(value, 'files')[0].path = '../x')],
    ['an absolute path', (value) => void (list(value, 'files')[0].path = '/x')],
    ['a path with a backslash', (value) => void (list(value, 'files')[0].path = 'a\\b')],
    [
      'a reserved history component',
      (value) => void (list(value, 'files')[0].path = `history-${'a'.repeat(64)}/x`)
    ],
    [
      'paths out of order',
      (value) => {
        const files = list(value, 'files')
        ;[files[0], files[1]] = [files[1], files[0]]
      }
    ],
    [
      'a repeated path',
      (value) => void (list(value, 'files')[1].path = String(list(value, 'files')[0].path))
    ],
    ['an unknown receipt key', (value) => void (list(value, 'receipts')[0].extra = 1)],
    [
      'a missing receipt key',
      (value) => void Reflect.deleteProperty(list(value, 'receipts')[0], 'subset')
    ],
    [
      'receipt counts that do not add up',
      (value) =>
        void (list(value, 'receipts')[0].added = Number(list(value, 'receipts')[0].added) + 1)
    ],
    [
      'a receipt from a later generation',
      (value) => void (list(value, 'receipts')[0].generation = 99)
    ],
    [
      'a duplicate receipt',
      (value) =>
        void (list(value, 'receipts')[1].transferId = String(list(value, 'receipts')[0].transferId))
    ],
    ['a receipt with a bad digest', (value) => void (list(value, 'receipts')[0].subset = 'zz')],
    ['receipts that are not a list', (value) => void (value.receipts = null)],
    [
      'more receipts than the ring holds',
      (value) =>
        void (value.receipts = Array.from({ length: 17 }, (_, index) => ({
          ...list(value, 'receipts')[0],
          transferId: hexId(index + 1)
        })))
    ],
    [
      'more files than the tree limit',
      (value) =>
        void (value.files = Array.from({ length: MAX_CATALOG_FILES + 1 }, (_, index) => ({
          path: `f${index}`,
          size: 1,
          sha256: sha('x'),
          writer: 0
        })))
    ],
    [
      'more writers than files could use',
      (value) =>
        void (value.writers = Array.from({ length: MAX_CATALOG_FILES + 1 }, (_, index) => ({
          transferId: hexId(1),
          uploader: hexId(2),
          committedAt: index
        })))
    ]
  ]
  for (const [name, mutate] of mutations) {
    const value = raw()
    mutate(value)
    await t.exception(() => parseFileCatalog(value), { code: ERRORS.PROTOCOL_INVALID }, name)
  }
  for (const value of [null, [], 'text', 5, true]) {
    await t.exception(() => parseFileCatalog(value), { code: ERRORS.PROTOCOL_INVALID })
  }

  try {
    parseFileCatalog({ ...raw(), version: 9 })
    t.fail('another version was accepted')
  } catch (error) {
    t.ok(error instanceof CorruptCatalogError && error.corruptCatalog === true)
    t.absent(String((error as Error).message).includes(hexId(1)), 'no identifier in the message')
  }
})

test('path rules reject case aliases, file/directory clashes and anything non-canonical', async (t) => {
  const bad: Array<[string, string[], PathProblem]> = [
    ['a container spelled two ways', ['A/b', 'a/c'], 'CASE_ALIAS'],
    ['a file spelled two ways', ['Foo', 'foo'], 'CASE_ALIAS'],
    ['a file that is also a directory', ['a', 'a/b'], 'KIND_CONFLICT'],
    ['the same clash with a name between them', ['a', 'a-x', 'a/b'], 'KIND_CONFLICT'],
    ['a listed path twice', ['a', 'a'], 'ORDER'],
    ['paths out of order', ['b', 'a'], 'ORDER']
  ]
  for (const [name, paths, problem] of bad) {
    await t.exception(
      () => parseFileCatalog(over(paths)),
      { code: ERRORS.PROTOCOL_INVALID, message: new RegExp(problem) },
      name
    )
    t.is(filePathProblem(paths)?.problem, problem, `${name}: the same verdict for a planner`)
  }
  t.is(filePathProblem(['a', 'a-x', 'b/c', 'b/d']), null)
  t.is(filePathProblem([]), null)
  t.is(filePathProblem(['../x'])?.problem, 'INVALID_PATH')
  t.is(parseFileCatalog(over(['a', 'a-x', 'b/c', 'b/d'])).files.length, 4)
})

test('bytes are bounded before anything is parsed, and what is written must parse back', async (t) => {
  await t.exception(() => decodeFileCatalog(b4a.from('{not json')), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => decodeFileCatalog(b4a.from('[]')), { code: ERRORS.PROTOCOL_INVALID })
  await t.exception(() => decodeFileCatalog(b4a.alloc(MAX_CATALOG_BYTES + 1, 0x20)), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /size limit/
  })

  const catalog = sample()
  const reversed: FileCatalog = { ...catalog, files: [...catalog.files].reverse() }
  await t.exception(() => serializeFileCatalog(reversed), { code: ERRORS.PROTOCOL_INVALID })
  await t.exception(() => serializeFileCatalog({ ...catalog, generation: -1 }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => serializeFileCatalog({ ...catalog, name: '../escape' }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  const stranger = { ...catalog.files[0], writer: { ...catalog.files[0].writer, extra: 1 } }
  await t.exception(
    () => serializeFileCatalog({ ...catalog, files: [stranger, ...catalog.files.slice(1)] }),
    { code: ERRORS.PROTOCOL_INVALID },
    'a writer with a field the schema does not know'
  )
})

test('published and uploaded identities are deterministic, separate and provenance-free', async (t) => {
  const files = [facts('a/x', 'x'), facts('a/y', 'y'), facts('b/z', '')]
  const digest = ownedDigest(files)
  t.ok(/^[0-9a-f]{64}$/.test(digest))
  t.is(digest, ownedDigest(files.map((file) => ({ ...file }))), 'the same facts, the same digest')
  t.not(digest, subsetDigest(files), 'an uploaded subset is never a published set')
  t.not(ownedDigest([]), subsetDigest([]))

  const first = files[0]
  const variants = [
    [{ ...first, path: 'a/w' }, files[1], files[2]],
    [{ ...first, size: 2 }, files[1], files[2]],
    [{ ...first, sha256: sha('other') }, files[1], files[2]],
    [files[0], files[1]],
    [...files, facts('c', 'c')]
  ]
  for (const changed of variants) {
    t.not(ownedDigest(changed), digest, 'every fact is part of the identity')
  }
  await t.exception(() => ownedDigest([files[1], files[0], files[2]]), {
    code: ERRORS.PROTOCOL_INVALID
  })

  // Who wrote the files, when, the generation and the receipts are not content.
  const one = sample()
  const other = merge(
    new Disk(),
    fresh('beta-1.2.3', RELEASE),
    {
      'flatpak/app.flatpak': 'flatpak bytes',
      'flatpak/meta/appdata.xml': '<xml/>',
      'snap/app.snap': 'snap bytes',
      'snap/zero.bin': ''
    },
    { writer: { ...writerOf(77), uploader: hexId(99) }, release: RELEASE }
  ).catalog
  t.not(one.generation, other.generation)
  t.is(ownedDigest(one.files), ownedDigest(other.files))
  t.is(catalogSnapshotId(one), catalogSnapshotId(other))

  // Group IDs: stable file stems that are not the names.
  const id = catalogGroupId('beta-1.2.3')
  t.ok(/^[0-9a-f]{64}$/.test(id))
  t.is(id, catalogGroupId('beta-1.2.3'))
  t.not(id, catalogGroupId('beta-1.2.4'))
  t.not(
    id,
    catalogGroupId('Beta-1.2.3'),
    'names are exact, so case variants have separate catalogs'
  )
  for (const name of ['', '../x', 'a/b', `history-${'a'.repeat(64)}`, '-x']) {
    await t.exception(() => catalogGroupId(name), { code: ERRORS.PROTOCOL_INVALID }, name)
  }
})

/** The legacy record a whole-tree upload of `root` would have left, from its verified digest. */
async function legacyOf(root: string): Promise<{
  record: LegacyDirectoryRecord
  digested: Awaited<ReturnType<typeof digestTree>>
}> {
  const digested = await digestTree(root, createStorage())
  return {
    digested,
    record: {
      name: 'beta-1.2.3',
      size: digested.payloadBytes,
      sha256: b4a.toString(digested.treeSha256, 'hex'),
      entryCount: digested.entryCount,
      transferId: hexId(7),
      uploaderFingerprint: hexId(8),
      committedAt: 123_456,
      release: RELEASE
    }
  }
}

test('digesting a tree also reports the verified digest of every file', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, { 'b.bin': 'bb', 'a/c.bin': 'ccc', 'a/empty/': '', zero: '' })
  const result = await digestTree(root, createStorage())
  t.alike(
    result.files.map((file) => [file.path, file.size, b4a.toString(file.sha256, 'hex')]),
    [
      ['a/c.bin', 3, sha('ccc')],
      ['b.bin', 2, sha('bb')],
      ['zero', 0, sha('')]
    ],
    'files only, in canonical order, a zero-length file included'
  )
  const digests = new Map(result.files.map((file) => [file.path, file.sha256]))
  const proof: TreeDigestEntry[] = result.entries.map((entry) =>
    entry.kind === 'directory' ? { entry } : { entry, sha256: digests.get(entry.path) }
  )
  t.alike(
    result.treeSha256,
    treeDigest(proof),
    'they are exactly what the tree digest is built from'
  )
})

test('a legacy whole-tree record imports its files only after an exact proof', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, { 'a/x.bin': 'xx', 'a/empty/': '', 'z.bin': '', 'b/y.bin': 'yyy' })
  const { record, digested } = await legacyOf(root)

  const imported = importLegacyDirectory(record, digested)
  if (!imported.ok) throw new Error(`expected an import, got ${imported.reason}`)
  const { catalog } = imported
  t.alike(
    catalog.files.map((file) => [file.path, file.size, file.sha256]),
    [
      ['a/x.bin', 2, sha('xx')],
      ['b/y.bin', 3, sha('yyy')],
      ['z.bin', 0, sha('')]
    ],
    'the files, a zero-length one included, and not the empty directory'
  )
  t.alike(
    [...new Set(catalog.files.map((file) => JSON.stringify(file.writer)))].map(
      (writer) => JSON.parse(writer) as unknown
    ),
    [{ transferId: hexId(7), uploader: hexId(8), committedAt: 123_456 }],
    'every file keeps the legacy upload as its writer'
  )
  t.is(catalog.name, 'beta-1.2.3')
  t.alike(catalog.release, RELEASE)
  t.is(catalog.generation, 1)
  t.alike(
    catalog.receipts.map((receipt) => [
      receipt.transferId,
      receipt.files,
      receipt.added,
      receipt.bytes
    ]),
    [[hexId(7), 3, 3, 5]]
  )
  t.is(catalog.receipts[0].subset, subsetDigest(catalog.files))
  t.alike(decodeFileCatalog(serializeFileCatalog(catalog)), catalog, 'and it is a valid catalog')
})

test('a legacy root that is not exactly the recorded tree is never adopted, not even in part', async (t) => {
  const tree = { 'a/x.bin': 'xx', 'a/empty/': '', 'z.bin': '', 'b/y.bin': 'yyy' }
  const dirty: Array<[string, (root: string) => Promise<void>]> = [
    ['an extra file', (root) => fs.promises.writeFile(path.join(root, 'extra.txt'), 'operator')],
    ['a changed byte', (root) => fs.promises.writeFile(path.join(root, 'a/x.bin'), 'xy')],
    ['a removed file', (root) => fs.promises.unlink(path.join(root, 'b/y.bin'))],
    ['an extra empty directory', (root) => fs.promises.mkdir(path.join(root, 'newdir'))],
    ['a removed empty directory', (root) => fs.promises.rmdir(path.join(root, 'a/empty'))]
  ]
  for (const [name, change] of dirty) {
    const root = await createTempDir(t)
    await writeTree(root, tree)
    const { record } = await legacyOf(root)
    await change(root)
    const result = importLegacyDirectory(record, await digestTree(root, createStorage()))
    t.alike(result, { ok: false, reason: 'DIRTY' }, name)
    t.is('catalog' in result, false, `${name}: no part of it is adopted`)
  }

  const root = await createTempDir(t)
  await writeTree(root, tree)
  const { record, digested } = await legacyOf(root)
  const lies: Array<[string, LegacyDirectoryRecord]> = [
    ['a record with another digest', { ...record, sha256: sha('other') }],
    ['a record with another entry count', { ...record, entryCount: record.entryCount + 1 }],
    ['a record with another size', { ...record, size: record.size + 1 }]
  ]
  for (const [name, wrong] of lies) {
    t.alike(importLegacyDirectory(wrong, digested), { ok: false, reason: 'DIRTY' }, name)
  }

  // The proof is recomputed from the digests handed in, so a caller cannot vouch for what it did not read.
  const forged = {
    entries: digested.entries,
    files: digested.files.map((file, index) =>
      index === 0 ? { ...file, sha256: b4a.from(sha('forged'), 'hex') } : file
    )
  }
  t.alike(importLegacyDirectory(record, forged), { ok: false, reason: 'DIRTY' }, 'a forged digest')
  t.alike(
    importLegacyDirectory(record, {
      entries: digested.entries,
      files: [...digested.files, { path: 'phantom', size: 1, sha256: b4a.from(sha('p'), 'hex') }]
    }),
    { ok: false, reason: 'DIRTY' },
    'a digest for a file that is not in the tree'
  )
  t.alike(
    importLegacyDirectory(record, { entries: digested.entries, files: digested.files.slice(1) }),
    { ok: false, reason: 'DIRTY' },
    'a file without a digest'
  )

  const invalid: Array<[string, LegacyDirectoryRecord]> = [
    ['a name that is not a basename', { ...record, name: '../x' }],
    ['a digest that is not hex', { ...record, sha256: 'zz' }],
    ['a transfer ID that is not hex', { ...record, transferId: 'nope' }],
    ['a negative time', { ...record, committedAt: -1 }],
    ['an invalid release', { ...record, release: { series: '' } }]
  ]
  for (const [name, wrong] of invalid) {
    t.alike(importLegacyDirectory(wrong, digested), { ok: false, reason: 'INVALID_RECORD' }, name)
  }
})

async function catalogDirectory(t: Assert): Promise<string> {
  const directory = path.join(await createTempDir(t), 'catalogs')
  await fs.promises.mkdir(directory, { mode: 0o700 })
  return directory
}

test('a catalog is stored under a hash of its name, privately, and read back exactly', async (t) => {
  const storage = createStorage()
  const directory = await catalogDirectory(t)
  const catalog = sample()
  t.is(await readFileCatalog(directory, catalog.name, storage), null, 'none yet')

  // A catalog planned from nothing is generation 1; generation 0 is only the empty starting point.
  await t.exception(() => commitFileCatalog(directory, emptyFileCatalog('x'), storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  const first = merge(new Disk(), fresh('beta-1.2.3'), { 'a/x': 'x' }).catalog
  await commitFileCatalog(directory, first, storage)
  t.alike(await readFileCatalog(directory, first.name, storage), first)

  const stem = catalogGroupId(first.name)
  t.alike(await fs.promises.readdir(directory), [`${stem}.json`], 'no name, no temporary file')
  t.is(fileCatalogPath(directory, first.name), path.join(directory, `${stem}.json`))
  t.is((await fs.promises.stat(fileCatalogPath(directory, first.name))).mode & 0o777, 0o600)
})

test('a stale plan cannot replace a catalog that moved on, and nothing is written', async (t) => {
  const storage = createStorage()
  const directory = await catalogDirectory(t)
  const disk = new Disk()
  const base = merge(disk, fresh('beta-1.2.3'), { 'a/x': 'x' }).catalog
  await commitFileCatalog(directory, base, storage)

  // Two planners start from the same catalog; only one of them can win.
  const left = merge(
    new Disk({ 'a/x': 'x' }),
    base,
    { 'b/left': 'l' },
    { writer: writerOf(2) }
  ).catalog
  const right = merge(
    new Disk({ 'a/x': 'x' }),
    base,
    { 'b/right': 'r' },
    { writer: writerOf(3) }
  ).catalog
  await commitFileCatalog(directory, left, storage)
  await t.exception(() => commitFileCatalog(directory, right, storage), {
    code: ERRORS.FILE_BUSY
  })
  t.alike(
    await readFileCatalog(directory, base.name, storage),
    left,
    "the first writer's catalog stands"
  )
  t.alike(await fs.promises.readdir(directory), [`${catalogGroupId(base.name)}.json`])

  // A catalog that vanished is not silently recreated from a later generation.
  const other = await catalogDirectory(t)
  await t.exception(() => commitFileCatalog(other, left, storage), { code: ERRORS.FILE_BUSY })
  t.alike(await fs.promises.readdir(other), [])
})

test('a catalog file that is not a trustworthy catalog is refused and never repaired', async (t) => {
  const storage = createStorage()
  const catalog = merge(new Disk(), fresh('beta-1.2.3'), { 'a/x': 'x' }).catalog
  const cases: Array<
    [string, (file: string, directory: string) => Promise<void>, Record<string, unknown>]
  > = [
    [
      'garbage',
      (file) => fs.promises.writeFile(file, 'not json at all'),
      { code: ERRORS.PROTOCOL_INVALID }
    ],
    [
      'a catalog for another name',
      (file) =>
        fs.promises.writeFile(
          file,
          serializeFileCatalog(merge(new Disk(), fresh('other'), { 'a/x': 'x' }).catalog)
        ),
      { code: ERRORS.PROTOCOL_INVALID, message: /another name/ }
    ],
    [
      'a catalog that breaks the schema',
      (file) => fs.promises.writeFile(file, JSON.stringify({ ...raw(catalog), extra: 1 })),
      { code: ERRORS.PROTOCOL_INVALID }
    ],
    [
      'a file past the size limit',
      (file) => fs.promises.writeFile(file, b4a.alloc(MAX_CATALOG_BYTES + 1, 0x20)),
      { code: ERRORS.PROTOCOL_INVALID }
    ],
    [
      'a symlink',
      async (file, directory) => {
        const target = path.join(directory, '..', 'target.json')
        await fs.promises.writeFile(target, serializeFileCatalog(catalog))
        await fs.promises.symlink(target, file)
      },
      { code: ERRORS.PROTOCOL_INVALID }
    ]
  ]
  for (const [name, plant, expected] of cases) {
    const directory = await catalogDirectory(t)
    const file = fileCatalogPath(directory, catalog.name)
    await plant(file, directory)
    await t.exception(() => readFileCatalog(directory, catalog.name, storage), expected, name)
    await t.exception(
      () => commitFileCatalog(directory, catalog, storage),
      { code: ERRORS.PROTOCOL_INVALID },
      `${name}: a write does not paper over it either`
    )
  }
})

test('removing a catalog needs the generation it was read at and touches nothing else', async (t) => {
  const storage = createStorage()
  const directory = await catalogDirectory(t)
  const one = merge(new Disk(), fresh('beta-1.2.3'), { 'a/x': 'x' }).catalog
  const other = merge(new Disk(), fresh('other'), { 'a/x': 'x' }).catalog
  await commitFileCatalog(directory, one, storage)
  await commitFileCatalog(directory, other, storage)

  t.is(await removeFileCatalog(directory, 'absent', 1, storage), false)
  await t.exception(() => removeFileCatalog(directory, one.name, one.generation + 1, storage), {
    code: ERRORS.FILE_BUSY
  })
  t.alike(
    await readFileCatalog(directory, one.name, storage),
    one,
    'a wrong generation removes nothing'
  )
  t.is(await removeFileCatalog(directory, one.name, one.generation, storage), true)
  t.is(await readFileCatalog(directory, one.name, storage), null)
  t.alike(
    await readFileCatalog(directory, other.name, storage),
    other,
    'another catalog is untouched'
  )
})

/** The root-record reader of releases through 0.7: a string `root`, or the state is malformed. */
function legacyReadBinding(marker: string): string {
  const bound: unknown = JSON.parse(fs.readFileSync(marker, 'utf8'))
  const owner = typeof bound === 'object' && bound !== null && 'root' in bound ? bound.root : null
  if (typeof owner !== 'string') {
    throw Object.assign(new Error(`Malformed state directory record: ${marker}`), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  return owner
}

test('the catalog feature is a durable barrier that older readers refuse and this release reads', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const marker = path.join(layout.internal, STATE_ROOT_NAME)
  const canonical = await fs.promises.realpath(layout.root)
  const read = (): unknown => JSON.parse(fs.readFileSync(marker, 'utf8'))
  t.alike(read(), { version: 1, root: canonical }, 'opening the state does not require it')
  t.is(stateRequiresFeature(layout, STATE_FEATURE_FILE_CATALOG), false)
  t.is(legacyReadBinding(marker), canonical, 'an older reader reads the untouched record')

  requireStateFeature(layout, STATE_FEATURE_FILE_CATALOG)
  t.alike(read(), {
    version: 2,
    root: { path: canonical, requires: [STATE_FEATURE_FILE_CATALOG] }
  })
  t.is(stateRequiresFeature(layout, STATE_FEATURE_FILE_CATALOG), true)
  t.is(stateRequiresFeature(layout, STATE_FEATURE_DIRECTORY_REPLACEMENT), false)
  t.is((await fs.promises.stat(marker)).mode & 0o777, 0o600)
  await t.exception(
    () => legacyReadBinding(marker),
    { message: /Malformed state directory record/ },
    'an older server stops at startup, before it reads anything else'
  )

  // This release reads the record, marking again changes nothing, and features accumulate sorted.
  t.is(findLayout(layout.root, layout.internal).internal, layout.internal)
  const bytes = fs.readFileSync(marker, 'utf8')
  requireStateFeature(layout, STATE_FEATURE_FILE_CATALOG)
  t.is(fs.readFileSync(marker, 'utf8'), bytes)
  requireStateFeature(layout, STATE_FEATURE_DIRECTORY_REPLACEMENT)
  t.alike(read(), {
    version: 2,
    root: {
      path: canonical,
      requires: [STATE_FEATURE_DIRECTORY_REPLACEMENT, STATE_FEATURE_FILE_CATALOG]
    }
  })
  t.is(initLayout(layout.root, layout.internal).internal, layout.internal)

  // A feature this release does not know is still refused.
  fs.writeFileSync(
    marker,
    JSON.stringify({ version: 2, root: { path: canonical, requires: ['file-catalog-v2'] } })
  )
  await t.exception(() => findLayout(layout.root, layout.internal), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /requires the feature file-catalog-v2/
  })
})
