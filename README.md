<h1 align="center">Swarm Deploy</h1>

<p align="center">
  Authenticated, encrypted, resumable artifact uploads over direct HyperDHT.
</p>

<p align="center">
  <a href="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/tetherto/swarm-deploy/blob/main/package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/tetherto/swarm-deploy?filename=package.json&amp;label=version&amp;style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 and 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933?logo=nodedotjs&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://github.com/holepunchto/bare"><img alt="Bare supported" src="https://img.shields.io/badge/Bare-supported-171717?logo=javascript&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="Strict TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://github.com/tetherto/swarm-deploy/blob/main/LICENSE.md"><img alt="Apache-2.0 license" src="https://img.shields.io/github/license/tetherto/swarm-deploy?style=flat-square"></a>
</p>

Swarm Deploy moves build artifacts from authorized clients to one receiving
server. Each file uses a fresh direct HyperDHT connection authenticated and
encrypted with Noise. The client pins the server's public key, while the server
accepts only client public keys in its immutable startup allowlist.

The receiver is upload-only. It does not execute, serve, or provide a download
protocol for stored artifacts.

## Requirements

- Node.js 22 or 24, or the current stable Bare runtime.
- A persistent server seed and at least one independently generated client seed.
- A dedicated server storage directory.
- Network access suitable for HyperDHT.

## Install

Install the runtime API in an application:

```sh
npm install @tetherto/swarm-deploy
```

Install the CLI globally for a receiving server or CI uploader:

```sh
npm install --global @tetherto/swarm-deploy
swarm-deploy --help
```

## Security and identity model

Three values have different roles:

- **Seed:** private 32-byte identity material. Never pass a seed as a command
  argument, put it in an allowlist, or print it in logs.
- **Client public key:** derived from a client seed and installed in the
  server's allowlist.
- **Server public key:** derived from the server seed and pinned by every
  client. It is both the direct HyperDHT destination and the server identity
  commitment.

HyperDHT Noise authenticates both peers and encrypts the transport. Application
SHA-256 checks verify the deterministic TAR and extracted file bytes.

There is no topic, swarm discovery, Protomux channel, dynamic allowlist reload,
or reconnect budget. Changing an allowed client key requires a controlled
server restart.

Keep seeds stable to preserve identity. Copying one client seed to several
machines intentionally gives all of them the same uploader identity; use
separate client seeds when independent authorization is required.

## Provision identities

Generate separate server and client seed files:

```sh
swarm-deploy keygen --out server.seed
swarm-deploy keygen --out client.seed
```

`keygen` creates an owner-only file, refuses to overwrite an existing path, and
prints the corresponding public key—not the seed.

Recover public keys later:

```sh
SERVER_KEY=$(swarm-deploy public-key --seed-file server.seed)
CLIENT_KEY=$(swarm-deploy public-key --seed-file client.seed)
```

Public keys are lowercase 64-character hexadecimal strings and are safe to use
as configuration values.

## Quick start

Start the receiver:

```sh
swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
  --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 2147483648
```

The server prints its full public key and then `ready` after storage recovery,
scrub, retention initialization, and HyperDHT listening complete:

```text
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
ready
```

Upload a file:

```sh
swarm-deploy upload --seed-file client.seed --server-key "$SERVER_KEY" \
  --idle-timeout 60000 ./artifact.tgz
```

Successful output is:

```text
artifact.tgz COMMITTED
```

Uploading the same managed content again returns `ALREADY_COMMITTED` without
retransmitting its TAR bytes.

## CLI reference

### `keygen`

```sh
swarm-deploy keygen --out <seed-file>
```

Creates a new seed file with owner-only permissions and prints its public key.
The destination must not already exist.

### `public-key`

```sh
swarm-deploy public-key --seed-file <seed-file>
```

Reads a seed safely and prints its public key.

### `server`

```sh
swarm-deploy server \
  --seed-file <seed-file> \
  --storage <directory> \
  --allow-key <64-lower-hex> \
  --max-file-bytes <bytes> \
  --max-staging-bytes <bytes> \
  [--allow-key <64-lower-hex>]... \
  [--max-storage-bytes <bytes>] \
  [--max-age-days <days>] \
  [--replace-name <safe-basename>]...
```

