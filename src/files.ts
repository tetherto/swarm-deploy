import fs from '#fs'
import path from '#path'
import os from '#os'
import crypto from '#crypto'
import { abortError, onAbort, throwIfAborted } from './abort.js'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { Digest } from './types.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DEFAULT_CHUNK_SIZE = 1024 * 1024
const TRANSFER_ID_HEX = /^[0-9a-f]{64}$/

/** Reserved top-level namespace for server-managed historical artifacts. */
export const HISTORY_NAME_PREFIX = 'history-'

export interface FileSnapshot {
  size: number
  mtimeMs: number
  ino: number | bigint
}

export interface FileManifest {
  path: string
  name: string
  size: number
  digest: Digest
  chunkDigests: Digest[]
  chunkCount: number
  chunkSize: number
  stat: FileSnapshot
}

export interface BuildFileManifestOptions {
  /** Logical chunk size in bytes; defaults to 1 MiB. */
  chunkSize?: number
  /**
   * Any `AbortSignal`, or the fallback controller signal used on runtimes
   * without a global `AbortController`. Spelled structurally so the published
   * surface never points at a type that cannot be imported from the root.
   */
  signal?: {
    readonly aborted: boolean
    addEventListener(event: 'abort', callback: () => void, options?: { once?: boolean }): void
    removeEventListener(event: 'abort', callback: () => void): void
  } | null
}

export interface SelectUploadPathsOptions {
  /** See {@link BuildFileManifestOptions.signal}. */
  signal?: BuildFileManifestOptions['signal']
}

function platformName(): string {
  return os.platform()
}

function noFollowFlag(): number {
  if (fs.constants?.O_NOFOLLOW !== undefined) {
    return fs.constants.O_NOFOLLOW
  }

  const platform = platformName()
  if (platform === 'darwin') return 0x100
  if (platform === 'linux') return 0x20000

  throw new SwarmDeployError(
    ERRORS.PROTOCOL_INVALID,
    'Safe file open is unsupported on this platform'
  )
}

function openReadFlags(): number {
  const O_RDONLY = fs.constants?.O_RDONLY ?? 0
  return O_RDONLY | noFollowFlag()
}

function validatePositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
  return value
}

function resolveChunkSize(opts: BuildFileManifestOptions = {}): number {
  if (opts.chunkSize === undefined) return DEFAULT_CHUNK_SIZE
  return validatePositiveSafeInteger(opts.chunkSize, 'chunkSize')
}

export function validateBasename(name: string): string {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid filename')
  }
  return name
}

export function isReservedHistoryName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(HISTORY_NAME_PREFIX)
}

/** The unique top-level path preserving the inode a replacement superseded. */
export function historyName(oldTransferId: string): string {
  if (typeof oldTransferId !== 'string' || !TRANSFER_ID_HEX.test(oldTransferId)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid history transfer ID')
  }
  return `${HISTORY_NAME_PREFIX}${oldTransferId}`
}

/**
 * Canonicalizes the opt-in mutable-name policy. Values are exact upload names;
 * the reserved history namespace and duplicate entries are always rejected.
 */
export function validateReplaceNames(values?: Iterable<string>): Set<string> {
  if (values === undefined || values === null) return new Set()
  if (
    typeof values === 'string' ||
    typeof values !== 'object' ||
    typeof (values as Iterable<string>)[Symbol.iterator] !== 'function'
  ) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid replacement names')
  }
  const names = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid filename')
    }
    validateBasename(value)
    if (isReservedHistoryName(value)) {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved replacement name')
    }
    if (names.has(value)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Duplicate replacement name')
    }
    names.add(value)
  }
  return names
}

function snapshotStat(stat: fs.Stats): FileSnapshot {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino
  }
}

function assertStableStat(before: FileSnapshot, after: FileSnapshot): void {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'File changed during pre-hash')
  }
}

type SelectedEntry = { kind: 'selected'; name: string }
type SkippedEntry = { kind: 'skipped'; reason: SkippedUploadReason }
type ClassifiedEntry = SelectedEntry | SkippedEntry

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function classifyEntry(entryPath: string, stat: fs.Stats): ClassifiedEntry {
  if (stat.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink' }
  }
  if (stat.isDirectory()) {
    return { kind: 'skipped', reason: 'directory' }
  }
  if (!stat.isFile()) {
    return { kind: 'skipped', reason: 'not-regular-file' }
  }

  const name = path.basename(entryPath)
  try {
    validateBasename(name)
  } catch {
    return { kind: 'skipped', reason: 'invalid-filename' }
  }

  return { kind: 'selected', name }
}

export type SkippedUploadReason = 'symlink' | 'directory' | 'not-regular-file' | 'invalid-filename'

export interface SelectedUploadPath {
  kind: 'selected'
  name: string
  path: string
}

export interface SkippedUploadPath {
  kind: 'skipped'
  name: string
  path: string
  reason: SkippedUploadReason
}

