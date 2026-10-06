import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { safeFileOpenFlags } from '../storage/layout.js'
import {
  assertSourceParent,
  CONTROL_VERSION,
  decodeTreeMetadataRecord,
  encodeTreeMetadataRecord,
  type TreeMetadataRecord
} from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import { deriveSourceParent, type TarResumeResult } from './manifest.js'
import {
  assertCanonicalTreeEntries,
  assertSameTreeIdentity,
  hashField,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  revalidateTreeSnapshot,
  snapshotTree,
  tarEntryName,
  treeDigest,
  type TreeDigestEntry,
  type TreeSnapshot,
  type TreeSnapshotEntry
} from './tree.js'
import {
  canonicalUstarTreeHeader,
  deterministicTreeTarSize,
  TAR_BLOCK_BYTES,
  TAR_DIRECTORY_MODE,
  TAR_GID,
  TAR_GNAME,
  TAR_MODE,
  TAR_MTIME_MS,
  TAR_UID,
  TAR_UNAME
} from './ustar.js'

export const TREE_TRANSFER_DOMAIN = 'swarm-deploy/direct-tree/v1'
const READ_BYTES = 64 * 1024

export interface TreeManifest {
  kind: 'directory'
  path: string
  name: string
  sourceParent?: string
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
  tarSize: number
  tarSha256: Buffer
  transferId: Buffer
  snapshot: TreeSnapshot
}

export interface TreeManifestOptions {
  signal?: AbortSignalLike | null
  /** Set to `false` to keep an identity that names no source parent. */
  includeSourceParent?: boolean
}

export interface TreeResumeOptions {
  signal?: AbortSignalLike | null
  expectedPrefixSha256?: Uint8Array | null
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertClientKey(key: Uint8Array): void {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw invalid('Invalid client public key')
}

function canonicalName(directoryPath: string): string {
  const name = validateBasename(path.basename(path.resolve(directoryPath)))
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
  }
  return name
}

/**
 * The authenticated identity of a directory offer. It is domain separated from
 * the file transfer ID and commits to every metadata field plus the pinned USTAR
 * constants and tree limits that shape the archive.
 */
export function computeTreeTransferId(
  clientPublicKey: Uint8Array,
  immutable: {
    name: string
    sourceParent?: string
    entryCount: number
    payloadBytes: number
    treeSha256: Uint8Array
    tarSize: number
    tarSha256: Uint8Array
  }
): Buffer {
  assertClientKey(clientPublicKey)
  for (const [label, value] of [
    ['tree entry count', immutable.entryCount],
    ['tree payload size', immutable.payloadBytes],
    ['TAR size', immutable.tarSize]
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw invalid(`Invalid ${label}`)
    }
  }
  if (!b4a.isBuffer(immutable.treeSha256) || immutable.treeSha256.byteLength !== 32) {
    throw invalid('Invalid tree digest')
  }
  if (!b4a.isBuffer(immutable.tarSha256) || immutable.tarSha256.byteLength !== 32) {
    throw invalid('Invalid TAR digest')
  }
  const hash = new SodiumSha256()
  hashField(hash, 'domain', TREE_TRANSFER_DOMAIN)
  hashField(hash, 'clientPublicKey', clientPublicKey)
  hashField(hash, 'kind', 'directory')
  hashField(hash, 'name', immutable.name)
  if (immutable.sourceParent !== undefined) {
    assertSourceParent(immutable.sourceParent)
    hashField(hash, 'sourceParent', immutable.sourceParent)
  }
  hashField(hash, 'entryCount', immutable.entryCount)
  hashField(hash, 'payloadBytes', immutable.payloadBytes)
  hashField(hash, 'treeSha256', immutable.treeSha256)
  hashField(hash, 'tarSize', immutable.tarSize)
  hashField(hash, 'tarSha256', immutable.tarSha256)
  hashField(hash, 'fileMode', TAR_MODE)
  hashField(hash, 'directoryMode', TAR_DIRECTORY_MODE)
  hashField(hash, 'uid', TAR_UID)
  hashField(hash, 'gid', TAR_GID)
  hashField(hash, 'mtimeMs', TAR_MTIME_MS)
  hashField(hash, 'uname', TAR_UNAME)
  hashField(hash, 'gname', TAR_GNAME)
  hashField(hash, 'maxDepth', MAX_TREE_DEPTH)
  hashField(hash, 'maxEntries', MAX_TREE_ENTRIES)
  hashField(hash, 'pax', 'none')
  return hash.digest()
}

