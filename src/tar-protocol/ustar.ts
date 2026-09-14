import { ERRORS, SwarmDeployError } from '../errors.js'

export const TAR_BLOCK_BYTES = 512
export const MAX_USTAR_FILE_BYTES = 0o77777777777
const TAR_END_BYTES = 2 * TAR_BLOCK_BYTES

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
