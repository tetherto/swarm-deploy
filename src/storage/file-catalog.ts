/**
 * The per-file ownership catalog.
 *
 * A published directory is only a container. What Swarm owns inside it is a list of individual
 * FILES, each with the digest it wrote, so a new leaf can join a folder an operator made, an
 * identical file is skipped, and nothing Swarm did not write is ever overwritten, adopted or
 * deleted. One catalog describes one artifact name (the top-level folder an upload names), as an
 * aggregate for links and retention; it never owns a directory or anything that is not listed.
 *
 * What a catalog is and is not:
 *
 * - `files` are the currently owned leaves, canonical and bounded (at most 10 000, the tree limit).
 *   Empty directories are never owned and never listed; a zero-length regular file is a file.
 * - The published identity (`ownedDigest`, `catalogSnapshotId`) describes only those leaves. The
 *   digest of an upload describes the uploaded subset (`subsetDigest`). Neither is the other, and
 *   neither covers files Swarm does not own.
 * - Every file keeps the writer that last wrote its bytes, so provenance survives later merges by
 *   other authorized clients. Writers are stored once and referenced, and only referenced ones exist.
 * - `receipts` are a bounded ring of facts about uploads this catalog has processed ("transfer T
 *   was applied at generation g"). A receipt is a historical fact and never a claim that the files
 *   still equal the upload; it is also what makes a durable catalog the linearization point of a
 *   merge for recovery.
 * - `generation` counts changes. A write checks it immediately before the atomic write, so under the
 *   lease that serializes writers two planners that started from the same catalog cannot both win.
 *
 * Everything here is strict: an exact key set, canonical ordering, caps checked before iteration,
 * and every path validated like a tree path. A catalog is only written if the bytes written parse
 * back to it. The module is storage-format only; it is not wired into startup and creates nothing
 * by itself (the directory is passed in).
 */
import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { SodiumSha256 } from '../tar-protocol/hash.js'
import {
  MAX_TREE_ENTRIES,
  assertTreeEntryPath,
  compareTreePaths,
  hashField,
  treeDigest,
  type TreeDigestEntry
} from '../tar-protocol/tree.js'
import { MAX_USTAR_FILE_BYTES } from '../tar-protocol/ustar.js'
import { MetadataFormatError, readJson, writeAtomic } from './atomic-file.js'
import { assertCommitRelease, isHex, type CommitRelease } from './commit-journal.js'
import { assertSafeFile, withSafeDirectoryIdentity } from './layout.js'
import type { TreeDigestResult } from './tree-fs.js'
import type { StorageAdapter } from './types.js'

export const FILE_CATALOG_VERSION = 1
/** The most files one catalog owns: the tree limit, so a whole upload always fits. */
export const MAX_CATALOG_FILES = MAX_TREE_ENTRIES
/** The most transfer receipts one catalog keeps; the oldest are dropped first. */
export const MAX_CATALOG_RECEIPTS = 16
/** The largest catalog file read or written: 10 000 files with one writer each is under 5 MiB. */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024

/** An upload that wrote some file: the transfer, who sent it and when it was applied. */
export interface FileWriter {
  /** The incoming transfer ID, 64 lowercase hex characters. */
  readonly transferId: string
  /** The uploader's fingerprint, 64 lowercase hex characters. */
  readonly uploader: string
  /** Milliseconds since the epoch at which the file's bytes were published. */
  readonly committedAt: number
}

/** The facts that identify one file's content. */
export interface FileFacts {
  /** Canonical relative POSIX path inside the artifact. */
  readonly path: string
  readonly size: number
  /** SHA-256 of the bytes, 64 lowercase hex characters. */
  readonly sha256: string
}

/** One file Swarm owns, with the writer that last wrote its current bytes. */
export interface OwnedFile extends FileFacts {
  readonly writer: FileWriter
}

/** A fact about one processed upload. `added + replaced + skipped === files`. */
export interface TransferReceipt {
  readonly transferId: string
  /** `subsetDigest` of the uploaded files. */
  readonly subset: string
  readonly files: number
  readonly bytes: number
  readonly added: number
  readonly replaced: number
  readonly skipped: number
  readonly uploader: string
  readonly appliedAt: number
  /** The catalog generation this upload produced (or, for a no-change upload, saw). */
  readonly generation: number
}

