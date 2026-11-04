/**
 * The pure planner for merging an uploaded subset of files into an existing container.
 *
 * It decides, from facts it is handed and nothing else, what a merge would do and what the
 * ownership catalog would be afterwards. It reads no file, writes no file, and holds no lock, so
 * the same plan serves any way of publishing it (renaming each file into place, or building a
 * whole directory and exchanging it); the caller observes the container, plans, then applies the
 * plan under its own lease and journal.
 *
 * The rules, per uploaded file (directory entries are ignored: an empty directory is not a
 * resource, and a directory is created only as the parent of a file that is added):
 *
 * - not there: it is added, with no permission needed;
 * - there with the same bytes: it is skipped. If Swarm owns it, nothing changes; if it is
 *   untracked it stays untracked, never adopted;
 * - there with other bytes: replaced only if Swarm owns that very file, the bytes on disk are still
 *   the bytes it wrote, and the replace permission for the name allows it. An untracked file, or an
 *   owned file somebody changed, is never overwritten, permission or not;
 * - a directory, symlink or special file where a file goes, a file or a link where a directory is
 *   needed, a name that differs only in case from an existing one, an invalid or non-canonical
 *   path, a release that is not the catalog's, or a size past a limit: a conflict.
 *
 * Any conflict refuses the whole upload and the outcome carries no action, so a refused upload
 * changes nothing. Files the upload omits are never touched. Planning the same upload against the
 * state it produced is a no-change plan, so a retry is idempotent.
 */
import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { assertCanonicalTreeEntries, compareTreePaths } from '../tar-protocol/tree.js'
import { isHex, type CommitRelease } from './commit-journal.js'
import {
  MAX_CATALOG_FILES,
  MAX_CATALOG_RECEIPTS,
  assertValidFileCatalog,
  copyRelease,
  ownedDigest,
  releasesMatch,
  snapshotId,
  subsetDigest,
  filePathProblem,
  type FileCatalog,
  type FileFacts,
  type FileWriter,
  type OwnedFile,
  type TransferReceipt
} from './file-catalog.js'
import type { TreeDigestResult } from './tree-fs.js'

const MAX_REPORTED_CONFLICTS = 100

export type ObservedKind = 'missing' | 'file' | 'directory' | 'symlink' | 'special'

/** What one path in the container is right now, as the caller found it without following links. */
export interface Observation {
  readonly kind: ObservedKind
  /** A regular file's size and SHA-256 (hex); required for `file`, forbidden otherwise. */
  readonly size?: number
  readonly sha256?: string
  /**
   * Other existing names (full relative paths) that equal this one ignoring case: siblings on a
   * case-sensitive volume, or the stored spelling when the volume resolved a different case.
   */
  readonly caseVariants?: readonly string[]
}

/** One entry of the uploaded tree. Files carry their verified digest (hex). */
export interface IncomingEntry {
  readonly kind: 'file' | 'directory'
  readonly path: string
  readonly size: number
  readonly sha256?: string
}

export interface MergeLimits {
  /** Most files the catalog may own after the merge. Defaults to the catalog limit. */
  readonly maxFiles?: number
  /** Most payload bytes the catalog may own after the merge. */
  readonly maxPayloadBytes?: number
}

export interface MergeRequest {
  /** The current catalog (`emptyFileCatalog` when there is none). */
  readonly catalog: FileCatalog
  /** The uploaded tree, files and directories, in canonical order. */
  readonly incoming: readonly IncomingEntry[]
  /** Observations for at least every path `observationPaths(incoming)` lists. */
  readonly observed: ReadonlyMap<string, Observation>
  /** Whether the existing replace permission allows replacing owned files under this name. */
  readonly allowReplace: boolean
  /** Who is writing, and when; recorded as the writer of every file this merge adds or replaces. */
  readonly writer: FileWriter
  /** The release identity the upload matched, if any. It must be the catalog's. */
  readonly release?: CommitRelease
  readonly limits?: MergeLimits
}

export type MergeAction =
  | { readonly op: 'add'; readonly path: string; readonly size: number; readonly sha256: string }
  | {
      readonly op: 'replace'
      readonly path: string
      readonly size: number
      readonly sha256: string
      /** The bytes Swarm owned, which the caller must find on disk again before replacing. */
      readonly previous: { readonly size: number; readonly sha256: string }
    }
  | {
      readonly op: 'skip'
      readonly path: string
      readonly size: number
      readonly sha256: string
      /** Whether Swarm owns the identical file that is there. */
      readonly owned: boolean
    }

