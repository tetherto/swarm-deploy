# Swarm Deploy Design

Date: 2026-08-31  
Status: Approved design, pending written-spec review

## Purpose

Swarm Deploy transfers binary artifacts from authorized CI clients to one receiving server over Hyperswarm. The server verifies each transfer, commits complete files atomically, supports interrupted-transfer resume, and optionally removes old artifacts.

The package supports Node.js and Bare on Linux and macOS.

## Scope

Version 1 provides:

- One-way client-to-server uploads.
- One file upload or a one-shot batch of top-level regular files from a directory.
- Stable client and server identities derived from separate persistent 32-byte seeds.
- Server-side client allowlisting and client-side server key pinning.
- A deterministic discovery topic derived from the server public key.
- Resumable, chunk-verified transfers.
- Original basename preservation with create-only commit semantics.
- Optional age and storage-size retention.
- A JavaScript API and command-line interface.
- Unit and local-DHT integration tests under Node.js and Bare.

Version 1 does not provide:

- Downloads or peer-to-peer artifact redistribution.
- Concurrent Hyperswarm connections from machines sharing one client seed.
- Automatic execution, unpacking, installation, serving, or malware scanning.
- Artifact provenance signing beyond authenticated transport identity.
- Windows support.
- Package publishing or release automation.

## Security Model

Swarm Deploy assumes unauthenticated peers are hostile and an allowlisted client may be compromised.
The server OS account and protected storage root are trusted against concurrent local tampering.
Existing or detected symlinks and parent-directory identity changes fail closed. Native
`openat`-style hardening against a malicious local writer is out of version 1 scope.

The system guarantees:

- The Noise peer presenting an allowlisted public key possesses the corresponding secret key.
- The client sends application data only to the pinned server public key.
- Noise protects transport confidentiality and integrity.
- A committed file has the exact declared length and SHA-256 digest.
- Failed or incomplete uploads never appear under their final filename.

The system does not guarantee:

- That uploaded content is safe or non-malicious.
- That a shared client identity identifies a specific machine or CI job.
- That a checksum proves publisher provenance. It proves byte consistency only.
- That the discovery topic is private or grants authorization.

Possession of a seed grants full control of that identity. Seeds must be random, stored as secrets, and rotated after compromise.

## Key and Topic Terminology

- **Seed:** Secret, random, exactly 32 bytes. It must never be allowlisted, logged, or shared with the opposite role.
- **Public key:** The 32-byte Noise/Ed25519 identity derived from a seed. Configuration represents it as 64 lowercase hexadecimal characters.
- **Server public key:** Pinned by clients and used to derive the discovery topic.
- **Client public key:** Stored in the server allowlist.
- **Topic:** A 32-byte Hyperswarm discovery value. It is not an identity, encryption key, password, or authorization capability.
- **Session transport keys:** Ephemeral keys derived by Noise for one connection. They are internal to the transport.

Server and client seeds are always distinct. Reusing the same client seed across CI machines is supported intentionally, but Hyperswarm deduplicates peers by public key, so only one connection for that shared identity can remain active at a time.

## Identity Provisioning

The CLI exposes role-neutral key operations:

```text
swarm-deploy keygen --out server.seed
swarm-deploy keygen --out client.seed
swarm-deploy public-key --seed-file server.seed
swarm-deploy public-key --seed-file client.seed
```

`keygen`:

- Uses cryptographically secure randomness.
- Writes a 64-character lowercase-hex seed plus a newline.
- Creates the file with owner-only permissions.
- Refuses to overwrite an existing path.
- Prints the derived public key, never the seed.

The server loads its persistent seed from `--seed-file` or `SWARM_DEPLOY_SERVER_SEED`. A client loads its persistent seed from `--seed-file` or `SWARM_DEPLOY_CLIENT_SEED`. Environment values use the same 64-character lowercase-hex representation. Raw seeds are not accepted as command-line arguments.

CI systems store the client seed as a protected secret variable. Server deployments store the server seed in a protected secret file, keychain, or secret manager. Reusing each role's seed across its own restarts keeps its public identity stable.

