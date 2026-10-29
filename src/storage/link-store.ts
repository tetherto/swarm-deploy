import b4a from 'b4a'
import { errorCode, isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { sodiumSha256 } from '../tar-protocol/hash.js'
import type { DesiredLink } from '../symlinks.js'
import type { ArtifactKind } from '../types.js'
import { MetadataFormatError, readJson, writeAtomic } from './atomic-file.js'
import { fileIdentity, identitiesEqual } from './commit-journal.js'
import { withSafeDirectoryIdentity } from './layout.js'
import { assertSymlinkCapable } from './tree-fs.js'
import type { StorageAdapter, StorageLayout, StorageStats, SymlinkCapableStorage } from './types.js'

const MAX_LINK_RECORD_BYTES = 4 * 1024
const RECORD_FILENAME = /^[0-9a-f]{64}\.json$/
const V1_RECORD_KEYS = 'name,target,targetKind,transferId,version'
const V2_RECORD_KEYS = 'mode,name,target,targetKind,transferId,version'
/** A pending-rollback journal sits beside the ownership records and never matches their pattern. */
const JOURNAL_FILENAME = /^[0-9a-f]{64}\.rollback\.json$/
const JOURNAL_KEYS = 'applied,intended,name,prior,token,version'
/** Bounds an untrusted journal before it is read and a prior literal before it is journaled. */
const MAX_ROLLBACK_JOURNAL_BYTES = 32 * 1024
const MAX_PRIOR_LITERAL_BYTES = 4096

export type LinkOwnershipMode = 'automatic' | 'manual'

export interface ManagedSymlinkRecord {
  version: 1 | 2
  mode: LinkOwnershipMode
  name: string
  target: string
  transferId: string
  targetKind: ArtifactKind
}

export interface LinkReconcileResult {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
}

export interface LinkReconcileOptions {
  /** Managed artifact basenames used to prove a crash-residual symlink target. */
  managedArtifactNames?: ReadonlySet<string>
}

export interface ManualLinkOptions {
  /** Current managed artifact basenames; the manual target must be one of them. */
  managedArtifactNames: ReadonlySet<string>
  /** Current automatic link names; manual names may not collide with them. */
  automaticLinkNames: ReadonlySet<string>
}

export interface ManualLinkResult {
  status: 'LINKED' | 'UNCHANGED'
}

export interface LinkStoreOptions {
  layout: StorageLayout
  /** Must provide `symlink` and `readlink`, or construction fails closed. */
  storage?: StorageAdapter
}

/** `dev` and `ino` of a symlink itself, or `null` when the adapter does not report them. */
type LinkIdentity = { dev: string; ino: string } | null

type Destination =
  | { state: 'MISSING' }
  | { state: 'SYMLINK'; target: string; identity: LinkIdentity }
  | { state: 'UNMANAGED' }

/**
 * The visible state of a link name before a rollback-able request changed it.
 * `literal` is the symlink's text, kept and restored as text only: it is never
 * resolved, followed, or used to build a path.
 */
type PriorLink =
  { state: 'MISSING' } | { state: 'SYMLINK'; literal: string; identity: LinkIdentity }

/**
 * Written durably before a rollback-able request changes anything, and removed
 * once the request is finalized or restored. While it exists, the request's
 * outcome is unknown: a restart restores `prior`, and retention keeps both
 * targets.
 */
interface RollbackJournal {
  version: 1
  name: string
  token: string
  intended: { target: string; transferId: string; targetKind: ArtifactKind }
  prior: { link: PriorLink; record: ManagedSymlinkRecord | null }
  /** The new link's identity once the change is complete; `null` before that. */
  applied: { identity: LinkIdentity } | null
}

/**
 * What `convergeManual` needs from a request that journals its change. `begin` is
 * awaited with the state the request found, right before its first change, and is
 * never called for a request that changes nothing. `withdraw` is called only when
 * creating the link found an entry already there (`EEXIST`), so no link of the
 * request's exists; it puts the previous record back only while the journal and
 * the record are still this request's own, and throws `LINK_FAILED`, changing
 * nothing, otherwise. Every other failure is left to the journal's own restore.
 */
interface Journaling {
  begin(prior: { record: ManagedSymlinkRecord | null; destination: Destination }): Promise<void>
  withdraw(): Promise<void>
}

/** An open rollback-able change: finalize it with `commitManual` or undo it with `rollbackManual`. */
export interface ManualLinkTransaction {
  readonly name: string
  readonly journal: RollbackJournal
}

export interface ManualLinkBegin extends ManualLinkResult {
  /** `null` when the request changed nothing, so there is nothing to restore. */
  transaction: ManualLinkTransaction | null
}

/** What an unresolved journal still holds back, for retention pins. */
export interface PendingRollback {
  name: string
  /** The attempted link. */
  target: string
  transferId: string
  /** The previous symlink text, or `null` when the name had no link. Text only. */
  priorLiteral: string | null
  priorRecord: ManagedSymlinkRecord | null
}

export interface RollbackRecovery {
  /** Names whose previous link and ownership record were restored. */
  restored: string[]
  /** Names whose state changed under the journal: left untouched, still journaled. */
  blocked: string[]
}

function identityOf(stat: StorageStats): LinkIdentity {
  try {
    return fileIdentity(stat)
  } catch {
    return null
  }
}

function conflict(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.LINK_CONFLICT, message)
}

function failure(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.LINK_FAILED, message, cause)
}

/**
 * Maps every failure to a stable link error. The raw error, which may carry an
 * errno or an absolute path, is kept only as the `cause`, never in the message.
 */
