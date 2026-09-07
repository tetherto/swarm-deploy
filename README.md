# Swarm deploy

Secure, resumable artifact uploads from CI clients to one receiving server over Hyperswarm.

## Security model

Three different 32-byte values have different jobs:

- **Seed:** secret identity material. Generate separate persistent seeds for the server and client. Never put a seed in an allowlist, log, or command-line argument.
- **Public key:** derived from a seed. The server allowlists client public keys.
- **Topic:** a nonsecret 32-byte commitment to the server identity: `SHA-256("swarm-deploy/topic/v1\0" || serverPublicKey)`.

Clients join the configured topic, then verify that the authenticated HyperDHT
Noise socket key derives that exact topic before sending protocol or upload
metadata. If Hyperswarm also supplies peer metadata, its public key must be
valid and equal the socket key. An arbitrary peer announcing the topic receives
no application data.
Keep the server seed stable: rotating it changes the server key and topic, so
every client configuration must be updated.

Knowing the topic does not expose stored files. Swarm Deploy is receive-only:
the server does not provide a download protocol, execute content, or serve a
website.

Publish stored files through a separately configured web server or
artifact service when needed.

HyperDHT Noise authenticates both transport keys and encrypts the connection. SHA-256 verifies transferred bytes; it does not prove that an authorized client uploaded safe software.

The server OS account and dedicated storage root are trusted against concurrent local tampering.

## Install

Install the runtime API in an application:

```sh
npm install @tetherto/swarm-deploy
```

Install the command globally for server and CI use:

```sh
npm install --global @tetherto/swarm-deploy
swarm-deploy --help
```

## Provision identities

Generate one server seed and one separate client seed:

```sh
swarm-deploy keygen --out server.seed
swarm-deploy keygen --out client.seed
```

Each command creates an owner-only seed file, refuses to overwrite an existing path, and prints only its public key. Recover a public key later with:

```sh
swarm-deploy public-key --seed-file server.seed
swarm-deploy public-key --seed-file client.seed
swarm-deploy topic --seed-file server.seed
```

The `topic` command safely reads the server seed file and prints only the full
64-character lowercase topic. Commit that nonsecret value to receiver
configuration; never copy the server seed into CI.

Put the client public key in an allowlist file:

```text
# deployment CI identity
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The file accepts one lowercase 64-character public key per line, blank lines, and `#` comments. It is loaded before networking starts and polled every five seconds. Removing a key closes its connections and deletes its active/resumable uploads. Already committed files remain.

## Run the server

The storage directory must be dedicated to Swarm Deploy:

```sh
swarm-deploy server \
  --seed-file server.seed \
  --storage ./artifacts \
  --allowlist ./allowlist.txt \
  --max-file-bytes 21474836480 \
  --max-staging-bytes 42949672960
```

`max-file-bytes` and `max-staging-bytes` are required. Optional rotation and
exact mutable names:

```sh
  --max-storage-bytes 107374182400 \
  --max-age-days 15 \
  --replace-name release.tar.gz \
  --replace-name latest.json
```

Defaults:

- 64 authenticated connections.
- 8 active uploads.
- 60-second idle timeout.
- 1 GiB minimum free-disk reserve.
- 15-minute cleanup interval.
- 7-day resumable-upload lifetime.

At startup the server recovers commit journals, purges resumable state owned by keys absent from the effective allowlist, and fully re-hashes managed committed files. Re-adding a key cannot resurrect a partial upload removed while it was offline. Scheduled cleanup checks metadata and size, removes expired resumable uploads, applies age retention, then deletes oldest committed files until under the storage limit. Age and quota deletion is deferred while an upload is receiving chunks; verified commit-time capacity eviction is still allowed.

The server prints its full public key, the full committed topic, and `ready`
only after recovery, retention initialization, and Hyperswarm announcement
complete.

## Upload

Expose the committed nonsecret value as `SWARM_DEPLOY_TOPIC`, then pass it with a file:

```sh
swarm-deploy upload \
  --seed-file client.seed \
  --topic "$SWARM_DEPLOY_TOPIC" \
  ./dist/artifact-linux-x64.tar.gz
```

A directory uploads its immediate regular-file children once, in lexical order.
Subdirectories, symlinks, unsafe names, and regular files beginning with the
reserved `history-` prefix are skipped; the stable reason for the latter is
`reserved-history`. Unreadable entries are reported as failures while later
files continue. A direct file beginning with `history-` is rejected with
`INVALID_FILENAME`.

