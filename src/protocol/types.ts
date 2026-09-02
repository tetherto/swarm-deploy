import type { ResultCode, StatusCode } from './constants.js'
import type { FileManifest, FileSnapshot } from '../files.js'
import type { Binary, BinaryInput, Digest, Fixed32, Scheduler, TransferId } from '../types.js'

export type { Binary, BinaryInput, Digest, Fixed32, TransferId }

export interface EncodingState {
  start: number
  end: number
  buffer: Binary
}

export interface Codec<Input, Output = Input> {
  preencode(state: EncodingState, value: Input): void
  encode(state: EncodingState, value: Input): void
  decode(state: EncodingState): Output
}

export interface TransferIdInput {
  clientPublicKey: Fixed32
  name: string
  size: number
  digest: Fixed32
  chunkSize: number
}

export interface OfferInput {
  version: number
  transferId: Fixed32
  name: string
  size: number
  digest: Fixed32
  chunkSize: number
  chunkCount: number
}

export interface Offer {
  version: number
  transferId: TransferId
  name: string
  size: number
  digest: Digest
  chunkSize: number
  chunkCount: number
}

export interface StatusInput {
  transferId: Fixed32
  code: StatusCode
  reason?: string
}

export interface Status {
  transferId: TransferId
  code: StatusCode
  reason?: string
}

export interface BitmapPageInput {
  transferId: Fixed32
  start: number
  count: number
  bits: BinaryInput
}

export interface BitmapPage {
  transferId: TransferId
  start: number
  count: number
  bits: Binary
}

export interface ReadyInput {
  transferId: Fixed32
}

export interface Ready {
  transferId: TransferId
}

/** A message carrying only a transfer identifier: READY and FINISH. */
export interface TransferMessage extends Ready {}

export interface ChunkInput {
  transferId: Fixed32
  index: number
  digest: Fixed32
  data: BinaryInput
}

export interface Chunk {
  transferId: TransferId
  index: number
  digest: Digest
  data: Binary
}

export interface ChunkAckInput {
  transferId: Fixed32
  index: number
}

export interface ChunkAck {
  transferId: TransferId
  index: number
}

export interface FinishInput {
  transferId: Fixed32
}

export interface Finish {
  transferId: TransferId
}

export interface ResultInput {
  transferId: Fixed32
  code: ResultCode
  reason?: string
}

export interface Result {
  transferId: TransferId
  code: ResultCode
  reason?: string
}

export interface ProtocolMessage {
  send(value: unknown): boolean | void
}

export interface ProtocolChannel {
  addMessage<Input, Output>(options: {
    encoding: Codec<Input, Output>
    onmessage: (value: Output) => void
  }): ProtocolMessage
  fullyOpened(): Promise<boolean>
  open(): void
  close(): void
  drained: boolean
  ondrain: () => void
  onclose: (isRemote: boolean) => void
  _recv(type: number, state: EncodingState): unknown
  _mux: { stream: { destroy(error: unknown): void } }
}

export type SessionScheduler = Scheduler

export type { FileManifest, FileSnapshot }
