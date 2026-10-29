import b4a from 'b4a'
import { ERRORS, SwarmDeployError, type ErrorCode } from '../errors.js'
import {
  copyHookResult,
  copyUploadHookResult,
  type HookResult,
  type UploadHookResult
} from '../hook-result.js'
import { MAX_TREE_ENTRIES } from './tree-path.js'
import { deterministicTarSize, MAX_USTAR_FILE_BYTES, TAR_BLOCK_BYTES } from './ustar.js'

export const CONTROL_VERSION = 1
export const MAX_CONTROL_RECORD_BYTES = 4 * 1024
const HEX_32 = /^[0-9a-f]{64}$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const SAFE_SOURCE_PARENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/
const HISTORY_PREFIX = 'history-'
const STABLE_CODES = new Set<string>(Object.values(ERRORS))

export interface MetadataRecord {
  v: typeof CONTROL_VERSION
  name: string
  sourceParent?: string
  fileSize: number
  fileSha256: string
  tarSize: number
  tarSha256: string
  transferId: string
  reset: boolean
  /**
   * Opt-in: asks for the data the server's response-declared hooks return. Sent
   * only when `true`, so an older strict server rejects an opted-in offer. It is
   * not part of the transfer identity or the session.
   */
  hookResult?: true
}

/**
 * A recursive directory offer. The key set is disjoint from the file record's,
 * so an older server's `exactKeys()` check rejects it before touching storage.
 */
export interface TreeMetadataRecord {
  v: typeof CONTROL_VERSION
  kind: 'directory'
  name: string
  sourceParent?: string
  entryCount: number
  payloadBytes: number
  treeSha256: string
  tarSize: number
  tarSha256: string
  transferId: string
  reset: boolean
  /** As for `MetadataRecord.hookResult`. */
  hookResult?: true
}

export type AnyMetadataRecord = MetadataRecord | TreeMetadataRecord

export function isTreeMetadata(value: AnyMetadataRecord): value is TreeMetadataRecord {
  return (value as TreeMetadataRecord).kind === 'directory'
}

/**
 * What the server does with a link it just made when `afterLink` fails:
 * `rollback` restores the previous link and ownership metadata (or removes a
 * link that did not exist), `keep` leaves the new link in place.
 */
export type LinkHookFailurePolicy = 'rollback' | 'keep'

export interface LinkRequestRecord {
  v: typeof CONTROL_VERSION
  kind: 'link'
  target: string
  name: string
  /**
   * The failure policy. A current client always sends it, so an older strict
   * server rejects the request instead of silently keeping a link the caller
   * expects to be rolled back. A request without it, from an older client, is
   * handled as `rollback`.
   */
  hookFailure?: LinkHookFailurePolicy
  /**
   * Opt-in: asks the server to return what its `afterLink` hook returned. The
   * field is sent only when `true`, so an older strict server rejects an
   * opted-in request.
   */
  hookResult?: true
}

/**
 * `hookResult` appears only on an answer to a request that asked for it, and
 * only when a response-declared hook returned an object: `afterLink`'s on
 * success, `onFailure`'s on a failure, whose `code` is always the primary one.
 */
export type LinkResultRecord =
  | { v: typeof CONTROL_VERSION; status: 'LINKED'; hookResult?: HookResult }
  | { v: typeof CONTROL_VERSION; status: 'UNCHANGED'; hookResult?: HookResult }
  | { v: typeof CONTROL_VERSION; status: 'FAILED'; code: ErrorCode; hookResult?: HookResult }

/**
 * The first direct control frame may be an upload offer or a link request.
 * Upload-specific readers remain strict and reject link records.
 */
export type FirstControlRecord = AnyMetadataRecord | LinkRequestRecord

export type AdmissionRecord =
  | { v: typeof CONTROL_VERSION; status: 'ACCEPT'; offset: 0 }
  | {
      v: typeof CONTROL_VERSION
      status: 'RESUME'
      offset: number
      prefixSha256: string
    }
  | { v: typeof CONTROL_VERSION; status: 'VERIFIED' }
  | { v: typeof CONTROL_VERSION; status: 'ALREADY_COMMITTED'; hookResult?: UploadHookResult }
  | {
      v: typeof CONTROL_VERSION
      status: 'REJECTED'
      code: ErrorCode
      hookResult?: UploadHookResult
    }

/** `hookResult` as for `LinkResultRecord`, in the upload's combined shape. */
export type FinalRecord =
  | { v: typeof CONTROL_VERSION; status: 'COMMITTED'; hookResult?: UploadHookResult }
  | { v: typeof CONTROL_VERSION; status: 'FAILED'; code: ErrorCode; hookResult?: UploadHookResult }

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

export function assertSourceParent(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !SAFE_SOURCE_PARENT.test(value) ||
    b4a.from(value).byteLength > 100
  ) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid source parent')
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

function hasKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/** An offer's receipt request: absent, or exactly `true` (`false` would be a second spelling of absent). */
function assertReceiptRequest(value: Record<string, unknown>): void {
  if (hasKey(value, 'hookResult') && value.hookResult !== true) {
    throw invalid('Invalid hook result request')
  }
}

