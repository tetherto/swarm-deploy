import b4a from 'b4a'
import * as c from 'compact-encoding'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  STATUS_CODE,
  RESULT_CODE,
  PROTOCOL_VERSION,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_COUNT,
  MAX_BITMAP_BITS
} from './constants.js'
import {
  assertFixed32,
  assertSafeUint,
  assertPositiveSafeUint,
  assertBoundedChunkSize
} from './validation.js'
import type {
  BitmapPage,
  Chunk,
  ChunkAck,
  Codec,
  Offer,
  ProtocolState,
  Result,
  Status,
  TransferMessage
} from './types.js'

function struct<T extends object>(fields: { [K in keyof T]: Codec<T[K]> }): Codec<T> {
  const keys = Object.keys(fields)
  return {
    preencode(state: ProtocolState, obj: T): void {
      for (const key of keys) {
        const field = fields[key as keyof T]
        field.preencode(state, obj[key as keyof T])
      }
    },
    encode(state: ProtocolState, obj: T): void {
      for (const key of keys) {
        const field = fields[key as keyof T]
        field.encode(state, obj[key as keyof T])
      }
    },
    decode(state: ProtocolState): T {
      const result = new Map<keyof T, T[keyof T]>()
      for (const key of keys) {
        const typedKey = key as keyof T
        result.set(typedKey, fields[typedKey].decode(state))
      }
      return Object.fromEntries(result) as T
    }
  }
}

function validatedCodec<T>(raw: Codec<T>, validate: (value: T) => void): Codec<T> {
  return {
    preencode(state: ProtocolState, value: T): void {
      validate(value)
      raw.preencode(state, value)
    },
    encode(state: ProtocolState, value: T): void {
      validate(value)
      raw.encode(state, value)
    },
    decode(state: ProtocolState): T {
      const value = raw.decode(state)
      validate(value)
      return value
    }
  }
}

const optionalString: Codec<string | undefined, string> = {
  preencode(state: ProtocolState, value: string | undefined): void {
    c.string.preencode(state, value === undefined ? '' : value)
  },
  encode(state: ProtocolState, value: string | undefined): void {
    c.string.encode(state, value === undefined ? '' : value)
  },
  decode(state: ProtocolState): string {
    return c.string.decode(state)
  }
}

function assertStatusCode(code: unknown): asserts code is number {
  assertSafeUint(code, 'code')
  if (
    code !== STATUS_CODE.ACCEPT &&
    code !== STATUS_CODE.ALREADY_COMMITTED &&
    code !== STATUS_CODE.FILE_EXISTS &&
    code !== STATUS_CODE.FILE_BUSY &&
    code !== STATUS_CODE.REJECTED
  ) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid status code')
  }
}

function assertOptionalReason(reason: unknown): asserts reason is string | undefined {
  if (reason !== undefined && typeof reason !== 'string') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid reason')
  }
}

function expectedBitmapBytes(count: number): number {
  return Math.ceil(count / 8)
}

function assertBitmapPadding(count: number, bits: Uint8Array): void {
  const remainder = count % 8
  if (remainder === 0) return
  const lastByte = bits[bits.byteLength - 1]
  const mask = (1 << remainder) - 1
  if ((lastByte & ~mask) !== 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid bitmap page padding')
  }
}

function validateBitmapPage(value: BitmapPage): void {
  assertFixed32(value.transferId, 'transferId')
  assertSafeUint(value.start, 'start')
  assertPositiveSafeUint(value.count, 'count')
  if (value.count > MAX_BITMAP_BITS) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid bitmap page count')
  }
  if (!b4a.isBuffer(value.bits) || value.bits.byteLength !== expectedBitmapBytes(value.count)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid bitmap page bits')
  }
  assertBitmapPadding(value.count, value.bits)
}

function bitIsSet(bits: Uint8Array, offset: number): boolean {
  const byteIndex = Math.floor(offset / 8)
  const bitIndex = offset % 8
  return (bits[byteIndex] & (1 << bitIndex)) !== 0
}

