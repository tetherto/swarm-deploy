import b4a from 'b4a'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  decodeTreeMetadataRecord,
  encodeTreeMetadataRecord,
  type TreeMetadataRecord
} from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import {
  assertTreeEntryPath,
  compareTreePaths,
  MAX_TREE_ENTRIES,
  treeDigest,
  type TreeDigestEntry,
  type TreeEntry
} from './tree.js'
import { canonicalUstarTreeHeader, TAR_BLOCK_BYTES } from './ustar.js'

export interface TreeFileSink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface TreeExtractionTarget {
  createDirectory(relativePath: string): Promise<void>
  createFile(relativePath: string, size: number): Promise<TreeFileSink>
  complete(): Promise<void>
  abort(error: unknown): Promise<void>
}

export interface TreeExtractionOptions {
  signal?: AbortSignalLike | null
}

export interface TreeExtractionResult {
  entries: TreeEntry[]
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
  tarSize: number
  tarSha256: Buffer
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  let value = 0
  let digits = 0
  for (let index = offset; index < offset + length; index++) {
    const byte = block[index]
    if (byte === 0x20 || byte === 0) break
    if (byte < 0x30 || byte > 0x37) throw invalid('Noncanonical tree TAR header')
    value = value * 8 + (byte - 0x30)
    digits++
    if (!Number.isSafeInteger(value)) throw invalid('Noncanonical tree TAR header')
  }
  if (digits === 0) throw invalid('Noncanonical tree TAR header')
  return value
}

function parseStoredName(block: Buffer): string {
  let end = 0
  while (end < 100 && block[end] !== 0) end++
  for (let index = end; index < 100; index++) {
    if (block[index] !== 0) throw invalid('Noncanonical tree TAR header')
  }
  if (end === 0) throw invalid('Noncanonical tree TAR header')
  return b4a.toString(block.subarray(0, end), 'utf8')
}

/**
 * Validates and extracts a canonical multi-entry tree archive.
 *
 * Only the name, typeflag, and size fields are parsed. Every other field is
 * proved by rebuilding the whole 512-byte canonical header and comparing it
 * byte for byte, so mode, uid, gid, mtime, uname, gname, magic, checksum, and
 * the USTAR prefix are all pinned by one comparison.
 *
 * The archive path is only ever handed to the target as a validated relative
 * path; this reader never joins it to an absolute path and never touches the
 * filesystem itself. Any failure aborts the target exactly once.
 */
