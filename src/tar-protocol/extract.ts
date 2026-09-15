import b4a from 'b4a'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { decodeMetadataRecord, encodeMetadataRecord, type MetadataRecord } from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import { canonicalUstarHeader, TAR_BLOCK_BYTES } from './ustar.js'

export interface TarExtractionStaging {
  writeTar(chunk: Uint8Array): void | Promise<void>
  writeFile(chunk: Uint8Array): void | Promise<void>
  complete(): void | Promise<void>
  abort(error: unknown): void | Promise<void>
}

export interface TarExtractionOptions {
  signal?: AbortSignalLike | null
}

export interface TarExtractionResult {
  fileSize: number
  fileSha256: Buffer
  tarSize: number
  tarSha256: Buffer
}

const EMPTY = b4a.alloc(0)

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

/**
 * Validates a deterministic single-entry TAR stream and yields its payload.
 *
 * Because every byte outside the payload is fixed by the offered metadata, the
 * whole stream can be checked by comparison: the header must equal the one
 * canonical block, and everything after the payload must be zero. A stream that
 * survives that is, by construction, one entry whose bytes are exactly
 * `tar[512 .. 512 + fileSize)`, so no TAR parser is needed to extract it.
 */
class CanonicalTarReader {
  private readonly metadata: MetadataRecord
  private readonly header: Buffer
  private position = 0

  constructor(metadata: MetadataRecord) {
    this.metadata = metadata
    this.header = canonicalUstarHeader(metadata.name, metadata.fileSize)
  }

  /** Checks `chunk` in place and returns the slice of it that is file payload. */
  write(chunk: Uint8Array): Uint8Array {
    const base = this.position
    if (base > this.metadata.tarSize - chunk.byteLength) {
      throw invalid('Trailing TAR payload')
    }
    const contentEnd = TAR_BLOCK_BYTES + this.metadata.fileSize
    for (let index = 0; index < chunk.byteLength; index++) {
      const absolute = base + index
      if (absolute < TAR_BLOCK_BYTES) {
        if (chunk[index] !== this.header[absolute]) throw invalid('Noncanonical TAR header')
        continue
      }
      if (absolute >= contentEnd && chunk[index] !== 0) {
        throw invalid('Nonzero TAR padding or terminator')
      }
    }
    this.position = base + chunk.byteLength

    // Payload occupies absolute offsets [512, 512 + fileSize); clip the chunk
    // to that window and translate back to chunk-relative indices.
    const start = Math.max(base, TAR_BLOCK_BYTES)
    const end = Math.min(this.position, contentEnd)
    return end <= start ? EMPTY : chunk.subarray(start - base, end - base)
  }

  finish(): void {
    if (this.position !== this.metadata.tarSize) throw invalid('Truncated TAR payload')
  }
}

function assertStaging(staging: TarExtractionStaging): void {
  if (
    !staging ||
    typeof staging !== 'object' ||
    typeof staging.writeTar !== 'function' ||
    typeof staging.writeFile !== 'function' ||
    typeof staging.complete !== 'function' ||
    typeof staging.abort !== 'function'
  ) {
    throw invalid('Invalid TAR extraction staging interface')
  }
}

export async function validateAndExtractTar(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  offeredMetadata: MetadataRecord,
  staging: TarExtractionStaging,
  { signal = null }: TarExtractionOptions = {}
): Promise<TarExtractionResult> {
  assertStaging(staging)
  const metadata = decodeMetadataRecord(encodeMetadataRecord(offeredMetadata))
  const expectedFileDigest = b4a.from(metadata.fileSha256, 'hex')
  const expectedTarDigest = b4a.from(metadata.tarSha256, 'hex')
  const reader = new CanonicalTarReader(metadata)
  const fileHash = new SodiumSha256()
  const tarHash = new SodiumSha256()
  let extractedBytes = 0

  try {
    throwIfAborted(signal)
    for await (const value of source) {
      throwIfAborted(signal)
      if (!b4a.isBuffer(value)) throw invalid('Invalid TAR source bytes')
      const payload = reader.write(value)
      tarHash.update(value)
      await staging.writeTar(value)
      if (payload.byteLength > 0) {
        extractedBytes += payload.byteLength
        fileHash.update(payload)
        await staging.writeFile(payload)
      }
    }
    reader.finish()
    if (extractedBytes !== metadata.fileSize) throw invalid('Extracted file size mismatch')

    const fileSha256 = fileHash.digest()
    const tarSha256 = tarHash.digest()
    if (!digestMatches(fileSha256, expectedFileDigest)) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Extracted file digest mismatch')
    }
    if (!digestMatches(tarSha256, expectedTarDigest)) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'TAR digest mismatch')
    }
    await staging.complete()
    return {
      fileSize: extractedBytes,
      fileSha256,
      tarSize: metadata.tarSize,
      tarSha256
    }
  } catch (error) {
    await Promise.resolve(staging.abort(error)).catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw invalid('TAR extraction failed', error)
  }
}