export function mergeBitmapPages(pages: Iterable<BitmapPage>, chunkCount: number): Set<number> {
  assertSafeUint(chunkCount, 'chunkCount')
  const verified = new Set<number>()
  const sorted = [...pages].sort((a, b) => a.start - b.start)
  let rangeEnd = 0
  let expectedTransferId = null

  for (const page of sorted) {
    validateBitmapPage(page)
    if (expectedTransferId === null) {
      expectedTransferId = page.transferId
    } else if (!b4a.equals(expectedTransferId, page.transferId)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Mixed bitmap transfer IDs')
    }
    if (page.count > chunkCount - page.start) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Bitmap page out of range')
    }
    if (page.start < rangeEnd) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Overlapping bitmap pages')
    }
    rangeEnd = page.start + page.count

    for (let i = 0; i < page.count; i++) {
      if (!bitIsSet(page.bits, i)) continue
      verified.add(page.start + i)
    }
  }

  return verified
}

function protocolInvalid(cause: unknown): SwarmDeployError {
  if (cause instanceof SwarmDeployError) return cause
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid protocol message', cause)
}

export function encodeBounded<T>(codec: Codec<T>, value: T, max = MAX_CONTROL_BYTES): Uint8Array {
  let buf
  try {
    buf = c.encode(codec, value)
  } catch (err) {
    throw protocolInvalid(err)
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }
  return buf
}

export function decodeBounded<T>(codec: Codec<T>, buf: Uint8Array, max = MAX_CONTROL_BYTES): T {
  if (!b4a.isBuffer(buf)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid message buffer')
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }

  const state = c.state(0, buf.byteLength, b4a.from(buf))
  let value
  try {
    value = codec.decode(state)
  } catch (err) {
    throw protocolInvalid(err)
  }
  if (state.start !== state.end) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Trailing message bytes')
  }
  return value
}

export const offer = validatedCodec<Offer>(
  struct<Offer>({
    version: c.uint,
    transferId: c.fixed32,
    name: c.string,
    size: c.uint,
    digest: c.fixed32,
    chunkSize: c.uint,
    chunkCount: c.uint
  }),
  (value: Offer) => {
    assertSafeUint(value.version, 'version')
    if (value.version !== PROTOCOL_VERSION) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid protocol version')
    }
    assertFixed32(value.transferId, 'transferId')
    if (typeof value.name !== 'string') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid name')
    }
    assertSafeUint(value.size, 'size')
    assertFixed32(value.digest, 'digest')
    assertBoundedChunkSize(value.chunkSize, 'chunkSize')
    assertSafeUint(value.chunkCount, 'chunkCount')
    if (
      value.chunkCount !== Math.ceil(value.size / value.chunkSize) ||
      value.chunkCount > MAX_CHUNK_COUNT
    ) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid offer chunk count')
    }
  }
)

export const status = validatedCodec<Status>(
  struct({
    transferId: c.fixed32,
    code: c.uint,
    reason: optionalString
  }),
  (value: Status) => {
    assertFixed32(value.transferId, 'transferId')
    assertStatusCode(value.code)
    assertOptionalReason(value.reason)
  }
)

export const bitmapPage = validatedCodec<BitmapPage>(
  struct({
    transferId: c.fixed32,
    start: c.uint,
    count: c.uint,
    bits: c.buffer
  }),
  validateBitmapPage
)

export const ready = validatedCodec<TransferMessage>(
  struct({
    transferId: c.fixed32
  }),
  (value: TransferMessage) => {
    assertFixed32(value.transferId, 'transferId')
  }
)

export const finish = validatedCodec<TransferMessage>(
  struct({
    transferId: c.fixed32
  }),
  (value: TransferMessage) => {
    assertFixed32(value.transferId, 'transferId')
  }
)

export const chunk = validatedCodec<Chunk>(
  struct({
    transferId: c.fixed32,
    index: c.uint,
    digest: c.fixed32,
    data: c.buffer
  }),
  (value: Chunk) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.index, 'index')
    assertFixed32(value.digest, 'digest')
    if (!b4a.isBuffer(value.data) || value.data.byteLength > MAX_CHUNK_BYTES) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid chunk data')
    }
  }
)

export const chunkAck = validatedCodec<ChunkAck>(
  struct({
    transferId: c.fixed32,
    index: c.uint
  }),
  (value: ChunkAck) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.index, 'index')
  }
)

export const result = validatedCodec<Result>(
  struct({
    transferId: c.fixed32,
    code: c.uint,
    reason: optionalString
  }),
  (value: Result) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.code, 'code')
    if (value.code !== RESULT_CODE.COMMITTED && value.code !== RESULT_CODE.REJECTED) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid result code')
    }
    assertOptionalReason(value.reason)
  }
)
