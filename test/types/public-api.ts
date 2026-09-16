import {
  Client,
  Server,
  generateSeed,
  parseAllowlist,
  parsePublicKey,
  type ClientOptions,
  type ServerOptions,
  type UploadResult
} from '../../dist/index.js'

const clientSeed = generateSeed()
const serverSeed = generateSeed()
const client = new Client({
  seed: clientSeed,
  serverPublicKey: parsePublicKey('00'.repeat(32))
} satisfies ClientOptions)
const server = new Server({
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096
} satisfies ServerOptions)

void client
void server
const result: UploadResult | null = null
void result

// @ts-expect-error Topics are not part of the direct-DHT API.
client.topic
// @ts-expect-error Swarm discovery is not configurable.
new Client({ seed: clientSeed, topic: generateSeed() })