Required options:

- `--seed-file`: persistent server seed.
- `--storage`: dedicated artifact and internal-state root.
- `--allow-key`: authorized client public key. Repeat for multiple identities;
  duplicates and malformed keys are rejected.
- `--max-file-bytes`: maximum extracted artifact size.
- `--max-staging-bytes`: aggregate persistent staging reservation. An admitted
  transfer reserves its deterministic TAR size plus extracted file size, so
  this commonly needs to be at least twice the largest simultaneously staged
  payload.

Optional options:

- `--max-storage-bytes`: maximum total managed committed storage. Oldest
  eligible artifacts are removed first.
- `--max-age-days`: remove eligible committed artifacts at or beyond this age.
- `--replace-name`: permit replacement of this exact basename. Repeat for
  multiple mutable names.

The CLI requires at least one `--allow-key`. Its snapshot is immutable for the
life of the process.

### `upload`

```sh
swarm-deploy upload \
  --seed-file <seed-file> \
  --server-key <64-lower-hex> \
  [--idle-timeout <milliseconds>] \
  <file-or-directory>
```

- `--server-key` is the full pinned server public key.
- `--idle-timeout` defaults to 60 seconds and bounds inactive protocol reads and
  backpressured writes.
- A direct file retains its basename.
- A directory processes immediate regular-file children once, in lexical
  order, with one independent connection and result per file.
- Subdirectories, symlinks, non-regular files, unsafe names, and names in the
  reserved `history-` namespace are skipped and reported.
- An unreadable directory entry is reported as a failure while later entries
  continue.

Accepted names start with an ASCII letter or digit, contain only letters,
digits, `.`, `_`, and `-`, and occupy at most 100 UTF-8 bytes. `history-` is
reserved for server-managed replacement history.

### Seed environment variables

The server and uploader accept role-specific environment variables:

- `SWARM_DEPLOY_SERVER_SEED`
- `SWARM_DEPLOY_CLIENT_SEED`

Each value is the lowercase 64-character hex content of the corresponding seed
file. Supplying both an environment seed and `--seed-file` is an error.

The `public-key` command intentionally reads a seed file and does not consume a
seed environment variable.

### CLI exit codes

- `0`: every selected file was committed or already committed.
- `1`: upload, network, protocol, storage, cleanup, or runtime failure.
- `2`: usage or configuration error.

For a directory, the CLI prints one line for every selected or skipped entry and
returns `1` if any selected upload failed.

## CI uploader example

Store the client seed as a protected CI secret and the server public key as a
nonsecret variable:

```yaml
- name: Install uploader
  run: npm install --global @tetherto/swarm-deploy

- name: Upload artifact
  env:
    SWARM_DEPLOY_CLIENT_SEED: ${{ secrets.SWARM_DEPLOY_CLIENT_SEED }}
    SWARM_DEPLOY_SERVER_KEY: ${{ vars.SWARM_DEPLOY_SERVER_KEY }}
  run: |
    swarm-deploy upload \
      --server-key "$SWARM_DEPLOY_SERVER_KEY" \
      --idle-timeout 60000 \
      ./dist/artifact-linux-x64.tar.gz
```

Do not enable shell tracing around commands that read seed environment
variables.

## Transfer and resume behavior

Each file follows this lifecycle:

1. The client connects directly to the pinned server public key with its seeded
   HyperDHT identity.
2. The server firewall and connection handler verify the authenticated client
   key against the startup allowlist.
3. The client sends bounded metadata containing the name, file size and digest,
   deterministic TAR size and digest, and transfer ID.
4. The server responds with `ACCEPT`, `RESUME`, `VERIFIED`,
   `ALREADY_COMMITTED`, or a stable rejection.
5. The client sends exactly the required deterministic one-entry USTAR bytes.
6. The server validates the canonical archive, extracted size, and both
   SHA-256 values before durable commit.
7. Success requires an explicit terminal `COMMITTED` result. EOF or socket
   closure is never success.

Incomplete uploads retain only durable TAR progress. On reconnect, the server
returns a TAR-byte offset and SHA-256 of that prefix. The client regenerates and
compares the prefix before sending the suffix. A mismatch closes that connection
and retries once from zero with explicit reset intent.