export interface FileCatalog {
  readonly version: typeof FILE_CATALOG_VERSION
  /** The artifact name: a valid basename that is not in the reserved history namespace. */
  readonly name: string
  readonly generation: number
  /** The release identity of every owned file; absent for an unpatterned artifact. */
  readonly release?: CommitRelease
  /** Canonical order, unique, no case alias, no file that is a directory of another. */
  readonly files: readonly OwnedFile[]
  readonly receipts: readonly TransferReceipt[]
}

/** A catalog that does not satisfy the schema. Its message never carries a path or a digest. */
export class CorruptCatalogError extends SwarmDeployError {
  readonly corruptCatalog = true

  constructor(message: string, cause: unknown = null) {
    super(ERRORS.PROTOCOL_INVALID, message, cause)
  }
}

function corrupt(message: string, cause: unknown = null): CorruptCatalogError {
  return new CorruptCatalogError(message, cause)
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

export type PathProblem = 'INVALID_PATH' | 'ORDER' | 'CASE_ALIAS' | 'KIND_CONFLICT'

/**
 * The first problem in a list of file paths, or `null` when it is canonical: every path a valid
 * tree path, strictly increasing in tree order, with no two names that differ only in case (a
 * directory included) and no path that is a file in one place and a directory in another.
 */
export function filePathProblem(
  paths: readonly string[]
): { path: string; problem: PathProblem } | null {
  const seen = new Map<string, { actual: string; file: boolean }>()
  let previous: string | null = null
  for (const filePath of paths) {
    try {
      assertTreeEntryPath(filePath, 'file')
    } catch {
      return { path: String(filePath), problem: 'INVALID_PATH' }
    }
    if (previous !== null && compareTreePaths(previous, filePath) >= 0) {
      return { path: filePath, problem: 'ORDER' }
    }
    previous = filePath
    const components = filePath.split('/')
    let prefix = ''
    for (let index = 0; index < components.length; index++) {
      prefix = index === 0 ? components[0] : `${prefix}/${components[index]}`
      const isFile = index === components.length - 1
      const key = prefix.toLowerCase()
      const prior = seen.get(key)
      if (prior === undefined) {
        seen.set(key, { actual: prefix, file: isFile })
      } else if (prior.actual !== prefix) {
        return { path: filePath, problem: 'CASE_ALIAS' }
      } else if (prior.file !== isFile || isFile) {
        // The same spelling as a file and as a directory, or a file listed twice.
        return { path: filePath, problem: isFile && prior.file ? 'ORDER' : 'KIND_CONFLICT' }
      }
    }
  }
  return null
}

function assertCanonicalPaths(paths: readonly string[]): void {
  const problem = filePathProblem(paths)
  if (problem !== null) throw corrupt(`Noncanonical file paths (${problem.problem})`)
}

// ---------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------

const OWNED_DOMAIN = 'swarm-deploy/owned-files/v1'
const SUBSET_DOMAIN = 'swarm-deploy/uploaded-files/v1'
const SNAPSHOT_DOMAIN = 'swarm-deploy/snapshot/v1'
const GROUP_DOMAIN = 'swarm-deploy/catalog-group/v1'

function digestFiles(domain: string, files: readonly FileFacts[]): string {
  assertCanonicalPaths(files.map((file) => file.path))
  const hash = new SodiumSha256()
  hashField(hash, 'domain', domain)
  hashField(hash, 'fileCount', files.length)
  for (const file of files) {
    if (!isHex(file.sha256)) throw corrupt('Invalid file digest')
    hashField(hash, 'path', file.path)
    hashField(hash, 'size', file.size)
    hashField(hash, 'sha256', b4a.from(file.sha256, 'hex'))
  }
  return b4a.toString(hash.digest(), 'hex')
}

/**
 * The digest of owned content: the files (path, size, digest), nothing else. Not provenance, not
 * the receipts, not any file Swarm does not own. Equal owned content has an equal digest however
 * and in whatever order it was merged.
 */
export function ownedDigest(files: readonly FileFacts[]): string {
  return digestFiles(OWNED_DOMAIN, files)
}

/**
 * The digest of an upload's files. It has its own domain, so a subset is never mistaken for a
 * published set that happens to hold the same files, and it ignores directory entries.
 */
export function subsetDigest(files: readonly FileFacts[]): string {
  return digestFiles(SUBSET_DOMAIN, files)
}

/** The same two-field identity of a release that `releasesEqual` compares. */
export function releasesMatch(
  left: CommitRelease | undefined,
  right: CommitRelease | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.series === right.series && left.version === right.version
}

/**
 * The identity of a published state: the artifact name, its release and the owned-content digest.
 * The same content under another release, or another name, is another snapshot, so a returning
 * state can be recognized without ever conflating two releases.
 */
export function snapshotId(
  name: string,
  release: CommitRelease | undefined,
  digest: string
): string {
  if (!isHex(digest)) throw corrupt('Invalid owned digest')
  const hash = new SodiumSha256()
  hashField(hash, 'domain', SNAPSHOT_DOMAIN)
  hashField(hash, 'name', name)
  hashField(
    hash,
    'releaseKind',
    release === undefined ? 'none' : release.version === undefined ? 'series' : 'version'
  )
  hashField(hash, 'releaseSeries', release?.series ?? '')
  hashField(hash, 'releaseVersion', release?.version ?? '')
  hashField(hash, 'owned', b4a.from(digest, 'hex'))
  return b4a.toString(hash.digest(), 'hex')
}

export function catalogSnapshotId(catalog: FileCatalog): string {
  return snapshotId(catalog.name, catalog.release, ownedDigest(catalog.files))
}

function assertCatalogName(name: unknown): string {
  if (typeof name !== 'string') throw corrupt('Invalid catalog name')
  try {
    validateBasename(name)
  } catch (error: unknown) {
    throw corrupt('Invalid catalog name', error)
  }
  if (isReservedHistoryName(name)) throw corrupt('Invalid catalog name')
  return name
}

/** The stable, name-independent file stem of a catalog: names are never used as file names. */
export function catalogGroupId(name: string): string {
  assertCatalogName(name)
  const hash = new SodiumSha256()
  hashField(hash, 'domain', GROUP_DOMAIN)
  hashField(hash, 'name', name)
  return b4a.toString(hash.digest(), 'hex')
}

// ---------------------------------------------------------------------------------------------
// Strict schema
// ---------------------------------------------------------------------------------------------

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt(`Invalid ${label}`)
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw corrupt(`Invalid ${label}`)
  }
  if (required.some((key) => !keys.includes(key))) throw corrupt(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function uint(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`Invalid ${label}`)
  }
  return value
}

