import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { historyName, isReservedHistoryName, validateBasename } from '../files.js'
import { assertSafeUint } from '../protocol/validation.js'
import { MetadataFormatError, readJson } from './atomic-file.js'
import { assertSafeFile } from './layout.js'
import type { StorageAdapter, StorageLayout, StorageStat } from './types.js'

const COMMIT_VERSION = 1
const REPLACEMENT_COMMIT_VERSION = 2
const JOURNAL_VERSION = 1
const REPLACEMENT_JOURNAL_VERSION = 2
const MAX_COMMIT_METADATA_BYTES = 16 * 1024

/** Ordered v2 transaction boundaries; each one is durable before the next. */
export const REPLACEMENT_PHASES = [
  'journaled',
  'deduped',
  'history-linked',
  'publication-linked',
  'final-renamed',
  'current-sidecar',
  'history-sidecar',
  'cleanup'
] as const

export type ReplacementPhase = (typeof REPLACEMENT_PHASES)[number]

function isReplacementPhase(value: unknown): value is ReplacementPhase {
  return typeof value === 'string' && (REPLACEMENT_PHASES as readonly string[]).includes(value)
}

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

/** The mutable name, transfer, and history path one replacement superseded. */
export interface CommitReplacement {
  name: string
  transferId: string
  historyName: string
}

