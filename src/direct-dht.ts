import DHT from 'hyperdht'
import b4a from 'b4a'
import sodium from 'sodium-native'
import { abortError, onAbort, throwIfAborted, type AbortSignalLike } from './abort.js'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { KeyPair, PublicKey, PublicKeyInput } from './types.js'

const DEFAULT_CONNECT_TIMEOUT = 10_000
const MAX_CONNECT_TIMEOUT = 5 * 60_000

export interface DirectDhtSocket {
  readonly opened: PromiseLike<boolean>
  readonly remotePublicKey: Buffer | null
  readonly destroyed: boolean
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: () => void): this
  destroy(error?: unknown): void
}

export interface DirectDhtServerHandle {
  readonly publicKey: Buffer | null
  readonly closed: boolean
  on(event: 'error', listener: (error: Error) => void): this
  listen(keyPair: KeyPair): Promise<this>
  close(): Promise<void>
}

export interface DirectDhtNode {
  destroyed: boolean
  createServer(
    options: { firewall(remotePublicKey: Buffer): boolean },
    onConnection: (socket: DirectDhtSocket) => void
  ): DirectDhtServerHandle
  connect(serverPublicKey: Buffer, options: { keyPair: KeyPair }): DirectDhtSocket
  on(event: 'error', listener: (error: Error) => void): this
  destroy(): Promise<void>
}

export type DirectDhtFactory = () => DirectDhtNode

export interface DirectDhtServerOptions {
  keyPair: KeyPair
  allowedClientPublicKeys: readonly PublicKeyInput[]
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
  onConnection?: (socket: DirectDhtSocket) => void
}

export interface DirectDhtClientOptions {
  keyPair: KeyPair
  dht?: DirectDhtNode
  dhtFactory?: DirectDhtFactory
  connectTimeout?: number
}

export interface DirectDhtConnectOptions {
  signal?: AbortSignalLike | null
  timeout?: number
}

