import type { ErrorCode } from './errors.js'

/**
 * A byte buffer accepted by identity, transport, and file APIs. Values that
 * represent keys, digests, or transfer IDs must be exactly 32 bytes.
 */
export type Binary = Buffer

/** Byte input accepted by APIs that normalize values to a b4a/Node Buffer. */
export type BinaryInput = Uint8Array

/** A 32-byte seed used to derive a Hyperswarm/HyperDHT identity. */
export type Seed = Binary
/** A 32-byte seed accepted by identity and constructor APIs. */
export type SeedInput = BinaryInput
/** A 32-byte HyperDHT public key. */
export type PublicKey = Binary
/** A 32-byte public key accepted by identity, constructor, and allowlist APIs. */
export type PublicKeyInput = BinaryInput
/** A SHA-256-derived 32-byte discovery topic. */
export type Topic = Binary
/** A SHA-256 digest. */
export type Digest = Binary
/** A SHA-256-derived transfer identifier. */
export type TransferId = Binary
/** A fixed-width 32-byte value accepted by protocol transfer-ID helpers. */
export type Fixed32 = BinaryInput

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

export interface SwarmDiscovery {
  flushed(): Promise<unknown>
  destroy?(): void | Promise<void>
}

export interface SwarmSocket {
  destroyed?: boolean
  remotePublicKey?: BinaryInput
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: () => void): this
  destroy(error?: unknown): void
}

export interface SwarmPeerInfo {
  publicKey?: BinaryInput
}

export interface Swarm {
  /**
   * `connection` is generic over the listener arguments so a precisely typed
   * handler is accepted without naming a transport type in the public surface.
   */
  on<Socket, PeerInfo>(
    event: 'connection',
    listener: (socket: Socket, peerInfo?: PeerInfo) => void
  ): unknown
  on(event: string, listener: (...args: unknown[]) => void): unknown
  join(topic: Topic, options: { server: boolean; client: boolean }): SwarmDiscovery
  destroy(): void | Promise<void>
}

export interface SwarmFactoryOptions {
  keyPair: KeyPair
  dht?: unknown
  maxPeers: number
  maxClientConnections: number
  maxServerConnections: number
  firewall?: (remotePublicKey: PublicKey) => boolean
}

export type SwarmFactory = (options: SwarmFactoryOptions) => Swarm

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

/** Metadata describing the managed artifact a successful replacement superseded. */
export interface ReplacementDetails {
  /** The configured mutable name the new artifact now occupies. */
  name: string
  /** The superseded transfer ID, in canonical lowercase hexadecimal. */
  transferId: string
  /** The generated top-level sibling that now holds the superseded artifact. */
  historyName: string
}