function hex64(value: unknown, label: string): string {
  if (!isHex(value)) throw corrupt(`Invalid ${label}`)
  return value
}

function parseRelease(value: unknown): CommitRelease {
  try {
    assertCommitRelease(value)
  } catch (error: unknown) {
    throw corrupt('Invalid catalog release', error)
  }
  const release = value as CommitRelease
  return {
    series: release.series,
    ...(release.version === undefined ? {} : { version: release.version })
  }
}

/** A validated copy of a release identity, sharing nothing with its input. */
export const copyRelease: (value: unknown) => CommitRelease = parseRelease

function parseWriter(value: unknown): FileWriter {
  const writer = exact(value, ['transferId', 'uploader', 'committedAt'], [], 'catalog writer')
  return {
    transferId: hex64(writer.transferId, 'writer transfer ID'),
    uploader: hex64(writer.uploader, 'writer uploader'),
    committedAt: uint(writer.committedAt, 'writer time')
  }
}

function writerKey(writer: FileWriter): string {
  return `${writer.transferId}:${writer.uploader}:${writer.committedAt}`
}

function parseReceipt(value: unknown): TransferReceipt {
  const receipt = exact(
    value,
    [
      'transferId',
      'subset',
      'files',
      'bytes',
      'added',
      'replaced',
      'skipped',
      'uploader',
      'appliedAt',
      'generation'
    ],
    [],
    'transfer receipt'
  )
  const parsed: TransferReceipt = {
    transferId: hex64(receipt.transferId, 'receipt transfer ID'),
    subset: hex64(receipt.subset, 'receipt digest'),
    files: uint(receipt.files, 'receipt file count'),
    bytes: uint(receipt.bytes, 'receipt size'),
    added: uint(receipt.added, 'receipt added count'),
    replaced: uint(receipt.replaced, 'receipt replaced count'),
    skipped: uint(receipt.skipped, 'receipt skipped count'),
    uploader: hex64(receipt.uploader, 'receipt uploader'),
    appliedAt: uint(receipt.appliedAt, 'receipt time'),
    generation: uint(receipt.generation, 'receipt generation')
  }
  if (parsed.files > MAX_CATALOG_FILES) throw corrupt('Invalid receipt file count')
  if (parsed.added + parsed.replaced + parsed.skipped !== parsed.files) {
    throw corrupt('Inconsistent transfer receipt')
  }
  return parsed
}

