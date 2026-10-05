import {
  Client,
  Server,
  generateSeed,
  parseAllowlist,
  parsePublicKey,
  type AfterCommitContext,
  type BeforeCommitContext,
  type ClientOptions,
  type HookArtifact,
  type HookFailureContext,
  type HookFailurePhase,
  type ServerHooks,
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
const stringSeedClientOptions = {
  seed: '11'.repeat(32),
  serverPublicKey: parsePublicKey('00'.repeat(32))
} satisfies ClientOptions
const stringSeedServerOptions = {
  seed: '22'.repeat(32),
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096
} satisfies ServerOptions

const hooks = {
  beforeCommit(context: BeforeCommitContext) {
    const artifact: HookArtifact = context.artifact
    const path: string = context.path
    const resumed: boolean = context.resumed
    const already: false = context.alreadyCommitted
    void [
      artifact.name,
      artifact.size,
      artifact.sha256,
      artifact.transferId,
      path,
      resumed,
      already
    ]
    void artifact.sourceParent?.length
    void artifact.release?.series
    void artifact.release?.version
    return Promise.resolve()
  },
  afterCommit(context: AfterCommitContext) {
    const already: boolean = context.alreadyCommitted
    void already
  },
  onFailure(context: HookFailureContext) {
    const phase: HookFailurePhase = context.phase
    const path: string | null = context.path
    const error: unknown = context.error
    void [phase, path, error, context.resumed, context.alreadyCommitted]
  }
} satisfies ServerHooks
const hookedServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  hooks
} satisfies ServerOptions
const emptyHooks: ServerHooks = {}
const phases: HookFailurePhase[] = [
  'offer',
  'transfer',
  'verification',
  'beforeCommit',
  'commit',
  'afterCommit'
]

void client
void server
void hookedServerOptions
void emptyHooks
void phases
void stringSeedClientOptions
void stringSeedServerOptions
const result: UploadResult | null = null
void result

// @ts-expect-error Topics are not part of the direct-DHT API.
client.topic
// @ts-expect-error Swarm discovery is not configurable.
new Client({ seed: clientSeed, topic: generateSeed() })

// @ts-expect-error Hook failure phases are a closed set.
const badPhase: HookFailurePhase = 'rollback'
void badPhase
// @ts-expect-error Hooks must be functions.
const badHooks: ServerHooks = { afterCommit: 'restart' }
void badHooks
const badBefore: BeforeCommitContext = {
  artifact: {} as HookArtifact,
  path: '',
  resumed: false,
  // @ts-expect-error beforeCommit contexts never describe an already committed artifact.
  alreadyCommitted: true
}
void badBefore
// @ts-expect-error Hook artifacts do not expose TAR bytes.
const tarBytes = ({} as HookArtifact).tar
void tarBytes
