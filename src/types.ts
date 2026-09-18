import type { ErrorCode } from './errors.js'

/**
 * A byte buffer accepted by identity, transport, and file APIs. Values that
 * represent keys, digests, or transfer IDs must be exactly 32 bytes.
 */
export type Binary = Buffer

/** Byte input accepted by APIs that normalize values to a b4a/Node Buffer. */
export type BinaryInput = Uint8Array

/** A 32-byte seed used to derive a HyperDHT identity. */
export type Seed = Binary
/** A 32-byte buffer or canonical lowercase 64-character hex seed string. */
export type SeedInput = BinaryInput | string
/** A 32-byte HyperDHT public key. */
export type PublicKey = Binary
/** A 32-byte public key accepted by identity, constructor, and allowlist APIs. */
export type PublicKeyInput = BinaryInput
/** A SHA-256 digest. */
export type Digest = Binary
/** A SHA-256-derived transfer identifier. */
export type TransferId = Binary

export interface KeyPair {
  publicKey: PublicKey
  secretKey: Binary
}

export interface Logger {
  info?(message: string, details?: Record<string, unknown>): void
  warn?(message: string, details?: Record<string, unknown>): void
  error?(message: string, details?: Record<string, unknown>): void
}

export interface Scheduler {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ServerScheduler extends Scheduler {
  setInterval(callback: () => void, delay: number): unknown
  clearInterval(handle: unknown): void
}

export interface Clock {
  now(): number
}

export interface FingerprintEvent {
  /** First 12 lowercase hexadecimal characters of SHA-256(public key). */
  fingerprint: string
}

export interface AuthenticationEvent extends FingerprintEvent {
  status: 'accepted' | 'rejected'
  reason?: ErrorCode
}

export interface TransferEvent {
  /** A 12-character SHA-256 fingerprint of the transfer ID. */
  transfer: string
  name: string
  size: number
}

export interface TransferLifecycleEvent extends TransferEvent {
  status: 'started' | 'succeeded' | 'failed'
  reason?: string
}
