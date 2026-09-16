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

declare module 'hyperdht/testnet' {
  import type DHT from 'hyperdht'

  export interface Testnet {
    bootstrap: Array<{ host: string; port: number }>
    nodes: DHT[]
    createNode(options?: Record<string, unknown>): DHT
    destroy(): Promise<void>
  }

  export default function createTestnet(
    size?: number,
    teardownHost?: { teardown(fn: () => unknown): void }
  ): Promise<Testnet>
}
