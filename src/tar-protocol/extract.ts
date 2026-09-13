import b4a from 'b4a'
import { extract, type Header } from 'tar-stream'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { decodeMetadataRecord, encodeMetadataRecord, type MetadataRecord } from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import {
  TAR_BLOCK_BYTES,
  TAR_GID,
  TAR_GNAME,
  TAR_MODE,
  TAR_MTIME_MS,
  TAR_UID,
  TAR_UNAME
} from './manifest.js'

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

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function octal(value: number, digits: number): Buffer {
  const encoded = value.toString(8)
  if (encoded.length > digits) throw invalid('Canonical TAR field overflow')
  return b4a.from(`${'0'.repeat(digits - encoded.length)}${encoded} `)
}

function setBytes(target: Buffer, offset: number, value: Uint8Array): void {
  target.set(value, offset)
}

function canonicalHeader(metadata: MetadataRecord): Buffer {
  const header = b4a.alloc(TAR_BLOCK_BYTES)
  setBytes(header, 0, b4a.from(metadata.name))
  setBytes(header, 100, octal(TAR_MODE, 6))
  setBytes(header, 108, octal(TAR_UID, 6))
  setBytes(header, 116, octal(TAR_GID, 6))
  setBytes(header, 124, octal(metadata.fileSize, 11))
  setBytes(header, 136, octal(TAR_MTIME_MS / 1000, 11))
  header[156] = 48
  setBytes(header, 257, b4a.from([0x75, 0x73, 0x74, 0x61, 0x72, 0]))
  setBytes(header, 263, b4a.from('00'))
  if (TAR_UNAME) setBytes(header, 265, b4a.from(TAR_UNAME))
  if (TAR_GNAME) setBytes(header, 297, b4a.from(TAR_GNAME))
  setBytes(header, 329, octal(0, 6))
  setBytes(header, 337, octal(0, 6))

  let checksum = 8 * 32
  for (let index = 0; index < 148; index++) checksum += header[index]
  for (let index = 156; index < TAR_BLOCK_BYTES; index++) checksum += header[index]
  setBytes(header, 148, octal(checksum, 6))
  return header
}

class CanonicalTarValidator {
  private readonly metadata: MetadataRecord
  private readonly header: Buffer
  private position = 0

  constructor(metadata: MetadataRecord) {
    this.metadata = metadata
    this.header = canonicalHeader(metadata)
  }

  write(chunk: Uint8Array): void {
    if (this.position > this.metadata.tarSize - chunk.byteLength) {
      throw invalid('Trailing TAR payload')
    }
    for (let index = 0; index < chunk.byteLength; index++) {
      const absolute = this.position + index
      if (absolute < TAR_BLOCK_BYTES) {
        if (chunk[index] !== this.header[absolute]) throw invalid('Noncanonical TAR header')
        continue
      }
      const contentEnd = TAR_BLOCK_BYTES + this.metadata.fileSize
      if (absolute >= contentEnd && chunk[index] !== 0) {
        throw invalid('Nonzero TAR padding or terminator')
      }
    }
    this.position += chunk.byteLength
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

function assertHeader(header: Header, metadata: MetadataRecord): void {
  if (
    header.name !== metadata.name ||
    header.type !== 'file' ||
    header.size !== metadata.fileSize ||
    header.mode !== TAR_MODE ||
    header.uid !== TAR_UID ||
    header.gid !== TAR_GID ||
    header.mtime.getTime() !== TAR_MTIME_MS ||
    header.uname !== TAR_UNAME ||
    header.gname !== TAR_GNAME ||
    (header.linkname !== null && header.linkname !== '') ||
    header.devmajor !== 0 ||
    header.devminor !== 0 ||
    header.pax !== null
  ) {
    throw invalid('Unexpected TAR entry')
  }
}

function waitForDrain(stream: {
  once(event: 'drain', listener: () => void): unknown
}): Promise<void> {
  return new Promise((resolve) => stream.once('drain', resolve))
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
  const structure = new CanonicalTarValidator(metadata)
  const fileHash = new SodiumSha256()
  const tarHash = new SodiumSha256()
  const unpack = extract()
  let entries = 0
  let extractedBytes = 0
  let extractionFailure: unknown = null
  let extractionTask: Promise<void> = Promise.resolve()

  const finished = new Promise<void>((resolve, reject) => {
    unpack.once('finish', resolve)
    unpack.once('error', reject)
  })

  unpack.on('entry', (header, stream, next) => {
    entries++
    extractionTask = (async () => {
      assertHeader(header, metadata)
      for await (const value of stream) {
        throwIfAborted(signal)
        if (!b4a.isBuffer(value)) throw invalid('Invalid TAR entry bytes')
        extractedBytes += value.byteLength
        if (extractedBytes > metadata.fileSize) throw invalid('Oversized TAR entry')
        fileHash.update(value)
        await staging.writeFile(value)
      }
    })()
    extractionTask.then(
      () => next(),
      (error) => {
        extractionFailure = error
        next(error instanceof Error ? error : invalid('TAR extraction failed', error))
      }
    )
  })

  try {
    throwIfAborted(signal)
    for await (const value of source) {
      throwIfAborted(signal)
      if (!b4a.isBuffer(value)) throw invalid('Invalid TAR source bytes')
      structure.write(value)
      tarHash.update(value)
      await staging.writeTar(value)
      if (!unpack.write(value)) await waitForDrain(unpack)
    }
    structure.finish()
    unpack.end(b4a.alloc(0))
    await finished
    await extractionTask
    if (extractionFailure) throw extractionFailure
    if (entries !== 1) throw invalid('TAR must contain exactly one entry')
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
    unpack.destroy(error instanceof Error ? error : invalid('TAR extraction failed', error))
    await finished.catch(() => {})
    await Promise.resolve(staging.abort(error)).catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw invalid('TAR extraction failed', error)
  }
}