/** Checks the invariants that span the whole catalog; used for a parsed one and a built one. */
export function assertValidFileCatalog(catalog: FileCatalog): void {
  if (catalog.version !== FILE_CATALOG_VERSION) throw corrupt('Unsupported file catalog version')
  assertCatalogName(catalog.name)
  uint(catalog.generation, 'catalog generation')
  if (catalog.release !== undefined) parseRelease(catalog.release)
  if (catalog.files.length > MAX_CATALOG_FILES) throw corrupt('Too many catalog files')
  let payload = 0
  for (const file of catalog.files) {
    uint(file.size, 'file size')
    if (file.size > MAX_USTAR_FILE_BYTES) throw corrupt('Invalid file size')
    hex64(file.sha256, 'file digest')
    parseWriter(file.writer)
    if (payload > Number.MAX_SAFE_INTEGER - file.size) throw corrupt('Catalog payload too large')
    payload += file.size
  }
  assertCanonicalPaths(catalog.files.map((file) => file.path))
  if (catalog.receipts.length > MAX_CATALOG_RECEIPTS) throw corrupt('Too many transfer receipts')
  const transfers = new Set<string>()
  for (const receipt of catalog.receipts) {
    parseReceipt(receipt)
    if (receipt.generation > catalog.generation) throw corrupt('Receipt is from a later generation')
    if (transfers.has(receipt.transferId)) throw corrupt('Duplicate transfer receipt')
    transfers.add(receipt.transferId)
  }
}

/** A catalog with nothing owned yet, at generation 0. It is never persisted as it is. */
export function emptyFileCatalog(name: string, release?: CommitRelease): FileCatalog {
  assertCatalogName(name)
  return {
    version: FILE_CATALOG_VERSION,
    name,
    generation: 0,
    ...(release === undefined ? {} : { release: parseRelease(release) }),
    files: [],
    receipts: []
  }
}

/**
 * Parses a decoded catalog. Strict: the exact key sets, every cap checked before the array it
 * bounds is walked, every writer referenced once in first-use order and none left over, so a valid
 * catalog has exactly one serialization.
 */
export function parseFileCatalog(value: unknown): FileCatalog {
  const top = exact(
    value,
    ['version', 'name', 'generation', 'writers', 'files', 'receipts'],
    ['release'],
    'file catalog'
  )
  if (top.version !== FILE_CATALOG_VERSION) throw corrupt('Unsupported file catalog version')
  const name = assertCatalogName(top.name)
  const generation = uint(top.generation, 'catalog generation')
  const release = top.release === undefined ? undefined : parseRelease(top.release)

  if (!Array.isArray(top.writers) || top.writers.length > MAX_CATALOG_FILES) {
    throw corrupt('Invalid catalog writers')
  }
  const writers = top.writers.map(parseWriter)
  if (new Set(writers.map(writerKey)).size !== writers.length) {
    throw corrupt('Duplicate catalog writer')
  }

  if (!Array.isArray(top.files) || top.files.length > MAX_CATALOG_FILES) {
    throw corrupt('Invalid catalog files')
  }
  let nextNewWriter = 0
  const files: OwnedFile[] = top.files.map((entry: unknown): OwnedFile => {
    const file = exact(entry, ['path', 'size', 'sha256', 'writer'], [], 'catalog file')
    if (typeof file.path !== 'string') throw corrupt('Invalid file path')
    const size = uint(file.size, 'file size')
    if (size > MAX_USTAR_FILE_BYTES) throw corrupt('Invalid file size')
    const index = file.writer
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      throw corrupt('Invalid file writer')
    }
    if (index >= writers.length || index > nextNewWriter) throw corrupt('Invalid file writer')
    if (index === nextNewWriter) nextNewWriter++
    return {
      path: file.path,
      size,
      sha256: hex64(file.sha256, 'file digest'),
      writer: writers[index]
    }
  })
  if (nextNewWriter !== writers.length) throw corrupt('Unreferenced catalog writer')

  if (!Array.isArray(top.receipts) || top.receipts.length > MAX_CATALOG_RECEIPTS) {
    throw corrupt('Invalid transfer receipts')
  }
  const receipts = top.receipts.map(parseReceipt)

  const catalog: FileCatalog = {
    version: FILE_CATALOG_VERSION,
    name,
    generation,
    ...(release === undefined ? {} : { release }),
    files,
    receipts
  }
  assertValidFileCatalog(catalog)
  return catalog
}