## Discovery and Authentication

The topic is derived without exposing the server seed:

```text
topic = SHA-256(
  UTF8("swarm-deploy/topic/v1\0") ||
  serverPublicKey
)
```

The server derives its public key and topic from its seed, then joins with:

```text
server: true
client: false
```

The client receives the server public key out of band, derives the same topic, and joins with:

```text
server: false
client: true
```

The server installs a synchronous Hyperswarm firewall. The firewall canonicalizes the authenticated remote Noise public key and rejects it unless it exists in the current in-memory allowlist. The connection handler repeats the key check before opening the upload protocol.

A client compares `peerInfo.publicKey` with its configured server public key before sending any metadata. It immediately destroys mismatched connections. A rogue peer may announce under the topic, but it receives no application data.

Server key rotation changes both the pinned server key and derived topic. Clients must update their server-key configuration. Client key rotation requires adding the new public key to the allowlist before removing the old key.

## Allowlist

The CLI server reads a line-oriented allowlist:

```text
# CI deployment identity
0123456789abcdef...64 lowercase hex characters...
```

Blank lines and lines beginning with `#` are ignored. Every other line must contain one canonical 64-character lowercase-hex public key.

The CLI polls the file every five seconds. Reload is all-or-nothing:

1. Read the complete file.
2. Parse and validate every entry.
3. Build a new immutable set.
4. Atomically replace the active set.

An invalid reload retains the previous valid set and emits an error event.

When a key is removed:

- All active connections for that key are destroyed.
- Active and resumable sessions owned by that key are deleted.
- New handshakes are rejected by the firewall.

All allowed keys use the same global server limits in version 1.

## Public JavaScript API

The CommonJS package exports:

```text
Server
Client
keyPairFromSeed
publicKeyFromSeed
topicFromServerPublicKey
errors
```

### Server

Conceptual construction:

```text
new Server({
  seed,
  storageDir,
  allowedKeys,
  maxFileBytes,
  maxStagingBytes,
  maxStorageBytes,
  maxAge,
  resumeTtl,
  cleanupInterval,
  maxConnections,
  maxActiveUploads,
  idleTimeout,
  minFreeBytes,
  logger
})
```

Required options are:

- `seed`: 32-byte binary server seed.
- `storageDir`: dedicated output directory.
- `allowedKeys`: current client public keys.
- `maxFileBytes`: hard maximum for one artifact.
- `maxStagingBytes`: hard logical reservation limit for active and resumable uploads.

Methods:

- `server.listen()`
- `server.reloadAllowlist(keys)`
- `server.close()`

The server exposes its `publicKey` and derived `topic` after construction.

### Client

Conceptual construction:

```text
new Client({
  seed,
  serverPublicKey,
  connectTimeout,
  idleTimeout,
  logger
})
```

The client derives the topic from `serverPublicKey`.

Methods:

- `client.upload(path)`
- `client.close()`

For a file, `upload()` resolves to one result or rejects with a typed error. For a directory, it processes sorted top-level entries sequentially and returns per-file results. Subdirectories and symlinks are skipped with reason-coded events. The CLI exits non-zero when any selected regular file fails.

Both classes emit structured lifecycle and progress events without exposing seeds or full key values.

## Command-Line Interface

```text
swarm-deploy keygen --out <seed-file>

swarm-deploy public-key --seed-file <seed-file>

swarm-deploy server \
  --seed-file <server.seed> \
  --storage <directory> \
  --allowlist <file> \
  --max-file-bytes <bytes> \
  --max-staging-bytes <bytes> \
  [--max-storage-bytes <bytes>] \
  [--max-age-days <days>]

swarm-deploy upload \
  --seed-file <client.seed> \
  --server-key <64-char-hex-public-key> \
  <file-or-directory>
```

The seed-file options may be omitted when the corresponding command-specific environment variable is set. If both are provided, the command fails instead of selecting one implicitly.