/** Checks the upload data an answer carries, when it carries any. */
function assertUploadReceipt(value: Record<string, unknown>): void {
  if (!hasKey(value, 'hookResult')) return
  try {
    copyUploadHookResult(value.hookResult)
  } catch (error) {
    throw invalid('Invalid hook result', error)
  }
}

/** Checks the link data an answer carries, when it carries any. */
function assertLinkReceipt(value: Record<string, unknown>): void {
  if (!hasKey(value, 'hookResult')) return
  try {
    // Decoded input is a fresh parse, so the checked original is what is returned.
    copyHookResult(value.hookResult)
  } catch (error) {
    throw invalid('Invalid hook result', error)
  }
}

function validateMetadata(value: unknown): MetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  const expected = [
    'v',
    'name',
    'fileSize',
    'fileSha256',
    'tarSize',
    'tarSha256',
    'transferId',
    'reset'
  ]
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) {
    expected.push('sourceParent')
  }
  if (hasKey(value, 'hookResult')) expected.push('hookResult')
  exactKeys(value, expected)
  assertReceiptRequest(value)
  assertVersion(value.v)
  assertName(value.name)
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) {
    assertSourceParent(value.sourceParent)
  }
  assertSafeUint(value.fileSize, 'file size')
  assertHex32(value.fileSha256, 'file digest')
  assertSafeUint(value.tarSize, 'TAR size')
  if (value.tarSize !== deterministicTarSize(value.fileSize)) throw invalid('Noncanonical TAR size')
  assertHex32(value.tarSha256, 'TAR digest')
  assertHex32(value.transferId, 'transfer ID')
  if (typeof value.reset !== 'boolean') throw invalid('Invalid reset flag')
  return value as unknown as MetadataRecord
}

const TAR_END_BLOCKS = 2 * TAR_BLOCK_BYTES

/**
 * The exact set of TAR sizes a canonical generator can produce for these counts.
 *
 * Every entry owns one header block and the archive ends with two zero blocks. Only files carry
 * payload, and each non-empty file pads to a block boundary with at most 511 bytes. At least one
 * file exists when there is any payload, so the unpadded total is `minimum`, and at most
 * `min(entryCount, payloadBytes)` files can each hold a padded tail. Real archives are whole blocks,
 * so the window is the whole-block sizes from `minimum` rounded up to `maximum` rounded down.
 */
function assertTreeTarSize(entryCount: number, payloadBytes: number, tarSize: number): void {
  if (payloadBytes > entryCount * MAX_USTAR_FILE_BYTES) throw invalid('Invalid tree payload size')
  if (payloadBytes > 0 && entryCount === 0) throw invalid('Invalid tree payload size')
  const base = TAR_END_BLOCKS + TAR_BLOCK_BYTES * entryCount
  const minimum = base + payloadBytes
  const maximum = minimum + (TAR_BLOCK_BYTES - 1) * Math.min(entryCount, payloadBytes)
  const lowest = Math.ceil(minimum / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
  const highest = Math.floor(maximum / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
  if (tarSize % TAR_BLOCK_BYTES !== 0 || tarSize < lowest || tarSize > highest) {
    throw invalid('Noncanonical TAR size')
  }
}

function validateTreeMetadata(value: unknown): TreeMetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  const expected = [
    'v',
    'kind',
    'name',
    'entryCount',
    'payloadBytes',
    'treeSha256',
    'tarSize',
    'tarSha256',
    'transferId',
    'reset'
  ]
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) expected.push('sourceParent')
  if (hasKey(value, 'hookResult')) expected.push('hookResult')
  exactKeys(value, expected)
  assertReceiptRequest(value)
  assertVersion(value.v)
  if (value.kind !== 'directory') throw invalid('Invalid artifact kind')
  assertName(value.name)
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) {
    assertSourceParent(value.sourceParent)
  }
  assertSafeUint(value.entryCount, 'tree entry count')
  if (value.entryCount > MAX_TREE_ENTRIES) throw invalid('Invalid tree entry count')
  assertSafeUint(value.payloadBytes, 'tree payload size')
  assertHex32(value.treeSha256, 'tree digest')
  assertSafeUint(value.tarSize, 'TAR size')
  assertHex32(value.tarSha256, 'TAR digest')
  assertHex32(value.transferId, 'transfer ID')
  if (typeof value.reset !== 'boolean') throw invalid('Invalid reset flag')
  assertTreeTarSize(value.entryCount, value.payloadBytes, value.tarSize)
  return value as unknown as TreeMetadataRecord
}

function validateAnyMetadata(value: unknown): AnyMetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  return Object.prototype.hasOwnProperty.call(value, 'kind')
    ? validateTreeMetadata(value)
    : validateMetadata(value)
}

const LINK_REQUEST_KEYS = ['v', 'kind', 'target', 'name']

