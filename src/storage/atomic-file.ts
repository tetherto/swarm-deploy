import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { openSafeRegularFile, withSafeDirectoryIdentity } from './layout.js'
import type { StorageAdapter, StorageFileHandle } from './types.js'

// Enough for 262,144 hex chunk digests while bounding untrusted on-disk reads.
const MAX_SESSION_METADATA_BYTES = 32 * 1024 * 1024
export const ATOMIC_WRITE_PHASE = Object.freeze({
  BEFORE_RENAME: 'before-rename',
  AFTER_RENAME: 'after-rename'
})

export class MetadataFormatError extends SwarmDeployError {
  metadataFormat: boolean

  constructor(message: string, cause: unknown | null = null) {
    super(ERRORS.PROTOCOL_INVALID, message, cause)
    this.metadataFormat = true
  }
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

interface AtomicWriteError extends Error {
  atomicWritePhase?: string
}

function markAtomicWriteError(error: unknown, phase: string): AtomicWriteError {
  const marked = error instanceof Error ? error : new Error(String(error))
  ;(marked as AtomicWriteError).atomicWritePhase = phase
  return marked
}

export function atomicWriteRenamed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'atomicWritePhase' in error &&
    error.atomicWritePhase === ATOMIC_WRITE_PHASE.AFTER_RENAME
  )
}

function randomSuffix(): string {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

async function assertRegularOrAbsent(filePath: string, storage: StorageAdapter): Promise<void> {
  try {
    const stat = await storage.lstat(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storageError(`Unsafe metadata file: ${filePath}`)
    }
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
}

async function writeAll(handle: StorageFileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write atomic metadata')
    }
    offset += count
  }
}

async function readAll(handle: StorageFileHandle, size: number): Promise<Buffer> {
  const bytes = b4a.alloc(size)
  let offset = 0
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Truncated metadata file')
    }
    offset += count
  }
  return bytes
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeAtomic(
  filePath: string,
  bytes: Uint8Array,
  storage: StorageAdapter = fs.promises
): Promise<void> {
  if (!(b4a.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    throw storageError('Atomic metadata must be bytes')
  }

  const directory = path.dirname(filePath)
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomSuffix()}.tmp`)
  let renamed = false
  try {
    await withSafeDirectoryIdentity(directory, storage, () =>
      assertRegularOrAbsent(filePath, storage)
    )
    await withSafeDirectoryIdentity(directory, storage, async () => {
      const handle = await storage.open(temporary, 'wx', 0o600)
      try {
        await writeAll(handle, bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })

    await withSafeDirectoryIdentity(directory, storage, () =>
      assertRegularOrAbsent(filePath, storage)
    )
    await withSafeDirectoryIdentity(directory, storage, async () => {
      await storage.rename(temporary, filePath)
      renamed = true
    })
    await withSafeDirectoryIdentity(directory, storage, () => syncDirectory(directory, storage))
  } catch (error: unknown) {
    if (!renamed) {
      await withSafeDirectoryIdentity(directory, storage, () => storage.unlink(temporary)).catch(
        () => {}
      )
    }
    throw markAtomicWriteError(
      error,
      renamed ? ATOMIC_WRITE_PHASE.AFTER_RENAME : ATOMIC_WRITE_PHASE.BEFORE_RENAME
    )
  }
}

export async function readJson(
  filePath: string,
  storage: StorageAdapter = fs.promises,
  maxBytes = MAX_SESSION_METADATA_BYTES
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw storageError('Invalid metadata size limit')
  }
  const directory = path.dirname(filePath)
  return withSafeDirectoryIdentity(directory, storage, async () => {
    let handle: StorageFileHandle | null = null
    try {
      handle = await openSafeRegularFile(filePath, 'read', storage)
      const stat = await handle.stat()
      if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
        throw storageError(`Metadata file exceeds ${maxBytes} byte limit`)
      }
      const bytes = await readAll(handle, stat.size)
      let parsed: unknown
      try {
        parsed = JSON.parse(b4a.toString(bytes, 'utf8'))
      } catch (error: unknown) {
        throw new MetadataFormatError(`Malformed metadata file: ${filePath}`, error)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new MetadataFormatError(`Malformed metadata file: ${filePath}`)
      }
      return parsed as Record<string, unknown>
    } catch (error: unknown) {
      if (error instanceof SwarmDeployError || error instanceof MetadataFormatError) throw error
      throw error
    } finally {
      if (handle) await handle.close()
    }
  })
}

export { MAX_SESSION_METADATA_BYTES }
