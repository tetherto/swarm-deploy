import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { MAX_CHUNK_BYTES } from './constants.js'

export function isFixed32(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32
}

export function assertFixed32(value: unknown, name: string): asserts value is Uint8Array {
  if (!isFixed32(value)) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

export function assertSafeUint(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

export function assertPositiveSafeUint(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

export function assertBoundedChunkSize(value: unknown, name: string): asserts value is number {
  assertPositiveSafeUint(value, name)
  if (value > MAX_CHUNK_BYTES) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}
