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
  type ReleaseCoordinates,
  type RetentionEvent,
  type ServerHooks,
  type ServerOptions,
  type UploadResult,
  type VersionGranularity
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
  serverPublicKey: parsePublicKey('00'.repeat(32)),
  includeSourceParent: false
} satisfies ClientOptions
const stringSeedServerOptions = {
  seed: '22'.repeat(32),
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096
} satisfies ServerOptions

function readArtifact(artifact: HookArtifact): void {
  const name: string = artifact.name
  const size: number = artifact.size
  const sha256: string = artifact.sha256
  const transferId: string = artifact.transferId
  const sourceParent: string | undefined = artifact.sourceParent
  const release: ReleaseCoordinates | undefined = artifact.release
  const series: string | undefined = release?.series
  const version: string | undefined = release?.version
  void [name, size, sha256, transferId, sourceParent, release, series, version]
}

const hooks = {
  beforeCommit(context: BeforeCommitContext) {
    readArtifact(context.artifact)
    const path: string = context.path
    const resumed: boolean = context.resumed
    const already: false = context.alreadyCommitted
    void [path, resumed, already]
    return Promise.resolve()
  },
  afterCommit(context: AfterCommitContext) {
    readArtifact(context.artifact)
    const path: string = context.path
    const resumed: boolean = context.resumed
    const already: boolean = context.alreadyCommitted
    void [path, resumed, already]
  },
  onFailure(context: HookFailureContext) {
    readArtifact(context.artifact)
    const phase: HookFailurePhase = context.phase
    const path: string | null = context.path
    const resumed: boolean = context.resumed
    const already: boolean = context.alreadyCommitted
    const error: unknown = context.error
    void [phase, path, resumed, already, error]
    return Promise.resolve()
  }
} satisfies ServerHooks
const granularities: VersionGranularity[] = ['major', 'minor']
const release: ReleaseCoordinates = { series: 'payments', version: '2.4.1' }
const fixedSeriesRelease: ReleaseCoordinates = { series: 'payments' }
const hookedServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  artifactPatterns: ['{series}-{version}.tar.gz', '{version}/{series}.zip'],
  maxCount: 5,
  maxVersions: 3,
  versionGranularity: 'minor',
  hooks
} satisfies ServerOptions
const nullHooksServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  artifactPatterns: new Set(['{series}.tar.gz']),
  maxCount: 1,
  hooks: null
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
void nullHooksServerOptions
void granularities
void release
void fixedSeriesRelease
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

const retentionEvent: RetentionEvent = {
  trigger: 'post-commit',
  status: 'completed',
  ageDeleted: 0,
  countDeleted: 1,
  versionDeleted: 2,
  storageDeleted: 3
}
const countDeleted: number | undefined = retentionEvent.countDeleted
const versionDeleted: number | undefined = retentionEvent.versionDeleted
void [countDeleted, versionDeleted]

const badGranularityOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  // @ts-expect-error Version granularity is limited to major or minor.
  versionGranularity: 'patch'
} satisfies ServerOptions
void badGranularityOptions
// @ts-expect-error Version granularity is a closed set.
const badGranularity: VersionGranularity = 'patch'
void badGranularity
// @ts-expect-error Artifact patterns are template strings.
const badPatterns: ServerOptions['artifactPatterns'] = [/payments/]
void badPatterns
// @ts-expect-error Release series is required.
const badRelease: ReleaseCoordinates = { version: '1.0.0' }
void badRelease
const badHookSignatures = {
  // @ts-expect-error beforeCommit receives exactly one context argument.
  beforeCommit(first: BeforeCommitContext, second: string) {
    void [first, second]
  },
  // @ts-expect-error afterCommit must not require an incompatible context.
  afterCommit(context: HookFailureContext) {
    void context
  },
  // @ts-expect-error onFailure must return void or a promise of void.
  onFailure(context: HookFailureContext) {
    return context.phase
  }
} satisfies ServerHooks
void badHookSignatures
// @ts-expect-error Hook artifacts are immutable descriptions without a staging path.
const artifactPath = ({} as HookArtifact).path
void artifactPath
// @ts-expect-error The failure context error is unknown, not an Error.
const failureMessage: string = ({} as HookFailureContext).error.message
void failureMessage
