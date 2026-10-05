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
names are limited to 100 UTF-8 bytes, and the server-managed `history-`
namespace is reserved.

The refactor has no peer discovery, topic, Hyperswarm, Protomux channel, chunk
protocol, chunk hash, bitmap, or multi-file connection.

## Identity, transport, and authorization

Server and client have separate, persistent Ed25519 identities. Each identity
starts from an independently generated random 32-byte seed, represented to
operators as 64 lowercase hexadecimal characters. Runtime constructors accept
the seed as a 32-byte Buffer or canonical hex string. The CLI accepts exactly
one role-specific seed source: file, environment variable, or explicit
`--seed`. Files and environment variables are preferred because command
arguments may be exposed through shell history, process listings, CI tracing,
and diagnostic tooling. Seeds are never logged by Swarm Deploy.

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

1. The client sends bounded metadata: protocol version, file name, optional
   `sourceParent`, file size, file SHA-256, and deterministic TAR length.
2. The server validates identity, metadata, limits, name policy, configured
   artifact-pattern match, destination policy, and persistent staging capacity.
3. The server replies `ACCEPT` at offset zero or `RESUME` with a TAR byte offset
   and SHA-256 of the staged TAR prefix.
4. The client deterministically creates the one-entry TAR stream. For a resume,
   it hashes its locally generated prefix through the supplied offset and uses
   constant-time comparison with the server digest.
5. If the prefix matches, the client sends bytes beginning exactly at the
   offset. If it does not match, the client requests `RESET`; the server
   truncates and synchronizes the staged TAR, then replies `ACCEPT` at zero.
6. The server acknowledges transport completion, validates the exact TAR
   length and TAR SHA-256, checks the stream against the one permitted
   canonical framing and takes its payload by offset, and commits it using the
   storage protocol below.
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
deterministic length derived from the file size.

Because every byte outside the payload is fixed by the offered metadata,
extraction is a comparison rather than a parse. The receiver derives the one
canonical 512-byte header from `(name, size)`, requires the stream to match it
exactly, requires every byte after the payload to be zero, and requires the
total length to equal the deterministic length. A stream that satisfies those
checks is by construction a single regular entry whose contents are exactly
`tar[512 .. 512 + size)`, so the payload is taken by offset. Any deviation —
a second entry, a non-canonical or non-file header, PAX or GNU extensions,
trailing bytes, or truncation — fails one of those checks. The extracted size
and digest must equal the metadata before commit.

`tar-stream` supplies streaming packing on the send path. The receive path
depends on no TAR parser; these canonical rules, byte counts, and validation
are Swarm Deploy protocol requirements. The two must agree byte for byte, and
a test pins the canonical header against the packer's output.

### Resume state

Resume offsets are byte offsets in the deterministic TAR, not source-file
offsets. The server only advertises a durable staged length. Before replying
`RESUME`, it hashes the complete staged prefix and returns that SHA-256.
Staging writes are synchronized before their offset becomes resumable.

Sessions are keyed by authenticated client public key plus immutable offered
metadata, including `sourceParent` when present. Inactive incomplete sessions expire seven days after their last
durable progress. Expiration never removes an active receive. A mismatch reset
reuses the admitted session after durably truncating it to zero; it does not
append to or trust a divergent prefix.

Startup purges all legacy chunk-session state, including chunk maps, partial
chunk payloads, and obsolete reservations. It preserves committed current
artifacts, history artifacts, commit sidecars, and v2 journals, which remain
subject to normal validation and recovery.

## Release identity, rotation, and hooks

### Source parent

The offer metadata record may carry one optional `sourceParent` string: the
basename of the client's immediate local parent directory. It is omitted unless
it matches `^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$` and is at most 100 UTF-8 bytes
(`+` is permitted for SemVer build metadata, unlike artifact names). Absolute
paths and higher components are never sent. When present it is a field of the
transfer-ID derivation, so it is authenticated by the owner key and immutable
across resume attempts; when absent the derivation and wire shape are identical
to earlier clients. The field is persisted with the resumable session, so a
verified reconnect retains its release identity.

