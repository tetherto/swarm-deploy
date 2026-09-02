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
  MAX_BITMAP_BITS,
  type ResultCode,
  type StatusCode
} from './constants.js'
import {
  assertFixed32,
  assertSafeUint,
  assertPositiveSafeUint,
  assertBoundedChunkSize
} from './validation.js'
import type {
  Binary,
  BinaryInput,
  BitmapPage,
  BitmapPageInput,
  Chunk,
  ChunkAck,
  ChunkAckInput,
  ChunkInput,
  Codec,
  EncodingState,
  Finish,
  FinishInput,
  Fixed32,
  Offer,
  OfferInput,
  Ready,
  ReadyInput,
  Result,
  ResultInput,
  Status,
  StatusInput,
  TransferMessage
} from './types.js'

const EMPTY = b4a.alloc(0)

/**
 * Mirrors `compact-encoding`'s two-pass encoder while preserving the concrete
 * Buffer type its allocation produces.
 */
export function encodeToBinary<Input, Output>(codec: Codec<Input, Output>, value: Input): Binary {
  const state: EncodingState = { start: 0, end: 0, buffer: EMPTY }
  codec.preencode(state, value)
  state.buffer = b4a.allocUnsafe(state.end)
  codec.encode(state, value)
  return state.buffer
}

/** A 32-byte field decoded as a view over the source buffer. */
export const fixed32: Codec<Fixed32, Binary> = {
  preencode(state: EncodingState, value: Fixed32): void {
    c.fixed32.preencode(state, value)
  },
  encode(state: EncodingState, value: Fixed32): void {
    c.fixed32.encode(state, value)
  },
  decode(state: EncodingState): Binary {
    if (state.end - state.start < 32) throw new Error('Out of bounds')
    return state.buffer.subarray(state.start, (state.start += 32))
  }
}

/** A length-prefixed field decoded as a view over the source buffer. */
const binary: Codec<BinaryInput, Binary> = {
  preencode(state: EncodingState, value: BinaryInput): void {
    c.buffer.preencode(state, value)
  },
  encode(state: EncodingState, value: BinaryInput): void {
    c.buffer.encode(state, value)
  },
  decode(state: EncodingState): Binary {
    const length = c.uint.decode(state)
    if (state.end - state.start < length) throw new Error('Out of bounds')
    return state.buffer.subarray(state.start, (state.start += length))
  }
}

function validatedCodec<Input, Output extends Input>(
  raw: Codec<Input, Output>,
  validate: (value: Input) => void
): Codec<Input, Output> {
  return {
    preencode(state: EncodingState, value: Input): void {
      validate(value)
      raw.preencode(state, value)
    },
    encode(state: EncodingState, value: Input): void {
      validate(value)
      raw.encode(state, value)
    },
    decode(state: EncodingState): Output {
      const value = raw.decode(state)
      validate(value)
      return value
    }
  }
}

const optionalString: Codec<string | undefined, string> = {
  preencode(state: EncodingState, value: string | undefined): void {
    c.string.preencode(state, value === undefined ? '' : value)
  },
  encode(state: EncodingState, value: string | undefined): void {
    c.string.encode(state, value === undefined ? '' : value)
  },
  decode(state: EncodingState): string {
    return c.string.decode(state)
  }
}

function assertStatusCode(code: unknown): asserts code is StatusCode {
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

function assertResultCode(code: unknown): asserts code is ResultCode {
  assertSafeUint(code, 'code')
  if (code !== RESULT_CODE.COMMITTED && code !== RESULT_CODE.REJECTED) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid result code')
  }
}

const statusCodeField: Codec<StatusCode> = {
  preencode(state: EncodingState, value: StatusCode): void {
    c.uint.preencode(state, value)
  },
  encode(state: EncodingState, value: StatusCode): void {
    c.uint.encode(state, value)
  },
  decode(state: EncodingState): StatusCode {
    const code = c.uint.decode(state)
    assertStatusCode(code)
    return code
  }
}

