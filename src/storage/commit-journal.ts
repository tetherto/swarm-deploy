import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import path from '#path'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { historyName, isReservedHistoryName, validateBasename } from '../files.js'
import { parseStrictVersion } from '../semver.js'
import { assertSafeUint } from '../validation.js'
import { MAX_TREE_ENTRIES, assertTreeEntryPath } from '../tar-protocol/tree.js'
import { MetadataFormatError, readJson } from './atomic-file.js'
import { assertSafeFile } from './layout.js'
import type { StorageAdapter, StorageLayout, StorageStat } from './types.js'

const COMMIT_VERSION = 1
const REPLACEMENT_COMMIT_VERSION = 2
const DIRECTORY_COMMIT_VERSION = 3
/**
 * A directory record that is only a history copy (`history-<transfer ID>`): what a replaced
 * directory's record becomes. Releases through 0.7 read none of version 4 and would delete such a
 * record as invalid, which is why the state directory requires `directory-replacement-v1` before
 * any version 4 record or journal is written (see `requireStateFeature`).
 */
const DIRECTORY_HISTORY_COMMIT_VERSION = 4
const JOURNAL_VERSION = 1
const REPLACEMENT_JOURNAL_VERSION = 2
const DIRECTORY_JOURNAL_VERSION = 3
const DIRECTORY_REPLACEMENT_JOURNAL_VERSION = 4
const MAX_COMMIT_METADATA_BYTES = 16 * 1024

function sameTransferId(left: string, right: string): boolean {
  return (
    isHex(left) &&
    isHex(right) &&
    sodium.sodium_memcmp(b4a.from(left, 'hex'), b4a.from(right, 'hex'))
  )
}

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

export interface CommitRelease {
  series: string
  version?: string
}

export interface CommitRecord {
  version: number
  /** Present only on a version 3 directory record. */
  kind?: 'directory'
  name: string
  /** Payload bytes: the file size, or the aggregate tree payload size. */
  size: number
  /** The file digest, or the canonical tree digest. */
  sha256: string
  /** Present only on a version 3 directory record. */
  entryCount?: number
  committedAt: number
  uploaderFingerprint: string
  transferId: string
  release?: CommitRelease
  replaces?: CommitReplacement
  /**
   * Set only on the aggregate view of a per-file ownership catalog (`file-catalog.ts`), which is
   * built in memory and never persisted: `transferId` is then the published snapshot ID, `size` the
   * owned bytes, `entryCount` the owned files. It is the artifact retention, links and hooks see,
   * and it is never a directory to remove as a whole.
   */
  group?: true
}

/** Newest first: descending commit time, then transfer ID and name for determinism. */
export function compareCommitOrder(left: CommitRecord, right: CommitRecord): number {
  if (left.committedAt !== right.committedAt) return right.committedAt - left.committedAt
  if (left.transferId !== right.transferId) return left.transferId < right.transferId ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function commitRecordKind(record: CommitRecord): 'file' | 'directory' {
  return record.kind === 'directory' ? 'directory' : 'file'
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

export function assertCommitRelease(value: unknown): asserts value is CommitRelease {
  if (!isRecordLike(value)) throw storageError('Invalid commit release metadata')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'series' && key !== 'version') || !keys.includes('series')) {
    throw storageError('Invalid commit release metadata')
  }
  try {
    validateBasename(typeof value.series === 'string' ? value.series : '')
  } catch (error: unknown) {
    throw storageError('Invalid commit release series', error)
  }
  if (value.version === undefined) return
  // A stored version is already canonical: build metadata never reaches the journal.
  if (parseStrictVersion(value.version)?.version !== value.version) {
    throw storageError('Invalid commit release version')
  }
}

