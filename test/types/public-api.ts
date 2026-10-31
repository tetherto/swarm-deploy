import {
  Client,
  Server,
  fixedSeriesKey,
  generateSeed,
  parseAllowlist,
  parsePublicKey,
  type AfterCommitContext,
  type AfterLinkContext,
  type ArtifactKind,
  type BeforeCommitContext,
  type ClientLinkEvent,
  type ClientLinkHookFailure,
  type ClientLinkOptions,
  type ClientLinkResult,
  type ClientLinkStatus,
  type ClientEventMap,
  type ClientOptions,
  type ClientUploadOptions,
  type ErrorCode,
  type FailedOutcome,
  type HookArtifact,
  type HookFailureContext,
  type HookFailurePhase,
  type HookLink,
  type HookLinkMode,
  type HookLinkStatus,
  type HookLinkTrigger,
  type HookModes,
  type HookResponse,
  type HookResult,
  type HookResultValue,
  type OperationOutcome,
  type RetentionEvent,
  type ReleaseCoordinates,
  type ServerHooks,
  type ServerEventMap,
  type ServerLinkEvent,
  type ServerOptions,
  type StorageAdapter,
  type SymlinkCapableStorage,
  type SymlinkRule,
  type UploadHookResult,
  type UploadLinkResult,
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

const linkStatus: ClientLinkStatus = 'LINKED'
const clientLink: Promise<ClientLinkResult> = client.link('release-1.2.3', 'current')
const linkEvent: ClientLinkEvent = {
  target: 'release-1.2.3',
  name: 'current',
  status: 'LINKED',
  final: true
}
const clientLinkEvent: ClientEventMap['link'] = linkEvent
void [linkStatus, clientLink, clientLinkEvent]

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
const failedHookServerLinkEvent: ServerLinkEvent = {
  fingerprint: '0123456789ab',
  target: 'release-1.2.3',
  name: 'current',
  status: 'failed',
  reason: 'HOOK_FAILED',
  result: 'LINKED'
}
const hookResult: 'LINKED' | 'UNCHANGED' | undefined = failedHookServerLinkEvent.result
void [rejectedServerLinkEvent, mappedServerLinkEvent, hookResult]

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

function readLink(link: HookLink): void {
  const name: string = link.name
  const target: string = link.target
  const mode: HookLinkMode = link.mode
  const path: string = link.path
  const targetPath: string = link.targetPath
  void [name, target, mode, path, targetPath]
}

const kinds: ArtifactKind[] = ['file', 'directory']
const symlinkRules: SymlinkRule[] = [
  { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
  { selector: 'release.tar.gz', name: 'current.tar.gz' },
  { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/' }
]
type ManualSymlinkRule = Extract<SymlinkRule, { name?: never }>
const manualSymlinkRule: ManualSymlinkRule = { selector: 'release.tar.gz' }
const invalidManualSymlinkRule: ManualSymlinkRule = {
  selector: 'release.tar.gz',
  // @ts-expect-error A manual rule cannot include an automatic-link name.
  name: 'current.tar.gz'
}
void [manualSymlinkRule, invalidManualSymlinkRule]
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
    const outcome: OperationOutcome = context.outcome
    void [path, resumed, already, outcome]
  },
  afterLink(context: AfterLinkContext) {
    readArtifact(context.artifact)
    readLink(context.link)
    const status: HookLinkStatus = context.status
    const trigger: HookLinkTrigger = context.trigger
    const outcome: OperationOutcome = context.outcome
    void [status, trigger, outcome]
    return Promise.resolve()
  },
  onFailure(context: HookFailureContext) {
    // Null only for a link request that failed before its target was resolved.
    if (context.artifact !== null) readArtifact(context.artifact)
    const operation: 'upload' | 'link' = context.operation
    const phase: HookFailurePhase = context.phase
    const path: string | null = context.path
    const resumed: boolean = context.resumed
    const already: boolean = context.alreadyCommitted
    const error: unknown = context.error
    const link: HookLink | undefined = context.link
    const request: { readonly name: string; readonly target: string } | undefined = context.request
    const outcome: FailedOutcome = context.outcome
    const failed: 'failed' = context.outcome.status
    const code: ErrorCode = context.outcome.code
    void [operation, phase, path, resumed, already, error, link, request, outcome, failed, code]
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
  'afterCommit',
  'afterLink',
  'link'
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
  // @ts-expect-error afterLink must not require an incompatible context.
  afterLink(context: HookFailureContext) {
    void context
  },
  // @ts-expect-error onFailure may return only void or a plain JSON object, not a string.
  onFailure(context: HookFailureContext) {
    return context.phase
  }
} satisfies ServerHooks
void badHookSignatures
// @ts-expect-error Link hook statuses are a closed set.
const badLinkStatus: HookLinkStatus = 'CREATED'
// @ts-expect-error Link hook triggers are a closed set.
const badLinkTrigger: HookLinkTrigger = 'retention'
// @ts-expect-error Link hook modes are a closed set.
const badLinkMode: HookLinkMode = 'unmanaged'
void [badLinkStatus, badLinkTrigger, badLinkMode]
// @ts-expect-error Link hook contexts never expose key material.
const linkSeed = ({} as AfterLinkContext).seed
void linkSeed
// @ts-expect-error The durable link outcome is LINKED or UNCHANGED.
const badLinkResult: ServerLinkEvent['result'] = 'FAILED'
void badLinkResult
// @ts-expect-error Hook artifacts are immutable descriptions without a staging path.
const artifactPath = ({} as HookArtifact).path
void artifactPath
// @ts-expect-error The failure context error is unknown, not an Error.
const failureMessage: string = ({} as HookFailureContext).error.message
void failureMessage

// Opting in to the hook's result, and what a hook may return for it.
const linkOptions: ClientLinkOptions = { hookResult: true }
const defaultLinkOptions: ClientLinkOptions = {}
const optedIn: Promise<ClientLinkResult> = client.link('release-1.2.3', 'current', linkOptions)
const declined: Promise<ClientLinkResult> = client.link('release-1.2.3', 'current', {
  hookResult: false
})
const plainLinkResult: ClientLinkResult = { target: 'a', name: 'b', status: 'LINKED' }
const reportedLinkResult: ClientLinkResult = {
  target: 'a',
  name: 'b',
  status: 'UNCHANGED',
  hookResult: { submissionId: 'sub-1', evidence: ['u1'], detail: { queued: true, note: null } }
}
const reported: HookResult | undefined = reportedLinkResult.hookResult
void [defaultLinkOptions, optedIn, declined, plainLinkResult, reported]
// The failure policy names what happens to the link when afterLink fails; it is independent of
// the result request, and omitting it means rollback.
const rollbackOptions: ClientLinkOptions = { hookFailure: 'rollback' }
const keepOptions: ClientLinkOptions = { hookFailure: 'keep', hookResult: true }
const policy: ClientLinkHookFailure = 'keep'
const policyOptions: ClientLinkOptions = { hookFailure: policy }
const keptLink: Promise<ClientLinkResult> = client.link('release-1.2.3', 'current', keepOptions)
const restoredEvent: ServerLinkEvent = {
  fingerprint: '0123456789ab',
  target: 'release-1.2.3',
  name: 'current',
  status: 'failed',
  reason: 'HOOK_FAILED',
  rolledBack: true
}
const rolledBack: true | undefined = restoredEvent.rolledBack
void [rollbackOptions, policyOptions, keptLink, rolledBack]
// @ts-expect-error The failure policy is a closed set.
const badPolicy: ClientLinkOptions = { hookFailure: 'delete' }
// @ts-expect-error The failure policy is a word, not a flag.
const flagPolicy: ClientLinkOptions = { hookFailure: true }
// @ts-expect-error The server event only ever says a request was restored.
const notRolledBack: ServerLinkEvent['rolledBack'] = false
void [badPolicy, flagPolicy, notRolledBack]
// @ts-expect-error The link options are hookFailure and hookResult only.
const unknownLinkOption: ClientLinkOptions = { results: true }
// @ts-expect-error hookResult is a boolean.
const stringLinkOption: ClientLinkOptions = { hookResult: 'yes' }
void [unknownLinkOption, stringLinkOption]
// @ts-expect-error The options are an object, not a bare flag.
void client.link('release-1.2.3', 'current', true)

const resultValue: HookResultValue = ['x', 1, true, null, { nested: [{ deep: 'y' }] }]
const plainResult: HookResult = { id: 'sub-1', attempts: 2, ratio: 0.5, accepted: true, note: null }
const nestedResult: HookResult = { evidence: [{ url: 'u1' }, ['u2']], detail: { queue: [] } }
void [resultValue, plainResult, nestedResult]
const resultHooks = {
  async afterLink(context: AfterLinkContext) {
    return {
      submissionId: context.link.name,
      accepted: context.status === 'LINKED',
      evidence: [context.artifact.sha256],
      detail: { transferId: context.artifact.transferId, release: null }
    }
  }
} satisfies ServerHooks
const syncResultHook: ServerHooks = { afterLink: () => ({ submitted: true }) }
// The result is optional, so a hook that returns nothing, as every earlier hook did, still fits.
const voidHook: ServerHooks = { afterLink: () => {} }
const asyncVoidHook: ServerHooks = { afterLink: async () => {} }
const maybeResultHook: ServerHooks = {
  afterLink: async (context): Promise<HookResult | undefined> =>
    context.status === 'LINKED' ? { linked: true } : undefined
}
void [resultHooks, syncResultHook, voidHook, asyncVoidHook, maybeResultHook]
// @ts-expect-error A hook result is a JSON object, not a primitive.
const primitiveResultHook: ServerHooks = { afterLink: () => 'ok' }
// @ts-expect-error A hook result is an object, not an array.
const arrayResultHook: ServerHooks = { afterLink: () => ['ok'] }
// The post-operation hooks may all return data; whether it is read depends on their declaration.
const commitResultHook: ServerHooks = { afterCommit: () => ({ id: 1 }) }
const failureResultHook: ServerHooks = { onFailure: async () => ({ ticket: 'T-1' }) }
// @ts-expect-error beforeCommit is a gate and returns nothing.
const gateResultHook: ServerHooks = { beforeCommit: () => ({ id: 1 }) }
// @ts-expect-error A hook result is an object, not a primitive.
const commitPrimitiveHook: ServerHooks = { afterCommit: () => 'ok' }
void [
  primitiveResultHook,
  arrayResultHook,
  commitResultHook,
  failureResultHook,
  gateResultHook,
  commitPrimitiveHook
]

// Which post-operation hooks are awaited is a declaration, never inferred from the callback.
const responseMode: HookResponse = 'response'
const detachedMode: HookResponse = 'detached'
const declared: HookModes = {
  afterCommit: 'response',
  afterLink: 'detached',
  onFailure: responseMode
}
const emptyDeclaration: HookModes = {}
const declaredServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  hooks,
  hookModes: declared
} satisfies ServerOptions
const noDeclarationOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  hookModes: null
} satisfies ServerOptions
void [detachedMode, emptyDeclaration, declaredServerOptions, noDeclarationOptions]
// @ts-expect-error A declaration is response or detached.
const badMode: HookResponse = 'await'
// @ts-expect-error beforeCommit is a gate and takes no declaration.
const gateDeclaration: HookModes = { beforeCommit: 'response' }
// @ts-expect-error The declaration is a word, not a flag.
const flagDeclaration: HookModes = { afterLink: true }
void [badMode, gateDeclaration, flagDeclaration]