Session records carry an on-disk version: version 2 sessions (no
`sourceParent`) remain readable, and sessions written by this version use
version 3 and always record the field when present. A version-2 record that
contains `sourceParent` is invalid.

### Artifact patterns

A server may be configured with an ordered list of templates made of literal
text and the placeholders `{series}` and `{version}`. A template has at least
one placeholder, at most one of each, no adjacent placeholders, one or two
`/`-separated non-empty segments (`basename` or `parent/basename`), no residual
`{` or `}` in its literal text, and is unique. `{version}` values are strict
SemVer 2.0.0 and are normalized without build metadata; a template without
`{series}` is a fixed series whose key is `fixed-` followed by the lowercase hex
SHA-256 of the exact template text. That key is a 70-byte safe basename, so it
satisfies commit-record validation and is byte-identical on every runtime and
across restarts. Matching evaluates templates in declaration order; templates with
a parent segment are skipped when no `sourceParent` was offered; the first
template that yields coordinates wins.

If at least one template is configured, matching is mandatory: an unmatched
offer is rejected with `INVALID_FILENAME` before session admission, destination
inspection, staging, verification, commit, or the `beforeCommit` and
`afterCommit` hooks. The failure hook still observes the rejection. A server
with no templates preserves the earlier behavior and stores no release identity.

The normalized `{series, version?}` coordinates are decided at commit time and
persisted in the commit record, copied to replacement-history records,
included in record comparison, journal serialization, and recovery, and
therefore stable across restarts and configuration changes. One transfer ID
cannot be committed with two different coordinates: the offer fails closed
instead of reporting `ALREADY_COMMITTED`. Records without coordinates (written
before the feature or by a server without templates) are legacy: they are
subject to age and quota retention but never to count or version rotation.

### Rotation and retention order

Retention serializes under the root lease. After session expiry and a
committed-state scrub, it applies in order: age, count, version, storage quota.
Each stage sees the records the previous stage kept, so configured count and
version bounds retain the intersection of their keep sets.

Count rotation groups released records by series, orders them by `committedAt`
descending then transfer ID and name ascending, and keeps the first `maxCount`.
Version rotation groups versioned records by series, orders them by SemVer
precedence descending (ties by the commit order above), maps each version to its
`major` or `major.minor` group per `versionGranularity`, and keeps every record
in the first `maxVersions` distinct groups. Prereleases and history records in a
retained group are kept; build metadata does not exist in stored versions.
Current mutable artifacts are pinned: they are counted but never deleted, so a
limit is best-effort when one exceeds it.