function assertCommitRecordShape(record: unknown): asserts record is CommitRecord {
  if (!isRecordLike(record)) throw storageError('Invalid commit record')
  const candidate = record
  if (
    candidate.version !== COMMIT_VERSION &&
    candidate.version !== REPLACEMENT_COMMIT_VERSION &&
    candidate.version !== DIRECTORY_COMMIT_VERSION &&
    candidate.version !== DIRECTORY_HISTORY_COMMIT_VERSION
  ) {
    throw storageError('Invalid commit record version')
  }
  validateBasename(typeof candidate.name === 'string' ? candidate.name : '')
  assertSafeUint(candidate.size, 'commit size')
  if (!isHex(candidate.sha256)) throw storageError('Invalid commit digest')
  assertSafeUint(candidate.committedAt, 'commit timestamp')
  if (!isHex(candidate.uploaderFingerprint)) throw storageError('Invalid uploader fingerprint')
  if (!isHex(candidate.transferId)) throw storageError('Invalid commit transfer ID')
  if (candidate.release !== undefined) assertCommitRelease(candidate.release)
  if (
    candidate.version === DIRECTORY_COMMIT_VERSION ||
    candidate.version === DIRECTORY_HISTORY_COMMIT_VERSION
  ) {
    if (candidate.kind !== 'directory') throw storageError('Invalid commit artifact kind')
    assertSafeUint(candidate.entryCount, 'commit entry count')
    if ((candidate.entryCount as number) > MAX_TREE_ENTRIES) {
      throw storageError('Invalid commit entry count')
    }
    if (candidate.version === DIRECTORY_COMMIT_VERSION) {
      if (isReservedHistoryName(candidate.name)) throw storageError('Reserved directory name')
    } else if (candidate.name !== historyName(candidate.transferId as string)) {
      // A history copy lives at exactly the name its own transfer ID gives it.
      throw storageError('Invalid directory history name')
    }
    if (candidate.replaces !== undefined) {
      throw storageError('Unexpected commit replacement metadata')
    }
    return
  }
  if (candidate.kind !== undefined) throw storageError('Unexpected commit artifact kind')
  if (candidate.entryCount !== undefined) throw storageError('Unexpected commit entry count')
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

export const DIRECTORY_PHASES = ['journaled', 'renamed', 'sidecar', 'cleanup'] as const
export type DirectoryPhase = (typeof DIRECTORY_PHASES)[number]

/**
 * The create-only directory transaction. A directory is published by renaming
 * its verified staging tree, so the journal names the staging tree and its
 * inode identity instead of a hardlink source.
 */
export interface DirectoryCommitJournal {
  version: 3
  intent: 'create-directory'
  state: 'committing' | 'aborting'
  phase: DirectoryPhase
  transferId: string
  attemptId: string
  name: string
  stagingTreeName: string
  stagingTreeIdentity: FileIdentity
  record: CommitRecord
}

/**
 * Ordered boundaries of a directory replacement; each one is durable before the next step starts.
 * The names are the order of events, not a recovery script: recovery trusts what it observes on
 * disk (which inode is at which path), and uses the phase only as the trail of intent.
 */
export const DIRECTORY_REPLACEMENT_PHASES = [
  'journaled',
  'dedup-moved',
  'moved',
  'swapped',
  'current-sidecar',
  'history-moved',
  'history-sidecar',
  'cleanup'
] as const
export type DirectoryReplacementPhase = (typeof DIRECTORY_REPLACEMENT_PHASES)[number]

/**
 * The transaction that replaces a managed directory by atomic exchange. Four private or public
 * paths take part, and every one is named here with the inode identity it must hold:
 *
 * - the visible name, which holds the old tree (`oldTreeIdentity`) until the exchange and the new
 *   tree (`stagingTreeIdentity`) after it;
 * - the publication path `publications/<publicationName>`, where the new tree waits for the
 *   exchange and the old tree waits afterwards;
 * - the history name (`historyName`), where the old tree ends up;
 * - when the returning content already has a history copy (A, B, A), the dedup path
 *   `publications/<dedupName>`, where that copy waits, together with its record
 *   (`dedupRecord`), until the new current record is durable. Nothing of it is deleted before
 *   then, so every step before the new current record is durable can be undone exactly.
 *
 * The new current record being durable is the linearization point.
 */
export interface DirectoryReplacementJournal {
  version: 4
  intent: 'replace-directory'
  state: 'committing' | 'aborting'
  phase: DirectoryReplacementPhase
  transferId: string
  attemptId: string
  name: string
  historyName: string
  publicationName: string
  dedupName: string | null
  stagingTreeIdentity: FileIdentity
  oldTreeIdentity: FileIdentity
  dedupTreeIdentity: FileIdentity | null
  dedupRecord: CommitRecord | null
  oldRecord: CommitRecord
  record: CommitRecord
}

/** The journal of one file-level merge of an uploaded directory (`file-catalog-v1`). */
const FILE_MERGE_JOURNAL_VERSION = 5
/**
 * Bound of a merge journal: it lists every action of an upload of up to 10 000 entries, so it is
 * larger than the 16 KiB of the older, fixed-size journals, and just as strictly bounded.
 */
const MAX_FILE_JOURNAL_BYTES = 16 * 1024 * 1024

/**
 * Ordered boundaries of a merge. `journaled`: every action and the identity of what it will touch
 * are durable, nothing public has changed. `prepared`: private preimages and links exist and the
 * missing directories are created (their identities recorded). `installed`: every file is in place.
 * `cleanup`: the catalog is durable and what remains is private residue. The phase is only the trail
 * of intent: whether the merge happened is decided by the durable catalog, never by the phase.
 */
export const FILE_MERGE_PHASES = ['journaled', 'prepared', 'installed', 'cleanup'] as const
export type FileMergePhase = (typeof FILE_MERGE_PHASES)[number]

/** One planned change to one public file, with the inodes that make it provable. */
export interface FileMergeAction {
  op: 'add' | 'replace'
  /** Canonical relative path inside the artifact. */
  path: string
  size: number
  sha256: string
  /** The staged inode that is installed. */
  staged: FileIdentity
  /** For a replacement: the owned inode that is replaced, kept privately until the commit is durable. */
  previous?: FileIdentity
}

export interface FileMergeDirectory {
  path: string
  /**
   * Set once this merge made the directory and recorded it. `null` while it is only planned (the
   * directory was missing when planned): rollback removes it only if it is still empty.
   */
  identity: FileIdentity | null
}

/**
 * The transaction of one directory upload merged into a (possibly shared) container. The journal
 * is keyed by the source session's transfer ID. The published snapshot ID is a different identity:
 * it names the owned set afterwards.
 */
export interface FileMergeJournal {
  version: typeof FILE_MERGE_JOURNAL_VERSION
  intent: 'merge-files'
  state: 'committing' | 'aborting'
  phase: FileMergePhase
  /** The source transfer ID: the upload's session, staged tree and journal name. */
  transferId: string
  attemptId: string
  name: string
  /** The generation the catalog on disk must have (0: none yet), and the one this merge writes. */
  baseGeneration: number
  generation: number
  /** The snapshot ID of the owned set this merge publishes. */
  snapshotId: string
  /** The one it replaces (none for a first merge): both stay pinned while the journal is open. */
  previousSnapshotId: string | null
  uploader: string
  committedAt: number
  release?: CommitRelease
  stagingTreeIdentity: FileIdentity
  actions: FileMergeAction[]
  directories: FileMergeDirectory[]
  /** Legacy whole-tree records this merge supersedes; retired once the catalog is durable. */
  legacyRecords: string[]
}

export type AnyCommitJournal =
  | CommitJournal
  | ReplacementJournal
  | DirectoryCommitJournal
  | DirectoryReplacementJournal
  | FileMergeJournal

export function isFileMergeJournal(journal: AnyCommitJournal | null): journal is FileMergeJournal {
  return journal !== null && journal.version === FILE_MERGE_JOURNAL_VERSION
}

export function isDirectoryReplacementJournal(
  journal: AnyCommitJournal | null
): journal is DirectoryReplacementJournal {
  return journal !== null && journal.version === DIRECTORY_REPLACEMENT_JOURNAL_VERSION
}

export function isDirectoryJournal(
  journal: AnyCommitJournal | null
): journal is DirectoryCommitJournal {
  return journal !== null && journal.version === DIRECTORY_JOURNAL_VERSION
}

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
    !sameTransferId(journal.transferId as string, id) ||
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
  if (!sameTransferId(record.transferId, id)) {
    throw new CorruptJournalError('Commit journal ID mismatch')
  }
  if (record.name !== name) throw new CorruptJournalError('Replacement journal name mismatch')
  if (journal.historyName !== historyName(oldRecord.transferId)) {
    throw new CorruptJournalError('Invalid replacement history name')
  }
  if (sameTransferId(oldRecord.transferId, record.transferId)) {
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

function isDirectoryPhase(value: unknown): value is DirectoryPhase {
  return typeof value === 'string' && (DIRECTORY_PHASES as readonly string[]).includes(value)
}

function parseDirectoryJournal(
  id: string,
  journal: Record<string, unknown>
): DirectoryCommitJournal {
  if (
    journal.intent !== 'create-directory' ||
    (journal.state !== 'committing' && journal.state !== 'aborting') ||
    !isDirectoryPhase(journal.phase) ||
    !sameTransferId(journal.transferId as string, id) ||
    !isHex(journal.attemptId) ||
    typeof journal.name !== 'string' ||
    journal.stagingTreeName !== `${id}.tree`
  ) {
    throw new CorruptJournalError('Invalid directory journal')
  }
  let name: string
  try {
    name = validateBasename(journal.name)
    if (isReservedHistoryName(name)) throw storageError('Reserved directory name')
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid directory journal name', error)
  }
  const record = parseRecord(journal.record)
  if (!sameTransferId(record.transferId, id)) {
    throw new CorruptJournalError('Commit journal ID mismatch')
  }
  if (record.version !== DIRECTORY_COMMIT_VERSION || record.name !== name) {
    throw new CorruptJournalError('Directory journal record mismatch')
  }
  return {
    version: DIRECTORY_JOURNAL_VERSION,
    intent: 'create-directory',
    state: journal.state,
    phase: journal.phase,
    transferId: id,
    attemptId: journal.attemptId,
    name,
    stagingTreeName: journal.stagingTreeName,
    stagingTreeIdentity: parseIdentity(journal.stagingTreeIdentity),
    record
  }
}

function isDirectoryReplacementPhase(value: unknown): value is DirectoryReplacementPhase {
  return (
    typeof value === 'string' && (DIRECTORY_REPLACEMENT_PHASES as readonly string[]).includes(value)
  )
}

function parseDirectoryReplacementJournal(
  id: string,
  journal: Record<string, unknown>
): DirectoryReplacementJournal {
  if (
    journal.intent !== 'replace-directory' ||
    (journal.state !== 'committing' && journal.state !== 'aborting') ||
    !isDirectoryReplacementPhase(journal.phase) ||
    !sameTransferId(journal.transferId as string, id) ||
    !isHex(journal.attemptId) ||
    typeof journal.name !== 'string' ||
    journal.publicationName !== `${journal.attemptId}.tree`
  ) {
    throw new CorruptJournalError('Invalid directory replacement journal')
  }
  let name: string
  try {
    name = validateBasename(journal.name)
    if (isReservedHistoryName(name)) throw storageError('Reserved replacement name')
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid directory replacement journal name', error)
  }
  const record = parseRecord(journal.record)
  const oldRecord = parseRecord(journal.oldRecord)
  if (!sameTransferId(record.transferId, id)) {
    throw new CorruptJournalError('Commit journal ID mismatch')
  }
  if (
    record.version !== DIRECTORY_COMMIT_VERSION ||
    oldRecord.version !== DIRECTORY_COMMIT_VERSION ||
    record.name !== name ||
    oldRecord.name !== name
  ) {
    throw new CorruptJournalError('Directory replacement journal record mismatch')
  }
  if (journal.historyName !== historyName(oldRecord.transferId)) {
    throw new CorruptJournalError('Invalid replacement history name')
  }
  if (sameTransferId(oldRecord.transferId, record.transferId)) {
    throw new CorruptJournalError('Replacement journal replaces its own transfer')
  }
  // The three fields describing a parked history copy are all present or all absent.
  const dedupRecord = journal.dedupRecord === null ? null : parseRecord(journal.dedupRecord)
  const dedupTreeIdentity =
    journal.dedupTreeIdentity === null ? null : parseIdentity(journal.dedupTreeIdentity)
  const dedupName = journal.dedupName
  const parked = [dedupRecord !== null, dedupTreeIdentity !== null, dedupName !== null]
  if (parked.some((value) => value !== parked[0])) {
    throw new CorruptJournalError('Invalid replacement dedup state')
  }
  if (dedupRecord !== null) {
    if (
      dedupName !== `${journal.attemptId}.dedup` ||
      dedupRecord.version !== DIRECTORY_HISTORY_COMMIT_VERSION ||
      !sameTransferId(dedupRecord.transferId, record.transferId)
    ) {
      throw new CorruptJournalError('Invalid replacement dedup record')
    }
  }
  return {
    version: DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
    intent: 'replace-directory',
    state: journal.state,
    phase: journal.phase,
    transferId: id,
    attemptId: journal.attemptId,
    name,
    historyName: journal.historyName,
    publicationName: journal.publicationName,
    dedupName: dedupName === null ? null : (dedupName as string),
    stagingTreeIdentity: parseIdentity(journal.stagingTreeIdentity),
    oldTreeIdentity: parseIdentity(journal.oldTreeIdentity),
    dedupTreeIdentity,
    dedupRecord,
    oldRecord,
    record
  }
}

const FILE_MERGE_KEYS = [
  'version',
  'intent',
  'state',
  'phase',
  'transferId',
  'attemptId',
  'name',
  'baseGeneration',
  'generation',
  'snapshotId',
  'previousSnapshotId',
  'uploader',
  'committedAt',
  'release',
  'stagingTreeIdentity',
  'actions',
  'directories',
  'legacyRecords'
]

function journalUint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptJournalError('Invalid file merge journal')
  }
  return value
}

