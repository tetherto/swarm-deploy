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
import { withSafeDirectoryIdentity } from './layout.js'
import { assertSymlinkCapable } from './tree-fs.js'
import type { StorageAdapter, StorageLayout, StorageStats, SymlinkCapableStorage } from './types.js'

const MAX_LINK_RECORD_BYTES = 4 * 1024
const RECORD_FILENAME = /^[0-9a-f]{64}\.json$/
const RECORD_KEYS = 'name,target,targetKind,transferId,version'

export interface ManagedSymlinkRecord {
  version: 1
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

export interface LinkStoreOptions {
  layout: StorageLayout
  /** Must provide `symlink` and `readlink`, or construction fails closed. */
  storage?: StorageAdapter
}

type Destination =
  { state: 'MISSING' } | { state: 'SYMLINK'; target: string } | { state: 'UNMANAGED' }

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
  if (
    Object.keys(candidate).sort().join(',') !== RECORD_KEYS ||
    candidate.version !== 1 ||
    candidate.name !== expectedName ||
    (candidate.targetKind !== 'file' && candidate.targetKind !== 'directory') ||
    typeof candidate.transferId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.transferId)
  ) {
    throw failure('Invalid managed link record')
  }
  assertSafeName(candidate.name, 'Invalid managed link record')
  assertSafeName(candidate.target, 'Invalid managed link record')
  return candidate as unknown as ManagedSymlinkRecord
}

function randomSuffix(): string {
  const bytes = b4a.allocUnsafe(16)
  sodium.randombytes_buf(bytes)
  return b4a.toString(bytes, 'hex')
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
 * A destination is replaceable only when a valid ownership record exists, the
 * visible destination is a symbolic link, and `readlink()` returns either the
 * recorded target or the desired target. Anything else is unmanaged: it is left
 * untouched and the operation fails closed. A link target is always exactly a
 * sibling basename, and `readlink()` output is only ever compared, never used
 * to build a path.
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
    return path.join(this.layout.links, `${b4a.toString(sodiumSha256(b4a.from(name)), 'hex')}.json`)
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
      return { state: 'SYMLINK' as const, target: await this.storage.readlink(finalPath) }
    })
  }

  private async writeRecord(link: DesiredLink): Promise<void> {
    const record: ManagedSymlinkRecord = {
      version: 1,
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
   */
  private async createLink(link: DesiredLink): Promise<void> {
    await this.writeRecord(link)
    try {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.symlink(link.target, this.finalPath(link.name))
      )
    } catch (error: unknown) {
      await this.removeRecord(link.name).catch(() => {})
      if (errorCode(error) === 'EEXIST') {
        throw conflict('Unmanaged path at a configured managed link name')
      }
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

  /** Atomically swaps an owned link by renaming a private temporary link over it. */
  private async replaceLink(link: DesiredLink): Promise<void> {
    const temporary = path.join(this.layout.publications, `.link-${randomSuffix()}`)
    try {
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        this.storage.symlink(link.target, temporary)
      )
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        syncDirectory(this.layout.publications, this.storage)
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
          this.storage.rename(temporary, this.finalPath(link.name))
        )
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
      await this.writeRecord(link)
    } finally {
      await this.removeTemporary(temporary)
    }
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
      if (destination.state === 'UNMANAGED') {
        throw conflict('Unmanaged path at a configured managed link name')
      }
      if (destination.state === 'MISSING') {
        await this.createLink(link)
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
        await this.writeRecord(link)
        result.updated.push(link.name)
        continue
      }
      await this.replaceLink(link)
      result.updated.push(link.name)
    }
    return result
  }
}