The server prints its public key and a topic fingerprint at startup. The upload command never requires a topic argument.

## Filename and Input Rules

The server preserves the original basename. Version 1 accepts names matching:

```text
^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$
```

This rejects empty names, leading dots, path separators, whitespace, control characters, Unicode normalization ambiguity, and internal reserved names. The name `.swarm-deploy` cannot match.

For a file argument:

- The path must identify a regular file.
- Symlinks are rejected.

For a directory argument:

- Only immediate regular-file children are selected.
- Entries are processed in lexical order.
- Subdirectories and symlinks are skipped.
- No client-relative directory paths are transmitted.

The client stats the file before and after pre-hashing. A changed size, modification time, or inode aborts the attempt before upload.

## Wire Protocol

The application protocol is named `swarm-deploy/upload/1` and runs over one authenticated Noise duplex using Protomux.

Small control messages use bounded `compact-encoding` records. File data uses separate bounded binary chunk messages. One connection processes one transfer at a time; a directory batch reuses the connection sequentially.

Version 1 constants:

- Whole-file hash: SHA-256.
- Chunk hash: SHA-256.
- Chunk size: 1 MiB, except the final shorter chunk.
- Maximum encoded control message: 16 KiB.
- Maximum filename length: 200 ASCII bytes.
- Maximum in-flight chunks per connection: 4.

The client pre-reads each file to determine:

- Exact byte length.
- Whole-file SHA-256.
- SHA-256 for each chunk.

The transfer ID is SHA-256 over the canonical compact encoding of:

```text
[
  "swarm-deploy/transfer/v1",
  authenticatedClientPublicKey,
  filename,
  fileSize,
  wholeFileSha256,
  chunkSize
]
```

This makes retries deterministic and binds resumable state to the authenticated identity, destination, and content.

### State Machine

1. **OFFER**
   - Client sends protocol version, transfer ID, filename, size, whole-file digest, chunk size, and chunk count.
2. **ACCEPT or terminal response**
   - Server validates authorization, metadata bounds, filename, limits, disk reservation, existing destination, and session conflicts.
   - Server returns `ACCEPT`, `ALREADY_COMMITTED`, `FILE_EXISTS`, `FILE_BUSY`, or a reason-coded rejection.
   - After `ACCEPT`, the server sends bounded, paginated verified-chunk bitmap messages followed by `READY`. This avoids exceeding the control-message limit for large or fragmented resumable sessions.
3. **CHUNK**
   - Client sends transfer ID, chunk index, chunk digest, and bytes.
   - Server validates index and exact expected length, computes SHA-256, writes by offset, and records a verified checkpoint.
   - A duplicate chunk with the same stored digest is idempotent. Inconsistent duplicate metadata fails the transfer.
4. **CHUNK_ACK**
   - Server acknowledges a chunk only after its bytes have been accepted by the storage layer and its digest has been verified.
   - Client keeps at most four unacknowledged chunks in flight and also pauses whenever Protomux reports stream backpressure.
5. **FINISH**
   - Client sends `FINISH` only after every missing chunk has been acknowledged.
6. **VERIFY**
   - Server ensures every chunk is present, synchronizes staging data, checks exact file length, and re-hashes the whole staging file.
7. **COMMIT**
   - Server commits without replacing an existing filename, persists the commit record, and returns `COMMITTED`.

EOF or disconnect never implies success. The client succeeds only after `COMMITTED` or `ALREADY_COMMITTED`.

Malformed frames, unknown versions, metadata changes, invalid hashes, invalid lengths, excess bytes, inactivity, and unexpected state transitions fail closed.

## Resumable State

The storage layout is:

```text
<storageDir>/
  <committed artifact files>
  .swarm-deploy/
    lock
    staging/
    sessions/
    commits/
    journals/
```

The server never exposes staging files under final artifact names.

Each session persists:

- Transfer ID.
- Owning client public-key fingerprint and full key in protected internal metadata.
- Filename, size, chunk size, and whole-file digest.
- Verified chunk bitmap and per-chunk digests.
- Creation, activity, and checkpoint timestamps.
- State: receiving, verified, committing, or committed.