function validateLinkRequest(value: unknown): LinkRequestRecord {
  if (!isRecord(value)) throw invalid('Link request record must be an object')
  const hasPolicy = Object.prototype.hasOwnProperty.call(value, 'hookFailure')
  const asksForResult = Object.prototype.hasOwnProperty.call(value, 'hookResult')
  exactKeys(value, [
    ...LINK_REQUEST_KEYS,
    ...(hasPolicy ? ['hookFailure'] : []),
    ...(asksForResult ? ['hookResult'] : [])
  ])
  assertVersion(value.v)
  if (value.kind !== 'link') throw invalid('Invalid control request kind')
  assertName(value.target)
  assertName(value.name)
  if (hasPolicy && value.hookFailure !== 'rollback' && value.hookFailure !== 'keep') {
    throw invalid('Invalid hook failure policy')
  }
  // Only `true` opts in; `false` would be a second spelling of the default.
  if (asksForResult && value.hookResult !== true) throw invalid('Invalid hook result request')
  return value as unknown as LinkRequestRecord
}

function validateFirstControl(value: unknown): FirstControlRecord {
  if (!isRecord(value)) throw invalid('Control record must be an object')
  return value.kind === 'link' ? validateLinkRequest(value) : validateAnyMetadata(value)
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
  } else if (value.status === 'VERIFIED') {
    exactKeys(value, ['v', 'status'])
  } else if (value.status === 'ALREADY_COMMITTED') {
    exactKeys(value, hasKey(value, 'hookResult') ? ['v', 'status', 'hookResult'] : ['v', 'status'])
    assertUploadReceipt(value)
  } else if (value.status === 'REJECTED') {
    exactKeys(
      value,
      hasKey(value, 'hookResult') ? ['v', 'status', 'code', 'hookResult'] : ['v', 'status', 'code']
    )
    assertStableCode(value.code)
    assertUploadReceipt(value)
  } else {
    throw invalid('Invalid admission status')
  }
  return value as unknown as AdmissionRecord
}

function validateFinal(value: unknown): FinalRecord {
  if (!isRecord(value)) throw invalid('Final record must be an object')
  assertVersion(value.v)
  if (value.status === 'COMMITTED') {
    exactKeys(value, hasKey(value, 'hookResult') ? ['v', 'status', 'hookResult'] : ['v', 'status'])
    assertUploadReceipt(value)
  } else if (value.status === 'FAILED') {
    exactKeys(
      value,
      hasKey(value, 'hookResult') ? ['v', 'status', 'code', 'hookResult'] : ['v', 'status', 'code']
    )
    assertStableCode(value.code)
    assertUploadReceipt(value)
  } else {
    throw invalid('Invalid final status')
  }
  return value as unknown as FinalRecord
}

function validateLinkResult(value: unknown): LinkResultRecord {
  if (!isRecord(value)) throw invalid('Link result record must be an object')
  assertVersion(value.v)
  if (value.status === 'LINKED' || value.status === 'UNCHANGED') {
    exactKeys(value, hasKey(value, 'hookResult') ? ['v', 'status', 'hookResult'] : ['v', 'status'])
    assertLinkReceipt(value)
  } else if (value.status === 'FAILED') {
    exactKeys(
      value,
      hasKey(value, 'hookResult') ? ['v', 'status', 'code', 'hookResult'] : ['v', 'status', 'code']
    )
    assertStableCode(value.code)
    assertLinkReceipt(value)
  } else {
    throw invalid('Invalid link result status')
  }
  return value as unknown as LinkResultRecord
}

export function encodeMetadataRecord(value: MetadataRecord): Buffer {
  return encodeRecord(value, validateMetadata)
}

export function decodeMetadataRecord(bytes: Uint8Array): MetadataRecord {
  return validateMetadata(parseRecord(bytes))
}

export function encodeTreeMetadataRecord(value: TreeMetadataRecord): Buffer {
  return encodeRecord(value, validateTreeMetadata)
}

export function decodeTreeMetadataRecord(bytes: Uint8Array): TreeMetadataRecord {
  return validateTreeMetadata(parseRecord(bytes))
}

export function encodeAnyMetadataRecord(value: AnyMetadataRecord): Buffer {
  return encodeRecord(value, validateAnyMetadata)
}

export function decodeAnyMetadataRecord(bytes: Uint8Array): AnyMetadataRecord {
  return validateAnyMetadata(parseRecord(bytes))
}

export function encodeLinkRequestRecord(value: LinkRequestRecord): Buffer {
  return encodeRecord(value, validateLinkRequest)
}

export function decodeLinkRequestRecord(bytes: Uint8Array): LinkRequestRecord {
  return validateLinkRequest(parseRecord(bytes))
}

export function decodeFirstControlRecord(bytes: Uint8Array): FirstControlRecord {
  return validateFirstControl(parseRecord(bytes))
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

export function encodeLinkResultRecord(value: LinkResultRecord): Buffer {
  return encodeRecord(value, validateLinkResult)
}

export function decodeLinkResultRecord(bytes: Uint8Array): LinkResultRecord {
  return validateLinkResult(parseRecord(bytes))
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