const resultCodeField: Codec<ResultCode> = {
  preencode(state: EncodingState, value: ResultCode): void {
    c.uint.preencode(state, value)
  },
  encode(state: EncodingState, value: ResultCode): void {
    c.uint.encode(state, value)
  },
  decode(state: EncodingState): ResultCode {
    const code = c.uint.decode(state)
    assertResultCode(code)
    return code
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

function validateBitmapPage(value: BitmapPageInput): void {
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

export function mergeBitmapPages(
  pages: Iterable<BitmapPageInput>,
  chunkCount: number
): Set<number> {
  assertSafeUint(chunkCount, 'chunkCount')
  const verified = new Set<number>()
  const sorted = [...pages].sort((a, b) => a.start - b.start)
  let rangeEnd = 0
  let expectedTransferId: BinaryInput | null = null

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

export function encodeBounded<Input, Output>(
  codec: Codec<Input, Output>,
  value: Input,
  max = MAX_CONTROL_BYTES
): Binary {
  let buf
  try {
    buf = encodeToBinary(codec, value)
  } catch (err) {
    throw protocolInvalid(err)
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }
  return buf
}

export function decodeBounded<Input, Output>(
  codec: Codec<Input, Output>,
  buf: BinaryInput,
  max = MAX_CONTROL_BYTES
): Output {
  if (!b4a.isBuffer(buf)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid message buffer')
  }
  if (buf.byteLength > max) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Message too large')
  }

  const state: EncodingState = { start: 0, end: buf.byteLength, buffer: b4a.from(buf) }
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

const offerStruct: Codec<OfferInput, Offer> = {
  preencode(state: EncodingState, value: OfferInput): void {
    c.uint.preencode(state, value.version)
    fixed32.preencode(state, value.transferId)
    c.string.preencode(state, value.name)
    c.uint.preencode(state, value.size)
    fixed32.preencode(state, value.digest)
    c.uint.preencode(state, value.chunkSize)
    c.uint.preencode(state, value.chunkCount)
  },
  encode(state: EncodingState, value: OfferInput): void {
    c.uint.encode(state, value.version)
    fixed32.encode(state, value.transferId)
    c.string.encode(state, value.name)
    c.uint.encode(state, value.size)
    fixed32.encode(state, value.digest)
    c.uint.encode(state, value.chunkSize)
    c.uint.encode(state, value.chunkCount)
  },
  decode(state: EncodingState): Offer {
    return {
      version: c.uint.decode(state),
      transferId: fixed32.decode(state),
      name: c.string.decode(state),
      size: c.uint.decode(state),
      digest: fixed32.decode(state),
      chunkSize: c.uint.decode(state),
      chunkCount: c.uint.decode(state)
    }
  }
}

export const offer: Codec<OfferInput, Offer> = validatedCodec(offerStruct, (value: OfferInput) => {
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
})

const statusStruct: Codec<StatusInput, Status> = {
  preencode(state: EncodingState, value: StatusInput): void {
    fixed32.preencode(state, value.transferId)
    statusCodeField.preencode(state, value.code)
    optionalString.preencode(state, value.reason)
  },
  encode(state: EncodingState, value: StatusInput): void {
    fixed32.encode(state, value.transferId)
    statusCodeField.encode(state, value.code)
    optionalString.encode(state, value.reason)
  },
  decode(state: EncodingState): Status {
    return {
      transferId: fixed32.decode(state),
      code: statusCodeField.decode(state),
      reason: optionalString.decode(state)
    }
  }
}

export const status: Codec<StatusInput, Status> = validatedCodec(
  statusStruct,
  (value: StatusInput) => {
    assertFixed32(value.transferId, 'transferId')
    assertStatusCode(value.code)
    assertOptionalReason(value.reason)
  }
)

const bitmapPageStruct: Codec<BitmapPageInput, BitmapPage> = {
  preencode(state: EncodingState, value: BitmapPageInput): void {
    fixed32.preencode(state, value.transferId)
    c.uint.preencode(state, value.start)
    c.uint.preencode(state, value.count)
    binary.preencode(state, value.bits)
  },
  encode(state: EncodingState, value: BitmapPageInput): void {
    fixed32.encode(state, value.transferId)
    c.uint.encode(state, value.start)
    c.uint.encode(state, value.count)
    binary.encode(state, value.bits)
  },
  decode(state: EncodingState): BitmapPage {
    return {
      transferId: fixed32.decode(state),
      start: c.uint.decode(state),
      count: c.uint.decode(state),
      bits: binary.decode(state)
    }
  }
}

export const bitmapPage: Codec<BitmapPageInput, BitmapPage> = validatedCodec(
  bitmapPageStruct,
  validateBitmapPage
)

function transferMessageStruct(): Codec<TransferMessage> {
  return {
    preencode(state: EncodingState, value: TransferMessage): void {
      fixed32.preencode(state, value.transferId)
    },
    encode(state: EncodingState, value: TransferMessage): void {
      fixed32.encode(state, value.transferId)
    },
    decode(state: EncodingState): TransferMessage {
      return { transferId: fixed32.decode(state) }
    }
  }
}

function assertTransferMessage(value: ReadyInput): void {
  assertFixed32(value.transferId, 'transferId')
}

export const ready: Codec<ReadyInput, Ready> = validatedCodec(
  transferMessageStruct(),
  assertTransferMessage
)

export const finish: Codec<FinishInput, Finish> = validatedCodec(
  transferMessageStruct(),
  assertTransferMessage
)

const chunkStruct: Codec<ChunkInput, Chunk> = {
  preencode(state: EncodingState, value: ChunkInput): void {
    fixed32.preencode(state, value.transferId)
    c.uint.preencode(state, value.index)
    fixed32.preencode(state, value.digest)
    binary.preencode(state, value.data)
  },
  encode(state: EncodingState, value: ChunkInput): void {
    fixed32.encode(state, value.transferId)
    c.uint.encode(state, value.index)
    fixed32.encode(state, value.digest)
    binary.encode(state, value.data)
  },
  decode(state: EncodingState): Chunk {
    return {
      transferId: fixed32.decode(state),
      index: c.uint.decode(state),
      digest: fixed32.decode(state),
      data: binary.decode(state)
    }
  }
}

export const chunk: Codec<ChunkInput, Chunk> = validatedCodec(chunkStruct, (value: ChunkInput) => {
  assertFixed32(value.transferId, 'transferId')
  assertSafeUint(value.index, 'index')
  assertFixed32(value.digest, 'digest')
  if (!b4a.isBuffer(value.data) || value.data.byteLength > MAX_CHUNK_BYTES) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid chunk data')
  }
})

const chunkAckStruct: Codec<ChunkAckInput, ChunkAck> = {
  preencode(state: EncodingState, value: ChunkAckInput): void {
    fixed32.preencode(state, value.transferId)
    c.uint.preencode(state, value.index)
  },
  encode(state: EncodingState, value: ChunkAckInput): void {
    fixed32.encode(state, value.transferId)
    c.uint.encode(state, value.index)
  },
  decode(state: EncodingState): ChunkAck {
    return {
      transferId: fixed32.decode(state),
      index: c.uint.decode(state)
    }
  }
}

export const chunkAck: Codec<ChunkAckInput, ChunkAck> = validatedCodec(
  chunkAckStruct,
  (value: ChunkAckInput) => {
    assertFixed32(value.transferId, 'transferId')
    assertSafeUint(value.index, 'index')
  }
)

const resultStruct: Codec<ResultInput, Result> = {
  preencode(state: EncodingState, value: ResultInput): void {
    fixed32.preencode(state, value.transferId)
    resultCodeField.preencode(state, value.code)
    optionalString.preencode(state, value.reason)
  },
  encode(state: EncodingState, value: ResultInput): void {
    fixed32.encode(state, value.transferId)
    resultCodeField.encode(state, value.code)
    optionalString.encode(state, value.reason)
  },
  decode(state: EncodingState): Result {
    return {
      transferId: fixed32.decode(state),
      code: resultCodeField.decode(state),
      reason: optionalString.decode(state)
    }
  }
}

export const result: Codec<ResultInput, Result> = validatedCodec(
  resultStruct,
  (value: ResultInput) => {
    assertFixed32(value.transferId, 'transferId')
    assertResultCode(value.code)
    assertOptionalReason(value.reason)
  }
)
