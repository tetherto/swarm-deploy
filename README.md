# swarm-deploy

Secure, resumable artifact uploads from CI clients to one receiving server over Hyperswarm.

Swarm Deploy supports Node.js and Bare on Linux and macOS. It receives and stores files only; it never executes, unpacks, installs, or serves them.

## Security model

Three different 32-byte values have different jobs:

- **Seed:** secret identity material. Generate separate persistent seeds for the server and client. Never put a seed in an allowlist, log, or command-line argument.
- **Public key:** derived from a seed. The server allowlists client public keys, and every client pins the server public key.
- **Topic:** `SHA-256("swarm-deploy/topic/v1\0" || serverPublicKey)`. It finds peers but grants no authorization.

HyperDHT Noise authenticates both transport keys and encrypts the connection. SHA-256 verifies transferred bytes; it does not prove that an authorized client uploaded safe software.

The server OS account and dedicated storage root are trusted against concurrent local tampering. Existing or detected symlink and directory-identity changes fail closed, but native `openat` hardening against a malicious local writer is outside version 1.

## Install

Install the public npm package:

```sh
npm install @tetherto/swarm-deploy
npx swarm-deploy --help
```

To build and run a checkout:

```sh
npm ci
npm run build
node dist/bin/swarm-deploy.js --help
bare dist/bin/swarm-deploy.js --help
```

The examples below use the installed `swarm-deploy` binary through `npx`.

## Provision identities

Generate one server seed and one separate client seed:

```sh
npx swarm-deploy keygen --out server.seed
npx swarm-deploy keygen --out client.seed
```

Each command creates an owner-only seed file, refuses to overwrite an existing path, and prints only its public key. Recover a public key later with:

```sh
npx swarm-deploy public-key --seed-file server.seed
npx swarm-deploy public-key --seed-file client.seed
```

Put the client public key in an allowlist file:

```text
# deployment CI identity
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The file accepts one lowercase 64-character public key per line, blank lines, and `#` comments. It is loaded before networking starts and polled every five seconds. Removing a key closes its connections and deletes its active/resumable uploads. Already committed files remain.

## Run the server

The storage directory must be dedicated to Swarm Deploy:

```sh
npx swarm-deploy server \
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

The server prints its full public key, a topic fingerprint, and `ready` only after recovery, retention initialization, and Hyperswarm announcement complete.

## Upload

Expose the pinned public value as `SWARM_DEPLOY_SERVER_KEY`, then pass it with a file:

```sh
npx swarm-deploy upload \
  --seed-file client.seed \
  --server-key "$SWARM_DEPLOY_SERVER_KEY" \
  ./dist/artifact-linux-x64.tar.gz
```

A directory uploads its immediate regular-file children once, in lexical order. Subdirectories and symlinks are skipped; unreadable entries are reported as failures while later files continue.

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

If a basename itself is exactly 64 lowercase hexadecimal characters, pass a path containing a directory component such as `./<name>` so the CLI cannot mistake it for an accidentally pasted seed.

## CI secrets

Store the contents of `client.seed` in the CI system as a protected secret named `SWARM_DEPLOY_CLIENT_SEED`. Do not print or pass it as an argument:

```yaml
- name: Upload artifact
  env:
    SWARM_DEPLOY_CLIENT_SEED: ${{ secrets.SWARM_DEPLOY_CLIENT_SEED }}
    SWARM_DEPLOY_SERVER_KEY: ${{ vars.SWARM_DEPLOY_SERVER_KEY }}
  run: |
    npx swarm-deploy upload \
      --server-key "$SWARM_DEPLOY_SERVER_KEY" \
      ./dist/artifact-linux-x64.tar.gz
```

The server command similarly accepts `SWARM_DEPLOY_SERVER_SEED`. Supplying both the role-specific environment variable and `--seed-file` is an error. Client jobs that reuse one seed share one Hyperswarm identity, so only one such transport can remain active at a time. Use distinct client seeds and allowlist each public key when concurrent jobs are required.

## JavaScript API

```js
const { Client, Server, parsePublicKey, parseSeed } = require('@tetherto/swarm-deploy')

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
  serverPublicKey: parsePublicKey(process.env.SWARM_DEPLOY_SERVER_KEY)
})

const result = await client.upload('./dist/artifact-linux-x64.tar.gz')
console.log(result.status)

await client.close()
await server.close()
```

The package works through CommonJS `require` and ESM `import`. Its root entrypoint also exports identity/topic helpers, file-selection/manifest helpers, bounded protocol codecs/constants, `AllowlistWatcher`, `SwarmDeployError`, and `ERRORS`. See the generated `dist/index.d.ts` for the complete API.

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

- `authentication`, `connection-open`, `connection-close`, and `rejected-peer`: pinning and transport lifecycle.
- `offer`: offered, accepted, resumed, rejected, or already-committed state.
- `progress`: acknowledged chunk and cumulative byte counts, including resumed verified bytes.
- `verification` and `commit`: transfer completion phases.
- `result`: directory member outcomes always have `final: false`; only a direct-file result or one aggregate batch result has `final: true`. Batch aggregates include `files`, `committed`, `failed`, and `skipped` counts.
- `skipped` and `close`: directory selection and lifecycle completion.

The exact discriminated payload types are `ServerEventMap` and `ClientEventMap`
in `dist/index.d.ts`.

## CLI exit codes

- `0`: every selected file was committed or already committed.
- `1`: transfer, discovery, runtime, or cleanup failure.
- `2`: usage or configuration error.

Parsing, configuration, and object-construction failures exit `2`. Once `server.listen()` or `client.upload()` begins, malformed protocol frames, `PROTOCOL_INVALID`, network, storage, and other runtime failures exit `1`.

## Test

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

See [the Swarm Deploy specification](docs/spec/swarm-deploy.md) for the
complete protocol, replacement, package, and threat-model requirements.

## Publish

Publishing is tag-driven through `.github/workflows/publish.yml`. The tag must
be exactly `vX.Y.Z` and equal the version in `package.json`; the workflow runs
the build, type, format, lint, Node, Bare, property, CLI, replacement, and
package gates before `npm publish --provenance --access public`.

Before the first release, configure npm trusted publishing for
`@tetherto/swarm-deploy` with GitHub Actions as the provider, this repository
owner/name, workflow filename `publish.yml`, and GitHub environment `npm`.
Protect that environment as appropriate. The workflow needs no npm token:
GitHub grants the configured OIDC identity through `id-token: write`. Local
builds, tests, and this migration task do not publish anything.
