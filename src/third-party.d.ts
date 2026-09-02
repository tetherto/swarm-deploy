declare module 'b4a' {
  const b4a: {
    alloc(size: number): Buffer
    allocUnsafe(size: number): Buffer
    from(value: string | Uint8Array, encoding?: BufferEncoding): Buffer
    isBuffer(value: unknown): value is Buffer
    equals(a: Uint8Array, b: Uint8Array): boolean
    toString(value: Uint8Array, encoding?: BufferEncoding): string
  }

  export default b4a
}

declare module 'hyperdht' {
  interface KeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  const DHT: {
    keyPair(seed: Buffer): KeyPair
  }

  export default DHT
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
