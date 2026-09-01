import { Buffer } from 'node:buffer'
import {
  type AllowlistKey,
  type BatchUploadResult,
  type Binary,
  type BitmapPage,
  type Chunk,
  type ClientEvent,
  type ClientOptions,
  type ClientResultEvent,
  Client,
  type Codec,
  type FileManifest,
  type Logger,
  type Offer,
  type Result,
  type ServerConnectionEvent,
  type ServerOptions,
  Server,
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

const seed: Binary = generateSeed()
const serverKey = publicKeyFromSeed(seed)
const clientKey = publicKeyFromSeed(Buffer.alloc(32, 2))
const keyPair = keyPairFromSeed(seed)
const logger: Logger = {
  info(message, details) {
    void message
    void details
  }
}

const serverOptions: ServerOptions = {
  seed,
  storageDir: '/var/lib/swarm-deploy',
  allowedKeys: [clientKey, clientKey.toString('hex') as AllowlistKey],
  maxFileBytes: MAX_CHUNK_BYTES,
  maxStagingBytes: MAX_CHUNK_BYTES * 2,
  logger
}
const clientOptions: ClientOptions = {
  seed: Buffer.alloc(32, 2),
  serverPublicKey: serverKey,
  logger
}

const server = new Server(serverOptions)
const client = new Client(clientOptions)
const listening: Promise<Server> = server.listen()
const reloaded: Promise<Set<string>> = server.reloadAllowlist([clientKey])
const closedServer: Promise<void> = server.close()
const uploaded: Promise<UploadResult | BatchUploadResult> = client.upload('./artifact.bin')
const closedClient: Promise<void> = client.close()
void [listening, reloaded, closedServer, uploaded, closedClient]

server.on('connection', (event: ServerConnectionEvent) => void event.connections)
server.once('listening', (event) => void event.publicKey)
client.on('result', (event: ClientResultEvent) => void event.status)
client.once('rejected-peer', (event: ClientEvent) => void event.fingerprint)

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