/** Decodes catalog bytes, bounded before anything is parsed. */
export function decodeFileCatalog(bytes: Uint8Array): FileCatalog {
  if (bytes.byteLength > MAX_CATALOG_BYTES) throw corrupt('File catalog exceeds its size limit')
  let decoded: unknown
  try {
    decoded = JSON.parse(b4a.toString(bytes, 'utf8'))
  } catch (error: unknown) {
    throw corrupt('Malformed file catalog', error)
  }
  return parseFileCatalog(decoded)
}

/**
 * The canonical bytes of a catalog: fixed key order, writers in first-use order. Only a valid
 * catalog serializes, and the bytes returned are checked to parse back to it.
 */
export function serializeFileCatalog(catalog: FileCatalog): Buffer {
  assertValidFileCatalog(catalog)
  const writers: FileWriter[] = []
  const indexes = new Map<string, number>()
  const files = catalog.files.map((file) => {
    const key = writerKey(file.writer)
    let index = indexes.get(key)
    if (index === undefined) {
      index = writers.length
      writers.push(file.writer)
      indexes.set(key, index)
    }
    return { path: file.path, size: file.size, sha256: file.sha256, writer: index }
  })
  const object = {
    version: FILE_CATALOG_VERSION,
    name: catalog.name,
    generation: catalog.generation,
    ...(catalog.release === undefined ? {} : { release: catalog.release }),
    writers: writers.map(({ transferId, uploader, committedAt }) => ({
      transferId,
      uploader,
      committedAt
    })),
    files,
    receipts: catalog.receipts.map((receipt) => ({
      transferId: receipt.transferId,
      subset: receipt.subset,
      files: receipt.files,
      bytes: receipt.bytes,
      added: receipt.added,
      replaced: receipt.replaced,
      skipped: receipt.skipped,
      uploader: receipt.uploader,
      appliedAt: receipt.appliedAt,
      generation: receipt.generation
    }))
  }
  const bytes = b4a.from(JSON.stringify(object))
  decodeFileCatalog(bytes)
  return bytes
}

// ---------------------------------------------------------------------------------------------
// Legacy whole-tree records
// ---------------------------------------------------------------------------------------------

/** The fields of a legacy whole-directory commit record (version 3) an import reads. */
export interface LegacyDirectoryRecord {
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly entryCount: number
  readonly transferId: string
  readonly uploaderFingerprint: string
  readonly committedAt: number
  readonly release?: CommitRelease
}

export type LegacyImport =
  | { readonly ok: true; readonly catalog: FileCatalog }
  | { readonly ok: false; readonly reason: 'DIRTY' | 'INVALID_RECORD' }

/**
 * Per-file ownership from a legacy whole-tree record, and only after an exact proof: the tree as
 * it is on disk (`digested`, the result of one verified `digestTree`) must reproduce the record's
 * tree digest, entry count and payload size byte for byte. The digest is recomputed here from the
 * per-file digests that were handed in, so a caller cannot vouch for content it did not read.
 *
 * Anything else is `DIRTY` and nothing is adopted, not even the files that still match: a root
 * with an extra, missing or changed file, or an extra directory, is not the tree the record
 * described. Empty directories of the legacy tree are proven but never owned.
 */