export async function validateAndExtractTreeTar(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  offeredMetadata: TreeMetadataRecord,
  target: TreeExtractionTarget,
  { signal = null }: TreeExtractionOptions = {}
): Promise<TreeExtractionResult> {
  if (
    !target ||
    typeof target !== 'object' ||
    typeof target.createDirectory !== 'function' ||
    typeof target.createFile !== 'function' ||
    typeof target.complete !== 'function' ||
    typeof target.abort !== 'function'
  ) {
    throw invalid('Invalid tree extraction target')
  }
  const metadata = decodeTreeMetadataRecord(encodeTreeMetadataRecord(offeredMetadata))
  const tarHash = new SodiumSha256()
  const digests: TreeDigestEntry[] = []
  const directories = new Set<string>()
  const folded = new Set<string>()

  let position = 0
  let pending: Buffer = b4a.alloc(0)
  let payloadBytes = 0
  let previousPath: string | null = null
  let terminatorBlocks = 0
  let sink: TreeFileSink | null = null
  let sinkHash: SodiumSha256 | null = null
  let sinkEntry: TreeEntry | null = null
  let payloadRemaining = 0
  let paddingRemaining = 0

  const closeSink = async (): Promise<void> => {
    if (!sink || !sinkHash || !sinkEntry) throw invalid('Tree extraction state is inconsistent')
    const closing = sink
    const hash = sinkHash
    const entry = sinkEntry
    sink = null
    sinkHash = null
    sinkEntry = null
    await closing.close()
    digests.push({ entry, sha256: hash.digest() })
  }

  const consumeHeader = async (block: Buffer): Promise<void> => {
    if (block.every((byte) => byte === 0)) {
      terminatorBlocks++
      if (terminatorBlocks > 2) throw invalid('Trailing tree TAR payload')
      return
    }
    if (terminatorBlocks > 0) throw invalid('Tree TAR entry after terminator')
    const storedName = parseStoredName(block)
    const typeflag = block[156]
    if (typeflag !== 48 && typeflag !== 53) throw invalid('Unsupported tree TAR entry type')
    const kind = typeflag === 53 ? 'directory' : 'file'
    if (kind === 'directory' && !storedName.endsWith('/')) {
      throw invalid('Noncanonical tree TAR header')
    }
    if (kind === 'file' && storedName.endsWith('/')) throw invalid('Noncanonical tree TAR header')
    const relativePath = kind === 'directory' ? storedName.slice(0, -1) : storedName
    assertTreeEntryPath(relativePath, kind)
    const size = parseOctal(block, 124, 12)
    if (kind === 'directory' && size !== 0) throw invalid('Invalid tree directory size')
    if (!b4a.equals(block, canonicalUstarTreeHeader(storedName, kind, size))) {
      throw invalid('Noncanonical tree TAR header')
    }
    if (digests.length >= Math.min(metadata.entryCount, MAX_TREE_ENTRIES)) {
      throw invalid('Tree TAR entry count exceeds the offer')
    }
    if (previousPath !== null && compareTreePaths(previousPath, relativePath) >= 0) {
      throw invalid('Noncanonical tree entry order')
    }
    const fold = relativePath.toLowerCase()
    if (folded.has(fold)) throw invalid('Case-folded duplicate tree entry path')
    folded.add(fold)
    const separator = relativePath.lastIndexOf('/')
    if (separator !== -1 && !directories.has(relativePath.slice(0, separator))) {
      throw invalid('Tree entry has no parent directory entry')
    }
    previousPath = relativePath
    const entry: TreeEntry = { kind, path: relativePath, size: kind === 'directory' ? 0 : size }
    if (kind === 'directory') {
      directories.add(relativePath)
      digests.push({ entry })
      await target.createDirectory(relativePath)
      return
    }
    if (payloadBytes > metadata.payloadBytes - size) throw invalid('Tree payload exceeds the offer')
    payloadBytes += size
    sinkEntry = entry
    sinkHash = new SodiumSha256()
    sink = await target.createFile(relativePath, size)
    payloadRemaining = size
    paddingRemaining = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (payloadRemaining === 0) await closeSink()
  }

  try {
    throwIfAborted(signal)
    for await (const value of source) {
      throwIfAborted(signal)
      if (!b4a.isBuffer(value)) throw invalid('Invalid TAR source bytes')
      if (position > metadata.tarSize - value.byteLength) throw invalid('Trailing tree TAR payload')
      tarHash.update(value)
      position += value.byteLength
      let offset = 0
      while (offset < value.byteLength) {
        if (payloadRemaining > 0) {
          const take = Math.min(payloadRemaining, value.byteLength - offset)
          const chunk = value.subarray(offset, offset + take)
          sinkHash!.update(chunk)
          await sink!.write(chunk)
          payloadRemaining -= take
          offset += take
          if (payloadRemaining === 0) await closeSink()
          continue
        }
        if (paddingRemaining > 0) {
          const take = Math.min(paddingRemaining, value.byteLength - offset)
          for (let index = offset; index < offset + take; index++) {
            if (value[index] !== 0) throw invalid('Nonzero tree TAR padding')
          }
          paddingRemaining -= take
          offset += take
          continue
        }
        const take = Math.min(TAR_BLOCK_BYTES - pending.byteLength, value.byteLength - offset)
        pending = b4a.concat([pending, value.subarray(offset, offset + take)])
        offset += take
        if (pending.byteLength < TAR_BLOCK_BYTES) continue
        const block = pending
        pending = b4a.alloc(0)
        await consumeHeader(block)
      }
    }
    if (
      pending.byteLength !== 0 ||
      payloadRemaining !== 0 ||
      paddingRemaining !== 0 ||
      sink !== null
    ) {
      throw invalid('Truncated tree TAR payload')
    }
    if (position !== metadata.tarSize) throw invalid('Truncated tree TAR payload')
    if (terminatorBlocks !== 2) throw invalid('Missing tree TAR terminator')
    if (digests.length !== metadata.entryCount) throw invalid('Tree entry count mismatch')
    if (payloadBytes !== metadata.payloadBytes) throw invalid('Tree payload size mismatch')
    const treeSha256 = treeDigest(digests)
    const tarSha256 = tarHash.digest()
    if (!digestMatches(treeSha256, b4a.from(metadata.treeSha256, 'hex'))) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Extracted tree digest mismatch')
    }
    if (!digestMatches(tarSha256, b4a.from(metadata.tarSha256, 'hex'))) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'TAR digest mismatch')
    }
    await target.complete()
    return {
      entries: digests.map((value) => value.entry),
      entryCount: digests.length,
      payloadBytes,
      treeSha256,
      tarSize: metadata.tarSize,
      tarSha256
    }
  } catch (error) {
    // A half-written file must release its handle before the target removes the tree.
    if (sink) await Promise.resolve((sink as TreeFileSink).close()).catch(() => {})
    await Promise.resolve(target.abort(error)).catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw invalid('Tree extraction failed', error)
  }
}