function asLinkError(error: unknown): SwarmDeployError {
  if (
    error instanceof SwarmDeployError &&
    (error.code === ERRORS.LINK_CONFLICT ||
      error.code === ERRORS.LINK_FAILED ||
      error.code === ERRORS.UNSUPPORTED_STORAGE)
  ) {
    return error
  }
  return failure('Managed link operation failed', error)
}

/** A link or target name: one safe basename, never reserved, never the internal directory. */
function assertSafeName(value: unknown, message: string): string {
  if (
    typeof value !== 'string' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value === '.' ||
    value === '..' ||
    value === '.swarm-deploy'
  ) {
    throw failure(message)
  }
  try {
    validateBasename(value)
  } catch (error: unknown) {
    throw failure(message, error)
  }
  if (isReservedHistoryName(value)) throw failure(message)
  return value
}

function assertRecord(value: unknown, expectedName: string): ManagedSymlinkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('Invalid managed link record')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort().join(',')
  const v1 = candidate.version === 1 && keys === V1_RECORD_KEYS
  const v2 =
    candidate.version === 2 &&
    keys === V2_RECORD_KEYS &&
    (candidate.mode === 'automatic' || candidate.mode === 'manual')
  if (
    (!v1 && !v2) ||
    candidate.name !== expectedName ||
    (candidate.targetKind !== 'file' && candidate.targetKind !== 'directory') ||
    typeof candidate.transferId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.transferId)
  ) {
    throw failure('Invalid managed link record')
  }
  const name = assertSafeName(candidate.name, 'Invalid managed link record')
  const target = assertSafeName(candidate.target, 'Invalid managed link record')
  return {
    version: candidate.version as 1 | 2,
    mode: v1 ? 'automatic' : (candidate.mode as LinkOwnershipMode),
    name,
    target,
    transferId: candidate.transferId,
    targetKind: candidate.targetKind
  }
}

function randomSuffix(): string {
  const bytes = b4a.allocUnsafe(16)
  sodium.randombytes_buf(bytes)
  return b4a.toString(bytes, 'hex')
}

function hashName(name: string): string {
  return b4a.toString(sodiumSha256(b4a.from(name)), 'hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameRecord(
  left: ManagedSymlinkRecord | null,
  right: ManagedSymlinkRecord | null
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.version === right.version &&
    left.mode === right.mode &&
    left.name === right.name &&
    left.target === right.target &&
    left.transferId === right.transferId &&
    left.targetKind === right.targetKind
  )
}

/** The ownership record a rollback-able request writes for its intended link. */
function intendedRecord(journal: RollbackJournal): ManagedSymlinkRecord {
  return { version: 2, mode: 'manual', name: journal.name, ...journal.intended }
}

function sameIdentity(left: LinkIdentity, right: LinkIdentity): boolean {
  if (left === null || right === null) return left === right
  return identitiesEqual(left, right)
}

function samePriorLink(left: PriorLink, right: PriorLink): boolean {
  if (left.state === 'MISSING' || right.state === 'MISSING') return left.state === right.state
  return left.literal === right.literal && sameIdentity(left.identity, right.identity)
}

/**
 * Whether the journal on disk is still the one an open request holds: the same
 * token and every field that is fixed when the journal is created (name, intended
 * link, previous link and record). Only `applied` may differ, and only by being
 * unset on one side: it is written after the change, so the disk copy of a request
 * whose last write failed, or the in-memory copy of a journal recovered from disk,
 * can lag behind. Two different identities are an edit.
 */
function sameJournal(persisted: RollbackJournal, open: RollbackJournal): boolean {
  return (
    persisted.token === open.token &&
    persisted.name === open.name &&
    persisted.intended.target === open.intended.target &&
    persisted.intended.transferId === open.intended.transferId &&
    persisted.intended.targetKind === open.intended.targetKind &&
    samePriorLink(persisted.prior.link, open.prior.link) &&
    sameRecord(persisted.prior.record, open.prior.record) &&
    (persisted.applied === null ||
      open.applied === null ||
      sameIdentity(persisted.applied.identity, open.applied.identity))
  )
}

/**
 * A symlink's text is kept and restored exactly, so text that a journal or a
 * later `symlink()` could not reproduce byte for byte is refused before anything
 * is changed: an empty or oversized literal, a NUL, or the replacement
 * character that decoding invalid UTF-8 leaves behind.
 */
function assertRestorableLiteral(literal: unknown): string {
  if (
    typeof literal !== 'string' ||
    literal.length === 0 ||
    literal.includes('\u0000') ||
    literal.includes('�') ||
    b4a.from(literal).byteLength > MAX_PRIOR_LITERAL_BYTES
  ) {
    throw conflict('Existing symlink cannot be restored exactly')
  }
  return literal
}

function assertIdentity(value: unknown): LinkIdentity {
  if (value === null) return null
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(',') !== 'dev,ino' ||
    typeof value.dev !== 'string' ||
    typeof value.ino !== 'string' ||
    !/^[0-9]{1,40}$/.test(value.dev) ||
    !/^[0-9]{1,40}$/.test(value.ino)
  ) {
    throw failure('Invalid rollback journal')
  }
  return { dev: value.dev, ino: value.ino }
}

