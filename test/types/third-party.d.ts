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

declare module 'streamx' {
  export interface DuplexOptions {
    write?(this: Duplex, data: Buffer, callback: (error?: Error | null) => void): void
    final?(this: Duplex, callback: (error?: Error | null) => void): void
  }

  /**
   * Only the members exercised by the protocol session harnesses are declared:
   * a `streamx` duplex is used as an in-memory replacement for a Hyperswarm
   * socket.
   */
  export class Duplex {
    constructor(options?: DuplexOptions)
    userData: unknown
    destroyed: boolean
    push(data: Buffer | null): boolean
    pause(): this
    resume(): this
    end(data?: Buffer): this
    destroy(error?: Error): void
    on(event: string, listener: (...args: never[]) => void): this
    once(event: string, listener: (...args: never[]) => void): this
    emit(event: string, ...args: unknown[]): boolean
  }
}

declare module 'protomux' {
  import type { Duplex } from 'streamx'
  import type { HyperswarmSocket } from 'hyperswarm'

  /**
   * Protomux frames over any streamx-compatible duplex. The harnesses supply
   * either an in-memory `streamx` duplex or a live Hyperswarm socket.
   */
  export type ProtomuxStream = Duplex | HyperswarmSocket

  export interface ProtomuxEncoding<Input, Output> {
    preencode(state: { start: number; end: number; buffer: Buffer }, value: Input): void
    encode(state: { start: number; end: number; buffer: Buffer }, value: Input): void
    decode(state: { start: number; end: number; buffer: Buffer }): Output
  }

  export interface ProtomuxMessage<Input> {
    send(value: Input): boolean
  }

  export interface ProtomuxMessageOptions<Input, Output> {
    encoding?: ProtomuxEncoding<Input, Output>
    onmessage?: (value: Output) => void
  }

  export interface ProtomuxChannelOptions {
    protocol: string
    id?: Uint8Array | null
    unique?: boolean
    onopen?: () => void
    onclose?: (isRemote: boolean) => void
    ondestroy?: () => void
    ondrain?: () => void
  }

  export class ProtomuxChannel {
    protocol: string
    id: Uint8Array | null
    opened: boolean
    closed: boolean
    destroyed: boolean
    drained: boolean
    ondrain: () => void
    onclose: (isRemote: boolean) => void
    _mux: Protomux
    addMessage<Input, Output>(
      options: ProtomuxMessageOptions<Input, Output>
    ): ProtomuxMessage<Input>
    fullyOpened(): Promise<boolean>
    open(handshake?: unknown): void
    close(): void
    cork(): void
    uncork(): void
    _recv(type: number, state: { start: number; end: number; buffer: Buffer }): unknown
  }

  export default class Protomux {
    constructor(stream: ProtomuxStream)
    /**
     * `createChannel` returns `null` only when the underlying stream is already
     * destroyed. The harnesses always create channels on freshly built streams,
     * so the channel is declared non-nullable to keep the test bodies free of
     * guards that never run.
     */
    static from(stream: ProtomuxStream): Protomux
    stream: ProtomuxStream
    drained: boolean
    createChannel(options: ProtomuxChannelOptions): ProtomuxChannel
    pair(options: { protocol: string; id?: Uint8Array | null }, notify: (id: Buffer) => void): void
    destroy(error?: Error): void
  }
}

declare module 'hyperswarm' {
  export interface HyperswarmKeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface HyperswarmSocket {
    destroyed?: boolean
    remotePublicKey?: Buffer
    userData: unknown
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'data', listener: (data: Buffer) => void): this
    once(event: 'close', listener: () => void): this
    write(data: Buffer): boolean
    end(): void
    destroy(error?: unknown): void
  }

  export interface HyperswarmPeerInfo {
    publicKey?: Buffer
  }

  export interface HyperswarmDiscovery {
    flushed(): Promise<unknown>
    destroy?(): void | Promise<void>
  }

  export interface HyperswarmOptions {
    keyPair?: HyperswarmKeyPair
    dht?: unknown
    maxPeers?: number
    maxClientConnections?: number
    maxServerConnections?: number
    firewall?: (remotePublicKey: Buffer) => boolean
  }

  export default class Hyperswarm {
    constructor(options?: HyperswarmOptions)
    keyPair: HyperswarmKeyPair
    destroyed: boolean
    on(
      event: 'connection',
      listener: (socket: HyperswarmSocket, peerInfo?: HyperswarmPeerInfo) => void
    ): this
    once(
      event: 'connection',
      listener: (socket: HyperswarmSocket, peerInfo?: HyperswarmPeerInfo) => void
    ): this
    join(topic: Uint8Array, options: { server: boolean; client: boolean }): HyperswarmDiscovery
    joinPeer(publicKey: Uint8Array): void
    flush(): Promise<void>
    destroy(): Promise<void>
  }
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

declare module 'hyperdht/testnet' {
  export interface Testnet {
    bootstrap: Array<{ host: string; port: number }>
    nodes: unknown[]
    createNode(options?: Record<string, unknown>): unknown
    destroy(): Promise<void>
  }

  /**
   * The optional second argument is any object exposing `teardown`, which the
   * Brittle assertion handle satisfies.
   */
  export default function createTestnet(
    size?: number,
    teardownHost?: { teardown(fn: () => unknown): void }
  ): Promise<Testnet>
}