Retention runs before a commit's link step and again after the commit becomes
durable, so rotation may remove an artifact that falls outside the retained
window immediately after it is committed. When an `afterCommit` hook is
configured the post-commit pass is deferred: the order is commit, `afterCommit`,
then the post-commit pass only after the callback succeeded, then the terminal
`COMMITTED` or `ALREADY_COMMITTED` reply. The deferred pass therefore runs before
that reply, and a slow retention pass can delay it. When `afterCommit` begins in
the sequential server flow, the final path and sidecar exist, including for
out-of-window releases and for replacement commits and their history. This is
not a lock: a concurrent commit's retention pass, a scheduled pass, or a manual
pass can remove the file while the callback runs, so a hook needing stable bytes should open or copy
it promptly. A failing `afterCommit` skips the pass for that connection and
leaves the artifact and record, so an immediate retry normally is
`ALREADY_COMMITTED`, reruns `afterCommit`, and then runs the pass. The deferred
pass is owed per transfer: the server tracks in memory the transfer IDs it
committed whose `afterCommit` has not yet succeeded, and an already-committed
offer starts a pass only for one of those. Any other duplicate offer still runs
`afterCommit` but performs no retention pass, so duplicate offers cannot force
repeated full scans. The owed set is cleared once a hook succeeds and its pass
has been attempted, and server close clears it.
Servers without an `afterCommit` hook (including `beforeCommit`-only and
`onFailure`-only) run the pass immediately after the commit. Pre-commit quota and
age checks are never deferred, and post-commit retention failures remain
non-fatal. Because no persistent hook-pending marker exists, any intervening
retention pass (startup after a restart, scheduled or manual cleanup, or a
concurrent commit's retention) can remove an out-of-window artifact whose
`afterCommit` failed before the retry; the retry is then a fresh upload, not
`ALREADY_COMMITTED`. Every retry statement in this document is qualified by that
caveat.
`retention` events and results expose `ageDeleted`, `countDeleted`,
`versionDeleted`, and `storageDeleted`; deletions log the stable reasons
`MAX_AGE`, `MAX_COUNT`, `MAX_VERSIONS`, and `MAX_STORAGE`.

`maxCount` requires at least one template; `maxVersions` requires a template
with `{version}` and `versionGranularity`; `versionGranularity` requires
`maxVersions`. Violations are construction-time `PROTOCOL_INVALID` errors and
CLI exit code 2.

### Hooks

A server may be configured with `beforeCommit`, `afterCommit`, and `onFailure`
callbacks. Direct `ServerOptions.hooks` accepts only a hook object whose own keys
are those names and whose values are functions; it is snapshotted at
construction. The CLI `--hooks` option loads a `.js`, `.mjs`, or `.cjs` module
before the server listens, selecting only those names (named exports win over a
default object; one `__esModule` interop level is unwrapped; other exports are
ignored) and failing with exit code 2 on any load or shape error. Hooks are
trusted code; contexts are frozen and exclude seeds, keys, TAR data, and session
material. Callbacks are invoked without a receiver. There is no hook timeout;
only server shutdown abandons a pending callback, which then continues detached.

Observable order:

- fresh or partially resumed upload: offer, ACCEPT or RESUME, TAR receipt,
  verification, `beforeCommit`, commit, `afterCommit`, `COMMITTED`;
- verified reconnect (`VERIFIED`): re-read of the verified staging file,
  `beforeCommit` with `resumed: true`, commit, `afterCommit`, `COMMITTED`;
- already committed: `afterCommit` with `alreadyCommitted: true` and
  `resumed: false`, then the deferred retention pass only when this process
  still owes one for that transfer, then `ALREADY_COMMITTED`, with no
  verification or `beforeCommit`.

A `beforeCommit` failure prevents commit mutation and leaves the verified
session resumable. An `afterCommit` failure leaves the artifact durably
committed, fails the connection, and (unless retention removed the artifact
first; see the retention caveat above) makes a retry take the already-committed
path, so both callbacks may run more than once for a transfer ID and must be
idempotent. A callback exception becomes the stable wire code `HOOK_FAILED` with
a fixed message.

`onFailure` runs at most once per connection after metadata was decoded and the
failure was sent, unless both gating hooks already succeeded. Its context phase
is `offer`, `transfer`, `verification`, `beforeCommit`, `commit`, or
`afterCommit`; its `error` is the raw callback exception for hook failures and
the original error otherwise. Its path is `null` for `offer`; the `.tar.part`
staging file during transfer and for fresh-upload verification; the extracted
`.part` staging file for `beforeCommit`, `commit`, and verified-reconnect
verification; and the final path for `afterCommit`. An `onFailure` exception is
logged as a secondary warning and never replaces the original failure.

### Rollout compatibility

Servers must be upgraded before clients. A server that predates `sourceParent`
decodes offers with an exact key set and rejects the new field, so a new client
that sends it to an old server fails. A new server accepts older clients,
version-2 sessions, and older commit records; offers without `sourceParent` can
match only patterns without a parent segment. Sessions the new server writes use
version 3, which a version-2-only server rejects, so in-flight uploads cannot
resume after a rollback and uploads should be drained first. Compatibility of
release-bearing commit records with older code is unverified.

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
and revocation-reload tests are deleted rather than retained as current
behavior. The package has no application dependency on `hyperswarm`,
`protomux`, `compact-encoding`, or `bare-crypto`; transitive HyperDHT
dependencies remain an implementation detail of HyperDHT itself.

Production and tests remain strict TypeScript targeting ES2022 with Node16
module behavior. Generated `dist/`, `.test-dist/`, coverage, task reports, and
tool plans remain untracked. The package continues to support Node.js 22 and
24 and the current stable Bare runtime on Linux and macOS.
