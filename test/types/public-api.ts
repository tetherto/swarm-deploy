import { Buffer } from 'node:buffer'
import {
  Client,
  ERRORS,
  Server,
  SwarmDeployError,
  generateSeed,
  keyPairFromSeed,
  parseAllowlist,
  parsePublicKey,
  parseSeed,
  parseTopic,
  publicKeyFromSeed,
  topicFromServerPublicKey,
  type AuthenticationEvent,
  type BatchUploadResult,
  type Binary,
  type BinaryInput,
  type ClientEventMap,
  type ClientOptions,
  type ClientUploadResult,
  type ErrorCode,
  type Logger,
  type PublicKey,
  type Seed,
  type ServerEventMap,
  type ServerOptions,
  type SkippedUploadReason,
  type StorageAdapter,
  type StorageFileHandle,
  type StorageStats,
  type SwarmFactory,
  type Topic,
  type UploadResult,
  // @ts-expect-error protocol constants are internal submodule details
  OFFER,
  // @ts-expect-error protocol codecs are internal submodule details
  encodeBounded,
  // @ts-expect-error storage implementations are not root exports
  SessionStore,
  // @ts-expect-error allowlist polling is owned by Server
  AllowlistWatcher
} from '../../dist/index.js'

const input: BinaryInput = new Uint8Array(32)
const seed: Seed = generateSeed()
const parsedSeed: Seed = parseSeed(seed.toString('hex'))
const publicKey: PublicKey = publicKeyFromSeed(input)
const parsedKey: PublicKey = parsePublicKey(publicKey.toString('hex'))
const keyPair = keyPairFromSeed(input)
const topic: Topic = topicFromServerPublicKey(publicKey)
const parsedTopic: Topic = parseTopic(topic.toString('hex'))
const allowlist: Set<string> = parseAllowlist(`${publicKey.toString('hex')}\n`)
const code: ErrorCode = ERRORS.CONNECT_TIMEOUT
const reservedSkip: SkippedUploadReason = 'reserved-history'
const bytes: Binary = Buffer.alloc(32)

const stats: StorageStats = {
  dev: 1,
  ino: 1,
  size: 0,
  isSymbolicLink: () => false,
  isDirectory: () => false,
  isFile: () => true
}
const handle: StorageFileHandle = {
  stat: () => Promise.resolve(stats),
  read: () => Promise.resolve({ bytesRead: 0 }),
  write: () => Promise.resolve({ bytesWritten: 0 }),
  sync: () => Promise.resolve(),
  close: () => Promise.resolve()
}
const storage: StorageAdapter = {
  readFile: () => Promise.resolve(''),
  lstat: () => Promise.resolve(stats),
  open: () => Promise.resolve(handle),
  mkdir: () => Promise.resolve(),
  rm: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  link: () => Promise.resolve(),
  unlink: () => Promise.resolve(),
  rmdir: () => Promise.resolve(),
  readdir: () => Promise.resolve([])
}
const logger: Logger = { info: (_message, _details) => {} }
const swarmFactory: SwarmFactory = (_options) => {
  throw new Error('type probe only')
}
const serverOptions: ServerOptions = {
  seed: input,
  storageDir: '/var/lib/swarm-deploy',
  allowedKeys: [parsedKey],
  maxFileBytes: 1024,
  maxStagingBytes: 2048,
  storage,
  swarmFactory,
  logger
}
const clientOptions: ClientOptions = {
  seed: input,
  topic,
  maxReconnectAttempts: 3,
  swarmFactory,
  logger
}
const server = new Server(serverOptions)
const client = new Client(clientOptions)
const uploaded: Promise<UploadResult | BatchUploadResult> = client.upload('./artifact.bin')
const uploadUnion: Promise<ClientUploadResult> = uploaded

server.on('authentication', (event: AuthenticationEvent) => void event.reason)
server.on('offer', (event: ServerEventMap['offer']) => void event.reason)
client.on('offer', (event: ClientEventMap['offer']) => void event.reason)
client.on('skipped', (event: ClientEventMap['skipped']) => {
  const reason: SkippedUploadReason = event.reason
  void reason
})

void [
  parsedSeed,
  keyPair,
  parsedTopic,
  allowlist,
  code,
  reservedSkip,
  bytes,
  server,
  client,
  uploadUnion,
  new SwarmDeployError(ERRORS.ACTIVE_UPLOAD_LIMIT, 'busy'),
  OFFER,
  encodeBounded,
  SessionStore,
  AllowlistWatcher
]