The server writes chunk bytes before marking them verified. It synchronizes staging data before atomically checkpointing a batch of verified chunks. A crash may cause recently received chunks to be requested again, but a checkpoint never intentionally promises unsynchronized bytes.

On resume:

- The authenticated key and complete OFFER metadata must reproduce the same transfer ID.
- The server validates retained checkpointed chunks against stored chunk hashes before advertising them as present.
- The server returns bounded pages of verified-chunk bits; the client derives missing indexes locally.
- Any machine holding the shared client seed may resume that shared identity's session.

Disconnected sessions expire seven days after their last verified activity. Protocol-invalid, checksum-invalid, or revoked sessions are deleted immediately.

## Atomic Commit and Idempotency

Final filenames are create-only.

Before commit, the server:

1. Closes further writes to the staging file.
2. Synchronizes the staging file.
3. Re-checks exact size and whole-file SHA-256.
4. Persists a committing journal.
5. Creates the final path atomically without replacement on the same filesystem.
6. Synchronizes the storage directory.
7. Atomically persists the commit sidecar.
8. Removes staging and journal state.

On Linux and macOS, the implementation uses an atomic same-filesystem hard link from the closed verified staging inode to the final path. `EEXIST` never overwrites the destination. Unsupported filesystems fail the commit and retain the verified resumable state.

A commit sidecar records:

- Filename.
- Size.
- SHA-256.
- Server commit time.
- Uploader key fingerprint.
- Transfer ID.

If an OFFER targets an existing managed file:

- Matching filename, size, digest, and transfer ID returns `ALREADY_COMMITTED`.
- Different metadata returns `FILE_EXISTS`.

This handles a lost final acknowledgement without replacing content.

## Crash Recovery and Startup Scrub

Only one server process may own a storage root.

Before announcing on Hyperswarm, startup:

1. Acquires the storage-root process lock.
2. Reconciles committing journals with staging, final files, and sidecars.
3. Removes irrecoverable incomplete commit state.
4. Re-hashes every managed committed file against its sidecar.
5. Deletes managed files and records that are missing, truncated, symlinked, or checksum-invalid.
6. Reports unknown top-level paths but does not modify them.
7. Restores valid resumable sessions and staging reservations.
8. Runs retention.

Startup may take time for large stores. Progress is emitted, and the server does not accept uploads until reconciliation and scrub finish.

## Limits and Backpressure

Required operator limits:

- `maxFileBytes`
- `maxStagingBytes`

Configurable defaults:

- Maximum connections: 64.
- Maximum active uploads: 8.
- Connect timeout: 30 seconds.
- Upload idle timeout: 60 seconds.
- Minimum free-disk reserve: 1 GiB.
- Cleanup interval: 15 minutes.
- Resume TTL: 7 days.
- Allowlist poll interval: 5 seconds.

There is no fixed total-transfer timeout while progress continues.

Before `ACCEPT`, the server atomically reserves the remaining declared bytes against `maxStagingBytes` and checks free disk. Active and resumable sessions count toward staging reservations. Expired inactive sessions are removed before a capacity rejection. Active sessions are never evicted.

The server respects stream backpressure and serializes or explicitly bounds queued chunk writes. A four-chunk acknowledgement window prevents the network from outrunning disk processing. The server does not acknowledge or checkpoint a chunk before its bytes have been accepted by the storage layer.

## Retention

Retention applies only to managed committed files.

Options:

- `maxAge`: maximum time since server-side commit.
- `maxStorageBytes`: maximum total logical bytes of committed managed files.

Both are optional. With neither configured, committed files remain indefinitely.

Before committing a verified upload, the server evicts the oldest committed files when needed to satisfy `maxStorageBytes`. It does not remove committed files while an upload is still receiving data. If eviction fails, the verified staging session remains resumable and no final file is created.

Retention also runs once at startup, after every successful commit, and every 15 minutes by default:

