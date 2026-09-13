# Swarm Deploy direct-HyperDHT specification

## Status and scope

This document is the authoritative target design for the direct-HyperDHT
refactor. Swarm Deploy is a Node.js and Bare package for authenticated,
encrypted, resumable, one-way artifact uploads to one server on Linux and
macOS. It stores regular files and never executes or serves them.

A client uploads either one regular file or the immediate regular-file
children of one directory. Directory children are processed in lexical order;
each child is an independent upload on a fresh connection. Directories,
symlinks, nested entries, and unsafe names are rejected or skipped before
connecting. Names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`;
`.swarm-deploy` and the server-managed `history-` namespace are reserved.

The refactor has no peer discovery, topic, Hyperswarm, Protomux channel, chunk
protocol, chunk hash, bitmap, or multi-file connection.

## Identity, transport, and authorization

Server and client have separate, persistent Ed25519 identities. Each identity
starts from an independently generated random 32-byte seed, represented to
operators as 64 lowercase hexadecimal characters. Seeds are read from
role-specific files or environment variables, never command-line arguments,
and are never logged.

`sodium-native` is the cryptographic implementation. Seeded keypairs use its
Ed25519 keypair primitive, SHA-256 uses its SHA-256 primitive, and
security-sensitive byte comparisons use its constant-time `sodium_memcmp`.
Public keys are exactly 32 bytes.

The server creates a HyperDHT instance and listens directly:

```ts
const server = dht.createServer({ firewall })
await server.listen(serverKeyPair)
```

The client is configured with the server's public key and connects directly
using its own identity:

```ts
const socket = dht.connect(serverPublicKey, { keyPair: clientKeyPair })
```

HyperDHT Noise authenticates both peers and encrypts the connection. The
authenticated remote client public key is the authorization identity.

The server's allowlist is required, parsed once during startup, and immutable
for that process lifetime. Startup fails on malformed or duplicate entries.
The `firewall` rejects every key absent from that snapshot before an
application connection is accepted. The connection handler also verifies the
authenticated remote key against the same snapshot as defense in depth.
There is no reload, revocation message, or mid-process allowlist mutation.

## Transfer lifecycle

One connection carries exactly one file and follows this sequence:

1. The client sends bounded metadata: protocol version, file name, file size,
   file SHA-256, and deterministic TAR length.
2. The server validates identity, metadata, limits, name policy, destination
   policy, and persistent staging capacity.
3. The server replies `ACCEPT` at offset zero or `RESUME` with a TAR byte offset
   and SHA-256 of the staged TAR prefix.
4. The client deterministically creates the one-entry TAR stream. For a resume,
   it hashes its locally generated prefix through the supplied offset and uses
   constant-time comparison with the server digest.
5. If the prefix matches, the client sends bytes beginning exactly at the
   offset. If it does not match, the client requests `RESET`; the server
   truncates and synchronizes the staged TAR, then replies `ACCEPT` at zero.
6. The server acknowledges transport completion, validates the exact TAR
   length and TAR SHA-256, extracts and validates the one permitted entry, and
   commits it using the storage protocol below.
7. The server sends one explicit terminal result (`COMMITTED`,
   `ALREADY_COMMITTED`, or a stable error) before either peer closes.

Control records are length-bounded and cannot be interleaved with TAR bytes.
EOF, socket close, or an implicit acknowledgment is never upload success.
Connection setup, metadata, transfer inactivity, result drain, and shutdown
remain bounded by explicit timeouts and cancellation.

### Deterministic one-entry TAR

For metadata `(name, size, mode, mtime)`, every runtime must emit identical
bytes. The archive contains exactly one regular-file entry whose path is
`name`, followed by the standard end-of-archive blocks. It uses the portable
USTAR subset with:

- no PAX, GNU, global, sparse, link, device, directory, or extended entries;
- canonical UTF-8 path bytes and no path prefix;
- declared size equal to the source file size;
- mode normalized to `0644`;
- uid, gid, mtime, uname, and gname normalized to zero or empty;
- canonical octal fields, checksum, zero padding, and two 512-byte end blocks.

The implementation rejects any archive whose byte length differs from the
deterministic length derived from the file size. Extraction accepts exactly
one regular entry with the offered name and size, rejects trailing entries or
non-canonical headers, and computes the extracted file SHA-256 while writing.
The extracted size and digest must equal the metadata before commit.

`tar-stream` supplies streaming packing and extraction, but these canonical
rules, byte counts, and validation are Swarm Deploy protocol requirements.

### Resume state

Resume offsets are byte offsets in the deterministic TAR, not source-file
offsets. The server only advertises a durable staged length. Before replying
`RESUME`, it hashes the complete staged prefix and returns that SHA-256.
Staging writes are synchronized before their offset becomes resumable.

Sessions are keyed by authenticated client public key plus immutable offered
metadata. Inactive incomplete sessions expire seven days after their last
durable progress. Expiration never removes an active receive. A mismatch reset
reuses the admitted session after durably truncating it to zero; it does not
append to or trust a divergent prefix.

Startup purges all legacy chunk-session state, including chunk maps, partial
chunk payloads, and obsolete reservations. It preserves committed current
artifacts, history artifacts, commit sidecars, and v2 journals, which remain
subject to normal validation and recovery.

## Storage accounting

`maxFileBytes` limits the extracted artifact size. Required
`maxStagingBytes` is a persistent reservation limit across active and
resumable sessions. Each admitted session reserves its full worst-case
transfer peak:

```text
deterministic TAR length + extracted file size
```

The complete reservation persists across restart and for the session's
seven-day resume lifetime, even when fewer TAR bytes have arrived. This covers
the phase where the staged TAR and extracted staging file coexist and prevents
restart, concurrency, or delayed extraction from overcommitting disk.
Admission first expires eligible inactive sessions under serialization, then
checks the limit. Cleanup releases reservations only after durable commit,
durable reset/removal, or expiry.

Committed retention is separate. Optional `maxAge` and `maxStorageBytes`
account for every current and historical artifact exactly once.

## Commit, replacement, and recovery

The existing create-only commit behavior and retained replacement/history
model remain:

- names are create-only unless present in the configured `replaceNames`;
- identical managed content returns `ALREADY_COMMITTED`;
- different content for a replaceable name atomically becomes current;
- the prior managed inode is retained as
  `history-<full-old-transfer-id>`;
- unmanaged destination and history paths are never overwritten or deleted;
- current replaceable artifacts are pinned against age/quota retention, while
  create-only and history artifacts participate in normal retention.

The v2 journal remains the crash-recovery authority for replacement. It
records the expected old record and inode, history destination, verified new
staging inode, new record, and phase before visible mutation. Before the
durable new current sidecar, rollback restores the old current and preserves a
valid verified new session. After that sidecar is durable, recovery finishes
the new current/history state and cleanup without rolling back committed
content.

Startup recovers journals before listening, validates journal-owned identities
before mutation, re-hashes managed committed files, removes invalid managed
records, reports unknown paths, restores valid direct-TAR sessions, then runs
retention. Recovery and retention preserve the create/replace/history
linearization and fail closed on corruption.

## Public API, CLI, and observability migration

The root API is simplified around `Client`, `Server`, stable errors, identity
helpers, allowlist parsing, and the public option/result/event types needed to
use them. Client configuration uses a client seed and
`serverPublicKey`; server configuration uses a server seed, immutable
allowlist, storage limits, replacement policy, and optional injected DHT.
Topic parsing/derivation, swarm factories, discovery controls, reconnect
budgets, Protomux types, and chunk protocol internals are removed.

The CLI keeps role-specific seed generation and server/upload commands. Server
startup prints the server public key and then `ready`. Upload requires
`--server-key <64-lower-hex>` plus client seed configuration. Topic commands
and `--topic` are removed. A directory upload is a lexical loop over immediate
files and reports each independent result.

Events and logs expose lifecycle milestones for direct connection, offer,
accept/resume/reset, transfer progress, verification, commit, recovery,
retention, and failure. They use short SHA-256 fingerprints and never expose
seeds, secret keys, full public keys, TAR contents, or session material.
Listener and logger failures cannot affect protocol correctness.

## Test and package migration

Tests cover deterministic TAR equality across Node and Bare, direct mutual
authentication, immutable firewall allowlisting, one-file connections,
directory looping, bounded controls, explicit terminal results, offset resume,
prefix mismatch reset, seven-day expiry, restart-safe peak reservations,
malicious TAR rejection, create/replace/history v2 crash points, recovery,
retention, cancellation, events, CLI behavior, and package import/type smoke.

Legacy discovery/topic, Protomux, chunk bitmap, chunk scheduling, reconnect,
and revocation-reload tests are deleted or rewritten rather than retained as
current behavior. `hyperswarm`, `protomux`, `compact-encoding`, and
`bare-crypto` stay installed only while still imported by the pre-refactor
implementation; later implementation tasks remove each dependency after its
last import and replacement tests are green.

Production and tests remain strict TypeScript targeting ES2022 with Node16
module behavior. Generated `dist/`, `.test-dist/`, coverage, task reports, and
tool plans remain untracked. The package continues to support Node.js 22 and
24 and the current stable Bare runtime on Linux and macOS.