Accepted basenames match:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$
```

Files retain their original basename. Names are create-only by default.
`--replace-name <safe-basename>` is a server-only option and may be repeated
for distinct exact names. Invalid basenames, duplicate values, and every name
beginning with reserved `history-` are rejected. For a configured mutable name,
matching content is idempotent. Different content atomically replaces the
current managed artifact and preserves its prior bytes and managed record at
top-level `history-<full-old-transfer-id>`.

Only the configured current mutable name is pinned against age and quota
retention. Historical versions and ordinary create-only artifacts remain
eligible for normal retention. An unmanaged path is never replaced.

Files use fixed 1 MiB SHA-256 chunks. Verified chunks are hidden under `.swarm-deploy/` and resume after reconnect. A final file becomes visible only after exact size and whole-file SHA-256 verification plus an atomic no-replace commit.

Before admitting a new offer against `maxStagingBytes`, the server reclaims
TTL-expired inactive resumable sessions and re-evaluates capacity. A session
attached to an active upload is never reclaimed; if it occupies the remaining
capacity, the new offer receives `STAGING_LIMIT`.

The client waits up to `connectTimeout` for initial discovery and starts a fresh
window after each established transport loss. Repeated establish/close flapping
is bounded by `maxReconnectAttempts` (default 3, maximum 100). Initial discovery
timeouts, reconnect-window expiry, and budget exhaustion report
`CONNECT_TIMEOUT`; `UPLOAD_IDLE_TIMEOUT` is reserved for active upload,
response-drain, or transport inactivity.

If a basename itself is exactly 64 lowercase hexadecimal characters, pass a path containing a directory component such as `./<name>` so the CLI cannot mistake it for an accidentally pasted seed.

## CI secrets

Store the contents of `client.seed` in the CI system as a protected secret named `SWARM_DEPLOY_CLIENT_SEED`. Do not print or pass it as an argument:

```yaml
- name: Upload artifact
  env:
    SWARM_DEPLOY_CLIENT_SEED: ${{ secrets.SWARM_DEPLOY_CLIENT_SEED }}
    SWARM_DEPLOY_TOPIC: ${{ vars.SWARM_DEPLOY_TOPIC }}
  run: |
    swarm-deploy upload \
      --topic "$SWARM_DEPLOY_TOPIC" \
      ./dist/artifact-linux-x64.tar.gz
```

The server command similarly accepts `SWARM_DEPLOY_SERVER_SEED`. Supplying both the role-specific environment variable and `--seed-file` is an error. Client jobs that reuse one seed share one Hyperswarm identity, so only one such transport can remain active at a time. Use distinct client seeds and allowlist each public key when concurrent jobs are required.

## JavaScript API

ESM:

```js
import { Client, Server, parsePublicKey, parseSeed, parseTopic } from '@tetherto/swarm-deploy'