export type ConflictReason =
  | 'INVALID_INCOMING'
  | 'RELEASE_MISMATCH'
  | 'KIND_CONFLICT'
  | 'SYMLINK'
  | 'SPECIAL'
  | 'CASE_ALIAS'
  | 'OBSERVATION_CHANGED'
  | 'UNTRACKED_DIFFERS'
  | 'EXTERNALLY_MODIFIED'
  | 'DIFFERS_NOT_ALLOWED'
  | 'TOO_MANY_FILES'
  | 'TOO_LARGE'

export interface MergeConflict {
  /** The uploaded path at fault, or `''` for a problem of the whole upload. */
  readonly path: string
  readonly reason: ConflictReason
}

/** Ownership dropped without touching the file: it no longer is what Swarm wrote. */
export interface ReleasedFile {
  readonly path: string
  readonly reason: 'MODIFIED'
}

/** The identity of an owned set: its content digest and the snapshot ID derived from it. */
export interface PublishedIdentity {
  readonly digest: string
  readonly snapshotId: string
  readonly files: number
  readonly bytes: number
}

export type MergeOutcome =
  | {
      readonly ok: false
      /** At most 100, in path order. Apply nothing. */
      readonly conflicts: readonly MergeConflict[]
      readonly totalConflicts: number
    }
  | {
      readonly ok: true
      /** Whether the catalog (and so the container) changes; `false` is an idempotent no-op. */
      readonly changed: boolean
      readonly actions: readonly MergeAction[]
      /** Directories to create, parents first: only parents of added files, never standalone. */
      readonly directories: readonly string[]
      readonly released: readonly ReleasedFile[]
      /** The catalog after the merge (`catalog` itself when nothing changes). */
      readonly next: FileCatalog
      /** `subsetDigest` of the uploaded files: the identity of what was uploaded. */
      readonly subset: string
      /** The owned set before and after: the identity of what is published. */
      readonly previous: PublishedIdentity
      readonly result: PublishedIdentity
    }

function invalid(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message)
}

/** The paths whose observation a plan needs: every uploaded file and each of its ancestors. */
export function observationPaths(incoming: readonly IncomingEntry[]): string[] {
  const wanted = new Set<string>()
  for (const entry of incoming) {
    if (entry.kind !== 'file') continue
    let prefix = ''
    for (const component of entry.path.split('/')) {
      prefix = prefix === '' ? component : `${prefix}/${component}`
      wanted.add(prefix)
    }
  }
  return [...wanted].sort(compareTreePaths)
}

/** The uploaded entries of one verified `digestTree`, with each file's digest as hex. */
export function incomingFromDigest(
  digested: Pick<TreeDigestResult, 'entries' | 'files'>
): IncomingEntry[] {
  const digests = new Map<string, string>()
  for (const file of digested.files) digests.set(file.path, b4a.toString(file.sha256, 'hex'))
  return digested.entries.map((entry): IncomingEntry => {
    if (entry.kind === 'directory') return { kind: 'directory', path: entry.path, size: 0 }
    const sha256 = digests.get(entry.path)
    if (sha256 === undefined) throw invalid('Uploaded file has no digest')
    return { kind: 'file', path: entry.path, size: entry.size, sha256 }
  })
}

function assertWriter(writer: FileWriter): void {
  if (
    typeof writer !== 'object' ||
    writer === null ||
    !isHex(writer.transferId) ||
    !isHex(writer.uploader) ||
    typeof writer.committedAt !== 'number' ||
    !Number.isSafeInteger(writer.committedAt) ||
    writer.committedAt < 0
  ) {
    throw invalid('Invalid merge writer')
  }
}

const OBSERVED_KINDS: readonly string[] = ['missing', 'file', 'directory', 'symlink', 'special']

function checked(path: string, observation: Observation | undefined): Observation {
  if (observation === undefined) throw invalid('Missing observation')
  if (!OBSERVED_KINDS.includes(observation.kind)) throw invalid('Invalid observation')
  if (observation.kind === 'file') {
    if (
      typeof observation.size !== 'number' ||
      !Number.isSafeInteger(observation.size) ||
      observation.size < 0 ||
      !isHex(observation.sha256)
    ) {
      throw invalid('Invalid observation')
    }
  } else if (observation.size !== undefined || observation.sha256 !== undefined) {
    throw invalid('Invalid observation')
  }
  const variants = observation.caseVariants
  if (
    variants !== undefined &&
    (!Array.isArray(variants) ||
      variants.some((name) => typeof name !== 'string' || name.length === 0 || name === path))
  ) {
    throw invalid('Invalid observation')
  }
  return observation
}

