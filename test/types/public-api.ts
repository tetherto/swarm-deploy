import {
  Client,
  Server,
  fixedSeriesKey,
  generateSeed,
  parseAllowlist,
  parsePublicKey,
  type AfterCommitContext,
  type ArtifactKind,
  type BeforeCommitContext,
  type ClientLinkEvent,
  type ClientLinkResult,
  type ClientLinkStatus,
  type ClientEventMap,
  type ClientOptions,
  type HookArtifact,
  type HookFailureContext,
  type HookFailurePhase,
  type ReleaseCoordinates,
  type RetentionEvent,
  type LinkRequestRecord,
  type LinkResultRecord,
  type ServerHooks,
  type ServerEventMap,
  type ServerLinkEvent,
  type ServerOptions,
  type StorageAdapter,
  type SymlinkCapableStorage,
  type SymlinkRule,
  type UploadResult,
  type UploadTarget,
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

const linkRequest: LinkRequestRecord = {
  v: 1,
  kind: 'link',
  target: 'release-1.2.3',
  name: 'current'
}
const linkResults: LinkResultRecord[] = [
  { v: 1, status: 'LINKED' },
  { v: 1, status: 'UNCHANGED' },
  { v: 1, status: 'FAILED', code: 'LINK_TARGET_NOT_FOUND' }
]
const linkStatus: ClientLinkStatus = 'LINKED'
const clientLink: Promise<ClientLinkResult> = client.link('release-1.2.3', 'current')
const linkEvent: ClientLinkEvent = {
  target: 'release-1.2.3',
  name: 'current',
  status: 'LINKED',
  final: true
}
const clientLinkEvent: ClientEventMap['link'] = linkEvent
void [linkRequest, linkResults, linkStatus, clientLink, clientLinkEvent]

const serverLinkEvent: ServerLinkEvent = {
  fingerprint: '0123456789ab',
  target: 'release-1.2.3',
  name: 'current',
  status: 'linked'
}
const rejectedServerLinkEvent: ServerLinkEvent = {
  fingerprint: '0123456789ab',
  target: 'missing',
  name: 'current',
  status: 'rejected',
  reason: 'LINK_TARGET_NOT_FOUND'
}
const mappedServerLinkEvent: ServerEventMap['link'] = serverLinkEvent
void [rejectedServerLinkEvent, mappedServerLinkEvent]

function readArtifact(artifact: HookArtifact): void {
  const name: string = artifact.name
  const kind: ArtifactKind = artifact.kind
  const size: number = artifact.size
  const sha256: string = artifact.sha256
  const transferId: string = artifact.transferId
  const entryCount: number | undefined = artifact.entryCount
  const sourceParent: string | undefined = artifact.sourceParent
  const release: ReleaseCoordinates | undefined = artifact.release
  const series: string | undefined = release?.series
  const version: string | undefined = release?.version
  void [name, kind, size, sha256, transferId, entryCount, sourceParent, release, series, version]
}

const kinds: ArtifactKind[] = ['file', 'directory']
const symlinkRules: SymlinkRule[] = [
  { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
  { selector: 'release.tar.gz', name: 'current.tar.gz' },
  { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/' }
]
const symlinkServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  symlinks: symlinkRules
} satisfies ServerOptions
const target: UploadTarget = { kind: 'directory', name: '0.18.1', path: '/srv/build/0.18.1' }
void [kinds, symlinkServerOptions, target]

function readDirectoryArtifact(artifact: HookArtifact): void {
  const kind: ArtifactKind = artifact.kind
  const entryCount: number | undefined = artifact.entryCount
  void [kind, entryCount]
}
void readDirectoryArtifact

const directoryResult: UploadResult = {
  status: 'COMMITTED',
  kind: 'directory',
  name: '0.18.1',
  size: 10,
  digest: Buffer.alloc(32),
  transferId: Buffer.alloc(32),
  entryCount: 4
}
void directoryResult

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
const derivedSeries: string = fixedSeriesKey('{version}/payments.tar.gz')
const derivedSeriesRelease: ReleaseCoordinates = { series: fixedSeriesKey('{version}.bin') }
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
void derivedSeries
void derivedSeriesRelease
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

declare const symlinkStorage: SymlinkCapableStorage
const storageAdapter: StorageAdapter = symlinkStorage
const linkTarget: Promise<string> = symlinkStorage.readlink('link')
const linked: Promise<void> = symlinkStorage.symlink('target', 'link')
void storageAdapter
void linkTarget
void linked

// @ts-expect-error Artifact kinds are a closed set.
const badKind: ArtifactKind = 'symlink'
void badKind
// @ts-expect-error Symlink rules are two-string records, not regular expressions.
const badRules: ServerOptions['symlinks'] = [/^\d+$/]
void badRules
// @ts-expect-error Directory batch upload results were removed.
const batch = ({} as UploadResult).results
void batch
// @ts-expect-error The client no longer reports skipped directory members.
const skippedEvent: keyof ClientEventMap = 'skipped'
void skippedEvent
// @ts-expect-error There is no user-facing atomic-directory option.
const atomicOptions: ServerOptions = { ...symlinkServerOptions, atomicDirectory: true }
void atomicOptions
