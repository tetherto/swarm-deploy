import type { Encoder, State } from 'compact-encoding'

export type ProtocolState = State<Uint8Array>

export interface Codec<Input, Output = Input> extends Encoder<Input, Output> {}

export interface TransferIdInput {
  clientPublicKey: Uint8Array
  name: string
  size: number
  digest: Uint8Array
  chunkSize: number
}

export interface Offer {
  version: number
  transferId: Uint8Array
  name: string
  size: number
  digest: Uint8Array
  chunkSize: number
  chunkCount: number
}

export interface Status {
  transferId: Uint8Array
  code: number
  reason?: string
}

export interface BitmapPage {
  transferId: Uint8Array
  start: number
  count: number
  bits: Uint8Array
}

export interface TransferMessage {
  transferId: Uint8Array
}

export interface Chunk extends TransferMessage {
  index: number
  digest: Uint8Array
  data: Uint8Array
}

export interface ChunkAck extends TransferMessage {
  index: number
}

export interface Result extends Status {}

export interface ProtocolMessage {
  send(value: unknown): boolean | void
}

export interface ProtocolChannel {
  addMessage<T>(options: { encoding: Codec<T>; onmessage: (value: T) => void }): ProtocolMessage
  fullyOpened(): Promise<boolean>
  open(): void
  close(): void
  drained: boolean
  ondrain: () => void
  onclose: (isRemote: boolean) => void
  _recv(type: number, state: ProtocolState): unknown
  _mux: { stream: { destroy(error: unknown): void } }
}

export interface SessionScheduler {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export interface FileSnapshot {
  size: number
  mtimeMs: number
  ino: number | bigint
}

export interface FileManifest {
  path: string
  name: string
  size: number
  digest: Uint8Array
  chunkSize: number
  chunkCount: number
  chunkDigests: Uint8Array[]
  stat?: FileSnapshot
}