const server = new Server({
  seed: parseSeed(process.env.SWARM_DEPLOY_SERVER_SEED),
  storageDir: './artifacts',
  allowedKeys: [parsePublicKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')],
  maxFileBytes: 20 * 1024 ** 3,
  maxStagingBytes: 40 * 1024 ** 3,
  allowlistPath: './allowlist.txt',
  replaceNames: ['release.tar.gz']
})

await server.listen()

const client = new Client({
  seed: parseSeed(process.env.SWARM_DEPLOY_CLIENT_SEED),
  topic: parseTopic(process.env.SWARM_DEPLOY_TOPIC),
  maxReconnectAttempts: 3
})

const result = await client.upload('./dist/artifact-linux-x64.tar.gz')
console.log(result.status)

await client.close()
await server.close()
```

## Events and logging

`Server` and `Client` are event emitters. Event payloads use 12-character SHA-256 fingerprints for peer and transfer correlation; they never contain seeds or full public keys. Exceptions thrown by event listeners or logger methods are contained and cannot change upload, cleanup, or lifecycle correctness.

Server events:

- `authentication`: accepted or rejected peer fingerprint and a reason for rejection.
- `connection-open` and `connection-close`: authenticated transport lifecycle. The legacy `connection` event remains available.
- `offer`: accepted, resumed, rejected, or already-committed offers with safe name, size, and transfer fingerprint.
- `progress`: verified chunk index plus cumulative chunk and byte counts.
- `verification` and `commit`: started, succeeded, or failed outcomes.
- `allowlist`: reload `completed` or `failed`, with `appliedCount`, `pendingCount`, and a safe failure code when applicable. Live read/safety/parse failures retain the prior effective snapshot and continue polling; initial-load failures remain startup-fatal.
- `recovery`: startup `started`/`completed`, per-journal outcomes, and structured `failed` outcomes with a safe phase, optional transfer fingerprint, and reason code.
- `scrub`: startup `started`, `completed` counts, or a structured `failed` reason emitted before startup rejects.
- `retention` and `cleanup`: storage lifecycle outcomes. Scheduled retention reports `deferred` while a receive is active; corrupt-journal cleanup uses a transfer fingerprint and a null name.
- `revocation`: completed owner cleanup. The legacy `revoked` event remains available.
- `listening` and `close`: server lifecycle completion.

Client events:

- `authentication`, `connection-open`, `connection-close`, and `rejected-peer`: topic-commitment and transport lifecycle.
- `offer`: offered, accepted, resumed, rejected, or already-committed state.
- `progress`: acknowledged chunk and cumulative byte counts, including resumed verified bytes.
- `verification` and `commit`: transfer completion phases.
- `result`: directory member outcomes always have `final: false`; only a direct-file result or one aggregate batch result has `final: true`. Batch aggregates include `files`, `committed`, `failed`, and `skipped` counts.
- `skipped` and `close`: directory selection and lifecycle completion.

The exact discriminated payload types are `ServerEventMap` and `ClientEventMap`
in `dist/index.d.ts`.

The CLI writes human-readable messages followed by JSON details to stderr. Use
the typed API events when diagnostics must be ingested as structured records.
Treat `reason` as a stable error code where the event type documents one; do
not parse exception messages or use fingerprints as credentials.
Offer-capacity rejection uses `ACTIVE_UPLOAD_LIMIT`; topic parsing uses
`INVALID_TOPIC`; discovery/reconnect exhaustion uses `CONNECT_TIMEOUT`.

## CLI exit codes

- `0`: every selected file was committed or already committed.
- `1`: transfer, discovery, runtime, or cleanup failure.
- `2`: usage or configuration error.

Parsing, configuration, and object-construction failures exit `2`. Once `server.listen()` or `client.upload()` begins, malformed protocol frames, `PROTOCOL_INVALID`, network, storage, and other runtime failures exit `1`.

## Production operations

- Run the server under a dedicated, non-root OS account. Restrict the seed,
  allowlist, and storage root to that account; keep seeds out of arguments,
  logs, backups shared with other services, and diagnostic bundles.
- Supervise the CLI process and wait for its final `ready` line before marking
  it healthy. A startup recovery or scrub failure is fatal and prevents
  readiness. On an unexpected exit, restart with the same seed, allowlist,
  limits, replacement names, and storage root; recovery is automatic.
- Alert on nonzero exits and failed authentication, recovery, scrub,
  verification, commit, retention, and cleanup events. Correlate peers and
  transfers by their safe fingerprints. Preserve stderr around startup and
  shutdown without adding seed environment variables to logs.
- Never edit `.swarm-deploy/` while the server is running. Back up the complete
  dedicated storage root only after a clean shutdown so visible artifacts and
  journals/sidecars remain consistent.
- Roll out an exact package version to one canary before wider deployment.
  Follow [RELEASING.md](RELEASING.md) for publication, verification, and
  rollback. In particular, drain or recover in-flight v2 replacement journals
  before running an older server.

## Contributor development

Production sources are strict TypeScript under `src/`; tests are strict
TypeScript under `test/`. Builds generate untracked `dist/` and
`.test-dist/`. All binary test content is generated in temporary directories.
Integration tests use an isolated local HyperDHT testnet, never the public DHT:

```sh
npm ci
npm run build
npm run build:test
npm run test:types
npm run format:check
npm run lint
npm run test:node
npm run test:bare
```

To exercise checkout artifacts directly after `npm run build`:

```sh
node dist/bin/swarm-deploy.js --help
bare dist/bin/swarm-deploy.js --help
```

See [the Swarm Deploy specification](docs/spec/swarm-deploy.md) for the
complete protocol, replacement, package, and threat-model requirements.