function parseFileMergeJournal(id: string, journal: Record<string, unknown>): FileMergeJournal {
  const bad = (): CorruptJournalError => new CorruptJournalError('Invalid file merge journal')
  if (
    Object.keys(journal).some((key) => !FILE_MERGE_KEYS.includes(key)) ||
    journal.intent !== 'merge-files' ||
    (journal.state !== 'committing' && journal.state !== 'aborting') ||
    !FILE_MERGE_PHASES.includes(journal.phase as FileMergePhase) ||
    !sameTransferId(journal.transferId as string, id) ||
    !isHex(journal.attemptId) ||
    !isHex(journal.snapshotId) ||
    (journal.previousSnapshotId !== null && !isHex(journal.previousSnapshotId)) ||
    !isHex(journal.uploader) ||
    typeof journal.name !== 'string'
  ) {
    throw bad()
  }
  let name: string
  try {
    name = validateBasename(journal.name)
    if (isReservedHistoryName(name)) throw storageError('Reserved merge name')
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid file merge journal name', error)
  }
  const baseGeneration = journalUint(journal.baseGeneration)
  const generation = journalUint(journal.generation)
  if (generation < baseGeneration + 1) throw bad()
  let release: CommitRelease | undefined
  if (journal.release !== undefined) {
    try {
      assertCommitRelease(journal.release)
    } catch (error: unknown) {
      throw new CorruptJournalError('Invalid file merge journal release', error)
    }
    const source = journal.release as CommitRelease
    release = {
      series: source.series,
      ...(source.version === undefined ? {} : { version: source.version })
    }
  }
  if (!Array.isArray(journal.actions) || journal.actions.length > MAX_TREE_ENTRIES) throw bad()
  if (!Array.isArray(journal.directories) || journal.directories.length > MAX_TREE_ENTRIES) {
    throw bad()
  }
  if (!Array.isArray(journal.legacyRecords) || journal.legacyRecords.length > 8) throw bad()
  const paths = new Set<string>()
  const actions = journal.actions.map((entry: unknown): FileMergeAction => {
    if (!isRecordLike(entry)) throw bad()
    const keys = Object.keys(entry)
    if (keys.some((key) => !['op', 'path', 'size', 'sha256', 'staged', 'previous'].includes(key))) {
      throw bad()
    }
    if (entry.op !== 'add' && entry.op !== 'replace') throw bad()
    if (typeof entry.path !== 'string' || paths.has(entry.path)) throw bad()
    try {
      assertTreeEntryPath(entry.path, 'file')
    } catch (error: unknown) {
      throw new CorruptJournalError('Invalid file merge journal path', error)
    }
    paths.add(entry.path)
    if (!isHex(entry.sha256)) throw bad()
    if ((entry.op === 'replace') !== (entry.previous !== undefined)) throw bad()
    return {
      op: entry.op,
      path: entry.path,
      size: journalUint(entry.size),
      sha256: entry.sha256,
      staged: parseIdentity(entry.staged),
      ...(entry.previous === undefined ? {} : { previous: parseIdentity(entry.previous) })
    }
  })
  const directoryPaths = new Set<string>()
  const directories = journal.directories.map((entry: unknown): FileMergeDirectory => {
    if (!isRecordLike(entry)) throw bad()
    const keys = Object.keys(entry)
    if (keys.some((key) => key !== 'path' && key !== 'identity')) throw bad()
    if (typeof entry.path !== 'string' || directoryPaths.has(entry.path)) throw bad()
    // Relative to the output root: the artifact's own name, then the upload's path below it.
    const components = entry.path.split('/')
    if (components.length > 33 || b4a.from(entry.path).byteLength > 400) throw bad()
    try {
      for (const component of components) {
        validateBasename(component)
        if (isReservedHistoryName(component)) throw storageError('Reserved merge path')
      }
    } catch (error: unknown) {
      throw new CorruptJournalError('Invalid file merge journal path', error)
    }
    directoryPaths.add(entry.path)
    return {
      path: entry.path,
      identity: entry.identity === null ? null : parseIdentity(entry.identity)
    }
  })
  const legacyRecords = journal.legacyRecords.map((value: unknown): string => {
    if (!isHex(value)) throw bad()
    return value
  })
  return {
    version: FILE_MERGE_JOURNAL_VERSION,
    intent: 'merge-files',
    state: journal.state,
    phase: journal.phase as FileMergePhase,
    transferId: id,
    attemptId: journal.attemptId,
    name,
    baseGeneration,
    generation,
    snapshotId: journal.snapshotId,
    previousSnapshotId: journal.previousSnapshotId as string | null,
    uploader: journal.uploader,
    committedAt: journalUint(journal.committedAt),
    ...(release === undefined ? {} : { release }),
    stagingTreeIdentity: parseIdentity(journal.stagingTreeIdentity),
    actions,
    directories,
    legacyRecords
  }
}

