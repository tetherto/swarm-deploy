import b4a from 'b4a'
import { ERRORS, SwarmDeployError, type ErrorCode } from '../errors.js'
import { deterministicTarSize } from './ustar.js'

export const CONTROL_VERSION = 1
export const MAX_CONTROL_RECORD_BYTES = 4 * 1024
const HEX_32 = /^[0-9a-f]{64}$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const HISTORY_PREFIX = 'history-'
const STABLE_CODES = new Set<string>(Object.values(ERRORS))

export interface MetadataRecord {
  v: typeof CONTROL_VERSION
  name: string
  fileSize: number
  fileSha256: string
  tarSize: number
  tarSha256: string
  transferId: string
  reset: boolean
}

export type AdmissionRecord =
  | { v: typeof CONTROL_VERSION; status: 'ACCEPT'; offset: 0 }
  | {
      v: typeof CONTROL_VERSION
      status: 'RESUME'
      offset: number
      prefixSha256: string
    }
  | { v: typeof CONTROL_VERSION; status: 'VERIFIED' }
  | { v: typeof CONTROL_VERSION; status: 'ALREADY_COMMITTED' }
  | { v: typeof CONTROL_VERSION; status: 'REJECTED'; code: ErrorCode }

export type FinalRecord =
  | { v: typeof CONTROL_VERSION; status: 'COMMITTED' }
  | { v: typeof CONTROL_VERSION; status: 'FAILED'; code: ErrorCode }

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid('Unexpected control record fields')
  }
}

function assertVersion(value: unknown): asserts value is typeof CONTROL_VERSION {
  if (value !== CONTROL_VERSION) throw invalid('Unsupported control record version')
}

function assertSafeUint(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`Invalid ${name}`)
  }
}

function assertHex32(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw invalid(`Invalid ${name}`)
}

function assertName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !SAFE_NAME.test(value) ||
    value.startsWith(HISTORY_PREFIX) ||
    b4a.from(value).byteLength > 100
  ) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid TAR filename')
  }
}

function assertStableCode(value: unknown): asserts value is ErrorCode {
  if (typeof value !== 'string' || !STABLE_CODES.has(value)) throw invalid('Invalid error code')
}

function parseRecord(bytes: Uint8Array): Record<string, unknown> {
  if (!b4a.isBuffer(bytes) || bytes.byteLength === 0) throw invalid('Invalid control record')
  if (bytes.byteLength > MAX_CONTROL_RECORD_BYTES) throw invalid('Control record too large')
  let value: unknown
  try {
    value = JSON.parse(b4a.toString(bytes, 'utf8'))
  } catch (error) {
    throw invalid('Malformed control record', error)
  }
  if (!isRecord(value)) throw invalid('Control record must be an object')
  return value
}

function encodeRecord<T>(value: T, validate: (value: unknown) => T): Buffer {
  const checked = validate(value)
  const encoded = b4a.from(JSON.stringify(checked))
  if (encoded.byteLength > MAX_CONTROL_RECORD_BYTES) throw invalid('Control record too large')
  return encoded
}

function validateMetadata(value: unknown): MetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  exactKeys(value, [
    'v',
    'name',
    'fileSize',
    'fileSha256',
    'tarSize',
    'tarSha256',
    'transferId',
    'reset'
  ])
  assertVersion(value.v)
  assertName(value.name)
  assertSafeUint(value.fileSize, 'file size')
  assertHex32(value.fileSha256, 'file digest')
  assertSafeUint(value.tarSize, 'TAR size')
  if (value.tarSize !== deterministicTarSize(value.fileSize)) throw invalid('Noncanonical TAR size')
  assertHex32(value.tarSha256, 'TAR digest')
  assertHex32(value.transferId, 'transfer ID')
  if (typeof value.reset !== 'boolean') throw invalid('Invalid reset flag')
  return value as unknown as MetadataRecord
}

function validateAdmission(value: unknown): AdmissionRecord {
  if (!isRecord(value)) throw invalid('Admission record must be an object')
  assertVersion(value.v)
  if (value.status === 'ACCEPT') {
    exactKeys(value, ['v', 'status', 'offset'])
    if (value.offset !== 0) throw invalid('Invalid ACCEPT offset')
  } else if (value.status === 'RESUME') {
    exactKeys(value, ['v', 'status', 'offset', 'prefixSha256'])
    assertSafeUint(value.offset, 'resume offset')
    if (value.offset === 0) throw invalid('Invalid resume offset')
    assertHex32(value.prefixSha256, 'prefix digest')
  } else if (value.status === 'VERIFIED' || value.status === 'ALREADY_COMMITTED') {
    exactKeys(value, ['v', 'status'])
  } else if (value.status === 'REJECTED') {
    exactKeys(value, ['v', 'status', 'code'])
    assertStableCode(value.code)
  } else {
    throw invalid('Invalid admission status')
  }
  return value as unknown as AdmissionRecord
}

function validateFinal(value: unknown): FinalRecord {
  if (!isRecord(value)) throw invalid('Final record must be an object')
  assertVersion(value.v)
  if (value.status === 'COMMITTED') {
    exactKeys(value, ['v', 'status'])
  } else if (value.status === 'FAILED') {
    exactKeys(value, ['v', 'status', 'code'])
    assertStableCode(value.code)
  } else {
    throw invalid('Invalid final status')
  }
  return value as unknown as FinalRecord
}

export function encodeMetadataRecord(value: MetadataRecord): Buffer {
  return encodeRecord(value, validateMetadata)
}

export function decodeMetadataRecord(bytes: Uint8Array): MetadataRecord {
  return validateMetadata(parseRecord(bytes))
}

export function encodeAdmissionRecord(value: AdmissionRecord): Buffer {
  return encodeRecord(value, validateAdmission)
}

export function decodeAdmissionRecord(bytes: Uint8Array): AdmissionRecord {
  return validateAdmission(parseRecord(bytes))
}

export function encodeFinalRecord(value: FinalRecord): Buffer {
  return encodeRecord(value, validateFinal)
}

export function decodeFinalRecord(bytes: Uint8Array): FinalRecord {
  return validateFinal(parseRecord(bytes))
}

export function encodeControlFrame(record: Uint8Array): Buffer {
  if (!b4a.isBuffer(record) || record.byteLength === 0) throw invalid('Invalid control record')
  if (record.byteLength > MAX_CONTROL_RECORD_BYTES) throw invalid('Control record too large')
  const frame = b4a.alloc(4 + record.byteLength)
  frame[0] = (record.byteLength >>> 24) & 0xff
  frame[1] = (record.byteLength >>> 16) & 0xff
  frame[2] = (record.byteLength >>> 8) & 0xff
  frame[3] = record.byteLength & 0xff
  frame.set(record, 4)
  return frame
}