1. Remove disconnected resumable sessions older than seven days.
2. Reconcile inexpensive managed-file metadata and exact sizes.
3. Delete committed files exceeding `maxAge`.
4. If committed bytes still exceed `maxStorageBytes`, delete oldest commit records first. Ties sort by filename.

Staging bytes are not counted as committed retention bytes because they have a separate required budget.

If a single offered file exceeds `maxStorageBytes`, the server rejects it before receiving data. Cleanup failures are logged and block new capacity-dependent accepts. Cleanup never follows symlinks, modifies unknown paths, or races an active transfer.

Committed files are fully re-hashed at startup, not during every 15-minute scheduler pass.

## Errors and Observability

Errors have stable machine-readable codes and human-readable messages. Initial codes include:

- `AUTH_REJECTED`
- `SERVER_KEY_MISMATCH`
- `PROTOCOL_VERSION_UNSUPPORTED`
- `PROTOCOL_INVALID`
- `INVALID_FILENAME`
- `INVALID_SEED`
- `INVALID_PUBLIC_KEY`
- `FILE_TOO_LARGE`
- `STAGING_LIMIT`
- `DISK_RESERVE`
- `FILE_EXISTS`
- `FILE_BUSY`
- `CHECKSUM_MISMATCH`
- `UPLOAD_IDLE_TIMEOUT`
- `SESSION_EXPIRED`
- `REVOKED`
- `COMMIT_FAILED`
- `CLEANUP_FAILED`

Structured events include:

- Authentication accepted/rejected.
- Connection opened/closed.
- Upload offered/accepted/resumed/rejected.
- Chunk and total-byte progress.
- Verification and commit outcome.
- Checksum mismatch.
- Allowlist reload and revocation.
- Startup recovery and scrub outcome.
- Retention and staging cleanup.

Logs identify peers using a short public-key fingerprint. Seeds, session transport keys, and full secret/public key material are never logged.

## Repository Layout

```text
.
├── .github/workflows/ci.yml
├── bin/swarm-deploy.js
├── docs/superpowers/specs/
├── index.js
├── index.d.ts
├── lib/
│   ├── client.js
│   ├── server.js
│   ├── identity.js
│   ├── topic.js
│   ├── errors.js
│   ├── protocol/
│   ├── storage/
│   └── compat/
├── test/
│   ├── unit/
│   ├── integration/
│   └── helpers/
├── package.json
├── package-lock.json
├── README.md
├── LICENSE.md
├── NOTICE.md
└── SECURITY.md
```

The package name is `@tetherto/swarm-deploy`. Implementation uses explicit CommonJS and conditional package imports for Node/Bare filesystem, path, and crypto adapters. Direct dependencies include Hyperswarm, HyperDHT, Protomux, compact-encoding, and cross-runtime buffer/crypto support. Exact versions are selected by the package manager and frozen in `package-lock.json`.

The package remains private initially. Publishing workflows are added only when publication is explicitly requested.

## Testing

Tests use Brittle and create all binary content in temporary directories at runtime. No binary fixtures are committed.

Unit coverage includes:

- Seed and public-key parsing.
- Deterministic topic and transfer-ID derivation.
- Filename validation and path confinement.
- Every protocol message and size bound.
- State-machine rejection of malformed or reordered messages.
- Chunk hashing, duplicate handling, and checkpoint recovery.
- Idempotency and same-name conflicts.
- Staging reservation and concurrent destination locks.
- Retention ordering and age boundaries.
- Journal reconciliation and startup scrub.
- Allowlist all-or-nothing reload and revocation.

Integration tests use `hyperdht/testnet` so CI does not depend on the public DHT. Coverage includes:

- Authorized upload and unauthorized rejection.
- Rogue server rejection before application metadata.
- Empty, one-byte, exact-chunk, chunk-minus-one, chunk-plus-one, and multi-chunk files.
- Disconnect at chunk boundaries and mid-transfer resume.
- Lost final acknowledgement followed by `ALREADY_COMMITTED`.
- Wrong declared size, chunk hash, and whole-file hash.
- Concurrent different identities and same-filename races.
- Shared-identity duplicate-connection behavior.
- Seven-day resume expiry.
- Live allowlist removal during upload.
- Simulated write, sync, link, and cleanup failures.
- Cleanup while another transfer is active.
- Restart around verify, commit journal, final link, and sidecar persistence.

Generated multi-chunk files remain small enough for CI. Multi-gigabyte limit behavior is tested with metadata, injected storage adapters, and sparse-file cases rather than committed or fully allocated fixtures.

The central invariants are:

- No failed upload becomes visible.
- No existing committed file is replaced.
- No committed success contains bytes different from the declared SHA-256.
- No unauthorized peer reaches the upload protocol.
- Staging usage remains bounded.

## CI and Repository Setup

The repository uses npm with a committed lockfile.

Scripts cover:

- Formatting and format checks with Prettier and the Holepunch configuration.
- Linting with Lunte.
- Declaration validation.
- Unit and integration tests under Node.js.
- The same compatible suites under Bare.

GitHub Actions runs:

- Ubuntu formatting, lint, and declaration checks.
- Node.js tests on Ubuntu and macOS.
- Bare tests on Ubuntu and macOS.
- A bounded parser/property-test job.

CI uses shared Holepunch setup actions where appropriate and `npm ci` for reproducible installation. It does not copy Barevisor's VM/KVM jobs or publishing workflow.

README documentation includes:

- Key, seed, topic, and Noise identity terminology.
- Server-first and client-first provisioning examples.
- CI secret examples that do not print seed values.
- Allowlist onboarding and live revocation.
- Shared-client-identity serialization.
- Required limits and retention behavior.
- Resume and crash-recovery semantics.
- Explicit content-safety and execution non-goals.

The repository uses Apache-2.0 and includes `LICENSE.md`, `NOTICE.md`, and `SECURITY.md` following the Barevisor reference.

## Authoritative References

- [Hyperswarm README and API](https://github.com/holepunchto/hyperswarm/blob/7fdc50f0ba6b355719b32e76d0e30ff72c3dcdf7/README.md)
- [Hyperswarm key handling](https://github.com/holepunchto/hyperswarm/blob/7fdc50f0ba6b355719b32e76d0e30ff72c3dcdf7/index.js#L23-L54)
- [Hyperswarm duplicate connection handling](https://github.com/holepunchto/hyperswarm/blob/7fdc50f0ba6b355719b32e76d0e30ff72c3dcdf7/index.js#L344-L382)
- [HyperDHT README and key API](https://github.com/holepunchto/hyperdht/blob/74e4d8a631f83155c5bf7a40214180d5a48a64c7/README.md)
- [HyperDHT firewall implementation](https://github.com/holepunchto/hyperdht/blob/74e4d8a631f83155c5bf7a40214180d5a48a64c7/lib/server.js#L217-L271)
- [HyperDHT Noise identity and transport](https://github.com/holepunchto/hyperdht/blob/74e4d8a631f83155c5bf7a40214180d5a48a64c7/lib/noise-wrap.js#L13-L50)
- [Pears Hyperswarm reference](https://docs.pears.com/reference/building-blocks/hyperswarm/)
- [QVAC registry client and binary transfer reference](https://github.com/tetherto/qvac/tree/40b585851dcf554b8b416ba8690a7a0e84199b7b/packages/registry-server/client)
- [QVAC Protomux RPC pattern](https://github.com/tetherto/qvac/blob/40b585851dcf554b8b416ba8690a7a0e84199b7b/packages/registry-server/lib/registry-service.js#L591-L615)
- [Barevisor package setup](https://github.com/tetherto/barevisor/blob/47a055ac65b196a37f7fd2e284783bf79676ba69/package.json)
- [Barevisor CI](https://github.com/tetherto/barevisor/blob/47a055ac65b196a37f7fd2e284783bf79676ba69/.github/workflows/ci.yml)
