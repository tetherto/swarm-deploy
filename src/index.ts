import type { Buffer } from 'node:buffer'

export { ERRORS, SwarmDeployError, type ErrorCode } from './errors.js'
export {
  parseSeed,
  parsePublicKey,
  generateSeed,
  keyPairFromSeed,
  publicKeyFromSeed,
  type BinaryInput,
  type KeyPair
} from './identity.js'
export { topicFromServerPublicKey } from './topic.js'
export {
  validateBasename,
  selectUploadPaths,
  buildFileManifest,
  type BuildFileManifestOptions,
  type FileManifest,
  type FileSnapshot,
  type UploadPathEntry,
  type UploadPathSelection
} from './files.js'
export {
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  RESULT_CODE,
  PROTOCOL_VERSION,
  DIGEST_BYTES,
  TRANSFER_ID_BYTES,
  MAX_CONTROL_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_BITMAP_BITS
} from './protocol/constants.js'
export {
  encodeBounded,
  decodeBounded,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result,
  mergeBitmapPages
} from './protocol/codecs.js'
export { transferId, encodeTransferIdCanonical } from './protocol/transfer-id.js'
export { parseAllowlist, AllowlistWatcher, type AllowlistWatcherOptions } from './allowlist.js'
export {
  Server,
  type AllowlistKey,
  type ServerConnectionEvent,
  type ServerEvent,
  type ServerEventName,
  type ServerEventMap,
  type ServerOptions
} from './server.js'
export {
  Client,
  type BatchUploadResult,
  type ClientEvent,
  type ClientEventName,
  type ClientEventMap,
  type ClientOptions,
  type ClientResultEvent,
  type UploadResult
} from './client.js'
export type {
  BitmapPage,
  Chunk,
  ChunkAck,
  Codec,
  Offer,
  Result,
  Status,
  TransferIdInput
} from './protocol/types.js'
export type {
  StorageAdapter,
  StorageFileHandle,
  StorageStat as StorageStats
} from './storage/types.js'

export type Binary = Buffer
export type Logger = import('./server.js').ServerLogger
export type OfferInput = import('./protocol/types.js').Offer
export type StatusInput = import('./protocol/types.js').Status
export type BitmapPageInput = import('./protocol/types.js').BitmapPage
export type Ready = import('./protocol/types.js').TransferMessage
export type ReadyInput = Ready
export type ChunkInput = import('./protocol/types.js').Chunk
export type ChunkAckInput = import('./protocol/types.js').ChunkAck
export type Finish = import('./protocol/types.js').TransferMessage
export type FinishInput = Finish
export type ResultInput = import('./protocol/types.js').Result
export interface RecoveryEvent {
  status: 'FILE_EXISTS' | 'RECOVERED' | 'RETIRED' | 'FAILED'
  phase: string
  reason?: string
}
export type ClientSkippedEvent = import('./client.js').ClientEventMap['skipped']
