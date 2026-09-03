import type { Client } from '../../dist/client.js'
import type { Server } from '../../dist/server.js'
import type { AllowlistWatcher } from '../../dist/allowlist.js'
import type { CommitStore } from '../../dist/storage/commit-store.js'
import type { RetentionManager } from '../../dist/storage/retention.js'
import type { SessionStore } from '../../dist/storage/session-store.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import type { SwarmPeerInfo, SwarmSocket } from '../../dist/types.js'

/**
 * The private `Server` and `Client` members the integration suites observe,
 * replace, or drive directly. Naming them here keeps the production surface
 * private while every test access stays typed.
 */

/** A tracked transport. Only destruction and the socket identity are used. */
export interface TrackedSocket {
  destroy(error?: unknown): void
}

/** A tracked connection as the revocation harness constructs it. */
export interface TrackedConnection {
  owner: string
  ownerKey: Uint8Array
  sessions: Set<unknown>
  socket: unknown
  transportTimer?: unknown
  refreshTransport: () => void
}

/**
 * `_onConnection` accepts partial transports: it guards the optional listener
 * registration at runtime, so the harnesses pass minimal sockets.
 */
export type ConnectableSocket = Partial<SwarmSocket> & {
  destroy(error?: unknown): void
}

/** A protomux stand-in accepted by `_onPair`. */
export interface PairMux {
  createChannel(options: { protocol: string; id: Uint8Array }): unknown
}

export interface ServerInternals {
  replaceNames: Set<string>
  layout: StorageLayout
  sessionStore: SessionStore
  commitStore: CommitStore
  retentionManager: RetentionManager
  allowlistWatcher: AllowlistWatcher
  swarm: { destroyed: boolean } | null
  discovery: unknown
  pendingRevocations: Map<string, { transferIds: Set<string> }>
  _allowlist: Set<string>
  _connections: Map<TrackedSocket, TrackedConnection>
  _sockets: Map<string, Set<TrackedSocket>>
  _sessions: Set<unknown>
  _activeUploads: Map<string, { id: string; name: string }>
  _activeNames: Map<string, { id: string; name: string }>
  _reserveUpload(
    transferId: Uint8Array,
    name: string
  ): { id: string; name: string } | { rejected: true; reason: string }
  _firewall(key: unknown): boolean
  _onConnection(socket: ConnectableSocket, peerInfo?: SwarmPeerInfo | null): void
  _onPair(mux: PairMux, socket: unknown, connection: TrackedConnection, id: Uint8Array): void
}

export interface ClientInternals {
  swarm: { destroyed: boolean } | null
  discovery: unknown
  sockets: Set<unknown>
  sessions: Set<unknown>
  socketWaiters: unknown[]
  delayWaiters: unknown[]
  _ensureStarted(): Promise<unknown>
  _delay(milliseconds: number): Promise<unknown>
  _waitForSocket(deadline: number): Promise<unknown>
  _startSession(...args: unknown[]): Promise<unknown>
  _uploadManifest(...args: unknown[]): Promise<unknown>
}

/** A Hyperswarm instance as the tests drive it for rogue-peer probes. */
export interface ClientSwarm {
  joinPeer(publicKey: Uint8Array): void
}

/**
 * The allowlist watcher's private reload timer. Every suite that drives the
 * timer injects a scheduler whose handles expose the pending callback.
 */
export interface WatcherInternals {
  timer: { callback(): unknown } | null
  keys: Set<string>
}

export function watcherInternals(watcher: AllowlistWatcher): WatcherInternals {
  return watcher as unknown as WatcherInternals
}

export function serverInternals(server: Server): ServerInternals {
  return server as unknown as ServerInternals
}

export function clientInternals(client: Client): ClientInternals {
  return client as unknown as ClientInternals
}

export function clientSwarm(client: Client): ClientSwarm {
  return clientInternals(client).swarm as unknown as ClientSwarm
}

/** Destroys every tracked server transport, simulating an abrupt disconnect. */
export function destroyServerConnections(server: Server): void {
  for (const socket of serverInternals(server)._connections.keys()) socket.destroy()
}