/** Streams one file's payload, proving it is the snapshotted inode at open and at the end. */
async function* readEntryPayload(
  entry: TreeSnapshotEntry,
  signal: AbortSignalLike | null | undefined
): AsyncGenerator<Buffer> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(entry.absolutePath, safeFileOpenFlags('read'))
    assertSameTreeIdentity(entry.identity, await handle.stat(), 'Tree entry changed while opening')
    let position = 0
    while (position < entry.size) {
      throwIfAborted(signal)
      const chunk = b4a.alloc(Math.min(READ_BYTES, entry.size - position))
      const read = await handle.read(chunk, 0, chunk.byteLength, position)
      const count = typeof read === 'number' ? read : read.bytesRead
      if (count !== chunk.byteLength) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree entry was truncated')
      }
      position += count
      yield chunk
    }
    assertSameTreeIdentity(
      entry.identity,
      await handle.stat(),
      'Tree entry changed during TAR generation'
    )
  } catch (error) {
    if (error instanceof SwarmDeployError) throw error
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to safely read tree entry', error)
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Yields the exact deterministic archive, hashing each entry payload in order. */
async function* generateTreeTar(
  snapshot: TreeSnapshot,
  digests: TreeDigestEntry[],
  signal: AbortSignalLike | null | undefined
): AsyncGenerator<Buffer> {
  for (const entry of snapshot.entries) {
    throwIfAborted(signal)
    yield canonicalUstarTreeHeader(tarEntryName(entry), entry.kind, entry.size)
    if (entry.kind === 'directory') {
      digests.push({ entry: { kind: entry.kind, path: entry.path, size: 0 } })
      continue
    }
    const hash = new SodiumSha256()
    for await (const chunk of readEntryPayload(entry, signal)) {
      hash.update(chunk)
      yield chunk
    }
    digests.push({
      entry: { kind: entry.kind, path: entry.path, size: entry.size },
      sha256: hash.digest()
    })
    const padding = (TAR_BLOCK_BYTES - (entry.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (padding > 0) yield b4a.alloc(padding)
  }
  yield b4a.alloc(2 * TAR_BLOCK_BYTES)
}

export async function buildTreeManifest(
  directoryPath: string,
  clientPublicKey: Uint8Array,
  { signal = null, includeSourceParent = true }: TreeManifestOptions = {}
): Promise<TreeManifest> {
  assertClientKey(clientPublicKey)
  const name = canonicalName(directoryPath)
  const sourceParent =
    includeSourceParent === false ? undefined : deriveSourceParent(path.resolve(directoryPath))
  const snapshot = await snapshotTree(directoryPath, { signal })
  assertCanonicalTreeEntries(snapshot.entries)
  const digests: TreeDigestEntry[] = []
  const tarHash = new SodiumSha256()
  let tarSize = 0
  for await (const chunk of generateTreeTar(snapshot, digests, signal)) {
    tarHash.update(chunk)
    tarSize += chunk.byteLength
  }
  await revalidateTreeSnapshot(snapshot, { signal })
  if (tarSize !== deterministicTreeTarSize(snapshot.entries)) {
    throw invalid('Noncanonical deterministic TAR length')
  }
  const treeSha256 = treeDigest(digests)
  const tarSha256 = tarHash.digest()
  const transferId = computeTreeTransferId(clientPublicKey, {
    name,
    ...(sourceParent === undefined ? {} : { sourceParent }),
    entryCount: snapshot.entryCount,
    payloadBytes: snapshot.payloadBytes,
    treeSha256,
    tarSize,
    tarSha256
  })
  return {
    kind: 'directory',
    path: directoryPath,
    name,
    ...(sourceParent === undefined ? {} : { sourceParent }),
    entryCount: snapshot.entryCount,
    payloadBytes: snapshot.payloadBytes,
    treeSha256,
    tarSize,
    tarSha256,
    transferId,
    snapshot
  }
}

export async function regenerateTreeTarSuffix(
  manifest: TreeManifest,
  offset: number,
  write: (chunk: Buffer) => void | Promise<void>,
  { signal = null, expectedPrefixSha256 = null }: TreeResumeOptions = {}
): Promise<TarResumeResult> {
  if (!manifest || typeof manifest !== 'object') throw invalid('Invalid tree manifest')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > manifest.tarSize) {
    throw invalid('Invalid TAR resume offset')
  }
  if (typeof write !== 'function') throw invalid('Invalid TAR suffix writer')
  if (
    expectedPrefixSha256 !== null &&
    (!b4a.isBuffer(expectedPrefixSha256) || expectedPrefixSha256.byteLength !== 32)
  ) {
    throw invalid('Invalid expected prefix digest')
  }

  const digests: TreeDigestEntry[] = []
  const tarHash = new SodiumSha256()
  const prefixHash = new SodiumSha256()
  let position = 0
  let bytesSent = 0
  let prefixSha256: Buffer | null = offset === 0 ? prefixHash.digest() : null
  let resetRequired =
    prefixSha256 !== null &&
    expectedPrefixSha256 !== null &&
    !sodium.sodium_memcmp(prefixSha256, expectedPrefixSha256)

  for await (const chunk of generateTreeTar(manifest.snapshot, digests, signal)) {
    throwIfAborted(signal)
    tarHash.update(chunk)
    const end = position + chunk.byteLength
    if (position < offset) {
      const prefixEnd = Math.min(chunk.byteLength, offset - position)
      prefixHash.update(chunk.subarray(0, prefixEnd))
      if (end >= offset) {
        prefixSha256 = prefixHash.digest()
        if (expectedPrefixSha256 && !sodium.sodium_memcmp(prefixSha256, expectedPrefixSha256)) {
          resetRequired = true
        }
        if (!resetRequired && prefixEnd < chunk.byteLength) {
          const suffix = chunk.subarray(prefixEnd)
          await write(suffix)
          bytesSent += suffix.byteLength
        }
      }
    } else if (!resetRequired) {
      await write(chunk)
      bytesSent += chunk.byteLength
    }
    position = end
  }
  await revalidateTreeSnapshot(manifest.snapshot, { signal })
  if (
    position !== manifest.tarSize ||
    (!resetRequired && bytesSent !== manifest.tarSize - offset)
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Regenerated TAR length changed')
  }
  if (
    !digestMatches(treeDigest(digests), manifest.treeSha256) ||
    !digestMatches(tarHash.digest(), manifest.tarSha256)
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree changed during TAR regeneration')
  }
  if (prefixSha256 === null) throw invalid('Unable to hash TAR prefix')
  if (resetRequired) return { status: 'RESET_REQUIRED', prefixSha256, bytesSent: 0 }
  return { status: 'MATCH', prefixSha256, bytesSent }
}

export function treeMetadataFromManifest(
  manifest: TreeManifest,
  reset = false
): TreeMetadataRecord {
  return {
    v: CONTROL_VERSION,
    kind: 'directory',
    name: manifest.name,
    ...(manifest.sourceParent === undefined ? {} : { sourceParent: manifest.sourceParent }),
    entryCount: manifest.entryCount,
    payloadBytes: manifest.payloadBytes,
    treeSha256: b4a.toString(manifest.treeSha256, 'hex'),
    tarSize: manifest.tarSize,
    tarSha256: b4a.toString(manifest.tarSha256, 'hex'),
    transferId: b4a.toString(manifest.transferId, 'hex'),
    reset
  }
}

export function assertTreeMetadataTransferId(
  clientPublicKey: Uint8Array,
  offeredMetadata: TreeMetadataRecord
): void {
  const metadata = decodeTreeMetadataRecord(encodeTreeMetadataRecord(offeredMetadata))
  const expected = computeTreeTransferId(clientPublicKey, {
    name: metadata.name,
    ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent }),
    entryCount: metadata.entryCount,
    payloadBytes: metadata.payloadBytes,
    treeSha256: b4a.from(metadata.treeSha256, 'hex'),
    tarSize: metadata.tarSize,
    tarSha256: b4a.from(metadata.tarSha256, 'hex')
  })
  if (!sodium.sodium_memcmp(expected, b4a.from(metadata.transferId, 'hex'))) {
    throw invalid('Noncanonical tree transfer ID')
  }
}
