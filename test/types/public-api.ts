import { Buffer } from 'node:buffer'
import {
  type AllowlistKey,
  type BatchUploadResult,
  type Binary,
  type BitmapPage,
  type Chunk,
  type ClientEvent,
  type ClientEventName,
  type ClientOptions,
  type ClientResultEvent,
  type ClientSkippedEvent,
  Client,
  type Codec,
  type FileManifest,
  type Logger,
  type Offer,
  type Result,
  type ServerConnectionEvent,
  type ServerOptions,
  Server,
  type StorageAdapter,
  type StorageFileHandle,
  type StorageStats,
  type Status,
  type UploadResult,
  AllowlistWatcher,
  CHUNK,
  CHUNK_ACK,
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
  clientEventName
]

server.on('connection', (event: ServerConnectionEvent) => void event.connections)
server.once('listening', (event) => void event.publicKey)
client.on('result', (event: ClientResultEvent) => {
  const reason: string | undefined = event.reason
  void [event.status, reason]
})
client.on('skipped', (event: ClientSkippedEvent) => {
  void [event.name, event.reason]
  // @ts-expect-error skipped client events omit the source path
  void event.path
})
client.once('rejected-peer', (event) => void event.fingerprint)

function describeClientEvent(event: ClientEvent): string {
  if ('fingerprint' in event) return event.fingerprint
  if ('status' in event) return event.reason ?? event.status
  return event.reason
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
  clientPublicKey: clientKey,
  name: validateBasename('artifact.bin'),
  size: 0,
  digest: Buffer.alloc(DIGEST_BYTES),
  chunkSize: MAX_CHUNK_BYTES
})
const canonical = encodeTransferIdCanonical({
  clientPublicKey: clientKey,
  name: 'artifact.bin',
  size: 0,
  digest: Buffer.alloc(DIGEST_BYTES),
  chunkSize: MAX_CHUNK_BYTES
})
const request: Offer = {
  version: PROTOCOL_VERSION,
  transferId: transfer,
  name: 'artifact.bin',
  size: 0,
  digest: Buffer.alloc(DIGEST_BYTES),
  chunkSize: MAX_CHUNK_BYTES,
  chunkCount: 0
}
const encoded = encodeBounded(offer, request, MAX_CONTROL_BYTES)
const decoded: Offer = decodeBounded(offer, encoded, MAX_CONTROL_BYTES)
const pages: BitmapPage[] = [{ transferId: transfer, start: 0, count: 1, bits: Buffer.from([0]) }]
const verified: Set<number> = mergeBitmapPages(pages, 1)
const protocolResult: Result = { transferId: transfer, code: RESULT_CODE.COMMITTED }
const protocolStatus: Status = { transferId: transfer, code: STATUS_CODE.ACCEPT }
const protocolChunk: Chunk = {
  transferId: transfer,
  index: 0,
  digest: Buffer.alloc(DIGEST_BYTES),
  data: Buffer.alloc(0)
}
const completionCodec: Codec<Result> = result

void [
  AllowlistWatcher,
  CHUNK,
  CHUNK_ACK,
  canonical,
  decoded,
  ERRORS,
  FINISH,
  finish,
  keyPair,
  MAX_BITMAP_BITS,
  MAX_CHUNK_FRAME_BYTES,
  OFFER,
  parseAllowlist(''),
  parsePublicKey(serverKey.toString('hex')),
  parseSeed(seed.toString('hex')),
  protocolChunk,
  protocolResult,
  protocolStatus,
  READY,
  ready,
  RESULT,
  STATUS,
  status,
  topicFromServerPublicKey(serverKey),
  TRANSFER_ID_BYTES,
  verified,
  completionCodec,
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