export interface CommitRecord {
  version: number
  name: string
  size: number
  sha256: string
  committedAt: number
  uploaderFingerprint: string
  transferId: string
  replaces?: CommitReplacement
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertReplacement(value: unknown): asserts value is CommitReplacement {
  if (!isRecordLike(value)) throw storageError('Invalid commit replacement metadata')
  if (typeof value.name !== 'string' || isReservedHistoryName(value.name)) {
    throw storageError('Invalid replaced name')
  }
  validateBasename(value.name)
  if (!isHex(value.transferId)) throw storageError('Invalid replaced transfer ID')
  if (value.historyName !== historyName(value.transferId)) {
    throw storageError('Invalid replacement history name')
  }
}

function assertCommitRecordShape(record: unknown): asserts record is CommitRecord {
  if (!isRecordLike(record)) throw storageError('Invalid commit record')
  const candidate = record
  if (candidate.version !== COMMIT_VERSION && candidate.version !== REPLACEMENT_COMMIT_VERSION) {
    throw storageError('Invalid commit record version')
  }
  validateBasename(typeof candidate.name === 'string' ? candidate.name : '')
  assertSafeUint(candidate.size, 'commit size')
  if (!isHex(candidate.sha256)) throw storageError('Invalid commit digest')
  assertSafeUint(candidate.committedAt, 'commit timestamp')
  if (!isHex(candidate.uploaderFingerprint)) throw storageError('Invalid uploader fingerprint')
  if (!isHex(candidate.transferId)) throw storageError('Invalid commit transfer ID')
  if (candidate.version === REPLACEMENT_COMMIT_VERSION) {
    assertReplacement(candidate.replaces)
  } else if (candidate.replaces !== undefined) {
    throw storageError('Unexpected commit replacement metadata')
  }
}

/** Validates in place so unknown persisted fields survive a read/write round-trip. */
export function assertCommitRecord(record: unknown): CommitRecord {
  assertCommitRecordShape(record)
  return record
}

export interface FileIdentity {
  dev: string
  ino: string
}

export interface CommitJournal {
  version: 1
  record: CommitRecord
  attemptId: string
  sourceStagingIdentity: FileIdentity
  state: 'committing' | 'aborting'
}

/**
 * The v2 transaction. It names the mutable final, the pinned old record and
 * inode, the destination history path, the private publication, every owned
 * inode identity, and the phase the attempt reached.
 */
export interface ReplacementJournal {
  version: 2
  intent: 'replace'
  state: 'committing' | 'aborting'
  phase: ReplacementPhase
  transferId: string
  attemptId: string
  name: string
  historyName: string
  publicationName: string
  sourceStagingIdentity: FileIdentity
  finalIdentity: FileIdentity
  historyIdentity: FileIdentity
  publicationIdentity: FileIdentity
  dedupHistoryName: string | null
  oldRecord: CommitRecord
  record: CommitRecord
}

export type AnyCommitJournal = CommitJournal | ReplacementJournal

export function isReplacementJournal(
  journal: AnyCommitJournal | null
): journal is ReplacementJournal {
  return journal !== null && journal.version === REPLACEMENT_JOURNAL_VERSION
}

function parseIdentity(value: unknown): FileIdentity {
  if (!isRecordLike(value)) throw new CorruptJournalError('Invalid commit journal')
  const { dev, ino } = value
  if (
    typeof dev !== 'string' ||
    typeof ino !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(dev) ||
    !/^(0|[1-9][0-9]*)$/.test(ino)
  ) {
    throw new CorruptJournalError('Invalid commit journal')
  }
  return { dev, ino }
}

function parseRecord(value: unknown): CommitRecord {
  try {
    return assertCommitRecord(value)
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid commit journal record', error)
  }
}

function parseReplacementJournal(id: string, journal: Record<string, unknown>): ReplacementJournal {
  if (
    journal.intent !== 'replace' ||
    (journal.state !== 'committing' && journal.state !== 'aborting') ||
    !isReplacementPhase(journal.phase) ||
    journal.transferId !== id ||
    !isHex(journal.attemptId) ||
    typeof journal.name !== 'string' ||
    journal.publicationName !== `${journal.attemptId}.part`
  ) {
    throw new CorruptJournalError('Invalid replacement journal')
  }
  let name: string
  try {
    name = validateBasename(journal.name)
    if (isReservedHistoryName(name)) throw storageError('Reserved replacement name')
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid replacement journal name', error)
  }
  const record = parseRecord(journal.record)
  const oldRecord = parseRecord(journal.oldRecord)
  if (record.transferId !== id) throw new CorruptJournalError('Commit journal ID mismatch')
  if (record.name !== name) throw new CorruptJournalError('Replacement journal name mismatch')
  if (journal.historyName !== historyName(oldRecord.transferId)) {
    throw new CorruptJournalError('Invalid replacement history name')
  }
  if (oldRecord.transferId === record.transferId) {
    throw new CorruptJournalError('Replacement journal replaces its own transfer')
  }
  if (
    journal.dedupHistoryName !== null &&
    journal.dedupHistoryName !== historyName(record.transferId)
  ) {
    throw new CorruptJournalError('Invalid replacement dedup name')
  }
  return {
    version: REPLACEMENT_JOURNAL_VERSION,
    intent: 'replace',
    state: journal.state,
    phase: journal.phase,
    transferId: id,
    attemptId: journal.attemptId,
    name,
    historyName: journal.historyName,
    publicationName: journal.publicationName,
    sourceStagingIdentity: parseIdentity(journal.sourceStagingIdentity),
    finalIdentity: parseIdentity(journal.finalIdentity),
    historyIdentity: parseIdentity(journal.historyIdentity),
    publicationIdentity: parseIdentity(journal.publicationIdentity),
    dedupHistoryName: journal.dedupHistoryName,
    oldRecord,
    record
  }
}

/** The exact durable shape of a journal, for creation and phase transitions. */
export function serializeJournal(journal: AnyCommitJournal): Record<string, unknown> {
  if (journal.version === REPLACEMENT_JOURNAL_VERSION) {
    return {
      version: REPLACEMENT_JOURNAL_VERSION,
      intent: journal.intent,
      state: journal.state,
      phase: journal.phase,
      transferId: journal.transferId,
      attemptId: journal.attemptId,
      name: journal.name,
      historyName: journal.historyName,
      publicationName: journal.publicationName,
      sourceStagingIdentity: journal.sourceStagingIdentity,
      finalIdentity: journal.finalIdentity,
      historyIdentity: journal.historyIdentity,
      publicationIdentity: journal.publicationIdentity,
      dedupHistoryName: journal.dedupHistoryName,
      oldRecord: journal.oldRecord,
      record: journal.record
    }
  }
  return {
    version: JOURNAL_VERSION,
    state: journal.state,
    transferId: journal.record.transferId,
    attemptId: journal.attemptId,
    sourceStagingIdentity: journal.sourceStagingIdentity,
    record: journal.record
  }
}

export async function readCommitJournal(
  id: string,
  layout: StorageLayout,
  storage: StorageAdapter
): Promise<AnyCommitJournal | null> {
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
    if (journal.version === REPLACEMENT_JOURNAL_VERSION) {
      return parseReplacementJournal(id, journal)
    }
    if (
      journal.version !== JOURNAL_VERSION ||
      (journal.state !== 'committing' && journal.state !== 'aborting') ||
      journal.transferId !== id ||
      !isHex(journal.attemptId)
    ) {
      throw new CorruptJournalError('Invalid commit journal')
    }
    const sourceStagingIdentity = parseIdentity(journal.sourceStagingIdentity)
    const record = parseRecord(journal.record)
    if (record.transferId !== id) throw new CorruptJournalError('Commit journal ID mismatch')
    return {
      version: JOURNAL_VERSION,
      record,
      attemptId: journal.attemptId,
      sourceStagingIdentity,
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

export {
  COMMIT_VERSION,
  REPLACEMENT_COMMIT_VERSION,
  JOURNAL_VERSION,
  REPLACEMENT_JOURNAL_VERSION,
  MAX_COMMIT_METADATA_BYTES
}