export interface FailedUploadPath {
  kind: 'failed'
  name: string
  path: string
  reason: 'unreadable'
  code: string | null
}

export type UploadPathEntry = SelectedUploadPath | SkippedUploadPath | FailedUploadPath

export interface UploadPathSelection {
  paths: string[]
  skipped: Array<Omit<SkippedUploadPath, 'kind'>>
  failed: Array<Omit<FailedUploadPath, 'kind'>>
  entries: UploadPathEntry[]
}

export async function selectUploadPaths(
  inputPath: string,
  { signal = null }: SelectUploadPathsOptions = {}
): Promise<UploadPathSelection> {
  throwIfAborted(signal)
  const rootStat = await fs.promises.lstat(inputPath)
  throwIfAborted(signal)

  if (rootStat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }

  if (rootStat.isFile()) {
    validateBasename(path.basename(inputPath))
    return {
      paths: [inputPath],
      skipped: [],
      failed: [],
      entries: [{ kind: 'selected', name: path.basename(inputPath), path: inputPath }]
    }
  }

  if (!rootStat.isDirectory()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file or directory')
  }

  const names = await fs.promises.readdir(inputPath)
  names.sort()

  const paths: string[] = []
  const skipped: Array<Omit<SkippedUploadPath, 'kind'>> = []
  const failed: Array<Omit<FailedUploadPath, 'kind'>> = []
  const entries: UploadPathEntry[] = []

  for (const name of names) {
    throwIfAborted(signal)
    const entryPath = path.join(inputPath, name)
    let entryStat
    try {
      entryStat = await fs.promises.lstat(entryPath)
    } catch (err: unknown) {
      throwIfAborted(signal)
      const entry: Omit<FailedUploadPath, 'kind'> = {
        name,
        path: entryPath,
        reason: 'unreadable',
        code: errorCode(err)
      }
      failed.push(entry)
      entries.push({ kind: 'failed', ...entry })
      continue
    }
    const classified = classifyEntry(entryPath, entryStat)

    if (classified.kind === 'selected') {
      paths.push(entryPath)
      entries.push({ kind: 'selected', name, path: entryPath })
      continue
    }

    skipped.push({
      name,
      path: entryPath,
      reason: classified.reason
    })
    entries.push({ kind: 'skipped', name, path: entryPath, reason: classified.reason })
  }

  return { paths, skipped, failed, entries }
}

async function openRegularFileNoFollow(filePath: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(filePath, openReadFlags())
  } catch (err: unknown) {
    if (errorCode(err) === 'ELOOP') {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported', err)
    }
    throw err
  }
}

export async function buildFileManifest(
  filePath: string,
  opts: BuildFileManifestOptions = {}
): Promise<FileManifest> {
  const chunkSize = resolveChunkSize(opts)
  const signal = opts.signal || null
  throwIfAborted(signal)
  const initialStat = await fs.promises.lstat(filePath)
  throwIfAborted(signal)

  if (initialStat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }
  if (!initialStat.isFile()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }

  const name = validateBasename(path.basename(filePath))
  const before = snapshotStat(initialStat)
  const handle = await openRegularFileNoFollow(filePath)

  const wholeHash = crypto.createHash('sha256')
  const chunkDigests: Buffer[] = []
  let pending = Buffer.alloc(0)
  let bytesRead = 0

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { fd: handle.fd, autoClose: false })
      const removeAbort = onAbort(signal, () => stream.destroy(abortError()))

      stream.on('data', (chunk: Buffer) => {
        try {
          throwIfAborted(signal)
        } catch (err: unknown) {
          stream.destroy(err instanceof Error ? err : abortError())
          return
        }
        bytesRead += chunk.length
        wholeHash.update(chunk)

        if (pending.length > 0) {
          const combined = Buffer.allocUnsafe(pending.length + chunk.length)
          pending.copy(combined, 0)
          chunk.copy(combined, pending.length)
          pending = combined
        } else {
          pending = Buffer.from(chunk)
        }

        while (pending.length >= chunkSize) {
          const logical = pending.subarray(0, chunkSize)
          chunkDigests.push(crypto.createHash('sha256').update(logical).digest())
          pending = pending.subarray(chunkSize)
        }
      })

      stream.on('error', (err: Error) => {
        removeAbort()
        reject(err)
      })
      stream.on('end', () => {
        removeAbort()
        if (pending.length > 0) {
          chunkDigests.push(crypto.createHash('sha256').update(pending).digest())
        }
        resolve()
      })
    })
  } finally {
    await handle.close().catch(() => {})
  }

  if (bytesRead !== before.size) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'File size mismatch during pre-hash')
  }

  const finalStat = await fs.promises.lstat(filePath)
  throwIfAborted(signal)
  assertStableStat(before, snapshotStat(finalStat))

  return {
    path: filePath,
    name,
    size: before.size,
    digest: wholeHash.digest(),
    chunkDigests,
    chunkCount: chunkDigests.length,
    chunkSize,
    stat: before
  }
}