The server coalesces network fragments into 1 MiB durability batches plus the
final remainder. A disconnect can require retransmitting only the uncheckpointed
in-memory tail; it never advertises bytes that were not durably published.

Inactive sessions expire after seven days by default. Active receives and
verification are protected from expiry.

## Storage, replacement, and retention

The storage root contains visible current and historical artifacts plus the
reserved `.swarm-deploy/` internal directory. Do not modify that directory
while the server is running.

Names are create-only by default:

- New content for an unused name is committed atomically.
- Identical managed content returns `ALREADY_COMMITTED`.
- Different content for an occupied create-only name returns `FILE_EXISTS`.
- Unmanaged files and paths are never overwritten or deleted.

Names configured with `--replace-name` or `ServerOptions.replaceNames` are
mutable:

- Different verified content atomically becomes current.
- The prior managed inode and record are preserved as
  `history-<full-old-transfer-id>`.
- The current mutable name is pinned against age and quota retention.
- Historical versions remain eligible for retention.

Commit journals and inode checks recover interrupted create and replacement
operations. Recovery rolls back mutations before the durable new current
sidecar and rolls forward operations after that linearization point.

Optional retention applies to managed artifacts only:

- `maxAge`/`--max-age-days` removes eligible artifacts by age.
- `maxStorageBytes`/`--max-storage-bytes` removes the oldest eligible artifacts
  until under quota.
- Startup recovery re-hashes managed files. Scheduled cleanup validates managed
  metadata and file sizes, removes invalid managed records safely, reports
  unknown paths without deleting them, and applies age and quota retention.

Runtime defaults:

- 64 authenticated connections.
- 8 active uploads.
- 60-second upload inactivity timeout.
- 1 GiB minimum free-disk reserve.
- 15-minute cleanup interval.
- 7-day resumable-session lifetime.

The advanced runtime API can override these values; the server CLI intentionally
exposes only its required limits, committed retention, and replacement policy.

## Runtime API

The package is strict TypeScript and exposes the same root API to ESM and
CommonJS consumers.

### Identity helpers

```ts
import {
  generateSeed,
  keyPairFromSeed,
  parsePublicKey,
  parseSeed,
  publicKeyFromSeed
} from '@tetherto/swarm-deploy'

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

### Server

```ts
import { Server, parsePublicKey, parseSeed } from '@tetherto/swarm-deploy'

