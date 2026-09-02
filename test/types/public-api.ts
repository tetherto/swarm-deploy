import { Buffer } from 'node:buffer'
import {
  type AllowlistEvent,
  type AllowlistFailureEvent,
  type AllowlistKey,
  type AllowlistReloadedEvent,
  type AllowlistRemovedEvent,
  type AuthenticationEvent,
  type BatchUploadResult,
  type Binary,
  type BitmapPage,
  type BitmapPageInput,
  type Chunk,
  type ChunkAck,
  type ChunkAckInput,
  type ChunkInput,
  type CleanupEvent,
  type ClientBatchResultEvent,
  type ClientCloseEvent,
  type ClientCommitEvent,
  type ClientEvent,
  type ClientEventName,
  type ClientFailureEvent,
  type ClientOfferEvent,
  type ClientOptions,
  type ClientProgressEvent,
  type ClientResultEvent,
  type ClientSkippedEvent,
  type ClientSuccessEvent,
  Client,
  type Codec,
  type ConnectionCloseEvent,
  type ConnectionOpenEvent,
  type EncodingState,
  type FailedUploadPath,
  type FileManifest,
  type FingerprintEvent,
  type Finish,
  type FinishInput,
  type Logger,
  type Offer,
  type OfferInput,
  type Ready,
  type ReadyInput,
  type Result,
  type ResultCode,
  type ResultInput,
  type RecoveryEvent,
  type RetentionEvent,
  type ScrubEvent,
  type SelectedUploadPath,
  type ServerCloseEvent,
  type ServerConnectionEvent,
  type ServerEventMap,
  type ServerEventName,
  type ServerListeningEvent,
  type ServerOfferEvent,
  type ServerOptions,
  type ServerProgressEvent,
  type ServerTransferLifecycleEvent,
  Server,
  type SkippedUploadPath,
  type SkippedUploadReason,
  type StatusCode,
  type StorageAdapter,
  type StorageFileHandle,
  type StorageStats,
  type Status,
  type StatusInput,
  type TransferLifecycleEvent,
  type UploadPathEntry,
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
} from '../../dist/index.js'

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
  replaceNames: ['release.tar.gz'] as Iterable<string>,
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
const decodedBuffers: Binary[] = [
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

/*
 * Listener and declaration exactness checks. `Equals` is invariant, so these
 * fail whenever an event payload silently widens to `any`, `unknown`, or a
 * reshaped structural approximation.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false

type NoImplicitAnyListeners = [
  Expect<Equals<IsAny<Parameters<Parameters<Server['on']>[1]>[0]>, false>>,
  Expect<Equals<IsAny<Parameters<Parameters<Client['on']>[1]>[0]>, false>>,
  Expect<Equals<IsAny<Parameters<Parameters<AllowlistWatcher['on']>[1]>[0]>, false>>
]

type ServerEventNameCoverage = Expect<
  Equals<
    ServerEventName,
    | 'authentication'
    | 'connection'
    | 'connection-open'
    | 'connection-close'
    | 'offer'
    | 'progress'
    | 'verification'
    | 'commit'
    | 'recovery'
    | 'scrub'
    | 'retention'
    | 'cleanup'
    | 'allowlist'
    | 'revocation'
    | 'revoked'
    | 'listening'
    | 'close'
  >
>

type ClientEventNameCoverage = Expect<
  Equals<
    ClientEventName,
    | 'authentication'
    | 'connection'
    | 'connection-open'
    | 'connection-close'
    | 'rejected-peer'
    | 'offer'
    | 'progress'
    | 'verification'
    | 'commit'
    | 'result'
    | 'skipped'
    | 'close'
  >
>

type ServerEventMapShapes = [
  Expect<Equals<ServerEventMap['authentication'], AuthenticationEvent>>,
  Expect<Equals<ServerEventMap['connection'], ServerConnectionEvent>>,
  Expect<Equals<ServerEventMap['connection-open'], ConnectionOpenEvent>>,
  Expect<Equals<ServerEventMap['connection-close'], ConnectionCloseEvent>>,
  Expect<Equals<ServerEventMap['offer'], ServerOfferEvent>>,
  Expect<Equals<ServerEventMap['progress'], ServerProgressEvent>>,
  Expect<Equals<ServerEventMap['verification'], ServerTransferLifecycleEvent>>,
  Expect<Equals<ServerEventMap['commit'], ServerTransferLifecycleEvent>>,
  Expect<Equals<ServerEventMap['recovery'], RecoveryEvent>>,
  Expect<Equals<ServerEventMap['scrub'], ScrubEvent>>,
  Expect<Equals<ServerEventMap['retention'], RetentionEvent>>,
  Expect<Equals<ServerEventMap['cleanup'], CleanupEvent>>,
  Expect<Equals<ServerEventMap['allowlist'], AllowlistEvent>>,
  Expect<Equals<ServerEventMap['revocation'], FingerprintEvent>>,
  Expect<Equals<ServerEventMap['revoked'], FingerprintEvent>>,
  Expect<Equals<ServerEventMap['listening'], ServerListeningEvent>>,
  Expect<Equals<ServerEventMap['close'], ServerCloseEvent>>
]

type RecoveryContract = [
  Expect<
    Equals<
      RecoveryEvent['status'],
      | 'started'
      | 'completed'
      | 'failed'
      | 'CORRUPT'
      | 'COMMITTED'
      | 'ABORTED'
      | 'RESUMABLE'
      | 'MISSING'
      | 'FILE_EXISTS'
    >
  >,
  Expect<Equals<RecoveryEvent['phase'], 'classification' | 'sessions' | 'journal' | undefined>>
]

type ProtocolCodeContract = [
  Expect<Equals<StatusCode, 0 | 1 | 2 | 3 | 4>>,
  Expect<Equals<ResultCode, 0 | 1>>,
  Expect<Equals<EncodingState['buffer'], Binary>>,
  Expect<Equals<Offer['transferId'], Binary>>,
  Expect<Equals<OfferInput['transferId'], Uint8Array>>,
  Expect<Equals<Chunk['data'], Binary>>,
  Expect<Equals<ChunkInput['data'], Uint8Array>>,
  Expect<Equals<Status['code'], StatusCode>>,
  Expect<Equals<Result['code'], ResultCode>>
]

type LoggerContract = [
  Expect<Equals<Parameters<NonNullable<Logger['info']>>, [string, Record<string, unknown>?]>>,
  Expect<Equals<Parameters<NonNullable<Logger['warn']>>, [string, Record<string, unknown>?]>>,
  Expect<Equals<Parameters<NonNullable<Logger['error']>>, [string, Record<string, unknown>?]>>
]

type UploadUnionContract = [
  Expect<Equals<UploadPathEntry, SelectedUploadPath | SkippedUploadPath | FailedUploadPath>>,
  Expect<
    Equals<SkippedUploadReason, 'symlink' | 'directory' | 'not-regular-file' | 'invalid-filename'>
  >,
  Expect<Equals<ClientSuccessEvent['reason'], undefined>>,
  Expect<Equals<ClientBatchResultEvent['reason'], undefined>>,
  Expect<Equals<ClientCloseEvent['reason'], undefined>>,
  Expect<Equals<ClientFailureEvent['reason'], string | undefined>>
]

void [
  null as unknown as NoImplicitAnyListeners,
  null as unknown as ServerEventNameCoverage,
  null as unknown as ClientEventNameCoverage,
  null as unknown as ServerEventMapShapes,
  null as unknown as RecoveryContract,
  null as unknown as ProtocolCodeContract,
  null as unknown as LoggerContract,
  null as unknown as UploadUnionContract
]

server.on('authentication', (event) => {
  const check: Expect<Equals<typeof event, AuthenticationEvent>> = true
  void [check, event.fingerprint, event.status, event.reason]
})
server.on('offer', (event) => {
  const check: Expect<Equals<typeof event, ServerOfferEvent>> = true
  void [check, event.fingerprint, event.transfer, event.status, event.resumed, event.reason]
})
server.on('verification', (event) => {
  const check: Expect<Equals<typeof event, ServerTransferLifecycleEvent>> = true
  void [check, event.fingerprint, event.status, event.name, event.size]
})
server.once('commit', (event) => {
  const check: Expect<Equals<typeof event, ServerTransferLifecycleEvent>> = true
  void [check, event.transfer, event.status]
})
server.on('scrub', (event) => {
  const check: Expect<Equals<typeof event, ScrubEvent>> = true
  void [check, event.status, event.deleted, event.unknownCount]
})
server.on('cleanup', (event) => {
  const check: Expect<Equals<typeof event, CleanupEvent>> = true
  void [check, event.transfer, event.name, event.reason]
})
server.on('revoked', (event) => {
  const check: Expect<Equals<typeof event, FingerprintEvent>> = true
  void [check, event.fingerprint]
})
server.on('close', (event) => {
  const check: Expect<Equals<typeof event, ServerCloseEvent>> = true
  void [check, event.status]
})

client.on('offer', (event) => {
  const check: Expect<Equals<typeof event, ClientOfferEvent>> = true
  void [check, event.status, event.resumedChunks, event.totalChunks, event.reason]
})
client.on('progress', (event) => {
  const check: Expect<Equals<typeof event, ClientProgressEvent>> = true
  void [check, event.chunksSent, event.bytesSent]
})
client.on('verification', (event) => {
  const check: Expect<Equals<typeof event, TransferLifecycleEvent>> = true
  void [check, event.status]
})
client.once('commit', (event) => {
  const check: Expect<Equals<typeof event, ClientCommitEvent>> = true
  void [check, event.result, event.status]
})
client.on('close', (event) => {
  const check: Expect<Equals<typeof event, ClientCloseEvent>> = true
  void [check, event.status]
})

allowlistWatcher.on('reloaded', (event) => {
  const check: Expect<Equals<typeof event, AllowlistReloadedEvent>> = true
  void [check, event.count]
})
allowlistWatcher.on('removed', (event) => {
  const check: Expect<Equals<typeof event, AllowlistRemovedEvent>> = true
  void [check, event.removed]
})
allowlistWatcher.once('failure', (event) => {
  const check: Expect<Equals<typeof event, AllowlistFailureEvent>> = true
  void [check, event.reason]
})

function describeUploadEntry(entry: UploadPathEntry): string {
  if (entry.kind === 'selected') return entry.path
  if (entry.kind === 'skipped') return entry.reason
  return entry.code ?? entry.reason
}
void describeUploadEntry