export function importLegacyDirectory(
  record: LegacyDirectoryRecord,
  digested: Pick<TreeDigestResult, 'entries' | 'files'>
): LegacyImport {
  let release: CommitRelease | undefined
  try {
    assertCatalogName(record.name)
    hex64(record.sha256, 'record digest')
    hex64(record.transferId, 'record transfer ID')
    hex64(record.uploaderFingerprint, 'record uploader')
    uint(record.size, 'record size')
    uint(record.entryCount, 'record entry count')
    uint(record.committedAt, 'record time')
    if (record.release !== undefined) release = parseRelease(record.release)
  } catch {
    return { ok: false, reason: 'INVALID_RECORD' }
  }

  const digestOf = new Map<string, Buffer>()
  for (const file of digested.files) digestOf.set(file.path, file.sha256)
  const proof: TreeDigestEntry[] = []
  const files: FileFacts[] = []
  let payload = 0
  try {
    for (const entry of digested.entries) {
      if (entry.kind === 'directory') {
        proof.push({ entry })
        continue
      }
      const sha256 = digestOf.get(entry.path)
      if (sha256 === undefined) return { ok: false, reason: 'DIRTY' }
      proof.push({ entry, sha256 })
      files.push({ path: entry.path, size: entry.size, sha256: b4a.toString(sha256, 'hex') })
      payload += entry.size
    }
    if (digestOf.size !== files.length) return { ok: false, reason: 'DIRTY' }
    if (
      digested.entries.length !== record.entryCount ||
      payload !== record.size ||
      b4a.toString(treeDigest(proof), 'hex') !== record.sha256
    ) {
      return { ok: false, reason: 'DIRTY' }
    }
  } catch {
    return { ok: false, reason: 'DIRTY' }
  }

  const writer: FileWriter = {
    transferId: record.transferId,
    uploader: record.uploaderFingerprint,
    committedAt: record.committedAt
  }
  try {
    const catalog: FileCatalog = {
      version: FILE_CATALOG_VERSION,
      name: record.name,
      generation: 1,
      ...(release === undefined ? {} : { release }),
      files: files.map((file) => ({ ...file, writer })),
      receipts: [
        {
          transferId: record.transferId,
          subset: subsetDigest(files),
          files: files.length,
          bytes: payload,
          added: files.length,
          replaced: 0,
          skipped: 0,
          uploader: record.uploaderFingerprint,
          appliedAt: record.committedAt,
          generation: 1
        }
      ]
    }
    assertValidFileCatalog(catalog)
    return { ok: true, catalog }
  } catch {
    return { ok: false, reason: 'INVALID_RECORD' }
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

/** Where a catalog lives under `directory`: a hash of the name, never the name itself. */
export function fileCatalogPath(directory: string, name: string): string {
  return path.join(directory, `${catalogGroupId(name)}.json`)
}

/**
 * Reads the catalog of `name`, or `null` when there is none. A file that is not a regular file, is
 * too large, is not JSON, does not satisfy the schema, or belongs to another name is corrupt; it is
 * never trusted and never repaired here.
 */
export async function readFileCatalog(
  directory: string,
  name: string,
  storage: StorageAdapter = fs.promises
): Promise<FileCatalog | null> {
  const file = fileCatalogPath(directory, name)
  try {
    await assertSafeFile(file, storage)
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  let decoded: Record<string, unknown>
  try {
    decoded = await readJson(file, storage, MAX_CATALOG_BYTES)
  } catch (error: unknown) {
    if (error instanceof MetadataFormatError) throw corrupt('Malformed file catalog', error)
    throw error
  }
  const catalog = parseFileCatalog(decoded)
  if (catalog.name !== name) throw corrupt('File catalog belongs to another name')
  return catalog
}

function catalogBusy(): SwarmDeployError {
  return new SwarmDeployError(ERRORS.FILE_BUSY, 'File catalog changed since it was planned')
}

/**
 * Durably replaces the catalog of `next.name` by `next`. It first checks that the catalog on disk is
 * still the generation `next` was planned from (no catalog is generation 0); one that moved on, or
 * vanished, is the retryable `FILE_BUSY` and nothing is written. The check and the write are not one
 * atomic step, so callers hold the lease that serializes catalog writers; under it this is a
 * compare-and-set. The write is atomic (synced temporary, rename, synced directory), so a crash
 * leaves the old catalog or the new one. A failure after the rename (`atomicWriteRenamed`) may still
 * have published `next`; the caller decides that by reading the catalog back.
 */
export async function commitFileCatalog(
  directory: string,
  next: FileCatalog,
  storage: StorageAdapter = fs.promises,
  /**
   * The generation the catalog on disk must have (0 when there is none). It is `next`'s own
   * predecessor, except when `next` continues a catalog imported from a legacy record, which has
   * not been written yet.
   */
  expectedGeneration: number = next.generation - 1
): Promise<void> {
  const bytes = serializeFileCatalog(next)
  if (next.generation < 1) throw corrupt('A persisted catalog has a generation')
  const current = await readFileCatalog(directory, next.name, storage)
  if ((current === null ? 0 : current.generation) !== expectedGeneration) throw catalogBusy()
  await writeAtomic(fileCatalogPath(directory, next.name), bytes, storage)
}

const CATALOG_FILE = /^([0-9a-f]{64})\.json$/

/**
 * Every catalog in `directory`. A file that is not a catalog under its own name is reported, not
 * read as one, so a corrupt or foreign file can neither be trusted nor hide a catalog.
 */
export async function listFileCatalogs(
  directory: string,
  storage: StorageAdapter = fs.promises
): Promise<{ catalogs: FileCatalog[]; corrupt: string[] }> {
  const names = await withSafeDirectoryIdentity(directory, storage, () =>
    storage.readdir(directory)
  )
  const catalogs: FileCatalog[] = []
  const unusable: string[] = []
  for (const filename of names.sort()) {
    const match = CATALOG_FILE.exec(filename)
    if (match === null) continue
    let catalog: FileCatalog
    try {
      catalog = parseFileCatalog(
        await readJson(path.join(directory, filename), storage, MAX_CATALOG_BYTES)
      )
    } catch {
      unusable.push(filename)
      continue
    }
    if (catalogGroupId(catalog.name) !== match[1]) {
      unusable.push(filename)
      continue
    }
    catalogs.push(catalog)
  }
  return { catalogs, corrupt: unusable }
}

/** What a catalog looks like to retention, links and hooks: one artifact with an owned size. */
export interface CatalogView {
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly entryCount: number
  readonly committedAt: number
  readonly uploaderFingerprint: string
  /** The published snapshot ID, never an upload's transfer ID. */
  readonly transferId: string
  readonly release?: CommitRelease
}

/**
 * The aggregate of a catalog's owned files, or `null` when it owns none. The newest writer stands
 * for the artifact's time and uploader. It describes only owned leaves: never a directory, never a
 * file Swarm does not own.
 */
export function catalogView(catalog: FileCatalog): CatalogView | null {
  if (catalog.files.length === 0) return null
  let newest = catalog.files[0].writer
  let size = 0
  for (const file of catalog.files) {
    size += file.size
    const writer = file.writer
    if (
      writer.committedAt > newest.committedAt ||
      (writer.committedAt === newest.committedAt && writer.transferId > newest.transferId)
    ) {
      newest = writer
    }
  }
  const digest = ownedDigest(catalog.files)
  return {
    name: catalog.name,
    size,
    sha256: digest,
    entryCount: catalog.files.length,
    committedAt: newest.committedAt,
    uploaderFingerprint: newest.uploader,
    transferId: snapshotId(catalog.name, catalog.release, digest),
    ...(catalog.release === undefined ? {} : { release: catalog.release })
  }
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Removes the catalog of `name` when it is still at `expectedGeneration`. Returns `false` when
 * there is none. Used when nothing is owned any more; it touches no published file.
 */
export async function removeFileCatalog(
  directory: string,
  name: string,
  expectedGeneration: number,
  storage: StorageAdapter = fs.promises
): Promise<boolean> {
  const current = await readFileCatalog(directory, name, storage)
  if (current === null) return false
  if (current.generation !== expectedGeneration) throw catalogBusy()
  const file = fileCatalogPath(directory, name)
  await withSafeDirectoryIdentity(directory, storage, async () => {
    await storage.unlink(file)
    await syncDirectory(directory, storage)
  })
  return true
}
