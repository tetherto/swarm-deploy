import { Buffer } from 'node:buffer'
import {
  type AllowlistKey,
  type BatchUploadResult,
  type Binary,
  type BitmapPage,
  type BitmapPageInput,
  type Chunk,
  type ChunkAck,
  type ChunkAckInput,
  type ChunkInput,
  type ClientEvent,
  type ClientEventName,
  type ClientOptions,
  type ClientResultEvent,
  type ClientSkippedEvent,
  Client,
  type Codec,
  type FileManifest,
  type Finish,
  type FinishInput,
  type Logger,
  type Offer,
  type OfferInput,
  type Ready,
  type ReadyInput,
  type Result,
  type ResultInput,
  type RecoveryEvent,
  type ServerConnectionEvent,
  type ServerOptions,
  Server,
  type StorageAdapter,
  type StorageFileHandle,
  type StorageStats,
  type Status,
  type StatusInput,
  type UploadResult,
  AllowlistWatcher,
  bitmapPage,
  CHUNK,
  CHUNK_ACK,
  chunk,
  chunkAck,
  decodeBounded,
  DIGEST_BYTES,
  encodeBounded,
  encodeTransferIdCanonical,
  ERRORS,
  FINISH,
  finish,
  generateSeed,
  keyPairFromSeed,
  MAX_BITMAP_BITS,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_FRAME_BYTES,
  MAX_CONTROL_BYTES,
  mergeBitmapPages,
  OFFER,
  offer,
  parseAllowlist,
  parsePublicKey,
  parseSeed,
  PROTOCOL_VERSION,
  publicKeyFromSeed,
  READY,
  ready,
  RESULT,
  RESULT_CODE,
  result,
  STATUS,
  status,
  STATUS_CODE,
  SwarmDeployError,
  topicFromServerPublicKey,
  TRANSFER_ID_BYTES,
  transferId,
  validateBasename
} from '../../index.js'

const binaryInput = new Uint8Array(32)
const seed: Binary = generateSeed()
const serverKey = publicKeyFromSeed(seed)
const clientKey = publicKeyFromSeed(Buffer.alloc(32, 2))
const keyPair = keyPairFromSeed(seed)
const binaryKeyPair = keyPairFromSeed(binaryInput)
const binaryPublicKey = publicKeyFromSeed(binaryInput)
const binaryTopic = topicFromServerPublicKey(binaryPublicKey)
const logger: Logger = {
  info(message, details) {
    void message
    void details
  }
}

const storageStats: StorageStats = {
  size: 0,
  dev: 0,
  ino: 0,
  isDirectory: () => true,
  isFile: () => true,
  isSymbolicLink: () => false
}
const storageHandle: StorageFileHandle = {
  stat: async () => storageStats,
  read: async () => ({ bytesRead: 0 }),
  write: async () => ({ bytesWritten: 0 }),
  sync: async () => {},
  close: async () => {}
}
const storage: StorageAdapter = {
  open: async (path, flags, mode) => {
    void [path, flags, mode]
    return storageHandle
  },
  lstat: async (path) => {
    void path
    return storageStats
  },
  readdir: async (path) => {
    void path
    return []
  },
  mkdir: async (path, options) => {
    void [path, options]
    return undefined
  },
  rm: async (path, options) => {
    void [path, options]
  },
  rename: async (oldPath, newPath) => {
    void [oldPath, newPath]
  },
  link: async (existingPath, newPath) => {
    void [existingPath, newPath]
  },
  unlink: async (path) => {
    void path
  },
  rmdir: async (path) => {
    void path
  },
  readFile: async (path, encoding) => {
    void [path, encoding]
    return ''
  },
  statfs: async (path) => {
    void path
    return { bavail: 0, bsize: 0 }
  }
}

const serverOptions: ServerOptions = {
  seed: binaryInput,
  storageDir: '/var/lib/swarm-deploy',
  allowedKeys: [binaryInput, clientKey.toString('hex') as AllowlistKey],
  maxFileBytes: MAX_CHUNK_BYTES,
  maxStagingBytes: MAX_CHUNK_BYTES * 2,
  storage,
  logger
}
const clientOptions: ClientOptions = {
  seed: binaryInput,
  serverPublicKey: new Uint8Array(serverKey),
  logger
}