function containerProblem(observation: Observation): ConflictReason | null {
  if (observation.caseVariants !== undefined && observation.caseVariants.length > 0) {
    return 'CASE_ALIAS'
  }
  if (observation.kind === 'file') return 'KIND_CONFLICT'
  if (observation.kind === 'symlink') return 'SYMLINK'
  if (observation.kind === 'special') return 'SPECIAL'
  return null
}

function identityOf(catalog: FileCatalog): PublishedIdentity {
  let bytes = 0
  for (const file of catalog.files) bytes += file.size
  const digest = ownedDigest(catalog.files)
  return {
    digest,
    snapshotId: snapshotId(catalog.name, catalog.release, digest),
    files: catalog.files.length,
    bytes
  }
}

function safeLimit(value: number | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`Invalid ${label}`)
  }
  return value
}

/**
 * Plans the merge of an uploaded subset. Throws only for a caller that handed in something
 * unusable (an invalid catalog or writer, a missing observation); every fact about the upload or
 * the container, however hostile, is an outcome.
 */
export function planFileMerge(request: MergeRequest): MergeOutcome {
  const { catalog, incoming, observed, allowReplace, writer } = request
  assertValidFileCatalog(catalog)
  assertWriter(writer)
  if (typeof allowReplace !== 'boolean') throw invalid('Invalid replace permission')
  const release = request.release === undefined ? undefined : copyRelease(request.release)
  const maxFiles = Math.min(
    MAX_CATALOG_FILES,
    safeLimit(request.limits?.maxFiles, 'file limit', MAX_CATALOG_FILES)
  )
  const maxPayload = safeLimit(
    request.limits?.maxPayloadBytes,
    'payload limit',
    Number.MAX_SAFE_INTEGER
  )

  const conflicts: MergeConflict[] = []
  let total = 0
  const note = (path: string, reason: ConflictReason): void => {
    total++
    if (conflicts.length < MAX_REPORTED_CONFLICTS) conflicts.push({ path, reason })
  }
  const refuse = (): MergeOutcome => ({
    ok: false,
    conflicts: conflicts
      .slice()
      .sort(
        (left, right) =>
          compareTreePaths(left.path, right.path) ||
          (left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0)
      ),
    totalConflicts: total
  })

  // What was uploaded: a canonical tree, of which only the files matter.
  try {
    assertCanonicalTreeEntries(incoming)
  } catch {
    note('', 'INVALID_INCOMING')
    return refuse()
  }
  const files: FileFacts[] = []
  for (const entry of incoming) {
    if (entry.kind === 'directory') {
      if (entry.sha256 !== undefined) note(entry.path, 'INVALID_INCOMING')
      continue
    }
    if (!isHex(entry.sha256)) {
      note(entry.path, 'INVALID_INCOMING')
      continue
    }
    files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 })
  }
  if (total > 0) return refuse()
  let subset: string
  try {
    subset = subsetDigest(files)
  } catch {
    note('', 'INVALID_INCOMING')
    return refuse()
  }

  const before = identityOf(catalog)
  if (files.length === 0) {
    // Nothing but directories (or nothing): no resource to publish.
    return {
      ok: true,
      changed: false,
      actions: [],
      directories: [],
      released: [],
      next: catalog,
      subset,
      previous: before,
      result: before
    }
  }
  if (catalog.files.length > 0 && !releasesMatch(catalog.release, release)) {
    note('', 'RELEASE_MISMATCH')
    return refuse()
  }

  const owned = new Map<string, OwnedFile>()
  for (const file of catalog.files) owned.set(file.path, file)
  const actions: MergeAction[] = []
  const released: ReleasedFile[] = []
  const directories = new Set<string>()

  for (const file of files) {
    const components = file.path.split('/')
    const ancestors: string[] = []
    let prefix = ''
    for (let index = 0; index < components.length - 1; index++) {
      prefix = index === 0 ? components[0] : `${prefix}/${components[index]}`
      ancestors.push(prefix)
    }

    // Every container on the way must be a real directory (or not exist yet), named exactly so.
    let firstMissing = -1
    let blocked = false
    for (let index = 0; index < ancestors.length; index++) {
      const observation = checked(ancestors[index], observed.get(ancestors[index]))
      const problem = containerProblem(observation)
      if (problem !== null) {
        note(file.path, problem)
        blocked = true
        break
      }
      if (firstMissing >= 0 && observation.kind !== 'missing') {
        note(file.path, 'OBSERVATION_CHANGED')
        blocked = true
        break
      }
      if (observation.kind === 'missing' && firstMissing < 0) firstMissing = index
    }
    if (blocked) continue

    const observation = checked(file.path, observed.get(file.path))
    if (observation.caseVariants !== undefined && observation.caseVariants.length > 0) {
      note(file.path, 'CASE_ALIAS')
      continue
    }
    if (firstMissing >= 0 && observation.kind !== 'missing') {
      note(file.path, 'OBSERVATION_CHANGED')
      continue
    }
    if (observation.kind === 'directory') {
      note(file.path, 'KIND_CONFLICT')
      continue
    }
    if (observation.kind === 'symlink') {
      note(file.path, 'SYMLINK')
      continue
    }
    if (observation.kind === 'special') {
      note(file.path, 'SPECIAL')
      continue
    }
    if (observation.kind === 'missing') {
      actions.push({ op: 'add', path: file.path, size: file.size, sha256: file.sha256 })
      if (firstMissing >= 0) {
        for (let index = firstMissing; index < ancestors.length; index++) {
          directories.add(ancestors[index])
        }
      }
      continue
    }

    // A regular file is there.
    const current = owned.get(file.path)
    const intact =
      current !== undefined &&
      observation.size === current.size &&
      observation.sha256 === current.sha256
    if (observation.size === file.size && observation.sha256 === file.sha256) {
      // Identical: skipped. Owned and intact stays owned; anything else stays untracked.
      if (current !== undefined && !intact) released.push({ path: file.path, reason: 'MODIFIED' })
      actions.push({
        op: 'skip',
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        owned: intact
      })
    } else if (current === undefined) {
      note(file.path, 'UNTRACKED_DIFFERS')
    } else if (!intact) {
      note(file.path, 'EXTERNALLY_MODIFIED')
    } else if (!allowReplace) {
      note(file.path, 'DIFFERS_NOT_ALLOWED')
    } else {
      actions.push({
        op: 'replace',
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        previous: { size: current.size, sha256: current.sha256 }
      })
    }
  }
  if (total > 0) return refuse()

  // The owned set afterwards, and whether it is still a canonical, bounded one.
  const written = new Map<string, FileFacts>()
  for (const action of actions) {
    if (action.op !== 'skip') written.set(action.path, action)
  }
  const dropped = new Set(released.map((file) => file.path))
  const newWriter: FileWriter = {
    transferId: writer.transferId,
    uploader: writer.uploader,
    committedAt: writer.committedAt
  }
  const nextFiles: OwnedFile[] = []
  for (const file of catalog.files) {
    if (dropped.has(file.path)) continue
    const replacement = written.get(file.path)
    nextFiles.push(
      replacement === undefined
        ? file
        : { path: file.path, size: replacement.size, sha256: replacement.sha256, writer: newWriter }
    )
    written.delete(file.path)
  }
  for (const [path, facts] of written) {
    nextFiles.push({ path, size: facts.size, sha256: facts.sha256, writer: newWriter })
  }
  nextFiles.sort((left, right) => compareTreePaths(left.path, right.path))

  const problem = filePathProblem(nextFiles.map((file) => file.path))
  if (problem !== null) {
    note(
      problem.path,
      problem.problem === 'CASE_ALIAS'
        ? 'CASE_ALIAS'
        : problem.problem === 'KIND_CONFLICT'
          ? 'KIND_CONFLICT'
          : 'INVALID_INCOMING'
    )
    return refuse()
  }
  if (nextFiles.length > maxFiles) note('', 'TOO_MANY_FILES')
  let payload = 0
  for (const file of nextFiles) payload += file.size
  if (payload > maxPayload) note('', 'TOO_LARGE')
  if (total > 0) return refuse()

  const changed = actions.some((action) => action.op !== 'skip') || released.length > 0
  if (!changed) {
    return {
      ok: true,
      changed: false,
      actions,
      directories: [],
      released: [],
      next: catalog,
      subset,
      previous: before,
      result: before
    }
  }

  let added = 0
  let replaced = 0
  let skipped = 0
  let uploadedBytes = 0
  for (const action of actions) {
    uploadedBytes += action.size
    if (action.op === 'add') added++
    else if (action.op === 'replace') replaced++
    else skipped++
  }
  const generation = catalog.generation + 1
  const receipt: TransferReceipt = {
    transferId: writer.transferId,
    subset,
    files: files.length,
    bytes: uploadedBytes,
    added,
    replaced,
    skipped,
    uploader: writer.uploader,
    appliedAt: writer.committedAt,
    generation
  }
  const receipts = [
    ...catalog.receipts.filter((existing) => existing.transferId !== writer.transferId),
    receipt
  ].slice(-MAX_CATALOG_RECEIPTS)
  const nextRelease = catalog.files.length > 0 ? catalog.release : release
  const next: FileCatalog = {
    version: catalog.version,
    name: catalog.name,
    generation,
    ...(nextRelease === undefined ? {} : { release: nextRelease }),
    files: nextFiles,
    receipts
  }
  assertValidFileCatalog(next)

  return {
    ok: true,
    changed: true,
    actions,
    directories: [...directories].sort(compareTreePaths),
    released,
    next,
    subset,
    previous: before,
    result: identityOf(next)
  }
}