const server = new Server({
  seed: parseSeed(process.env.SWARM_DEPLOY_SERVER_SEED!),
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

- `seed: Buffer`
- `storageDir: string`
- `allowedKeys: Iterable<Buffer | string>`
- `maxFileBytes: number`
- `maxStagingBytes: number`

Optional operational limits and policies:

- `maxConnections`, `maxActiveUploads`, `idleTimeout`
- `cleanupInterval`, `resumeTtl`, `minFreeBytes`
- `maxAge`, `maxStorageBytes`, `replaceNames`

Advanced integration and test seams:

- `dht` or `dhtFactory` for an injected HyperDHT node.
- `storage` for a compatible filesystem adapter.
- `scheduler` for timeout and interval control.
- `logger` with optional `info`, `warn`, and `error` methods.

### Client

```ts
import { Client, parsePublicKey, parseSeed } from '@tetherto/swarm-deploy'

const client = new Client({
  seed: parseSeed(process.env.SWARM_DEPLOY_CLIENT_SEED!),
  serverPublicKey: parsePublicKey(process.env.SWARM_DEPLOY_SERVER_KEY!),
  connectTimeout: 30_000,
  idleTimeout: 60_000
})

const result = await client.upload('./dist/release.tar.gz')
console.log(result.status, result.name, result.size)

await client.close()
```

`ClientOptions` requires `seed` and `serverPublicKey` as Buffer values. Optional
values are `connectTimeout`, `idleTimeout`, `dht`, `dhtFactory`, and `logger`.

`connectTimeout` defaults to 30 seconds. `idleTimeout` defaults to 60 seconds.
Calling `close()` aborts pending work, closes active sockets, and is idempotent.

### Upload results

A direct file resolves to:

```ts
interface UploadResult {
  status: 'COMMITTED' | 'ALREADY_COMMITTED'
  name: string
  size: number
  digest: Buffer
  transferId: Buffer
}
```

A directory resolves to:

```ts
interface BatchUploadResult {
  status: 'COMMITTED' | 'FAILED'
  results: Array<
    | UploadResult
    | {
        name: string
        status: ErrorCode
        reason?: string
      }
  >
  skipped: Array<{
    name: string
    path: string
    reason: SkippedUploadReason
  }>
}
```

Directory members are processed sequentially. A failed member does not prevent
later members from being attempted.

### Events

`Server` and `Client` are event emitters. Listener and logger exceptions are
contained and cannot change protocol correctness.

Public peer and transfer correlation fields use 12-character SHA-256
fingerprints. Events never expose seeds, secret keys, full remote public keys,
TAR contents, or resumable session material. Internal storage warnings may
include a full SHA-256 uploader fingerprint, but never the uploader key itself.

Server events:

- `authentication`: accepted client fingerprint.
- `connection`, `connection-open`, `connection-close`: authenticated connection
  lifecycle and current count.
- `offer`: accepted, resumed, reset, rejected, or already-committed state.
- `progress`: durable TAR bytes received and total TAR bytes.
- `verification`: started, succeeded, or failed.
- `commit`: succeeded or failed.
- `recovery`: startup, per-journal, corruption, resumable, and completion
  outcomes.
- `retention`: startup, scheduled, manual, commit, or post-commit outcomes.
- `failure`: stable failure code and peer fingerprint.
- `listening`: local server-key fingerprint.
- `close`: closed or failed outcome.

Client events:

- `connection`, `connection-open`, `connection-close`
- `offer`: offered, accepted, resumed, reset, rejected, or already committed.
- `progress`: cumulative TAR `bytesSent` and full `totalBytes`, including a
  durable resume offset.
- `verification`, `commit`
- `result`: direct result or per-file/aggregate directory result.
- `skipped`: skipped directory member and stable reason.
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

### Logging

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

### Errors

Configuration, authentication, protocol, transfer, and managed-storage failures
generally reject with `SwarmDeployError`. Raw operating-system or adapter errors
may propagate while selecting or opening a local input, initializing or locking
the server storage root, or performing filesystem operations:

```ts
import { ERRORS, SwarmDeployError } from '@tetherto/swarm-deploy'

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

Stable codes include authentication and server-key rejection, invalid
configuration and protocol records, file and staging limits, disk reserve,
filename and replacement conflicts, checksum failures, connection or upload
timeouts, aborts, commit failures, and cleanup failures. Import `ERRORS` rather
than matching exception messages.

## Production operations

- Run the server under a dedicated non-root account.
- Restrict the server seed and storage root to that account.
- Supervise the process and wait for the final `ready` line before marking it
  healthy.
- Restart with the same seed, allowlist, limits, replacement names, and storage
  root so interrupted sessions and commit journals can recover.
- Alert on nonzero CLI exits and failed authentication, recovery, verification,
  commit, retention, and cleanup events.
- Never edit `.swarm-deploy/` while the server is running.
- Stop the server cleanly before backing up or restoring the complete storage
  root.
- Publish stored artifacts through a separately configured artifact service or
  web server.
- Roll out an exact package version to a canary before wider deployment.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and operator
precautions.

## Contributor development

Production and tests are strict TypeScript. Build output is generated under
untracked `dist/` and `.test-dist/`. Tests generate binary payloads in temporary
directories and use an isolated local HyperDHT testnet, not the public DHT.

```sh
npm ci
npm run build
npm run build:test
npm run test:types
npm run format:check
npm run lint
npm run test:node
npm run test:bare
npm run test:property
npm run test:package
npm run test:release-tag
```

Exercise the built CLI directly:

```sh
node dist/bin/swarm-deploy.js --help
bare dist/bin/swarm-deploy.js --help
```

## Release

Version tags use `v<package-version>`. The tag workflow validates the version,
builds the untracked distribution, checks package contents and types, and
publishes through the configured npm environment with provenance.

See [RELEASING.md](RELEASING.md) for the release and rollback procedure.

## Protocol specification

See [docs/spec/swarm-deploy.md](docs/spec/swarm-deploy.md) for the complete
transport, deterministic TAR, resumability, storage, replacement, recovery,
retention, threat-model, and package requirements.