const server = new Server(serverOptions)
const client = new Client(clientOptions)
const recoveryFileExists: RecoveryEvent['status'] = 'FILE_EXISTS'
const allowlistWatcher = new AllowlistWatcher({
  filePath: '/var/lib/swarm-deploy/allowlist',
  storage,
  onReload: (keys) => void keys,
  onFailure: (event) => void event.reason
})
allowlistWatcher.on('failure', (event) => void event.reason)
const listening: Promise<Server> = server.listen()
const reloaded: Promise<Set<string>> = server.reloadAllowlist([binaryInput])
const closedServer: Promise<void> = server.close()
const uploaded: Promise<UploadResult | BatchUploadResult> = client.upload('./artifact.bin')
const closedClient: Promise<void> = client.close()
const clientEventName: ClientEventName = 'skipped'
void [
  listening,
  reloaded,
  closedServer,
  uploaded,
  closedClient,
  binaryKeyPair,
  binaryPublicKey,
  binaryTopic,
  clientEventName,
  recoveryFileExists,
  allowlistWatcher
]

server.on('connection', (event: ServerConnectionEvent) => void event.connections)
server.once('listening', (event) => void event.publicKey)
server.on('progress', (event) => void [event.transfer, event.bytesReceived, event.totalBytes])
server.on('retention', (event) => void [event.trigger, event.status, event.storageDeleted])
server.on('allowlist', (event) => void [event.status, event.appliedCount, event.pendingCount])
server.on('recovery', (event) => void [event.status, event.phase, event.reason])
client.on('result', (event: ClientResultEvent) => {
  const reason: string | undefined = event.reason
  if ('files' in event) void [event.files, event.committed, event.failed, event.skipped]
  void [event.status, reason, event.final]
})
client.on('skipped', (event: ClientSkippedEvent) => {
  void [event.name, event.reason]
  // @ts-expect-error skipped client events omit the source path
  void event.path
})
client.once('rejected-peer', (event) => void event.fingerprint)
client.on('progress', (event) => void [event.transfer, event.bytesSent, event.totalBytes])

function describeClientEvent(event: ClientEvent): string {
  if ('fingerprint' in event) return event.fingerprint
  if ('status' in event) return event.reason ?? event.status
  return event.name
}

async function exerciseStorageAdapter() {
  const handle = await storage.open('/tmp/file', 'r')
  const stat = await storage.lstat('/tmp/file')
  const names = await storage.readdir('/tmp')
  const text = await storage.readFile('/tmp/allowlist', 'utf8')
  const filesystem = await storage.statfs?.('/tmp')
  await storage.mkdir('/tmp/dir', { mode: 0o700 })
  await storage.rm('/tmp/dir', { recursive: true, force: true })
  await storage.rename('/tmp/source', '/tmp/destination')
  await storage.link('/tmp/source', '/tmp/destination')
  await storage.unlink('/tmp/file')
  await storage.rmdir('/tmp/dir')
  await handle.read(new Uint8Array(1), 0, 1, 0)
  await handle.write(new Uint8Array(1), 0, 1, 0)
  await handle.sync()
  await handle.close()
  void [stat, names, text, filesystem]
}

void [describeClientEvent, exerciseStorageAdapter]

