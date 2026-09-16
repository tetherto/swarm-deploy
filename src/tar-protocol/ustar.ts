import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from '../errors.js'

export const TAR_BLOCK_BYTES = 512
export const MAX_USTAR_FILE_BYTES = 0o77777777777
const TAR_END_BYTES = 2 * TAR_BLOCK_BYTES

/**
 * Every USTAR metadata field is pinned to a constant so that the same content
 * always frames to the same bytes. The transfer ID commits to these values, so
 * changing one changes every transfer ID.
 */
export const TAR_MODE = 0o644
export const TAR_UID = 0
export const TAR_GID = 0
export const TAR_MTIME_MS = 0
export const TAR_UNAME = ''
export const TAR_GNAME = ''

function invalidSize(): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid deterministic TAR file size')
}

export function assertUstarFileSize(size: unknown): asserts size is number {
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_USTAR_FILE_BYTES
  ) {
    throw invalidSize()
  }
}

export function deterministicTarSize(fileSize: number): number {
  assertUstarFileSize(fileSize)
  const padding = (TAR_BLOCK_BYTES - (fileSize % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
  const total = TAR_BLOCK_BYTES + fileSize + padding + TAR_END_BYTES
  if (!Number.isSafeInteger(total)) throw invalidSize()
  return total
}

function octal(value: number, digits: number): Buffer {
  const encoded = value.toString(8)
  if (encoded.length > digits) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Canonical TAR field overflow')
  }
  return b4a.from(`${'0'.repeat(digits - encoded.length)}${encoded} `)
}

/**
 * Builds the single canonical USTAR header block for `name`/`fileSize`.
 *
 * Both the send path and receive validator use this exact block. A test also
 * pins it byte-for-byte against tar-stream's portable USTAR representation.
 */
export function canonicalUstarHeader(name: string, fileSize: number): Buffer {
  assertUstarFileSize(fileSize)
  const header = b4a.alloc(TAR_BLOCK_BYTES)
  const set = (offset: number, value: Uint8Array): void => {
    header.set(value, offset)
  }
  set(0, b4a.from(name))
  set(100, octal(TAR_MODE, 6))
  set(108, octal(TAR_UID, 6))
  set(116, octal(TAR_GID, 6))
  set(124, octal(fileSize, 11))
  set(136, octal(TAR_MTIME_MS / 1000, 11))
  header[156] = 48
  set(257, b4a.from([0x75, 0x73, 0x74, 0x61, 0x72, 0]))
  set(263, b4a.from('00'))
  if (TAR_UNAME) set(265, b4a.from(TAR_UNAME))
  if (TAR_GNAME) set(297, b4a.from(TAR_GNAME))
  set(329, octal(0, 6))
  set(337, octal(0, 6))

  let checksum = 8 * 32
  for (let index = 0; index < 148; index++) checksum += header[index]
  for (let index = 156; index < TAR_BLOCK_BYTES; index++) checksum += header[index]
  set(148, octal(checksum, 6))
  return header
}
