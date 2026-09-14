import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { throwIfAborted } from './abort.js'
import { ERRORS, SwarmDeployError } from './errors.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const TRANSFER_ID_HEX = /^[0-9a-f]{64}$/

/** Reserved top-level namespace for server-managed historical artifacts. */
export const HISTORY_NAME_PREFIX = 'history-'

export interface SelectUploadPathsOptions {
  signal?: {
    readonly aborted: boolean
    addEventListener(event: 'abort', callback: () => void, options?: { once?: boolean }): void
    removeEventListener(event: 'abort', callback: () => void): void
  } | null
}

export function validateBasename(name: string): string {
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || b4a.from(name).byteLength > 100) {
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
  if (isReservedHistoryName(name)) {
    return { kind: 'skipped', reason: 'reserved-history' }
  }

  return { kind: 'selected', name }
}

export type SkippedUploadReason =
  'symlink' | 'directory' | 'not-regular-file' | 'invalid-filename' | 'reserved-history'

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
    const name = validateBasename(path.basename(inputPath))
    if (isReservedHistoryName(name)) {
      throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
    }
    return {
      paths: [inputPath],
      skipped: [],
      failed: [],
      entries: [{ kind: 'selected', name, path: inputPath }]
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