function assertPriorLink(value: unknown): PriorLink {
  if (!isPlainObject(value)) throw failure('Invalid rollback journal')
  const keys = Object.keys(value).sort().join(',')
  if (value.state === 'MISSING' && keys === 'state') return { state: 'MISSING' }
  if (value.state === 'SYMLINK' && keys === 'identity,literal,state') {
    let literal: string
    try {
      literal = assertRestorableLiteral(value.literal)
    } catch (error: unknown) {
      throw failure('Invalid rollback journal', error)
    }
    return { state: 'SYMLINK', literal, identity: assertIdentity(value.identity) }
  }
  throw failure('Invalid rollback journal')
}

/**
 * Validates an untrusted journal: exact keys, safe names, bounded text, and a
 * filename that proves which link it belongs to. Nothing in it is used as a path.
 */
function assertJournal(value: unknown, filename: string): RollbackJournal {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== JOURNAL_KEYS) {
    throw failure('Invalid rollback journal')
  }
  if (
    value.version !== 1 ||
    typeof value.token !== 'string' ||
    !/^[0-9a-f]{32}$/.test(value.token)
  ) {
    throw failure('Invalid rollback journal')
  }
  const name = assertSafeName(value.name, 'Invalid rollback journal')
  if (filename !== `${hashName(name)}.rollback.json`) throw failure('Foreign rollback journal')

  const { intended, prior, applied } = value
  if (
    !isPlainObject(intended) ||
    Object.keys(intended).sort().join(',') !== 'target,targetKind,transferId' ||
    (intended.targetKind !== 'file' && intended.targetKind !== 'directory') ||
    typeof intended.transferId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(intended.transferId)
  ) {
    throw failure('Invalid rollback journal')
  }
  const target = assertSafeName(intended.target, 'Invalid rollback journal')
  if (target === name) throw failure('Invalid rollback journal')

  if (!isPlainObject(prior) || Object.keys(prior).sort().join(',') !== 'link,record') {
    throw failure('Invalid rollback journal')
  }
  let record: ManagedSymlinkRecord | null = null
  if (prior.record !== null) {
    record = assertRecord(prior.record, name)
    // Only a manual v2 record can precede a manual request; anything else is foreign.
    if (record.version !== 2 || record.mode !== 'manual') throw failure('Invalid rollback journal')
  }

  let appliedIdentity: RollbackJournal['applied'] = null
  if (applied !== null) {
    if (!isPlainObject(applied) || Object.keys(applied).join(',') !== 'identity') {
      throw failure('Invalid rollback journal')
    }
    appliedIdentity = { identity: assertIdentity(applied.identity) }
  }
  return {
    version: 1,
    name,
    token: value.token,
    intended: { target, transferId: intended.transferId, targetKind: intended.targetKind },
    prior: { link: assertPriorLink(prior.link), record },
    applied: appliedIdentity
  }
}

async function syncDirectory(directory: string, storage: SymlinkCapableStorage): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Owns every server-managed symlink in the storage root.
 *
 * Automatic reconciliation and every recorded link are replaceable only when a
 * valid ownership record exists, the visible destination is a symbolic link, and
 * `readlink()` returns either the recorded target or the desired target. Anything
 * else is unmanaged: it is left untouched and the operation fails closed.
 *
 * The one exception is an explicit, authenticated manual request (`linkManual`)
 * whose target has passed every policy check: a symlink at the requested name
 * that has no ownership record at all is taken over by atomic replacement plus a
 * manual record, whatever its old literal says. Regular files and directories,
 * automatic, version 1, malformed, or foreign records, and a recorded link that
 * changed externally are still never touched, and automatic reconciliation never
 * takes anything over.
 *
 * A link target is always exactly a sibling basename, and `readlink()` output is
 * only ever compared, never used to build a path or followed.
 */
export class LinkStore {
  readonly layout: StorageLayout
  readonly storage: SymlinkCapableStorage

  constructor({ layout, storage = fs.promises }: LinkStoreOptions) {
    if (!layout || typeof layout !== 'object') throw failure('Invalid storage layout')
    assertSymlinkCapable(storage)
    this.layout = layout
    this.storage = storage
  }

  recordPath(name: string): string {
    return path.join(this.layout.links, `${hashName(name)}.json`)
  }

  private journalPath(name: string): string {
    return path.join(this.layout.links, `${hashName(name)}.rollback.json`)
  }

  private finalPath(name: string): string {
    return path.join(this.layout.root, name)
  }

