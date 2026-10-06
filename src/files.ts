import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { throwIfAborted } from './abort.js'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { ArtifactKind } from './types.js'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const TRANSFER_ID_HEX = /^[0-9a-f]{64}$/

/** Reserved top-level namespace for server-managed historical artifacts. */
export const HISTORY_NAME_PREFIX = 'history-'

export interface SelectUploadTargetOptions {
  signal?: {
    readonly aborted: boolean
    addEventListener(event: 'abort', callback: () => void, options?: { once?: boolean }): void
    removeEventListener(event: 'abort', callback: () => void): void
  } | null
}

export interface UploadTarget {
  kind: ArtifactKind
  /** The managed artifact basename. */
  name: string
  path: string
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

/**
 * Classifies one upload input. A directory becomes exactly one recursive
 * directory artifact; children are never uploaded independently.
 */
export async function selectUploadTarget(
  inputPath: string,
  { signal = null }: SelectUploadTargetOptions = {}
): Promise<UploadTarget> {
  throwIfAborted(signal)
  const stat = await fs.promises.lstat(inputPath)
  throwIfAborted(signal)
  if (stat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file or directory')
  }
  const name = validateBasename(path.basename(path.resolve(inputPath)))
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
  }
  return { kind: stat.isDirectory() ? 'directory' : 'file', name, path: inputPath }
}