export type CleanupReason = 'MODIFIED' | 'MISSING' | 'REPLACED'

export interface CleanupPlan {
  /** Owned files whose bytes are still exactly what Swarm wrote: the only ones to delete. */
  readonly remove: readonly string[]
  /** Owned files that are gone or no longer Swarm's: ownership ends, the file is left alone. */
  readonly release: ReadonlyArray<{ readonly path: string; readonly reason: CleanupReason }>
  /** Selected-out files, kept as they are. */
  readonly keep: readonly string[]
  /**
   * Directories above removed files, deepest first: candidates for a non-recursive `rmdir`, which
   * succeeds only if nothing foreign is left in them. They are never owned.
   */
  readonly prune: readonly string[]
  readonly changed: boolean
  readonly next: FileCatalog
}

/**
 * Plans removing owned files (for retention): only a file that is still exactly what Swarm wrote
 * is removed. One that changed, vanished or became another kind of thing is released from the
 * catalog and never touched; files that are not in the catalog are not even looked at. `select`
 * narrows the candidates (default: all); `observed` must cover every selected file.
 */
export function planOwnedCleanup(
  catalog: FileCatalog,
  observed: ReadonlyMap<string, Observation>,
  select: (file: OwnedFile) => boolean = () => true
): CleanupPlan {
  assertValidFileCatalog(catalog)
  const remove: string[] = []
  const release: Array<{ path: string; reason: CleanupReason }> = []
  const keep: string[] = []
  for (const file of catalog.files) {
    if (!select(file)) {
      keep.push(file.path)
      continue
    }
    const observation = checked(file.path, observed.get(file.path))
    if (observation.kind === 'missing') {
      release.push({ path: file.path, reason: 'MISSING' })
    } else if (observation.kind !== 'file') {
      release.push({ path: file.path, reason: 'REPLACED' })
    } else if (observation.size === file.size && observation.sha256 === file.sha256) {
      remove.push(file.path)
    } else {
      release.push({ path: file.path, reason: 'MODIFIED' })
    }
  }
  const gone = new Set<string>([...remove, ...release.map((entry) => entry.path)])
  const directories = new Set<string>()
  for (const filePath of remove) {
    const components = filePath.split('/')
    let prefix = ''
    for (let index = 0; index < components.length - 1; index++) {
      prefix = index === 0 ? components[0] : `${prefix}/${components[index]}`
      directories.add(prefix)
    }
  }
  const prune = [...directories].sort(
    (left, right) =>
      right.split('/').length - left.split('/').length || compareTreePaths(left, right)
  )
  if (gone.size === 0) {
    return { remove, release, keep, prune, changed: false, next: catalog }
  }
  const next: FileCatalog = {
    version: catalog.version,
    name: catalog.name,
    generation: catalog.generation + 1,
    ...(catalog.release === undefined ? {} : { release: catalog.release }),
    files: catalog.files.filter((file) => !gone.has(file.path)),
    receipts: catalog.receipts
  }
  assertValidFileCatalog(next)
  return { remove, release, keep, prune, changed: true, next }
}
