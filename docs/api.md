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

- `maxConnections`, `maxActiveUploads`, `idleTimeout`
- `cleanupInterval`, `resumeTtl`, `minFreeBytes`
- `maxAge`, `maxStorageBytes`, `replaceNames`
- `artifactPatterns?: Iterable<string>`, `maxCount?: number`,
  `maxVersions?: number`, and `versionGranularity?: 'major' | 'minor'`; see
  [Artifact patterns and rotation](artifact-patterns.md).
- `symlinks?: Iterable<SymlinkRule>` with automatic
  `{ selector, name }` and manual-authorization `{ selector }` entries; see
  [Managed symlinks](managed-links.md).
- `hooks?: ServerHooks | null`; see [Deployment hooks](hooks.md).

The root package exports the `ServerHooks`, `BeforeCommitContext`,
`AfterCommitContext`, `AfterLinkContext`, `HookFailureContext`,
`HookFailurePhase`, `HookArtifact`, `HookLink`, `HookLinkMode`, `HookLinkStatus`,
`HookLinkTrigger`, `HookResult`, `HookResultValue`, `ReleaseCoordinates`, and
`VersionGranularity` types:

```ts
import type { ServerHooks } from 'swarm-deploy'

const hooks: ServerHooks = {
  async afterCommit({ artifact, path, alreadyCommitted }) {
    // Idempotent: skip work already recorded for artifact.transferId.
  },
  async afterLink({ link, artifact, status, trigger }) {
    // Repeatable: skip when link.name already publishes artifact.transferId.
    // May return a JSON object for a caller that asked; see below.
  },
  onFailure({ phase, path, error }) {
    console.error(phase, path, error)
  }
}
```

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
  hookResult?: boolean // default false
}

interface ClientLinkResult {
  target: string
  name: string
  status: 'LINKED' | 'UNCHANGED'
  hookResult?: HookResult // only when requested and the hook returned an object
}
```

`hookResult: true` asks the server for what its `afterLink` hook returned, a
plain JSON object (`HookResult`, with `HookResultValue` for its values) the hook
author chose to report, such as an accepted submission's ID or evidence URL. It
arrives only after the hook has resolved and is absent when the server has no
hook or the hook returned nothing. It is data the hook reported, not proof that
anything was published, and it is never placed in client events or logs. Without
the option the request and the result are exactly what earlier versions
exchanged. Unknown options and non-boolean values reject with `PROTOCOL_INVALID`
before connecting. An opted-in request needs a server of version 0.5.0 or later;
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
}
```

Files and directories share the same result shape. For a directory, `size` is
aggregate payload bytes and `entryCount` counts stored entries (files and
directories).

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
  `versionDeleted`, and `storageDeleted` counters.
- `link`: one terminal manual-link outcome with `target`, `name`, client
  fingerprint, and status `linked`, `unchanged`, `rejected`, or `failed`.
  Rejected and failed outcomes also include a stable `reason`. A failed
  `afterLink` hook is `failed` with reason `HOOK_FAILED` and `result`
  (`LINKED` or `UNCHANGED`), the durable outcome the link had already reached.
  Automatic links emit no `link` event.
- `failure`: stable failure code and peer fingerprint.
- `listening`: local server-key fingerprint.
- `close`: closed or failed outcome.

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
`afterLink` the artifact (and, for `afterLink`, the link) is already durable
when the code is reported, so a retry is safe and does not undo it.

Stable codes include authentication and server-key rejection, invalid
configuration and protocol records, file and staging limits, disk reserve,
filename and replacement conflicts, checksum failures, connection or upload
timeouts, aborts, commit failures, cleanup failures, and managed-link failures
(`LINK_NOT_ALLOWED`, `LINK_TARGET_NOT_FOUND`, `LINK_CONFLICT`, `LINK_FAILED`,
`UNSUPPORTED_STORAGE`). Manual requests use `LINK_NOT_ALLOWED` for policy,
self-link, and automatic-name rejection; `LINK_TARGET_NOT_FOUND` for an absent
current managed target; `LINK_CONFLICT` for managed-namespace or unmanaged-path
collisions; and `LINK_FAILED` for other link-operation failures. A link
reconciliation failure after a durable commit behaves like other post-commit
deployment failures: the artifact stays committed, the client receives a
stable failure, and an already-committed retry reruns reconciliation before
succeeding. Import `ERRORS` rather than matching exception messages.
