declare module 'b4a' {
  const b4a: {
    alloc(size: number, fill?: number): Buffer
    allocUnsafe(size: number): Buffer
    concat(values: Uint8Array[], total?: number): Buffer
    from(value: string | Uint8Array | ArrayLike<number>, encoding?: BufferEncoding): Buffer
    isBuffer(value: unknown): value is Buffer
    equals(a: Uint8Array, b: Uint8Array): boolean
    toString(value: Uint8Array, encoding?: BufferEncoding): string
  }

  export default b4a
}

declare module 'sodium-native' {
  const sodium: {
    randombytes_buf(buffer: Uint8Array): void
    crypto_sign_seed_keypair(publicKey: Uint8Array, secretKey: Uint8Array, seed: Uint8Array): void
    crypto_hash_sha256_BYTES: number
    crypto_hash_sha256_STATEBYTES: number
    crypto_hash_sha256(output: Uint8Array, input: Uint8Array): void
    crypto_hash_sha256_init(state: Uint8Array): void
    crypto_hash_sha256_update(state: Uint8Array, input: Uint8Array): void
    crypto_hash_sha256_final(state: Uint8Array, output: Uint8Array): void
    sodium_memcmp(a: Uint8Array, b: Uint8Array): boolean
  }

  export default sodium
}

declare module 'hyperdht' {
  export interface HyperDhtKeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface HyperDhtSocket {
    opened: Promise<boolean>
    remotePublicKey: Buffer | null
    destroyed: boolean
    on(event: 'error', listener: (error: Error) => void): this
    once(event: 'close', listener: () => void): this
    destroy(error?: unknown): void
  }

  export interface HyperDhtServer {
    publicKey: Buffer | null
    closed: boolean
    on(event: 'error', listener: (error: Error) => void): this
    listen(keyPair: HyperDhtKeyPair): Promise<this>
    close(): Promise<void>
  }

  export default class DHT {
    constructor()
    static keyPair(seed: Buffer): HyperDhtKeyPair
    destroyed: boolean
    createServer(
      options: { firewall(remotePublicKey: Buffer): boolean },
      onConnection: (socket: HyperDhtSocket) => void
    ): HyperDhtServer
    connect(serverPublicKey: Buffer, options: { keyPair: HyperDhtKeyPair }): HyperDhtSocket
    on(event: 'error', listener: (error: Error) => void): this
    destroy(): Promise<void>
  }
}

declare module 'hyperswarm' {
  interface HyperswarmKeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  interface HyperswarmSocket {
    destroyed?: boolean
    remotePublicKey?: Uint8Array
    on(event: 'error', listener: (error: Error) => void): this
    once(event: 'close', listener: () => void): this
    destroy(error?: unknown): void
  }

  interface HyperswarmPeerInfo {
    publicKey?: Uint8Array
  }

  interface HyperswarmDiscovery {
    flushed(): Promise<void>
    destroy?(): void | Promise<void>
  }

  interface HyperswarmOptions {
    keyPair: HyperswarmKeyPair
    dht?: unknown
    maxPeers: number
    maxClientConnections: number
    maxServerConnections: number
  }

  class Hyperswarm {
    constructor(options: HyperswarmOptions)
    on(
      event: 'connection',
      listener: (socket: HyperswarmSocket, peerInfo?: HyperswarmPeerInfo) => void
    ): this
    join(topic: Uint8Array, options: { server: boolean; client: boolean }): HyperswarmDiscovery
    destroy(): void | Promise<void>
  }

  export default Hyperswarm
}

declare module 'protomux' {
  interface ProtomuxChannelOptions {
    protocol: string
    id: Uint8Array
  }

  interface ProtomuxInstance {
    createChannel(options: ProtomuxChannelOptions): unknown
    pair(options: { protocol: string }, listener: (id: Uint8Array) => void): void
  }

  interface ProtomuxStatic {
    from(stream: { destroy(error?: unknown): void }): ProtomuxInstance
  }

  const Protomux: ProtomuxStatic
  export default Protomux
}
