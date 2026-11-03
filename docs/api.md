# Runtime API

The package is strict TypeScript and exposes the same root API to ESM and
CommonJS consumers. Back to the [README](../README.md).

## Contents

- [Identity helpers](#identity-helpers)
- [Server](#server)
- [Client](#client)
- [Link results](#link-results)
- [Upload results](#upload-results)
- [Events](#events)
- [Logging](#logging)
- [Errors](#errors)

Related guides: the [CLI reference](cli.md),
[artifact patterns and rotation](artifact-patterns.md),
[managed symlinks](managed-links.md), [deployment hooks](hooks.md), and
[operations and storage](operations.md).

## Identity helpers

```ts
import {
  generateSeed,
  keyPairFromSeed,
  parsePublicKey,
  parseSeed,
  publicKeyFromSeed
} from 'swarm-deploy'

const seed = generateSeed() // 32 random bytes
const restored = parseSeed(process.env.SEED!) // strict lowercase hex
const keyPair = keyPairFromSeed(restored)
const publicKey = publicKeyFromSeed(restored)
const peer = parsePublicKey(process.env.PEER_PUBLIC_KEY!)
```

`parseSeed` and `parsePublicKey` require exactly 64 lowercase hexadecimal
characters. `keyPairFromSeed` is deterministic.

`parseAllowlist(text)` parses lowercase client public keys separated by
newlines. Blank lines and lines beginning with `#` are ignored; malformed or
duplicate keys throw. It returns a `Set<string>` suitable for
`ServerOptions.allowedKeys`.

`fixedSeriesKey(template)` returns the series a template without `{series}`
persists, so an operator reading `fixed-…` in a commit sidecar, retention log,
or hook context can identify which configured pattern owns it:

```ts
import { fixedSeriesKey } from 'swarm-deploy'

const owner = patterns.find((template) => fixedSeriesKey(template) === record.release?.series)
```

## Server

```ts
import { Server, parsePublicKey } from 'swarm-deploy'

const server = new Server({
  seed: process.env.SWARM_DEPLOY_SERVER_SEED!,
  storageDir: '/srv/artifacts',
  allowedKeys: [
    parsePublicKey(process.env.CLIENT_A_PUBLIC_KEY!),
    parsePublicKey(process.env.CLIENT_B_PUBLIC_KEY!)
  ],
  maxFileBytes: 1024 ** 3,
  maxStagingBytes: 4 * 1024 ** 3,
  maxConnections: 64,
  maxActiveUploads: 8,
  idleTimeout: 60_000,
  cleanupInterval: 15 * 60_000,
  resumeTtl: 7 * 24 * 60 * 60_000,
  minFreeBytes: 1024 ** 3,
  maxAge: 15 * 24 * 60 * 60_000,
  maxStorageBytes: 100 * 1024 ** 3,
  replaceNames: ['release.tar.gz', 'latest.json']
})

await server.listen()
console.log(server.publicKey.toString('hex'))

// Later, after draining or on process shutdown:
await server.close()
```

Required `ServerOptions`:

- `seed: Buffer | string`
- `storageDir: string`
- `allowedKeys: Iterable<Buffer | string>`
- `maxFileBytes: number`
- `maxStagingBytes: number`

Optional operational limits and policies:

- `stateDir?: string`: absolute path of the private state directory (also
  readable as `server.stateDir`). `storageDir` is the output root and holds only
  published artifacts and managed links, so it may be served; everything private
  lives in the state directory. Omitted, it is `~/.swarm-deploy/<id>` under the
  home directory the runtime reports for the user running the server
  (`os.homedir()`, which honors `HOME`), with `<id>` derived from the real path of
  `storageDir`. A custom directory must be outside `storageDir` and on the same
  filesystem (and, on Linux, the same mount; a volume mounted directly at
  `storageDir` shares its mount with nothing outside it, so mount a common
  parent and use one subdirectory for each), is kept at mode `0700`, and serves
  one `storageDir` only; `listen()` rejects otherwise, while
  `<storageDir>/.swarm-deploy` from 0.6.0 or earlier still exists, and when the
  user's default state for the root can be read, is bound to it, and `stateDir`
  names another (a default that cannot be examined is ignored).
  Every instance for one root must use the same user, `HOME`, and value. While
  a server runs, `<storageDir>/.swarm-deploy` reappearing makes it refuse new
  uploads, link requests, and retention passes. It logs one legacy-state alert,
  without a path, when it first sees the directory, and each refused scheduled
  retention pass logs its own failure (also without a path). See
  [Private state](../README.md#private-state).
- `initializeState?: boolean` (also readable as `server.initializeState`): a
  one-time acknowledgement. `listen()` rejects when it would start new state, or
  bind a directory that holds entries but no record of its root, while
  `storageDir` already holds entries, unless this is `true`. Set it once after
  deleting state on purpose or migrating from 0.6.0 or earlier, then leave it
  unset: state already bound to the root needs no flag, and keeping it would let
  a mistaken `stateDir` or `HOME` start a second set of state. Published files are
  never adopted or deleted.
- `maxConnections`, `maxActiveUploads`, `idleTimeout`
- `cleanupInterval`, `resumeTtl`, `minFreeBytes`. `minFreeBytes: 0` turns the
  free-disk reserve off for API callers; the CLI has no such value. From 0.7.0 the
  reserve check adds up what the open sessions can still write (a receiving
  session's remaining durable TAR plus its full payload; a verified or deleting
  session owes nothing) instead of every session's full reservation, so bytes
  that are already on disk are no longer counted twice. It does not reduce the
  peak of a fresh upload, which still needs its TAR and its extracted payload
  at once; `maxStagingBytes` and the reservations themselves are unchanged.
- `maxAge`, `maxStorageBytes`, `replaceNames`
- `artifactPatterns?: Iterable<string>`, `maxCount?: number`,
  `maxVersions?: number`, and `versionGranularity?: 'major' | 'minor'`; see
  [Artifact patterns and rotation](artifact-patterns.md).
- `retentionScopes?: Iterable<RetentionScope>` (0.7.0), opt-in cleanup of the
  committed artifacts whose basename matches a release template, whether or not
  `artifactPatterns` admitted them. `RetentionScope` is exported:
  `{ pattern: string; maxCount?: number; maxAge?: number }`, with `maxAge` in
  milliseconds. Omitted or empty, nothing changes. The list is validated and
  copied when the server is constructed (read it back as
  `server.retentionScopes`, a frozen list of plain copies), and an invalid one
  throws `PROTOCOL_INVALID`. See
  [Scoped retention](artifact-patterns.md#scoped-retention).
- `symlinks?: Iterable<SymlinkRule>` with automatic
  `{ selector, name }` and manual-authorization `{ selector }` entries; see
  [Managed symlinks](managed-links.md).
- `hooks?: ServerHooks | null`; see [Deployment hooks](hooks.md).
- `hookModes?: HookModes | null`: which post-operation hooks (`afterCommit`,
  `afterLink`, `onFailure`) are `'response'`, awaited before the answer. Every
  other post-operation hook is `'detached'`: it runs after the answer, and nothing
  waits for it. See
  [Response and detached hooks](hooks.md#response-and-detached-hooks).

The root package exports the `ServerHooks`, `HookModes`, `HookResponse`,
`OperationOutcome`, `FailedOutcome`, `BeforeCommitContext`,
`AfterCommitContext`, `AfterLinkContext`, `HookFailureContext`,
`HookFailurePhase`, `HookArtifact`, `HookLink`, `HookLinkMode`, `HookLinkStatus`,
`HookLinkTrigger`, `HookResult`, `HookResultValue`, `UploadHookResult`,
`UploadLinkResult`, `ClientUploadOptions`, `ReleaseCoordinates`, and
`VersionGranularity` types:

```ts
import { Server, type HookModes, type ServerHooks } from 'swarm-deploy'

const hooks: ServerHooks = {
  async afterCommit({ artifact, path, alreadyCommitted }) {
    // Idempotent: skip work already recorded for artifact.transferId.
    const deployment = await deploy(artifact.transferId, path)
    return { deploymentId: deployment.id } // data for a client that asks
  },
  async afterLink({ link, artifact, status, trigger, outcome }) {
    // Detached: runs after the answer; `outcome` says how the operation ended.
    if (outcome.status === 'succeeded') await publish(link.name, artifact.transferId)
  },
  onFailure({ phase, path, error, outcome }) {
    // Every failed operation, including ones before anything durable exists.
    console.error(phase, path, outcome.code, error)
  },
  async beforeClose() {
    // Called once by close(), before the server lets go of its storage: cancel what your
    // hooks started outside the server and resolve once none of it can continue.
    await publisher.cancelAndDrain()
  }
}
// afterCommit gates the upload, so it is a response hook; the others stay detached.
// beforeClose is the teardown callback and takes no declaration.
const hookModes: HookModes = { afterCommit: 'response' }
const server = new Server({ /* ... */ hooks, hookModes })
```

`ServerHooks.beforeClose?(): void | Promise<void>` (0.6.2 or newer) is always awaited
by `close()`: the server stops admitting connections, calls it at once, aborts its
operations, and releases the storage lock and emits `close` only after it settled
and the operations finished. It is called once however often `close()` is called,
and it owns its own cancellation and time bounds: the server never abandons it. If
it throws or rejects, `close()` rejects with `HOOK_FAILED` (fixed message, raw error
only as `cause`) after the same teardown, and the `close` event reports `failed`.
See [Shutdown cleanup: beforeClose](hooks.md#shutdown-cleanup-beforeclose).

Advanced integration and test seams:

- `dht` or `dhtFactory` for an injected HyperDHT node.
- `storage` for a compatible filesystem adapter.
- `scheduler` for timeout and interval control.
- `logger` with optional `info`, `warn`, and `error` methods.

## Client

```ts
import { Client, parsePublicKey } from 'swarm-deploy'

const client = new Client({
  seed: process.env.SWARM_DEPLOY_CLIENT_SEED!,
  serverPublicKey: parsePublicKey(process.env.SWARM_DEPLOY_SERVER_KEY!),
  connectTimeout: 30_000,
  idleTimeout: 60_000
})

const result = await client.upload('./dist/release.tar.gz')
console.log(result.status, result.name, result.size)

await client.close()
```

`ClientOptions.seed` accepts a Buffer or canonical lowercase 64-character hex
string. `serverPublicKey` is a Buffer produced by `parsePublicKey`. Optional
values are `connectTimeout`, `idleTimeout`, `includeSourceParent`, `dht`,
`dhtFactory`, and `logger`.

`connectTimeout` defaults to 30 seconds. `idleTimeout` defaults to 60 seconds.
`includeSourceParent` defaults to `true`; set it to `false` to suppress the
[source parent](artifact-patterns.md#source-parent) for every upload the client
makes. Calling `close()` aborts pending work, closes active sockets, and is
idempotent.

## Link results

`Client.link(target, name, options?)` resolves to:

```ts
interface ClientLinkOptions {
  hookFailure?: 'rollback' | 'keep' // default 'rollback'
  hookResult?: boolean // default false
}

interface ClientLinkResult {
  target: string
  name: string
  status: 'LINKED' | 'UNCHANGED'
  hookResult?: HookResult // only when requested and the hook returned an object
}
```

`hookFailure` says what the server does with the link it just made when its
`response` `afterLink` hook fails (it has no effect on a `detached` one, which cannot
fail the request and leaves nothing to restore). The request waits for the hook in
both modes, and a failed hook is `HOOK_FAILED` in both. `'rollback'` (the default) restores the previous
local symlink and its ownership record, or removes a link the request created,
before the error is returned; `'keep'` leaves the new link in place, as 0.5.x did.
Neither undoes the uploaded artifact or anything the hook did elsewhere, and
neither affects an upload's automatic links. After a rollback the same request
links afresh (`LINKED`), after `'keep'` it returns `UNCHANGED`. The policy is
always sent, so a server older than 0.6.0 rejects the request and the call fails
rather than keeping a link you expected to be rolled back; upgrade servers
first. If a restore cannot be proven or fails, the call fails with `LINK_FAILED`
instead and the server leaves what it found. See
[Rollback and its limits](hooks.md#rollback-and-its-limits). Unknown options and
values reject with `PROTOCOL_INVALID` before connecting.

`hookResult: true` asks the server to send back what its `response` `afterLink`
hook returned, a
plain JSON object (`HookResult`, with `HookResultValue` for its values) the hook
author chose to report, such as an accepted submission's ID or evidence URL. It
arrives only after the hook has resolved and is absent when the server has no
hook, the hook is `detached`, or the hook returned nothing. It is data the hook
reported, not proof that
anything was published, and it is never placed in client events or logs. Without
the option the answer is exactly what earlier versions returned, and it is
independent of `hookFailure`. The option only asks for data to be sent: whether
the server waits for the hook is its own declaration and never depends on it. When
a failed request's answer carries data from the server's `response` `onFailure`, it is
`error.hookResult` on the thrown `SwarmDeployError`, next to the unchanged primary
`error.code`. An opted-in request needs a server of version 0.5.0 or later;
an older server rejects it, so the call fails rather than returning without the
result. A server that sends a result nobody asked for, or a malformed one, fails
the call with `PROTOCOL_INVALID`. See
[Link publication hooks](hooks.md#link-publication-hooks) for the limits and what
to put in the result.

```ts
const { status, hookResult } = await client.link('app-2.4.1.tar.gz', 'latest', {
  hookResult: true
})
```

The client validates both names before connecting. Link operations share the
client's pinned server identity, authenticated client identity, connection and
idle timeouts, serialized operation queue, cancellation, and `close()`
behavior with uploads. See [Managed symlinks](managed-links.md) for the
server-side rules.

## Upload results

A direct file resolves to:

```ts
interface UploadResult {
  status: 'COMMITTED' | 'ALREADY_COMMITTED'
  kind: 'file' | 'directory'
  name: string
  size: number
  digest: Buffer
  transferId: Buffer
  entryCount?: number
  hookResult?: UploadHookResult // only when requested and a response hook returned data
}

interface ClientUploadOptions {
  hookResult?: boolean // default false
}

interface UploadHookResult {
  afterCommit?: HookResult
  afterLink?: Array<{ name: string; target: string; result: HookResult }>
  onFailure?: HookResult // only on the error of a failed upload
}
```

Files and directories share the same result shape. For a directory, `size` is
aggregate payload bytes and `entryCount` counts stored entries (files and
directories).

`Client.upload(path, { hookResult: true })` asks the server to send back the data
its `response`-declared hooks returned: `afterCommit`'s object and one `afterLink`
entry per automatic link whose `response` `afterLink` returned an object. The
combined JSON is bounded to 3 KiB, and a failed upload's error carries
`error.hookResult.onFailure` when the server's `response` `onFailure` returned
data. The option only asks for the data to be sent; it never decides whether the
server waits for a hook. The opt-in is sent only when asked for and is not part of
the transfer identity, so a request that does not ask is unchanged; a server older
than 0.6.0 rejects an opted-in offer, so the call fails rather than returning
without the data. Unknown options reject with `PROTOCOL_INVALID` before
connecting. See [Returning data in the answer](hooks.md#link-publication-hooks).

## Events

`Server` and `Client` are event emitters. Listener and logger exceptions are
contained and cannot change protocol correctness.

Public peer and transfer correlation fields use 12-character SHA-256
fingerprints. Events never expose seeds, secret keys, full remote public keys,
TAR contents, or resumable session material. Internal storage warnings may
include a full SHA-256 uploader hash (`uploaderKeyId`, see [Logging](#logging)),
but never the uploader key itself.

Server events:

- `authentication`: accepted client fingerprint.
- `connection`, `connection-open`, `connection-close`: authenticated connection
  lifecycle and current count.
- `offer`: accepted, resumed, reset, rejected, or already-committed state.
  Includes artifact `kind`.
- `progress`: durable TAR bytes received and total TAR bytes. Includes artifact
  `kind`.
- `verification`: started, succeeded, or failed.
- `commit`: succeeded or failed.
- `recovery`: startup, per-journal, corruption, resumable, and completion
  outcomes.
- `retention`: startup, scheduled, manual, commit, or post-commit outcomes,
  with `expiredSessions`, `scrubbed`, `ageDeleted`, `countDeleted`,
  `versionDeleted`, and `storageDeleted` counters, plus `scopedDeleted` only
  when `retentionScopes` are configured (0.7.0).
- `link`: one terminal manual-link outcome with `target`, `name`, client
  fingerprint, and status `linked`, `unchanged`, `rejected`, or `failed`.
  Rejected and failed outcomes also include a stable `reason`. A failed
  `response` `afterLink` hook is `failed` with reason `HOOK_FAILED` and either
  `rolledBack: true` (the previous link and record were restored; there is no
  `result`) or `result` (`LINKED` or `UNCHANGED`), the outcome that stayed in place
  after `keep` or a request that changed nothing. A restore that could not be
  proven or failed is `failed` with `LINK_FAILED` and neither field.
  Automatic links emit no `link` event.
- `failure`: stable failure code and peer fingerprint.
- `listening`: local server-key fingerprint.
- `close`: closed or failed outcome, emitted once after the storage lock was
  released; `failed` means the `beforeClose` hook threw or rejected.

Client events:

- `connection`, `connection-open`, `connection-close`
- `offer`: offered, accepted, resumed, reset, rejected, or already committed.
- `progress`: cumulative TAR `bytesSent` and full `totalBytes`, including a
  durable resume offset.
- `verification`, `commit`
- `result`: terminal upload result with artifact `kind`.
- `link`: after the request is written, `requested` with `final: false`,
  followed by exactly one `LINKED`, `UNCHANGED`, or stable error code with
  `final: true`. A request-write failure after connection can emit only the
  terminal failed event. Local argument validation, an already closed or
  cancelled client, and connection failure can reject before any `link` event.
- `failure`, `close`

Use the exported `ServerEventMap`, `ClientEventMap`, `ServerEventName`, and
`ClientEventName` types for event-name-specific payload narrowing:

```ts
client.on('progress', ({ name, bytesSent, totalBytes }) => {
  console.log(name, `${bytesSent}/${totalBytes}`)
})

server.on('recovery', (event) => {
  if (event.status === 'failed') console.error(event.phase, event.reason)
})
```

## Logging

Both constructors accept:

```ts
interface Logger {
  info?(message: string, details?: Record<string, unknown>): void
  warn?(message: string, details?: Record<string, unknown>): void
  error?(message: string, details?: Record<string, unknown>): void
}
```

Logger exceptions are ignored. Logger detail objects are diagnostic rather than
a stable ingestion schema; use typed event payloads or `SwarmDeployError.code`
for automation. Do not use fingerprints as credentials.

Logger detail properties that hold a hash of a public key are named for what
they identify, not `fingerprint`:

- `publicKeyId`: the first 12 hex characters of the SHA-256 of a public key,
  either the peer's or the server's own (`Direct DHT server listening`). It is
  `invalid` when no valid peer key was available.
- `uploaderKeyId`: the full 64-character SHA-256 of the uploader's public key,
  as stored in the commit record (`Committed artifact cleanup remains pending`).
- `pathId`: the first 12 hex characters of the SHA-256 of an unrecognized
  journal file name (`Ignoring unknown journal path`), never the name itself.
- `transfer`: the first 12 hex characters of the SHA-256 of a transfer ID. It is
  not a public-key hash and keeps its name.

`publicKeyId` and `uploaderKeyId` come from the same public key but differ in
length: the first 12 characters of an `uploaderKeyId` are that uploader's
`publicKeyId`. They are identifiers for correlation, never the key itself, a
seed, or a filesystem path.

The rename applies to logger details only. Event payloads and their exported
types keep their `fingerprint` fields, and commit records keep the persisted
`uploaderFingerprint` field, so no event consumer, wire message, or stored
record changes.

## Errors

Configuration, authentication, protocol, transfer, and managed-storage failures
generally reject with `SwarmDeployError`. Raw operating-system or adapter errors
may propagate while selecting or opening a local input, initializing or locking
the server storage root, or performing filesystem operations:

```ts
import { ERRORS, SwarmDeployError } from 'swarm-deploy'

try {
  await client.upload('./artifact.tgz')
} catch (error) {
  if (error instanceof SwarmDeployError) {
    console.error(error.code, error.message)
    if (error.code === ERRORS.CONNECT_TIMEOUT) {
      // Server could not be reached and authenticated before the deadline.
    }
  } else {
    console.error(error)
  }
}
```

`HOOK_FAILED` is the stable code for a failed `beforeCommit`, `afterCommit`, or
`afterLink` callback. Its message is fixed and the original exception is
available only as `cause` and to `onFailure`. For `afterCommit` and
`afterLink` the artifact is already durable when the code is reported, so a retry
is safe and does not undo it. An upload's automatic link stays too; an explicit
link request restores its previous link first unless it asked to keep it (see
[Link results](#link-results)).

Stable codes include authentication and server-key rejection, invalid
configuration and protocol records, file and staging limits, disk reserve,
filename and replacement conflicts, checksum failures, connection or upload
timeouts, aborts, commit failures, cleanup failures, unexpected server errors
(`SERVER_ERROR`, 0.6.3), and managed-link failures
(`LINK_NOT_ALLOWED`, `LINK_TARGET_NOT_FOUND`, `LINK_CONFLICT`, `LINK_FAILED`,
`UNSUPPORTED_STORAGE`). Manual requests use `LINK_NOT_ALLOWED` for policy,
self-link, and automatic-name rejection; `LINK_TARGET_NOT_FOUND` for an absent
current managed target; `LINK_CONFLICT` for managed-namespace or unmanaged-path
collisions; and `LINK_FAILED` for other link-operation failures. A link
reconciliation failure after a durable commit behaves like other post-commit
deployment failures: the artifact stays committed, the client receives a
stable failure, and an already-committed retry reruns reconciliation before
succeeding. Import `ERRORS` rather than matching exception messages.

### How a server reports its own failures (0.6.3)

Through 0.6.2 a server reported every upload error that was not a
`SwarmDeployError` as `PROTOCOL_INVALID`, so a raw server fault could look like
an invalid request. From 0.6.3, for **uploads**:

- An explicit `SwarmDeployError` always keeps its stable code. That includes
  `PROTOCOL_INVALID`, which can mean an invalid request or answer (a malformed
  record, a transfer ID that does not match, a peer's own stream failing) **or**
  a check of the server's own storage state: the storage layer can wrap a raw
  failure in its own `PROTOCOL_INVALID` (for example when it cannot open or check
  a staging file or directory, or when rolling back a failed append), and the
  server refuses new work while legacy private state is in the output root. So
  `PROTOCOL_INVALID` alone does not say that the request, a field, or the client
  version was at fault; the server log's `phase` and `systemCode` say more.
- A raw error that reaches the server **unwrapped** and has a known errno is
  reported as the code that names it: `ENOSPC` and `EDQUOT` as `DISK_RESERVE`;
  `EXDEV`, `ENOSYS` and `ENOTSUP` as `UNSUPPORTED_STORAGE`; `EACCES`, `EPERM`,
  `EROFS` and `EIO` as `COMMIT_FAILED` (a write or commit that could not be
  done). The errno is read from the error or from one level of its `cause`. An
  errno inside a storage guard's `PROTOCOL_INVALID` is not remapped.
- Any other unwrapped raw error is the new stable code `SERVER_ERROR`
  (`ERRORS.SERVER_ERROR`): the server hit an error it did not expect. Its
  explanation is fixed; no message or cause is sent.
- Link requests are unchanged: a failure of a link request that has no stable
  link code is reported as `LINK_FAILED`, so the errno mapping and `SERVER_ERROR`
  do not apply to link answers.
- The answer carries only the code, as before: no record field and no version
  changed. The server log line `Direct upload failed` (and `Direct link failed`)
  carries `publicKeyId`, `reason`, the `phase` the server was in (`offer`,
  `transfer`, `verification`, `beforeCommit`, `commit`, `afterCommit`,
  `afterLink`; `link` or `afterLink` for a link request) and, when the failure
  has one, `systemCode`: the errno name, from a short fixed list. It never
  carries the error's message, a path, a stack, or hook text.

A client older than 0.6.3 does not know `SERVER_ERROR`: it rejects the answer as
an invalid record (`PROTOCOL_INVALID`, raised by the client while decoding) and
cannot show the code, so look at the server log, which says `SERVER_ERROR` and
the phase. This fails closed: no request that succeeds is affected, and the
other codes above already existed. A client of 0.6.3 or newer shows the code.

### Where a client failure came from (0.6.3)

A `Client.upload` or `Client.link` failure says whether the server explained it:

- `error.remote === true`: the server answered and `error.code` is its own
  stable code (for example `FILE_EXISTS`, `FILE_TOO_LARGE`, `DISK_RESERVE`,
  `LINK_NOT_ALLOWED`). The message names the code and a fixed explanation of it
  (`Server rejected upload (DISK_RESERVE): the server does not have enough free
disk space or quota`); text the server wrote, paths, and hook causes never
  appear in it.
  `error.hookResult` is unchanged. This includes a failure the server hit while
  the client was still sending: the client reads the answer, stops sending, and
  reports that code, not a local write error.
- `error.transport === true`: the connection failed, closed, or timed out and
  **no server reason was received**. The code then says nothing about the
  server's cause, and nothing says whether the server rolled back or finished:
  an abrupt close after the whole payload was sent may follow a commit. The
  error object is the one that was thrown (a raw stream error such as a reset
  stays a raw error with its own message and code; a `SwarmDeployError` keeps its
  code and `cause`), with these fields added on it.
- `error.operation` (`'upload' | 'link'`) and `error.phase`
  (`'connect' | 'request' | 'admission' | 'streaming' | 'final'`) say where it
  surfaced, when known: `connect` covers the DHT lookup, the server-key check and
  the handshake (a client key the server does not allow is dropped before any
  answer, so it looks the same as an unreachable server); `admission` is waiting
  for the decision on an upload offer; `streaming` is sending the artifact;
  `final` is waiting for the terminal answer.
- An error with neither `remote` nor `transport` (an invalid input, a local
  checksum or changed-source failure, an answer that could not be read, an abort)
  is the client's own: it keeps its type and code. It may still carry `operation`
  and `phase` saying where the client was when it failed, which does not mean the
  server or the connection was involved, so decide on `remote` and `transport`,
  not on the presence of `phase`. An abort is never relabelled and carries no
  `operation` or `phase`.

`RequestOperation` and `RequestPhase` are exported types. The server can only
answer a client it has authenticated, and only while it can write: a client
key the server does not allow, an over-capacity server (`maxConnections`), a
crash, or a network failure end the connection with no answer, and are
`transport` failures.
