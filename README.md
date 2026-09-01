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

The package is private until an npm release is configured. From a checkout:

```sh
npm ci
node bin/swarm-deploy.js --help
npx bare bin/swarm-deploy.js --help
```

The examples below use `node bin/swarm-deploy.js`. Replace `node` with `bare` when running the CLI in Bare.

## Provision identities

Generate one server seed and one separate client seed:

```sh
node bin/swarm-deploy.js keygen --out server.seed
node bin/swarm-deploy.js keygen --out client.seed
```

Each command creates an owner-only seed file, refuses to overwrite an existing path, and prints only its public key. Recover a public key later with:

```sh
node bin/swarm-deploy.js public-key --seed-file server.seed
node bin/swarm-deploy.js public-key --seed-file client.seed
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
node bin/swarm-deploy.js server \
  --seed-file server.seed \
  --storage ./artifacts \
  --allowlist ./allowlist.txt \
  --max-file-bytes 21474836480 \
  --max-staging-bytes 42949672960
```

`max-file-bytes` and `max-staging-bytes` are required. Optional rotation:

```sh
  --max-storage-bytes 107374182400 \
  --max-age-days 15
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
node bin/swarm-deploy.js upload \
  --seed-file client.seed \
  --server-key "$SWARM_DEPLOY_SERVER_KEY" \
  ./dist/artifact-linux-x64.tar.gz
```

A directory uploads its immediate regular-file children once, in lexical order. Subdirectories and symlinks are skipped; unreadable entries are reported as failures while later files continue.

Accepted basenames match:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$
```

Files retain their original basename. Existing files are never replaced. Retrying the same authenticated transfer returns `ALREADY_COMMITTED`; different content using an existing name returns `FILE_EXISTS`.

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
    node bin/swarm-deploy.js upload \
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
  allowlistPath: './allowlist.txt'
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

The CommonJS entrypoint also exports identity/topic helpers, file-selection/manifest helpers, bounded protocol codecs/constants, `AllowlistWatcher`, `SwarmDeployError`, and `ERRORS`. See `index.d.ts` for the complete API.

## Events and logging

`Server` and `Client` are event emitters. Event payloads use 12-character SHA-256 fingerprints for peer and transfer correlation; they never contain seeds or full public keys. Exceptions thrown by event listeners or logger methods are contained and cannot change upload, cleanup, or lifecycle correctness.

Server events:

- `authentication`: accepted or rejected peer fingerprint and a reason for rejection.
- `connection-open` and `connection-close`: authenticated transport lifecycle. The legacy `connection` event remains available.
- `offer`: accepted, resumed, rejected, or already-committed offers with safe name, size, and transfer fingerprint.
- `progress`: verified chunk index plus cumulative chunk and byte counts.
- `verification` and `commit`: started, succeeded, or failed outcomes.
- `recovery`, `scrub`, `retention`, and `cleanup`: startup and storage lifecycle outcomes. Scheduled retention reports `deferred` while a receive is active.
- `revocation`: completed owner cleanup. The legacy `revoked` event remains available.
- `listening` and `close`: server lifecycle completion.

Client events:

- `authentication`, `connection-open`, `connection-close`, and `rejected-peer`: pinning and transport lifecycle.
- `offer`: offered, accepted, resumed, rejected, or already-committed state.
- `progress`: acknowledged chunk and cumulative byte counts, including resumed verified bytes.
- `verification` and `commit`: transfer completion phases.
- `result`: every per-file outcome and one final direct-file or batch result.
- `skipped` and `close`: directory selection and lifecycle completion.

The exact discriminated payload types are `ServerEventMap` and `ClientEventMap` in `index.d.ts`.

## CLI exit codes

- `0`: every selected file was committed or already committed.
- `1`: transfer, discovery, runtime, or cleanup failure.
- `2`: usage or configuration error.

Parsing, configuration, and object-construction failures exit `2`. Once `server.listen()` or `client.upload()` begins, malformed protocol frames, `PROTOCOL_INVALID`, network, storage, and other runtime failures exit `1`.

## Test

All binary test content is generated in temporary directories. Integration tests use an isolated local HyperDHT testnet, never the public DHT:

```sh
npm run format:check
npm run lint
npm run test:node
npm run test:bare
```

See `docs/superpowers/specs/2026-08-31-swarm-deploy-design.md` for the complete protocol and threat model.