const transfer = transferId({
  clientPublicKey: binaryInput,
  name: validateBasename('artifact.bin'),
  size: 0,
  digest: binaryInput,
  chunkSize: MAX_CHUNK_BYTES
})
const canonical = encodeTransferIdCanonical({
  clientPublicKey: binaryInput,
  name: 'artifact.bin',
  size: 0,
  digest: binaryInput,
  chunkSize: MAX_CHUNK_BYTES
})
const request: OfferInput = {
  version: PROTOCOL_VERSION,
  transferId: binaryInput,
  name: 'artifact.bin',
  size: 0,
  digest: binaryInput,
  chunkSize: MAX_CHUNK_BYTES,
  chunkCount: 0
}
const encoded = encodeBounded(offer, request, MAX_CONTROL_BYTES)
const decoded: Offer = decodeBounded(offer, new Uint8Array(encoded), MAX_CONTROL_BYTES)
const pages: BitmapPageInput[] = [
  { transferId: binaryInput, start: 0, count: 1, bits: new Uint8Array([0]) }
]
const verified: Set<number> = mergeBitmapPages(pages, 1)
const protocolResult: ResultInput = { transferId: binaryInput, code: RESULT_CODE.COMMITTED }
const protocolStatus: StatusInput = { transferId: binaryInput, code: STATUS_CODE.ACCEPT }
const protocolChunk: ChunkInput = {
  transferId: binaryInput,
  index: 0,
  digest: binaryInput,
  data: new Uint8Array()
}
const protocolReady: ReadyInput = { transferId: binaryInput }
const protocolChunkAck: ChunkAckInput = { transferId: binaryInput, index: 0 }
const protocolFinish: FinishInput = { transferId: binaryInput }
const decodedBitmapPage: BitmapPage = decodeBounded(
  bitmapPage,
  new Uint8Array(encodeBounded(bitmapPage, pages[0])),
  MAX_CONTROL_BYTES
)
const decodedStatus: Status = decodeBounded(
  status,
  new Uint8Array(encodeBounded(status, protocolStatus)),
  MAX_CONTROL_BYTES
)
const decodedReady: Ready = decodeBounded(
  ready,
  new Uint8Array(encodeBounded(ready, protocolReady)),
  MAX_CONTROL_BYTES
)
const decodedChunk: Chunk = decodeBounded(
  chunk,
  new Uint8Array(encodeBounded(chunk, protocolChunk)),
  MAX_CONTROL_BYTES
)
const decodedChunkAck: ChunkAck = decodeBounded(
  chunkAck,
  new Uint8Array(encodeBounded(chunkAck, protocolChunkAck)),
  MAX_CONTROL_BYTES
)
const decodedFinish: Finish = decodeBounded(
  finish,
  new Uint8Array(encodeBounded(finish, protocolFinish)),
  MAX_CONTROL_BYTES
)
const decodedResult: Result = decodeBounded(
  result,
  new Uint8Array(encodeBounded(result, protocolResult)),
  MAX_CONTROL_BYTES
)
const decodedBuffers: Buffer[] = [
  decoded.transferId,
  decoded.digest,
  decodedBitmapPage.transferId,
  decodedBitmapPage.bits,
  decodedStatus.transferId,
  decodedReady.transferId,
  decodedChunk.transferId,
  decodedChunk.digest,
  decodedChunk.data,
  decodedChunkAck.transferId,
  decodedFinish.transferId,
  decodedResult.transferId
]
const offerCodec: Codec<OfferInput, Offer> = offer
const statusCodec: Codec<StatusInput, Status> = status
const bitmapPageCodec: Codec<BitmapPageInput, BitmapPage> = bitmapPage
const readyCodec: Codec<ReadyInput, Ready> = ready
const chunkCodec: Codec<ChunkInput, Chunk> = chunk
const chunkAckCodec: Codec<ChunkAckInput, ChunkAck> = chunkAck
const finishCodec: Codec<FinishInput, Finish> = finish
const resultCodec: Codec<ResultInput, Result> = result

void [
  AllowlistWatcher,
  CHUNK,
  CHUNK_ACK,
  canonical,
  decoded,
  decodedBuffers,
  ERRORS,
  FINISH,
  finish,
  finishCodec,
  keyPair,
  MAX_BITMAP_BITS,
  MAX_CHUNK_FRAME_BYTES,
  OFFER,
  offerCodec,
  parseAllowlist(''),
  parsePublicKey(serverKey.toString('hex')),
  parseSeed(seed.toString('hex')),
  protocolChunkAck,
  protocolFinish,
  protocolReady,
  protocolChunk,
  protocolResult,
  protocolStatus,
  READY,
  ready,
  readyCodec,
  RESULT,
  resultCodec,
  STATUS,
  status,
  statusCodec,
  topicFromServerPublicKey(serverKey),
  transfer,
  TRANSFER_ID_BYTES,
  verified,
  bitmapPageCodec,
  chunkCodec,
  chunkAckCodec,
  new SwarmDeployError(ERRORS.ABORTED, 'aborted')
]

const manifest: FileManifest = {
  path: './artifact.bin',
  name: 'artifact.bin',
  size: 0,
  digest: Buffer.alloc(DIGEST_BYTES),
  chunkDigests: [],
  chunkCount: 0,
  chunkSize: MAX_CHUNK_BYTES,
  stat: { size: 0, mtimeMs: 0, ino: 0 }
}
void manifest