// What a hook is told about how the operation ended.
const succeeded: OperationOutcome = { status: 'succeeded' }
const failedOutcome: OperationOutcome = {
  status: 'failed',
  code: 'HOOK_FAILED',
  phase: 'afterLink'
}
const narrowed: ErrorCode | null = failedOutcome.status === 'failed' ? failedOutcome.code : null
void [succeeded, narrowed]
// @ts-expect-error A succeeded outcome carries no failure code.
const succeededWithCode: OperationOutcome = { status: 'succeeded', code: 'HOOK_FAILED' }
// @ts-expect-error A failed outcome names its code and phase.
const incompleteFailure: OperationOutcome = { status: 'failed' }
void [succeededWithCode, incompleteFailure]

// Asking an upload for its hooks' data, and what comes back.
const uploadOptions: ClientUploadOptions = { hookResult: true }
const askedUpload: Promise<UploadResult> = client.upload('./app.tar.gz', uploadOptions)
const plainUpload: Promise<UploadResult> = client.upload('./app.tar.gz')
const linkEntry: UploadLinkResult = { name: 'latest', target: 'app-1.tar.gz', result: { id: 1 } }
const uploadData: UploadHookResult = { afterCommit: { id: 'dep-1' }, afterLink: [linkEntry] }
const failedUploadData: UploadHookResult = { onFailure: { ticket: 'T-1' } }
const reportedUpload: UploadResult = { ...directoryResult, hookResult: uploadData }
const afterCommitData: HookResult | undefined = reportedUpload.hookResult?.afterCommit
void [askedUpload, plainUpload, failedUploadData, afterCommitData]
// @ts-expect-error The upload options are hookResult only.
const unknownUploadOption: ClientUploadOptions = { hookFailure: 'keep' }
// @ts-expect-error hookResult is a boolean.
const stringUploadOption: ClientUploadOptions = { hookResult: 'yes' }
// @ts-expect-error The upload data has only the three known hooks.
const unknownUploadKey: UploadHookResult = { beforeCommit: {} }
void [unknownUploadOption, stringUploadOption, unknownUploadKey]
// @ts-expect-error A Date is not a JSON value.
const dateResult: HookResult = { when: new Date() }
// @ts-expect-error A function is not a JSON value.
const functionResult: HookResult = { run: () => 1 }
// @ts-expect-error undefined is not a JSON value.
const undefinedResult: HookResult = { missing: undefined }
// @ts-expect-error A BigInt is not a JSON value.
const bigintResult: HookResult = { count: 1n }
// @ts-expect-error A result is an object, not an array.
const arrayResult: HookResult = ['x']
void [dateResult, functionResult, undefinedResult, bigintResult, arrayResult]
// @ts-expect-error A returned result is read-only data.
plainResult.id = 'changed'

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

// The private state directory is optional and a path string; the layout helpers stay internal.
const stateServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/artifacts',
  stateDir: '/var/lib/swarm-deploy/artifacts',
  initializeState: true,
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096
} satisfies ServerOptions
const configuredState: string | undefined = new Server(stateServerOptions).stateDir
const initializing: boolean = new Server(stateServerOptions).initializeState
void [stateServerOptions, configuredState, initializing]
// @ts-expect-error Initialization is acknowledged with a boolean, not a word.
const wordInitialization: ServerOptions['initializeState'] = 'yes'
void wordInitialization
// @ts-expect-error The state directory is a path, not a flag.
const flagState: ServerOptions['stateDir'] = true
void flagState
declare const publicApi: typeof import('../../dist/index.js')
// @ts-expect-error The storage layout helpers are internal, not public exports.
void publicApi.initLayout
// @ts-expect-error The storage layout helpers are internal, not public exports.
void publicApi.resolveLayout