/** The exact durable shape of a journal, for creation and phase transitions. */
export function serializeJournal(journal: AnyCommitJournal): Record<string, unknown> {
  if (journal.version === FILE_MERGE_JOURNAL_VERSION) {
    return {
      version: FILE_MERGE_JOURNAL_VERSION,
      intent: journal.intent,
      state: journal.state,
      phase: journal.phase,
      transferId: journal.transferId,
      attemptId: journal.attemptId,
      name: journal.name,
      baseGeneration: journal.baseGeneration,
      generation: journal.generation,
      snapshotId: journal.snapshotId,
      previousSnapshotId: journal.previousSnapshotId,
      uploader: journal.uploader,
      committedAt: journal.committedAt,
      ...(journal.release === undefined ? {} : { release: journal.release }),
      stagingTreeIdentity: journal.stagingTreeIdentity,
      actions: journal.actions,
      directories: journal.directories,
      legacyRecords: journal.legacyRecords
    }
  }
  if (journal.version === DIRECTORY_REPLACEMENT_JOURNAL_VERSION) {
    return {
      version: DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
      intent: journal.intent,
      state: journal.state,
      phase: journal.phase,
      transferId: journal.transferId,
      attemptId: journal.attemptId,
      name: journal.name,
      historyName: journal.historyName,
      publicationName: journal.publicationName,
      dedupName: journal.dedupName,
      stagingTreeIdentity: journal.stagingTreeIdentity,
      oldTreeIdentity: journal.oldTreeIdentity,
      dedupTreeIdentity: journal.dedupTreeIdentity,
      dedupRecord: journal.dedupRecord,
      oldRecord: journal.oldRecord,
      record: journal.record
    }
  }
  if (journal.version === DIRECTORY_JOURNAL_VERSION) {
    return {
      version: DIRECTORY_JOURNAL_VERSION,
      intent: journal.intent,
      state: journal.state,
      phase: journal.phase,
      transferId: journal.transferId,
      attemptId: journal.attemptId,
      name: journal.name,
      stagingTreeName: journal.stagingTreeName,
      stagingTreeIdentity: journal.stagingTreeIdentity,
      record: journal.record
    }
  }
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
    journal = await readJson(journalPath, storage, MAX_FILE_JOURNAL_BYTES)
    if (journal.version === FILE_MERGE_JOURNAL_VERSION) return parseFileMergeJournal(id, journal)
    // Every older journal is a fixed-size record: the larger bound is only for a merge journal.
    if (JSON.stringify(journal).length > MAX_COMMIT_METADATA_BYTES) {
      throw new CorruptJournalError('Commit journal exceeds its size limit')
    }
    if (journal.version === DIRECTORY_JOURNAL_VERSION) return parseDirectoryJournal(id, journal)
    if (journal.version === DIRECTORY_REPLACEMENT_JOURNAL_VERSION) {
      return parseDirectoryReplacementJournal(id, journal)
    }
    if (journal.version === REPLACEMENT_JOURNAL_VERSION) {
      return parseReplacementJournal(id, journal)
    }
    if (
      journal.version !== JOURNAL_VERSION ||
      (journal.state !== 'committing' && journal.state !== 'aborting') ||
      !sameTransferId(journal.transferId as string, id) ||
      !isHex(journal.attemptId)
    ) {
      throw new CorruptJournalError('Invalid commit journal')
    }
    const sourceStagingIdentity = parseIdentity(journal.sourceStagingIdentity)
    const record = parseRecord(journal.record)
    if (!sameTransferId(record.transferId, id)) {
      throw new CorruptJournalError('Commit journal ID mismatch')
    }
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
  DIRECTORY_COMMIT_VERSION,
  DIRECTORY_HISTORY_COMMIT_VERSION,
  JOURNAL_VERSION,
  REPLACEMENT_JOURNAL_VERSION,
  DIRECTORY_JOURNAL_VERSION,
  DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
  FILE_MERGE_JOURNAL_VERSION,
  MAX_COMMIT_METADATA_BYTES,
  MAX_FILE_JOURNAL_BYTES
}