  async read(name: string): Promise<ManagedSymlinkRecord | null> {
    try {
      return await this.readRecord(assertSafeName(name, 'Invalid managed link name'))
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /** Every persisted ownership record, keyed by its proven link name. */
  async list(): Promise<ManagedSymlinkRecord[]> {
    try {
      return await this.listRecords()
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  private async readRecord(name: string): Promise<ManagedSymlinkRecord | null> {
    try {
      return assertRecord(
        await readJson(this.recordPath(name), this.storage, MAX_LINK_RECORD_BYTES),
        name
      )
    } catch (error: unknown) {
      if (isMissing(error)) return null
      if (error instanceof MetadataFormatError) {
        throw failure('Malformed managed link record', error)
      }
      throw error
    }
  }

  private async listRecords(): Promise<ManagedSymlinkRecord[]> {
    const filenames = await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      this.storage.readdir(this.layout.links)
    )
    const records: ManagedSymlinkRecord[] = []
    for (const filename of filenames.sort()) {
      if (!RECORD_FILENAME.test(filename)) continue
      let parsed: Record<string, unknown>
      try {
        parsed = await readJson(
          path.join(this.layout.links, filename),
          this.storage,
          MAX_LINK_RECORD_BYTES
        )
      } catch (error: unknown) {
        throw failure('Malformed managed link record', error)
      }
      const record = assertRecord(parsed, typeof parsed.name === 'string' ? parsed.name : '')
      if (path.basename(this.recordPath(record.name)) !== filename) {
        throw failure('Foreign managed link record')
      }
      records.push(record)
    }
    return records
  }

  private classify(name: string): Promise<Destination> {
    const finalPath = this.finalPath(name)
    return withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      let stat: StorageStats
      try {
        stat = await this.storage.lstat(finalPath)
      } catch (error: unknown) {
        if (isMissing(error)) return { state: 'MISSING' as const }
        throw error
      }
      if (!stat.isSymbolicLink()) return { state: 'UNMANAGED' as const }
      return {
        state: 'SYMLINK' as const,
        target: await this.storage.readlink(finalPath),
        identity: identityOf(stat)
      }
    })
  }

  private async writeRecord(link: DesiredLink, mode: LinkOwnershipMode): Promise<void> {
    const record: ManagedSymlinkRecord = {
      version: 2,
      mode,
      name: link.name,
      target: link.target,
      transferId: link.transferId,
      targetKind: link.targetKind
    }
    assertRecord(record, link.name)
    await writeAtomic(this.recordPath(link.name), b4a.from(JSON.stringify(record)), this.storage)
  }

  private async removeRecord(name: string): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.links, this.storage, async () => {
      try {
        await this.storage.unlink(this.recordPath(name))
      } catch (error: unknown) {
        if (!isMissing(error)) throw error
      }
    })
    await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      syncDirectory(this.layout.links, this.storage)
    )
  }

  /**
   * Creates a link where nothing exists. The ownership record is durable first,
   * so a crash after the link appears never leaves an unrecorded link; the
   * link itself is created without overwriting, so a path that appeared since
   * classification is never replaced and its record is withdrawn.
   *
   * A request that journals its change passes `withdraw`, which puts back the
   * record it replaced instead of deleting the name's record: with a previous
   * record on file, deleting it would leave a state the journal rightly refuses
   * to restore. It proves the journal and the record are still its own first.
   *
   * Only `EEXIST` says the link was not created: `symlink` never overwrites, so
   * the entry it found was there before and is left alone. Any other failure may
   * have been reported after the link appeared (revalidating the directory can
   * fail once the call has succeeded), so a journaled request does not assume
   * the link is absent: it keeps its record and journal and rethrows, and the
   * caller's undo looks at what exists and restores it or fails closed.
   */
  private async createLink(
    link: DesiredLink,
    mode: LinkOwnershipMode,
    withdraw?: () => Promise<void>
  ): Promise<void> {
    await this.writeRecord(link, mode)
    try {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.symlink(link.target, this.finalPath(link.name))
      )
    } catch (error: unknown) {
      if (errorCode(error) === 'EEXIST') {
        // A failed restore is not the conflict that caused it: it surfaces as itself.
        if (withdraw) await withdraw()
        else await this.removeRecord(link.name).catch(() => {})
        throw conflict('Unmanaged path at a configured managed link name')
      }
      if (!withdraw) await this.removeRecord(link.name).catch(() => {})
      throw error
    }
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      syncDirectory(this.layout.root, this.storage)
    )
  }

  /** Removes a temporary symlink with `lstat`/`unlink`, never a regular-file helper. */
  private async removeTemporary(temporary: string): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.publications, this.storage, async () => {
      try {
        await this.storage.lstat(temporary)
      } catch (error: unknown) {
        if (isMissing(error)) return
        throw error
      }
      await this.storage.unlink(temporary)
    }).catch(() => {})
  }

  /**
   * Atomically swaps a link by renaming a private temporary link over it.
   * `beforeSwap` runs immediately before the rename, so a caller that does not
   * yet own the destination can re-prove what it saw and fail closed.
   */
  private async replaceLink(
    link: DesiredLink,
    mode: LinkOwnershipMode,
    beforeSwap?: () => Promise<void>
  ): Promise<void> {
    await this.swapLink(link.name, link.target, beforeSwap)
    await this.writeRecord(link, mode)
  }

  /**
   * Atomically points `name` at the symlink text `literal`. The text is only
   * stored in the new link, never resolved: a rollback restores whatever an
   * adopted symlink said, even a dangling or absolute literal.
   */
  private async swapLink(
    name: string,
    literal: string,
    beforeSwap?: () => Promise<void>
  ): Promise<void> {
    const temporary = path.join(this.layout.publications, `.link-${randomSuffix()}`)
    try {
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        this.storage.symlink(literal, temporary)
      )
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        syncDirectory(this.layout.publications, this.storage)
      )
      await beforeSwap?.()
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
          this.storage.rename(temporary, this.finalPath(name))
        )
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
    } finally {
      await this.removeTemporary(temporary)
    }
  }

  /** The journal for `name`, `null` when none is pending; malformed ones fail closed. */
  private readJournal(name: string): Promise<RollbackJournal | null> {
    return this.readJournalFile(`${hashName(name)}.rollback.json`)
  }

  private async readJournalFile(filename: string): Promise<RollbackJournal | null> {
    try {
      const parsed = await readJson(
        path.join(this.layout.links, filename),
        this.storage,
        MAX_ROLLBACK_JOURNAL_BYTES
      )
      return assertJournal(parsed, filename)
    } catch (error: unknown) {
      if (isMissing(error)) return null
      if (error instanceof SwarmDeployError && error.code === ERRORS.LINK_FAILED) throw error
      throw failure('Malformed rollback journal', error)
    }
  }

  private async writeJournal(journal: RollbackJournal): Promise<void> {
    const bytes = b4a.from(JSON.stringify(journal))
    if (bytes.byteLength > MAX_ROLLBACK_JOURNAL_BYTES) {
      throw conflict('Existing symlink cannot be restored exactly')
    }
    await writeAtomic(this.journalPath(journal.name), bytes, this.storage)
  }

  /**
   * Fails closed unless the journal on disk is still the one `journal` was made
   * from. A request's snapshot is only a claim on its own journal: if that file
   * was removed, replaced by another request's, or edited, it describes somebody
   * else's state now, and nothing is changed or erased on its behalf.
   */
  private async assertOwned(journal: RollbackJournal): Promise<void> {
    const persisted = await this.readJournal(journal.name)
    if (persisted === null) throw failure('Rollback journal is missing')
    if (!sameJournal(persisted, journal)) throw failure('Rollback journal was replaced')
  }

  /**
   * Puts back the ownership record a creation that failed had replaced. Nothing is
   * written unless the journal on disk is still this request's own and the record
   * is still the previous one (then there is nothing to do) or the one this request
   * wrote: a record that is anything else is somebody else's and is left as found.
   */
  private async putBackRecord(journal: RollbackJournal): Promise<void> {
    await this.assertOwned(journal)
    const record = await this.readRecord(journal.name)
    if (sameRecord(record, journal.prior.record)) return
    if (!sameRecord(record, intendedRecord(journal))) {
      throw failure('Managed link changed since the pending request')
    }
    if (journal.prior.record === null) await this.removeRecord(journal.name)
    else await this.writeRecord(journal.prior.record, 'manual')
  }

  /** Removes a journal only after proving the file on disk is still this one. */
  private async removeOwnedJournal(journal: RollbackJournal): Promise<void> {
    await this.assertOwned(journal)
    await withSafeDirectoryIdentity(this.layout.links, this.storage, async () => {
      try {
        await this.storage.unlink(this.journalPath(journal.name))
      } catch (error: unknown) {
        if (!isMissing(error)) throw error
      }
    })
    await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      syncDirectory(this.layout.links, this.storage)
    )
  }

  private async removeLink(record: ManagedSymlinkRecord, desiredTarget?: string): Promise<void> {
    const destination = await this.classify(record.name)
    const allowed = new Set([record.target])
    if (desiredTarget) allowed.add(desiredTarget)
    if (destination.state === 'SYMLINK' && allowed.has(destination.target)) {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.unlink(this.finalPath(record.name))
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
    } else if (destination.state !== 'MISSING') {
      throw conflict('Unmanaged path at a removed managed link name')
    }
    await this.removeRecord(record.name)
  }

  /**
   * Converges every desired link and removes the record and visible link of
   * every name no rule owns. Level-triggered: the same input always produces
   * the same output, whatever the previous attempt's crash point.
   */
  async reconcile(
    desired: readonly DesiredLink[],
    ruleNames: ReadonlySet<string>,
    options: LinkReconcileOptions = {}
  ): Promise<LinkReconcileResult> {
    try {
      return await this.converge(desired, ruleNames, options)
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /**
   * Atomically creates, keeps, or repoints one explicitly requested manual
   * link. The caller supplies the current namespace so manual ownership cannot
   * claim artifact or automatic-link destinations.
   */
  async linkManual(link: DesiredLink, options: ManualLinkOptions): Promise<ManualLinkResult> {
    try {
      return await this.convergeManual(link, options)
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /**
   * `linkManual` that can be undone. Before the first change a durable journal
   * records the previous visible state (no link, or the symlink's exact text) and
   * the previous ownership record, so a crash or a failed hook can restore them.
   * A request that changes nothing writes no journal and returns no transaction.
   * Otherwise the caller finalizes the transaction with `commitManual` once its
   * hook has succeeded, or undoes it with `rollbackManual`. Every call, like
   * every other mutation, runs under the root lease.
   */
  async beginManual(link: DesiredLink, options: ManualLinkOptions): Promise<ManualLinkBegin> {
    const held: {
      journal: RollbackJournal | null
      /** The first write of the journal returned, so it is on disk. */
      durable: boolean
      /** Another entry was already at the name and the previous record is back: nothing of ours remains. */
      undone: boolean
    } = { journal: null, durable: false, undone: false }
    try {
      const journaling: Journaling = {
        begin: async ({ record, destination }) => {
          held.journal = {
            version: 1,
            name: link.name,
            token: randomSuffix(),
            intended: {
              target: link.target,
              transferId: link.transferId,
              targetKind: link.targetKind
            },
            prior: { link: this.priorLink(destination), record },
            applied: null
          }
          await this.writeJournal(held.journal)
          held.durable = true
        },
        withdraw: async () => {
          if (held.journal === null) throw failure('Rollback journal is missing')
          await this.putBackRecord(held.journal)
          held.undone = true
        }
      }
      const result = await this.convergeManual(link, options, journaling)
      const journal = held.journal
      if (journal === null) return { ...result, transaction: null }
      const now = await this.classify(link.name)
      journal.applied = { identity: now.state === 'SYMLINK' ? now.identity : null }
      // This write replaces the file, so it must still be ours to replace.
      await this.assertOwned(journal)
      await this.writeJournal(journal)
      return { ...result, transaction: { name: link.name, journal } }
    } catch (error: unknown) {
      // The change began and did not finish: put back what was there. If that
      // cannot be proven the journal stays, the name fails closed until resolved,
      // and the answer is `LINK_FAILED`, not the error that interrupted the change.
      try {
        await this.undoBegin(held)
      } catch (undoError: unknown) {
        throw failure('The interrupted link change could not be undone', undoError)
      }
      throw asLinkError(error)
    }
  }

  /**
   * Settles the journal of a `beginManual` that threw. Nothing is touched unless
   * the journal on disk is this request's own: one that was never written needs
   * nothing, and a missing or replaced one is somebody else's to resolve.
   */
  private async undoBegin(held: {
    journal: RollbackJournal | null
    durable: boolean
    undone: boolean
  }): Promise<void> {
    const journal = held.journal
    if (journal === null) return
    if (!held.durable) {
      // The first write did not return, and the change always follows it, so nothing has
      // changed. The file may still have landed (a failure after the rename); clean up only
      // that, and only if it is ours.
      const persisted = await this.readJournal(journal.name)
      if (persisted === null) return
      if (persisted.token !== journal.token) throw failure('Rollback journal was replaced')
    }
    // `undone`: the creation found somebody else's entry and the previous record is back, so
    // the journal has nothing left to restore, and that entry is never ours to touch.
    if (held.undone) await this.removeOwnedJournal(journal)
    else await this.settle(journal)
  }

  /**
   * The request's hook succeeded: the change is final and the journal is removed.
   * Removing it is the commit point, so it must still be this request's own
   * journal; a missing, replaced, or edited one fails closed with `LINK_FAILED`
   * and is left alone.
   */
  async commitManual(transaction: ManualLinkTransaction): Promise<void> {
    try {
      await this.removeOwnedJournal(transaction.journal)
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /**
   * Restores the previous link and ownership record, then removes the journal.
   * It only restores what this transaction changed: a link or record that is
   * neither the previous state nor the one the request made (an external edit,
   * a replaced inode, a file at the path) fails closed with `LINK_FAILED`, is
   * left untouched, and keeps the journal.
   */
  async rollbackManual(transaction: ManualLinkTransaction): Promise<void> {
    try {
      await this.settle(transaction.journal)
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /**
   * Resolves every journal left by an interrupted process. A malformed or
   * foreign journal throws, because it cannot say what to restore or pin. One
   * whose link or record changed since is left in place and reported as
   * `blocked`; requests for that name fail until it is resolved.
   */
  async recoverRollbacks(): Promise<RollbackRecovery> {
    try {
      const recovery: RollbackRecovery = { restored: [], blocked: [] }
      for (const journal of await this.readJournals()) {
        try {
          await this.settle(journal)
          recovery.restored.push(journal.name)
        } catch {
          recovery.blocked.push(journal.name)
        }
      }
      return recovery
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  /** The targets every unresolved journal still holds back, for retention pins. */
  async pendingRollbacks(): Promise<PendingRollback[]> {
    try {
      return (await this.readJournals()).map((journal) => ({
        name: journal.name,
        target: journal.intended.target,
        transferId: journal.intended.transferId,
        priorLiteral: journal.prior.link.state === 'SYMLINK' ? journal.prior.link.literal : null,
        priorRecord: journal.prior.record
      }))
    } catch (error: unknown) {
      throw asLinkError(error)
    }
  }

  private async readJournals(): Promise<RollbackJournal[]> {
    const filenames = await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      this.storage.readdir(this.layout.links)
    )
    const journals: RollbackJournal[] = []
    for (const filename of filenames.sort()) {
      if (!JOURNAL_FILENAME.test(filename)) continue
      const journal = await this.readJournalFile(filename)
      if (journal !== null) journals.push(journal)
    }
    return journals
  }

  private priorLink(destination: Destination): PriorLink {
    if (destination.state === 'MISSING') return { state: 'MISSING' }
    if (destination.state !== 'SYMLINK') throw failure('Invalid takeover state')
    return {
      state: 'SYMLINK',
      literal: assertRestorableLiteral(destination.target),
      identity: destination.identity
    }
  }

  /** The visible link is still the symlink that was inspected: same text, same inode if known. */
  private async assertStill(name: string, seen: Destination): Promise<void> {
    const now = await this.classify(name)
    if (
      seen.state !== 'SYMLINK' ||
      now.state !== 'SYMLINK' ||
      now.target !== seen.target ||
      (seen.identity !== null &&
        now.identity !== null &&
        !identitiesEqual(seen.identity, now.identity))
    ) {
      throw failure('Managed link changed since the pending request')
    }
  }

  /**
   * Restores a journal's previous state if it is provably ours to restore, then
   * removes it. The journal on disk must still be this one before anything is
   * restored and again before it is removed.
   */
  private async settle(journal: RollbackJournal): Promise<void> {
    await this.assertOwned(journal)
    await this.restore(journal)
    await this.removeOwnedJournal(journal)
  }

  /**
   * Compare-and-restore. The visible link must be the previous one or the one the
   * request made (same text, and same inode when both sides report one), and the
   * ownership record must be the previous one or the one the request wrote.
   * Every state a crash can leave in between is one of those combinations, so the
   * same call finishes an interrupted restore. Anything else is somebody else's
   * change and is never overwritten. The link is put back before the record.
   */
  private async restore(journal: RollbackJournal): Promise<void> {
    const { name, prior, intended, applied } = journal
    const destination = await this.classify(name)
    const record = await this.readRecord(name)

    const linkWasPrior =
      prior.link.state === 'MISSING'
        ? destination.state === 'MISSING'
        : destination.state === 'SYMLINK' && destination.target === prior.link.literal
    const linkIsApplied =
      destination.state === 'SYMLINK' &&
      destination.target === intended.target &&
      (applied === null ||
        applied.identity === null ||
        destination.identity === null ||
        identitiesEqual(applied.identity, destination.identity))
    const recordWasPrior = sameRecord(record, prior.record)
    const recordIsApplied = sameRecord(record, intendedRecord(journal))
    if (!(linkWasPrior || linkIsApplied) || !(recordWasPrior || recordIsApplied)) {
      throw failure('Managed link changed since the pending request')
    }

    if (!linkWasPrior) {
      // The exact spelling must be a listed entry, so a case variant on a
      // case-insensitive volume is never restored over.
      const entries = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.readdir(this.layout.root)
      )
      if (!entries.includes(name)) throw failure('Managed link changed since the pending request')
      // Re-proved immediately before the change, like a takeover: there is no
      // compare-and-swap, so this narrows the window without closing it.
      if (prior.link.state === 'MISSING') {
        await this.assertStill(name, destination)
        await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
          this.storage.unlink(this.finalPath(name))
        )
        await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
          syncDirectory(this.layout.root, this.storage)
        )
      } else {
        await this.swapLink(name, prior.link.literal, () => this.assertStill(name, destination))
      }
    }
    if (!recordWasPrior) {
      if (prior.record === null) await this.removeRecord(name)
      else await this.writeRecord(prior.record, 'manual')
    }
  }

  private async sweepTemporaryLinks(): Promise<void> {
    const names = await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
      this.storage.readdir(this.layout.publications)
    )
    for (const name of names) {
      if (!/^\.link-[0-9a-f]{32}$/.test(name)) continue
      await this.removeTemporary(path.join(this.layout.publications, name))
    }
  }

  private async converge(
    desired: readonly DesiredLink[],
    ruleNames: ReadonlySet<string>,
    { managedArtifactNames }: LinkReconcileOptions = {}
  ): Promise<LinkReconcileResult> {
    await this.sweepTemporaryLinks()
    const result: LinkReconcileResult = { created: [], updated: [], removed: [], unchanged: [] }
    const desiredByName = new Map(desired.map((link) => [link.name, link]))
    for (const record of await this.listRecords()) {
      if (record.mode === 'manual') continue
      if (ruleNames.has(record.name)) {
        if (!desiredByName.has(record.name)) {
          const destination = await this.classify(record.name)
          const desiredTarget =
            destination.state === 'SYMLINK' && destination.target !== record.target
              ? destination.target
              : undefined
          await this.removeLink(record, desiredTarget)
          result.removed.push(record.name)
        }
        continue
      }
      const destination = await this.classify(record.name)
      let desiredTarget: string | undefined
      if (destination.state === 'SYMLINK' && destination.target !== record.target) {
        const pending = desiredByName.get(record.name)
        if (pending) desiredTarget = pending.target
        else if (managedArtifactNames?.has(destination.target)) {
          desiredTarget = destination.target
        }
      }
      await this.removeLink(record, desiredTarget)
      result.removed.push(record.name)
    }
    for (const link of desired) {
      if (!ruleNames.has(link.name)) throw failure('Desired link is not a configured rule')
      assertSafeName(link.name, 'Invalid managed link name')
      assertSafeName(link.target, 'Invalid managed link target')
      if (link.target === link.name) throw failure('Managed link cannot target itself')
      const record = await this.readRecord(link.name)
      const destination = await this.classify(link.name)
      if (record?.mode === 'manual') {
        throw conflict('Manual managed link at a configured automatic link name')
      }
      if (destination.state === 'UNMANAGED') {
        throw conflict('Unmanaged path at a configured managed link name')
      }
      if (destination.state === 'MISSING') {
        await this.createLink(link, 'automatic')
        result.created.push(link.name)
        continue
      }
      if (record === null) throw conflict('Unrecorded symlink at a configured managed link name')
      // Ownership proof: a record exists and the visible link is either the
      // recorded target or the desired one (a crash after the visible swap).
      if (destination.target !== record.target && destination.target !== link.target) {
        throw conflict('Managed link does not match its ownership record')
      }
      if (destination.target === link.target) {
        if (
          record.target === link.target &&
          record.transferId === link.transferId &&
          record.targetKind === link.targetKind
        ) {
          result.unchanged.push(link.name)
          continue
        }
        await this.writeRecord(link, 'automatic')
        result.updated.push(link.name)
        continue
      }
      await this.replaceLink(link, 'automatic')
      result.updated.push(link.name)
    }
    return result
  }

  /** A visible entry's identity, `'missing'` when absent, or `null` when the adapter reports none. */
  private entryIdentity(name: string): Promise<LinkIdentity | 'missing'> {
    return withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      try {
        return identityOf(await this.storage.lstat(this.finalPath(name)))
      } catch (error: unknown) {
        if (isMissing(error)) return 'missing' as const
        throw error
      }
    })
  }

  /**
   * Re-proves, immediately before a takeover swap, that the destination is still
   * the unrecorded symlink that was inspected: same literal, same inode when the
   * adapter reports one, and still no ownership record. Anything else (a file, a
   * directory, another symlink, a new record) fails closed. The old literal is
   * only compared as text, never resolved.
   *
   * Records are keyed by the exact spelling of a name, but on a case-insensitive
   * volume `Latest` and `latest` are one directory entry, so a request for one
   * spelling would otherwise miss the record of the other and replace a link that
   * is recorded. Two filesystem-aware checks close that: the entry must be listed
   * in the root under exactly the requested spelling, and no protected name that
   * differs only in case may resolve to the same entry. Protected names are every
   * recorded name (so an externally case-renamed recorded link is caught) and the
   * configured automatic link names and managed artifact names passed in, which
   * are reserved even before they have a record. Names that are genuinely distinct
   * on a case-sensitive volume, including a recorded `latest` beside an unrecorded
   * `Latest`, stay independent. If the adapter reports no inode identity and a
   * protected case variant exists, independence cannot be proven and the request
   * fails closed.
   *
   * This narrows the window but cannot close it: the adapter has no
   * compare-and-swap rename, so a writer outside this process that changes the
   * path between this check and the rename can still be replaced.
   */
  private async assertTakeoverStillSafe(
    name: string,
    seen: Destination,
    reserved: Iterable<string>
  ): Promise<void> {
    if (seen.state !== 'SYMLINK') throw failure('Invalid takeover state')
    const now = await this.classify(name)
    if (
      now.state !== 'SYMLINK' ||
      now.target !== seen.target ||
      (seen.identity !== null &&
        now.identity !== null &&
        !identitiesEqual(seen.identity, now.identity)) ||
      (await this.readRecord(name)) !== null
    ) {
      throw conflict('Existing symlink changed while it was being taken over')
    }
    const entries = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.readdir(this.layout.root)
    )
    if (!entries.includes(name)) {
      throw conflict('Existing symlink is another spelling of a different directory entry')
    }
    const protectedNames = new Set(reserved)
    for (const record of await this.listRecords()) protectedNames.add(record.name)
    const folded = name.toLowerCase()
    for (const other of protectedNames) {
      if (other === name || other.toLowerCase() !== folded) continue
      const identity = await this.entryIdentity(other)
      if (identity === 'missing') continue
      if (identity === null || now.identity === null || identitiesEqual(identity, now.identity)) {
        throw conflict('Existing symlink is a case variant of a protected managed name')
      }
    }
  }

  /**
   * `begin`, when given, is awaited with the state this request found right
   * before its first change and is never called for a request that changes
   * nothing: it is where a rollback journal is made durable.
   */
  private async convergeManual(
    link: DesiredLink,
    { managedArtifactNames, automaticLinkNames }: ManualLinkOptions,
    journaling?: Journaling
  ): Promise<ManualLinkResult> {
    if (
      !managedArtifactNames ||
      typeof managedArtifactNames.has !== 'function' ||
      typeof managedArtifactNames[Symbol.iterator] !== 'function' ||
      !automaticLinkNames ||
      typeof automaticLinkNames.has !== 'function' ||
      typeof automaticLinkNames[Symbol.iterator] !== 'function'
    ) {
      throw failure('Invalid manual link options')
    }
    assertSafeName(link.name, 'Invalid managed link name')
    assertSafeName(link.target, 'Invalid managed link target')
    if (link.target === link.name) throw failure('Managed link cannot target itself')
    if (
      (link.targetKind !== 'file' && link.targetKind !== 'directory') ||
      !/^[0-9a-f]{64}$/.test(link.transferId)
    ) {
      throw failure('Invalid manual managed link')
    }
    if (!managedArtifactNames.has(link.target)) {
      throw conflict('Manual managed link target is not a current artifact')
    }
    if (managedArtifactNames.has(link.name) || automaticLinkNames.has(link.name)) {
      throw conflict('Manual managed link name is reserved')
    }

    await this.sweepTemporaryLinks()
    // An earlier request that never finished is resolved before this one looks at the
    // name; if that cannot be proven, this request fails closed too.
    const pending = await this.readJournal(link.name)
    if (pending !== null) await this.settle(pending)
    const record = await this.readRecord(link.name)
    if (record !== null && record.mode !== 'manual') {
      throw conflict('Automatic managed link at a requested manual link name')
    }
    const destination = await this.classify(link.name)
    if (destination.state === 'UNMANAGED') {
      throw conflict('Unmanaged path at a requested manual link name')
    }
    const prior = { record, destination }
    if (destination.state === 'MISSING') {
      await journaling?.begin(prior)
      await this.createLink(link, 'manual', journaling?.withdraw)
      return { status: 'LINKED' }
    }
    if (record === null) {
      // An explicit manual request, whose target has passed every check above, takes
      // over a symlink that has no ownership record: it is replaced atomically by the
      // requested link and then recorded. The old link is never followed, so whatever
      // it pointed at (a legacy directory, a dangling or foreign path) is left alone and
      // never imported. Even a link that already reads as the target is replaced, so the
      // visible text and the record agree for every later comparison. The swap comes
      // first and the record second: a crash between them leaves a symlink at the
      // requested target that this same request takes over again on retry.
      const reserved = [...automaticLinkNames, ...managedArtifactNames]
      await journaling?.begin(prior)
      await this.replaceLink(link, 'manual', () =>
        this.assertTakeoverStillSafe(link.name, destination, reserved)
      )
      return { status: 'LINKED' }
    }
    if (destination.target !== record.target && destination.target !== link.target) {
      throw conflict('Managed link does not match its ownership record')
    }
    if (destination.target === link.target) {
      if (record.target === link.target) {
        if (record.transferId === link.transferId && record.targetKind === link.targetKind) {
          return { status: 'UNCHANGED' }
        }
        // Only the record changes, but it is still a change a failed hook undoes.
        await journaling?.begin(prior)
        await this.writeRecord(link, 'manual')
        return { status: 'UNCHANGED' }
      }
      await journaling?.begin(prior)
      await this.writeRecord(link, 'manual')
      return { status: 'LINKED' }
    }
    await journaling?.begin(prior)
    await this.replaceLink(link, 'manual')
    return { status: 'LINKED' }
  }
}