function copyBytes(value: Uint8Array, length: number, label: string): Buffer {
  if (!b4a.isBuffer(value) || value.byteLength !== length) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Expected ${length}-byte ${label}`)
  }
  return b4a.from(value)
}

function copyKeyPair(keyPair: KeyPair): KeyPair {
  if (!keyPair || typeof keyPair !== 'object') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Expected seeded key pair')
  }
  return {
    publicKey: copyBytes(keyPair.publicKey, 32, 'public key'),
    secretKey: copyBytes(keyPair.secretKey, 64, 'secret key')
  }
}

function assertTimeout(timeout: number): void {
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Connect timeout must be positive')
  }
  if (timeout > MAX_CONNECT_TIMEOUT) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Connect timeout exceeds maximum')
  }
}

function createNode(options: { dht?: DirectDhtNode; dhtFactory?: DirectDhtFactory }): {
  dht: DirectDhtNode
  owned: boolean
} {
  if (options.dht !== undefined && options.dhtFactory !== undefined) {
    throw new SwarmDeployError(
      ERRORS.PROTOCOL_INVALID,
      'Specify either an injected DHT or a DHT factory'
    )
  }
  if (options.dht !== undefined) return { dht: options.dht, owned: false }
  return {
    dht: options.dhtFactory ? options.dhtFactory() : new DHT(),
    owned: true
  }
}

function safeDestroy(socket: DirectDhtSocket, error?: unknown): void {
  try {
    socket.destroy(error)
  } catch {}
}

function transportError(code: string, message: string, cause: unknown = null): SwarmDeployError {
  const error = new SwarmDeployError(code, message, cause)
  error.transport = true
  return error
}

export class DirectDhtServer {
  readonly publicKey: PublicKey
  private readonly keyPair: KeyPair
  private readonly dht: DirectDhtNode
  private readonly ownedDht: boolean
  private readonly server: DirectDhtServerHandle
  private readonly allowedClientPublicKeys: readonly Buffer[]
  private readonly onConnection: ((socket: DirectDhtSocket) => void) | undefined
  private readonly sockets = new Set<DirectDhtSocket>()
  private listenPromise: Promise<this> | null = null
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(options: DirectDhtServerOptions) {
    if (!options || typeof options !== 'object') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid direct DHT server options')
    }
    this.keyPair = copyKeyPair(options.keyPair)
    this.publicKey = b4a.from(this.keyPair.publicKey)
    if (!Array.isArray(options.allowedClientPublicKeys)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Expected client public key allowlist')
    }
    this.allowedClientPublicKeys = options.allowedClientPublicKeys.map((key) =>
      copyBytes(key, 32, 'allowed client public key')
    )
    if (options.onConnection !== undefined && typeof options.onConnection !== 'function') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid connection callback')
    }
    this.onConnection = options.onConnection
    const created = createNode(options)
    this.dht = created.dht
    this.ownedDht = created.owned
    this.dht.on('error', () => {})
    this.server = this.dht.createServer(
      {
        firewall: (remotePublicKey) => this.firewall(remotePublicKey)
      },
      (socket) => this.accept(socket)
    )
    this.server.on('error', () => {})
  }

  private firewall(remotePublicKey: Buffer): boolean {
    return !this.isAllowed(remotePublicKey)
  }

  private isAllowed(remotePublicKey: Buffer | null): boolean {
    if (!b4a.isBuffer(remotePublicKey) || remotePublicKey.byteLength !== 32) return false
    let accepted = false
    for (const allowed of this.allowedClientPublicKeys) {
      accepted = sodium.sodium_memcmp(remotePublicKey, allowed) || accepted
    }
    return accepted
  }

  private accept(socket: DirectDhtSocket): void {
    if (this.closed || !this.isAllowed(socket.remotePublicKey)) {
      safeDestroy(socket)
      return
    }
    socket.on('error', () => {})
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    if (!this.onConnection) return
    try {
      this.onConnection(socket)
    } catch (error) {
      safeDestroy(socket, error)
    }
  }

  listen(): Promise<this> {
    if (this.closed) {
      return Promise.reject(
        new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Direct DHT server is closed')
      )
    }
    if (!this.listenPromise) {
      this.listenPromise = this.server.listen(this.keyPair).then(() => this)
    }
    return this.listenPromise
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeAll()
    return this.closePromise
  }

  private async closeAll(): Promise<void> {
    this.closed = true
    for (const socket of this.sockets) safeDestroy(socket)
    this.sockets.clear()
    let failure: unknown = null
    try {
      await this.server.close()
    } catch (error) {
      failure = error
    }
    if (this.ownedDht) {
      try {
        await this.dht.destroy()
      } catch (error) {
        if (failure === null) failure = error
      }
    }
    if (failure !== null) throw failure
  }
}

export class DirectDhtClient {
  readonly publicKey: PublicKey
  private readonly keyPair: KeyPair
  private readonly dht: DirectDhtNode
  private readonly ownedDht: boolean
  private readonly connectTimeout: number
  private readonly sockets = new Set<DirectDhtSocket>()
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(options: DirectDhtClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid direct DHT client options')
    }
    this.keyPair = copyKeyPair(options.keyPair)
    this.publicKey = b4a.from(this.keyPair.publicKey)
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
    assertTimeout(this.connectTimeout)
    const created = createNode(options)
    this.dht = created.dht
    this.ownedDht = created.owned
    this.dht.on('error', () => {})
  }

  async connect(
    serverPublicKey: PublicKeyInput,
    options: DirectDhtConnectOptions = {}
  ): Promise<DirectDhtSocket> {
    if (this.closed) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Direct DHT client is closed')
    }
    throwIfAborted(options.signal)
    const expectedServerPublicKey = copyBytes(serverPublicKey, 32, 'server public key')
    const timeout = options.timeout ?? this.connectTimeout
    assertTimeout(timeout)
    const socket = this.dht.connect(expectedServerPublicKey, { keyPair: this.keyPair })
    let socketError: Error | null = null
    socket.on('error', (error) => {
      if (socketError === null) socketError = error
    })
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))

    try {
      const opened = await this.awaitOpened(socket.opened, timeout, options.signal)
      if (opened !== true) {
        throw (
          socketError ||
          transportError(
            ERRORS.SERVER_KEY_MISMATCH,
            'Unable to authenticate expected direct DHT server'
          )
        )
      }
      const remotePublicKey = socket.remotePublicKey
      if (
        !b4a.isBuffer(remotePublicKey) ||
        remotePublicKey.byteLength !== 32 ||
        !sodium.sodium_memcmp(remotePublicKey, expectedServerPublicKey)
      ) {
        throw transportError(
          ERRORS.SERVER_KEY_MISMATCH,
          'Connected direct DHT server key did not match commitment'
        )
      }
      return socket
    } catch (error) {
      safeDestroy(socket, error)
      throw error
    }
  }

  private awaitOpened(
    opened: PromiseLike<boolean>,
    timeout: number,
    signal: AbortSignalLike | null | undefined
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false
      let removeAbort = () => {}
      const timer = setTimeout(() => {
        finish(reject, transportError(ERRORS.CONNECT_TIMEOUT, 'Direct DHT connection timed out'))
      }, timeout)
      const finish = <T>(callback: (value: T) => void, value: T): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeAbort()
        callback(value)
      }
      removeAbort = onAbort(signal, () => finish(reject, abortError()))
      Promise.resolve(opened).then(
        (value) => finish(resolve, value),
        (error: unknown) => finish(reject, error)
      )
    })
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.closeAll()
    return this.closePromise
  }

  private async closeAll(): Promise<void> {
    this.closed = true
    for (const socket of this.sockets) safeDestroy(socket)
    this.sockets.clear()
    if (this.ownedDht) await this.dht.destroy()
  }
}
