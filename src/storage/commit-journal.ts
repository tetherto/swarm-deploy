import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { validateBasename } from '../files.js'
import { assertSafeUint } from '../protocol/validation.js'
import { MetadataFormatError, readJson } from './atomic-file.js'
import { assertSafeFile } from './layout.js'
import type { StorageAdapter, StorageLayout, StorageStat } from './types.js'

const COMMIT_VERSION = 1
const JOURNAL_VERSION = 1
const MAX_COMMIT_METADATA_BYTES = 16 * 1024

export class CorruptJournalError extends Error {
  cause: unknown | null

  constructor(message: string, cause: unknown | null = null) {
    super(message)
    this.name = 'CorruptJournalError'
    this.cause = cause
  }
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function isMissing(error: unknown): boolean {
  if (errorCode(error) === 'ENOENT') return true
  return (
    typeof error === 'object' &&
    error !== null &&
    'cause' in error &&
    errorCode(error.cause) === 'ENOENT'
  )
}

function identityValue(value: unknown): string {
  if (
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) &&
    (typeof value !== 'bigint' || value < 0n)
  ) {
    throw storageError('Storage file identity is unavailable')
  }
  return String(value)
}

export function fileIdentity(stat: StorageStat): { dev: string; ino: string } {
  return { dev: identityValue(stat.dev), ino: identityValue(stat.ino) }
}

export function identitiesEqual(
  left: { dev: string; ino: string },
  right: { dev: string; ino: string }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export interface CommitRecord {
  version: number
  name: string
  size: number
  sha256: string
  committedAt: number
  uploaderFingerprint: string
  transferId: string
}

export function assertCommitRecord(record: unknown): CommitRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw storageError('Invalid commit record')
  }
  const candidate = record as Record<string, unknown>
  if (candidate.version !== COMMIT_VERSION) throw storageError('Invalid commit record version')
  const name = typeof candidate.name === 'string' ? candidate.name : ''
  validateBasename(name)
  assertSafeUint(candidate.size, 'commit size')
  if (!isHex(candidate.sha256)) throw storageError('Invalid commit digest')
  assertSafeUint(candidate.committedAt, 'commit timestamp')
  if (!isHex(candidate.uploaderFingerprint)) throw storageError('Invalid uploader fingerprint')
  if (!isHex(candidate.transferId)) throw storageError('Invalid commit transfer ID')
  return {
    version: COMMIT_VERSION,
    name,
    size: candidate.size,
    sha256: candidate.sha256,
    committedAt: candidate.committedAt,
    uploaderFingerprint: candidate.uploaderFingerprint,
    transferId: candidate.transferId
  }
}

export interface CommitJournal {
  record: CommitRecord
  attemptId: string
  sourceStagingIdentity: { dev: string; ino: string }
  state: 'committing' | 'aborting'
}

export async function readCommitJournal(
  id: string,
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<CommitJournal | null> {
  if (!isHex(id)) throw storageError('Invalid journal ID')
  const journalPath = path.join(layout.journals, `${id}.json`)
  let journal: Record<string, unknown>
  try {
    try {
      await assertSafeFile(journalPath, storage)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
    journal = await readJson(journalPath, storage, MAX_COMMIT_METADATA_BYTES)
    const sourceStagingIdentity = journal.sourceStagingIdentity
    if (
      journal.version !== JOURNAL_VERSION ||
      (journal.state !== 'committing' && journal.state !== 'aborting') ||
      journal.transferId !== id ||
      !isHex(journal.attemptId) ||
      !sourceStagingIdentity ||
      typeof sourceStagingIdentity !== 'object' ||
      Array.isArray(sourceStagingIdentity) ||
      !('dev' in sourceStagingIdentity) ||
      !('ino' in sourceStagingIdentity)
    ) {
      throw new CorruptJournalError('Invalid commit journal')
    }
    const { dev, ino } = sourceStagingIdentity
    if (
      typeof dev !== 'string' ||
      typeof ino !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(dev) ||
      !/^(0|[1-9][0-9]*)$/.test(ino)
    ) {
      throw new CorruptJournalError('Invalid commit journal')
    }
    let record: CommitRecord
    try {
      record = assertCommitRecord(journal.record)
    } catch (error: unknown) {
      throw new CorruptJournalError('Invalid commit journal record', error)
    }
    if (record.transferId !== id) throw new CorruptJournalError('Commit journal ID mismatch')
    return {
      record,
      attemptId: journal.attemptId,
      sourceStagingIdentity: {
        dev,
        ino
      },
      state: journal.state
    }
  } catch (error: unknown) {
    if (error instanceof CorruptJournalError) throw error
    if (error instanceof MetadataFormatError) {
      throw new CorruptJournalError('Malformed commit journal', error)
    }
    throw error
  }
}

export { COMMIT_VERSION, JOURNAL_VERSION, MAX_COMMIT_METADATA_BYTES }
