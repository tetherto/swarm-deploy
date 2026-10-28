# Swarm Deploy direct-HyperDHT specification

## Status and scope

This document is the authoritative target design for the direct-HyperDHT
refactor. Swarm Deploy is a Node.js and Bare package for authenticated,
encrypted, resumable, one-way artifact uploads to one server on Linux and
macOS. It stores regular files and never executes or serves them.

A client uploads either one regular file or one recursive directory artifact.
Directory uploads commit exactly one managed tree named after the input
basename; unsafe members reject the whole offer before connecting. Names match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`;
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

### Deterministic recursive tree TAR

A directory offer carries a canonical multi-entry USTAR archive. Entries are
ordered bytewise on normalized TAR names with parents before children. Regular
files use mode `0644`; directories use mode `0755` with a trailing slash in the
stored name. uid, gid, mtime, uname, and gname are fixed. Each path component
and whole stored name is limited to 100 UTF-8 bytes; depth is 32; entry count is
10,000. Aggregate payload bytes obey `maxFileBytes`. The tree digest uses the
`swarm-deploy/tree/v1` framing over normalized headers and payload bytes.
Symlinks, hard links, devices, sockets, FIFOs, cycles, traversal, duplicates,
and case-fold collisions are rejected.

### Directory offer metadata

Directory metadata is disjoint from the file record key set so an older server
rejects it through its exact-key check without mutating storage. Required keys
include `kind: 'directory'`, `entryCount`, `payloadBytes`, `treeSha256`, and
the usual TAR length and transfer fields. Transfer IDs use the
`swarm-deploy/direct-tree/v1` domain. Committed directory records carry the
same descriptive fields plus the authenticated uploader fingerprint.

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

File sessions remain at persisted versions 2 and 3. Directory sessions use
version 4 and verify into `.swarm-deploy/staging/<transfer-id>.tree/` by
rebuilding canonical headers and recomputing the tree digest independently.

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

A client may suppress the field for privacy with `includeSourceParent: false`
(CLI `--no-source-parent`, which takes no value). The option defaults to `true`,
applies to every file in a run, and makes the upload indistinguishable on the
wire from a client that predates the field, including its transfer ID. A server
pattern with a parent segment therefore rejects an opted-out upload with
`INVALID_FILENAME`.

Session records carry an on-disk version that follows the field rather than the
writing code: a session with a `sourceParent` is written as version 3 and a
session without one as version 2. Both are readable. A version-2 record that
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
across restarts. That shape is reserved: a captured `{series}` of exactly
`fixed-` followed by 64 lowercase hex characters is not a valid capture, so an
offered name cannot claim the series of a version-only template; the pattern is
simply a non-match. Matching evaluates templates in declaration order; templates
with a parent segment are skipped when no `sourceParent` was offered; the first
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
window immediately after it is committed. When an `afterCommit` or `afterLink`
hook is configured the post-commit pass is deferred: the order is commit,
`afterCommit`, `afterLink`, then the post-commit pass only after the callbacks
succeeded, then the terminal `COMMITTED` or `ALREADY_COMMITTED` reply. The deferred pass therefore runs before
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
has been attempted, and server close clears it. It holds at most 1024 transfers,
the same ceiling as `maxConnections`; a persistently failing hook that reaches
the bound evicts the oldest owed transfer first. Eviction is deterministic and
loses nothing durable: the artifact stays committed and its rotation falls back
to the next startup, scheduled, or commit-triggered pass.
Servers without an `afterCommit` or `afterLink` hook (including
`beforeCommit`-only and `onFailure`-only) run the pass immediately after the
commit. Pre-commit quota and
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

A server may be configured with `beforeCommit`, `afterCommit`, `afterLink`, and
`onFailure` callbacks. Direct `ServerOptions.hooks` accepts only a hook object whose own keys
are those names and whose values are functions; it is snapshotted at
construction. The CLI `--hooks` option loads a module before the server listens,
selecting only those names (named exports win over a default object; one
`__esModule` interop level is unwrapped; other exports are ignored) and failing
with exit code 2 on any load or shape error. The path's extension must be
exactly `.js`, `.mjs`, or `.cjs`; any other extension is rejected before the
load is attempted. Hooks are
trusted code; contexts are frozen and exclude seeds, keys, TAR data, and session
material. Callbacks are invoked without a receiver. There is no hook timeout;
only server shutdown abandons a pending callback, which then continues detached.
A callback on a fresh or resumed upload runs while its connection still holds an
active-upload slot and its session's staging reservation, so hung callbacks
consume upload capacity and can make further offers fail with
`ACTIVE_UPLOAD_LIMIT` until the server closes. Only the already-committed path
holds no upload slot. Bounded timeout and anti-spam controls are deferred to
issue #8.

A transfer ID has a single owner for its commit lifecycle. From the moment
metadata authenticates until that lifecycle ends, a second connection offering
the same transfer ID is rejected with `FILE_BUSY` during the offer phase, before
any staging work, so verification, `beforeCommit`, commit, and `afterCommit`
never execute concurrently against one transfer identity. The guard is per
process and in memory, holds at most one entry per connection, and is released
when the connection finishes or the server closes.

The guard covers the lifecycle, not observation. A failing connection releases
the transfer before awaiting `onFailure`, since that callback only reports an
already-settled outcome; the `finally` release is then a no-op and cannot take
ownership from whichever connection acquired the transfer next. A retry is
therefore admitted while the previous `onFailure` is still running, and its own
lifecycle hooks may overlap that callback. Each connection still invokes
`onFailure` at most once.

Observable order:

- fresh or partially resumed upload: offer, ACCEPT or RESUME, TAR receipt,
  verification, `beforeCommit`, commit, `afterCommit`, `afterLink` for each
  automatic link now pointing at the artifact, `COMMITTED`;
- verified reconnect (`VERIFIED`): re-read of the verified staging file,
  `beforeCommit` with `resumed: true`, commit, `afterCommit`, `afterLink`,
  `COMMITTED`;
- already committed: `afterCommit` with `alreadyCommitted: true` and
  `resumed: false`, `afterLink` for each automatic link pointing at the
  artifact, then the deferred retention pass only when this process still owes
  one for that transfer, then `ALREADY_COMMITTED`, with no verification or
  `beforeCommit`;
- explicit link request: policy checks, the durable link mutation, `afterLink`
  with `trigger: 'request'`, then the `LINKED` or `UNCHANGED` result.

A `beforeCommit` failure prevents commit mutation and leaves the verified
session resumable. An `afterCommit` failure leaves the artifact durably
committed, fails the connection, and (unless retention removed the artifact
first; see the retention caveat above) makes a retry take the already-committed
path, so both callbacks may run more than once for a transfer ID and must be
idempotent. A callback exception becomes the stable wire code `HOOK_FAILED` with
a fixed message.

`afterLink` publishes a durable link. It receives
`{ link, artifact, status, trigger }`, where `link` is
`{ name, target, mode, path, targetPath }`, `status` is `LINKED` or `UNCHANGED`
(the link decision this call observed, not proof of publication: another
commit's retention or reconciliation may have moved the link first, and a manual
ownership-metadata refresh for the same target is `UNCHANGED`),
and `trigger` is `upload` (one call per automatic link that points at the
uploaded artifact, after `afterCommit`) or `request` (one call for an explicit
link request). It runs for `UNCHANGED` too, so a retry after a failed hook
re-runs it, and it is at-least-once: hooks must be idempotent on link name plus
artifact transfer ID. No success is sent before it returns, and a failure is
`HOOK_FAILED` (a `FAILED` link result, upload final record, or admission
`REJECTED` record) without rolling back the committed artifact or an upload's
automatic link. An explicit link request additionally carries a failure policy
(see the manual link control protocol): by default the previous link and
ownership record are restored before `HOOK_FAILED` is answered, or kept when the
request asked for `keep`. It does not run for a rejected or unauthorized link,
for a manual link whose target is replaced, or for reconciliation done by startup
or retention.

`afterLink` may return a plain JSON object. The server reads that value only for
an explicit link request that asked for it (see the manual link control
protocol); an upload's automatic links and a request that did not ask ignore it
without inspecting it. A checked copy is sent in the `LINKED` or `UNCHANGED`
answer after the hook has resolved. An unusable value (not a plain object, or
containing `undefined`, a function, a symbol, a BigInt, a non-finite number, a
class instance, an accessor, a symbol key, a cycle, more than 8 levels, or more
than 3072 bytes) fails the request like a throw: `HOOK_FAILED` with the fixed
message, the link restored or kept as the failure policy says, and `onFailure`
receiving an error that names the reason and path but no value. The result is whatever the hook chose to report, such as
an external submission ID, and is not proof of publication.

The hook runs with no storage-root lease held, so it never blocks other work and
cannot deadlock on it; consequently its context is a snapshot of one decision and
the link or target may already have changed. For an upload's automatic links the
server starts hooks in the order the link decisions were made (a place in an
in-memory first-in, first-out line is reserved under the lease) and never runs
two at once; different links run concurrently. Explicit link requests for one
name run one at a time, in arrival order, from the link decision through the hook
to the finalize or restore, under a name-scoped admission (names compared
case-folded, taken before and never while holding the root lease), so a request
never decides against another's unfinished change; the lease itself is held only
around the decision and around finalizing or restoring. Neither ordering survives
a restart, and both are unbounded in time because there is no hook timeout. A client
waits for its answer for at most its idle timeout, which covers everything the
server does first (commit, `afterCommit`, every `afterLink` call in sequence,
hooks queued ahead for the same link, retention); if it expires first the
client reports `UPLOAD_IDLE_TIMEOUT` instead of `HOOK_FAILED` while the server
still finishes the hooks.

After a `HOOK_FAILED` answer is written the server ends its write side and
destroys the connection when the peer closes it or after a 5-second grace
period, so the peer reads the stable code rather than a stream reset. Other
failure answers are followed by an immediate destroy.

`onFailure` runs at most once per connection after metadata was decoded and the
failure was sent, unless every gating hook already succeeded; it also runs once
for a failed `afterLink` on a link request, after the link was restored or final
and the client was answered, with no lease held. Its
context phase is `offer`, `transfer`, `verification`, `beforeCommit`, `commit`,
`afterCommit`, or `afterLink`; its `error` is the raw callback exception for hook
failures and the original error otherwise. Its path is `null` for `offer`; the
`.tar.part` staging file during transfer and for fresh-upload verification; the
extracted `.part` staging file for `beforeCommit`, `commit`, and
verified-reconnect verification; the final path for `afterCommit`; and the link
path for `afterLink`, whose context also carries `link`. An `onFailure`
exception is logged as a secondary warning and never replaces the original
failure.

An `offer`-phase context is assembled from decoded metadata before the transfer
ID is authenticated, and is reported even when that authentication is the
failure. Its artifact fields are then unauthenticated peer input and must not be
used as audit or idempotency keys. Contexts for all later phases follow
successful authentication.

### Rollout compatibility

Servers must be upgraded before clients. A server that predates `sourceParent`
decodes offers with an exact key set and rejects the new field, so a new client
that sends it to an old server fails. A new server accepts older clients,
version-2 sessions, and older commit records; offers without `sourceParent` can
match only patterns without a parent segment. Only a parent-bearing session is
written as version 3, so a rollback loses the resumability of those sessions
alone; draining in-flight uploads first avoids it.

Release identity in a commit record is durable and is never rewritten.
Enabling patterns, or changing one an in-flight upload already matched, makes a
retry of already-committed bytes compute a different identity, and the server
fails closed: a create-only name is rejected with `FILE_EXISTS` and a
replaceable name retried under the same transfer ID with a different release is
rejected as a release-identity conflict. In-flight uploads should therefore be
drained before patterns are enabled or changed.

Commit-record compatibility is asserted only in the reading direction: a record
without release coordinates is read by this version and is excluded from count
and version rotation. Whether older code tolerates records this version writes
is untested.

Direct file TAR bytes, transfer IDs, sessions, records, commit, replacement,
hooks, and retention for files are unchanged. Directory metadata, session
version 4, commit record version 3, directory journals, directory trash, and
managed symlinks are not downgrade-compatible. Drain uploads before upgrading
and do not roll back after committing a directory artifact without restoring
from backup.

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

Commit records for directories use version 3. Directory journals use version 3
with phases `journaled → renamed → sidecar → cleanup`. A directory publishes by
renaming its verified staging tree under the name and root leases. Recovery
handles crashes before rename, after rename, after the sidecar, and during
symlink reconciliation. Directory artifacts are create-only; configured
`replaceNames`, file-to-directory, and directory-to-file offers are rejected.
Committed artifacts, including directories, are immutable on disk: hooks and
operators must not write into a published directory (`npm ci`, `.cache`,
dotfiles, or extra symlinks). If a committed tree changes, startup hash scrub
drops the sidecar while leaving bytes in place, the name stays occupied
(`FILE_EXISTS`), the tree falls outside quota and rotation, and a managed
`latest` link can repoint to an older release.
Deletion renames a managed directory into `.swarm-deploy/trash/<transfer-id>.tree`
before recursive removal without following symlinks; startup sweeps proven trash.

The existing create-only commit behavior and retained replacement/history
model remain for files:

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

## Managed symlinks

### Policy model

`ServerOptions.symlinks` is snapshotted and compiled at construction. Every
entry has exactly one of these shapes:

```ts
{ selector: string, name: string } // automatic newest-match reconciliation
{ selector: string }               // manual target authorization
```

The CLI equivalent is repeatable `--symlink <selector> [<link-name>]`. A
selector is either an exact safe managed-artifact basename or an unflagged
regular expression written `/pattern/`. Selectors are non-empty and limited to
200 UTF-8 bytes. Exact selectors, automatic names, request targets, and request
names are safe top-level basenames of at most 100 UTF-8 bytes and may not use
the reserved `history-` namespace.

Configuration rejects malformed iterables and record shapes, duplicate
automatic names, duplicate manual selectors, malformed or oversized regular
expressions, unsafe or reserved exact selectors and automatic names, and an
exact automatic selector equal to its own name. Automatic names alone form the
configured link-name set and alone participate in newest-match selection.
Manual rules are only a target allowlist and never create or reconcile a link
by themselves.

Automatic selection uses validated current commit records, excludes history,
and skips a candidate whose artifact name equals the link name. The newest
`committedAt` wins, with transfer ID then artifact name as deterministic
tie-breakers. A rule with no matching current artifact is dormant, but its
automatic name remains reserved from manual requests.

### Manual link control protocol

An authenticated client sends one strict bounded first control record:

```ts
{ v: 1, kind: 'link', target: string, name: string } // an older client
{ v: 1, kind: 'link', target: string, name: string, hookFailure: 'rollback' | 'keep' }
{ v: 1, kind: 'link', target: string, name: string, hookFailure: 'rollback' | 'keep', hookResult: true }
```

The record has exactly the first four fields, plus `hookFailure` when the client
states its failure policy and `hookResult` only when it asks for the hook result
(see below); `hookResult` can only be `true`. A current client always sends
`hookFailure` (`rollback` unless the caller chose `keep`), so a server that
predates it rejects the unknown key and the request fails closed instead of
keeping a link the caller expects to be rolled back; a request without it, which
only an older client sends, is handled as `rollback`. The two optional fields are
independent. The failure policy decides, when the server's `afterLink` hook fails
(throws, returns a result that cannot be sent, or is aborted by a closing server),
whether the link and ownership record the request changed are restored (`rollback`)
or left (`keep`); the request waits for the hook and is answered `HOOK_FAILED`
either way (see "Link rollback journal" below). It is a control RPC separate from upload
offers and TAR bytes. The client half-closes after the request; the server
requires EOF immediately, so trailing control records or payload bytes fail the
request. The response is exactly one strict record:

```ts
{ v: 1, status: 'LINKED' }
{ v: 1, status: 'UNCHANGED' }
{ v: 1, status: 'FAILED', code: ErrorCode }
{ v: 1, status: 'LINKED' | 'UNCHANGED', hookResult: HookResult } // opt-in only
```

`hookResult` appears only in the answer to a request that carried
`hookResult: true`, only on `LINKED` or `UNCHANGED`, and only when the server's
`afterLink` hook returned an object. A `FAILED` record never carries it, and a
client that did not ask treats one as `PROTOCOL_INVALID`. The decoder accepts
exactly one extra key and validates its value as a plain JSON object: strings,
finite numbers, booleans, `null`, arrays, and plain objects, at most 8 levels
deep, at most 3072 UTF-8 bytes of compact JSON (so the record stays inside the
4 KiB control record limit, which is unchanged), with no `__proto__` key. The
server builds the value from what the hook returned, as a copy, and fails the
request with `HOOK_FAILED` (the link restored or kept as the failure policy says,
no result sent) when the hook returns anything else; a hook that returns nothing sends no field. A result is
what the hook chose to report, not proof of publication, and it is never put in
events or logs. `CONTROL_VERSION` stays `1`.

HyperDHT Noise identity, pinned server identity, the server firewall, and the
immutable client allowlist authenticate a link caller exactly as for upload.
Only after authentication and strict request decoding does the server apply
manual-link policy: target and name must differ, the target must match a manual
authorization rule, and the name must not be an automatic name. Under the
storage-root lease it then resolves the target from current commit records,
rejects missing and history targets, snapshots current artifact and automatic
link names, and performs the namespace check and mutation. The lease serializes
the decision and mutation with commit, recovery, retention, and other link
requests. It is released before any `afterLink` hook runs, and the result record
is written only after that hook returns; a hook failure is the `FAILED` result
with code `HOOK_FAILED`, which every existing client already decodes. A restore
that cannot be proven or fails is `FAILED` with `LINK_FAILED` instead. Before the
lease, each request enters a name-scoped admission (the link name case-folded), so
explicit requests for one name run one at a time from decision through hook to
finalize or restore; the root lease is taken again, briefly, to finalize or
restore.

The target must be a current managed top-level file or directory. The
destination name cannot be the target, an automatic name, or a managed artifact
name. A missing destination may be created; an existing destination may be
changed only when its valid ownership record says it is manual and its visible
symlink still points to the recorded or requested relative sibling basename.
A regular file, directory, changed symlink, automatic record, foreign record, or
other occupied unmanaged path fails closed and is never replaced, moved, or
deleted.

The one exception is an existing symlink with no ownership record at the
requested name. After every check above has passed for the requested target, an
explicit manual request takes it over: the server re-checks that the symlink is
unchanged (same literal, same inode where the adapter reports one) and still
unrecorded, atomically renames a private sibling-target symlink over it, and
then writes a manual record that names only the requested artifact. The first
takeover returns `LINKED`, even if the old literal already read as the target;
repeats return `UNCHANGED`. The old literal is only compared as text and is never
resolved, so any value (relative, absolute, outside the root, dangling, a chain,
or a self-reference) is replaced without touching what it named, and no commit
metadata is created for it. If the destination became a file, a directory, a
different symlink, or gained a record before the swap, the request fails with
`LINK_CONFLICT`. The adapter has no compare-and-swap rename, so a writer outside
the server that edits the root between the re-check and the rename is not
excluded. A crash after the swap and before the record leaves a symlink at the
requested target, which the same request takes over again on retry. Automatic
reconciliation and startup never take over an unrecorded symlink, and a record
that is automatic, version 1, malformed, or foreign is not unrecorded.

Ownership records are keyed by the exact spelling of a name, but on a
case-insensitive volume names that differ only in case are one directory entry.
The same re-check therefore also requires the root listing to contain the entry
under exactly the requested spelling, and compares the entry's inode identity
with that of every protected name that differs only in case: each recorded name,
each configured automatic link name (reserved even before it has a record), and
each managed artifact name. If one resolves to the same entry, the request fails
with `LINK_CONFLICT` and nothing is replaced, which also covers a recorded link
that was renamed in case outside the server. If such a protected case-variant
name exists but the storage reports no inode identities, so that independence
cannot be proven, the request also fails closed; missing identities do not block
a takeover when no protected case variant exists. On a case-sensitive volume
such names are distinct entries and remain independent.

`LINKED` means the link was created, repointed, taken over from an unrecorded
symlink, or its crash-residual state was completed. `UNCHANGED` means the
durable manual ownership already selects the
requested target. The operation is idempotent: a retry after an acknowledged
or ambiguous result converges to that target and returns `UNCHANGED` once the
durable state already agrees. When a current target was replaced in place, an
`UNCHANGED` retry refreshes its stored transfer ID and target kind without
rewriting the visible symlink.

### Ownership, recovery, and isolation

Ownership records live at
`.swarm-deploy/links/<sha256(link-name)>.json`. Version 1 has the exact fields
`version`, `name`, `target`, `transferId`, and `targetKind`; it is read as
automatic ownership. Version 2 adds the exact `mode` field, whose only values
are `automatic` and `manual`. Unknown versions, fields, modes, unsafe values,
filename hashes, target kinds, or transfer IDs fail closed. New and rewritten
records use version 2.

For creation, the record is durable before the non-overwriting visible symlink
is created. For replacement, a private sibling-target symlink is synchronized
and atomically renamed over the proven owned destination before the record is
rewritten. Temporary links are swept and each operation is level-triggered, so
a retry can complete either crash point without claiming an unmanaged path.
An explicit manual takeover of an unrecorded symlink follows the replacement
order (swap, then record). Its crash residue is an unrecorded symlink at the
requested target, which any explicit manual request that is otherwise allowed
for that name (for the same or a different valid current managed target) takes
over again (it returns `LINKED`); automatic reconciliation and startup never
claim it.

#### Link rollback journal

A manual request with the `rollback` policy whose server has an `afterLink` hook
and whose change is more than nothing (a link or record would change, including a
record-only refresh) writes one durable journal before changing anything:
`.swarm-deploy/links/<sha256(link-name)>.rollback.json`, which never matches the
ownership-record filename pattern. It is at most 32 KiB and has the exact fields
`version` (1), `name`, `token` (32 lowercase hex), `intended` (`target`,
`targetKind`, `transferId`), `prior`, and `applied`. `prior.link` is `{ state:
'MISSING' }` or `{ state: 'SYMLINK', literal, identity }`, where `literal` is the
symlink text as read (1 to 4096 bytes, no NUL or U+FFFD, so that it can be
restored exactly) and `identity` is `{ dev, ino }` or `null`; `prior.record` is
the manual version 2 ownership record or `null`. `applied` is `null` until the
change is complete, then `{ identity }` of the new link. A request that would
change nothing (an exact `UNCHANGED`) writes no journal.

The journal is written before the change and removed after the hook succeeded
(this removal is the commit point and is durable before the success answer) or
after a restore. It is validated strictly when read: any other key, version,
unsafe name, foreign filename hash, malformed text, oversize file, or non-regular
file fails closed with `LINK_FAILED`, and nothing in it is used as a path.

A request holds a snapshot of its journal and acts on the file only while the file
is still that journal: before it removes the file (commit or restore), restores
the link or record, or cleans up after a failed change, it re-reads the file and
requires the same `token` and the same `name`, `intended`, and `prior`; `applied`
may be unset on one side only (the write that sets it can fail, and a recovered
journal has no in-memory copy), and two different values are an edit. A missing,
replaced, or edited journal fails closed with `LINK_FAILED`, leaves the link,
record, and file as found, and is never erased by the request that lost it.

The commit point is final. Once the removal succeeded the request is finished and
no unjournaled rollback is attempted; refreshing the server's managed-name
snapshot comes after it and can only add the name to the snapshot. A failure there
is logged by link name and changes neither the answer (`LINKED`, or the hook's
failure after a restore) nor any state, and the name stays reserved until a later
successful refresh replaces the snapshot.

Creating the link (nothing existed at the name) is exclusive: `symlink` never
overwrites. When it fails with `EEXIST`, the entry that was there is not the
request's, so it is never removed or adopted; the request puts back the record it
replaced, or removes the record when there was none, removes the journal, and
answers `LINK_CONFLICT`. Before it changes the record it re-proves the fence: the
journal on disk must still be its own, and the record must be the previous one
(nothing to do) or the one the request wrote. Any other record is somebody
else's and is left untouched.

Every other failure of the creation (including one reported after the call, such
as a failed revalidation of the root directory once the link was made) does not
say whether the link exists, so none of it is assumed: the record and the journal
are left as they are and the failure goes to the journal's own restore, which
classifies what is at the name. A link at the name with the intended text is
taken to be the request's own (the same assumption crash recovery makes while
`applied` is unset) and is removed, then the previous record is put back and the
journal removed. A missing link only needs the record put back. Any other entry
is not the request's: nothing is changed, the journal and record stay, and the
name fails closed. A restore that itself fails, or is refused for any of these
reasons, answers `LINK_FAILED`, not `LINK_CONFLICT`, and the journal stays until a
later request for the name finishes the restore or fails closed.

Restore is compare-and-restore. The visible link must be the prior link or the
one the request made (same text, and the same identity when both sides report
one), and the record must be the prior record or the one the request wrote; every
state a crash can leave between them is one of those combinations, so the same
operation finishes an interrupted restore. The link is put back before the record,
by atomically renaming a private symlink carrying the exact prior text over it or
by unlinking a link the request created, after re-checking the destination and
that the exact spelling is a listed entry. Anything else (a regular file, another
symlink, a replaced link, an edited or removed record) is never overwritten: the
restore fails with `LINK_FAILED`, `rolledBack` is not reported, and the journal is
kept. A journal found at start-up is restored before retention runs and before
the server listens, since the request's outcome is unknown and its client never
heard success; one that cannot be proven is kept and its name blocked, and a
journal that fails validation stops the start. Any later request for a name with a
journal first resolves it or fails closed.

While a journal exists it holds back, from retention, the attempted target, the
previous record's target, and any current artifact that the previous symlink's
text names, in addition to the ordinary pins. The text is untrusted and is only
compared as a string, never resolved or used as a path: for each current artifact
`n`, the candidates are `n`, `./n`, and `<root>/n`, where `<root>` is the layout
root of this server, each optionally followed by one `/`, and the text pins the
artifact only if it is exactly one of them. Any other spelling, including a path
that reaches the same file by a different route, pins nothing; the text is still
restored exactly. Only the root lease is held while a journal is
written, restored, or removed; a hook never runs under it.

Automatic reconciliation ignores manual records and therefore never repoints
or removes a manual link. Manual mutation rejects automatic records and
configured automatic names. Removing a manual authorization rule prevents
future requests that depend on it but does not remove or rewrite an existing
manual link. Removing an automatic rule removes only its proven automatic
record and visible link. If all automatic rules are removed, proven stale
automatic links are still reconciled away; malformed or conflicting ledgers
fail closed. Existing version-1 records retain the automatic behavior from
v0.2.0.

There is no unlink RPC. An operator removes a managed link only while the
server is stopped: remove the visible symlink and its matching
`.swarm-deploy/links/<sha256(link-name)>.json` ownership record, then restart.
The ledger must never be edited while the server runs.

At startup the default Node and Bare adapters load the entire ledger, including
manual records whose authorization policy was removed. Persisted automatic and
manual names join configured automatic names in the protected namespace used
by upload admission and retention, so an upload cannot claim a managed-link
path after restart. Automatic reconciliation runs from startup, commit,
already-committed retry, recovery, and retention; manual records remain
isolated throughout.

### Retention, hooks, errors, and compatibility

Every desired automatic target and every durable manual target is pinned
against age, count, SemVer, and storage-quota deletion. Pinned targets still
participate in accounting. The desired automatic set and durable manual ledger
are recomputed under the root lease before deletion. If reconciliation fails,
the fallback pin set includes recorded transfer IDs and any matching current
target records, preferring retention to unsafe deletion. Repointing a manual
link moves the durable pin to its newly selected target.

Link control requests do not upload or commit an artifact and invoke none of
`beforeCommit`, `afterCommit`, or `onFailure`. They emit link and failure
events, not upload offer, transfer, verification, commit, or hook events.

Stable manual-link failures are:

- `LINK_NOT_ALLOWED`: self-link, target-policy, or automatic-name rejection;
- `LINK_TARGET_NOT_FOUND`: no current managed target with that name;
- `LINK_CONFLICT`: artifact-name collision, or a destination that cannot be
  taken over: a regular file or directory, a symlink with an automatic or
  version 1 record, a recorded link that was changed externally, a symlink that
  changed or gained a record during takeover, or a case variant of a recorded
  link. An unrecorded symlink at the requested manual name is not a conflict; an
  explicit manual request takes it over;
- `LINK_FAILED`: storage, transport-result, or other link-operation failure,
  including a malformed or foreign ownership record.

`UNSUPPORTED_STORAGE` remains the construction-time failure when configured
symlink policy needs an adapter without `symlink` and `readlink`.

Old upload clients remain compatible because link is a separate first-control
variant. A client that sends a link request to an older strict server is not
compatible: `swarm-deploy link` requires an upgraded server. The hook-result
opt-in follows the same rule: a server older than 0.5.0 decodes link requests
with an exact four-field key set and rejects `hookResult`, so an opted-in client
fails instead of returning without the result. The failure policy follows it too,
and unlike the result it is always sent: a server older than 0.6.0 rejects
`hookFailure`, so a current client fails against it rather than silently keeping a
link the caller expects to be rolled back, while an older client against a current
server sends no policy and gets `rollback`, which is a change of default for it
(a failed hook now restores the link, and the retry returns `LINKED`). Upgrade
servers before clients. A server older than 0.6.0 ignores `.rollback.json` files
in `.swarm-deploy/links`, so roll back to one only after no journal remains. This
version reads
v1 automatic ledgers and writes v2 mode-aware ledgers. After an upgraded server
creates, repairs, or repoints any managed link, v0.2.0 cannot read its v2
record. Rollback then requires restoring the complete pre-upgrade storage
backup, including visible links and `.swarm-deploy/links`, or staying on the
upgraded server.

## Public API, CLI, and observability migration

The root API is simplified around `Client`, `Server`, stable errors, identity
helpers, allowlist parsing, and the public option/result/event types needed to
use them. Client configuration uses a client seed and
`serverPublicKey`; server configuration uses a server seed, immutable
allowlist, storage limits, replacement policy, and optional injected DHT.
Topic parsing/derivation, swarm factories, discovery controls, reconnect
budgets, Protomux types, and chunk protocol internals are removed.

The CLI keeps role-specific seed generation and server/upload commands and adds
`link`. Server startup prints the server public key and then `ready`. Upload and
link require `--server-key <64-lower-hex>` plus client seed configuration and
accept the same idle timeout. `swarm-deploy link <target> <link-name>` prints
exactly `<link-name> -> <target> <LINKED|UNCHANGED>` on success;
`swarm-deploy link --json <target> <link-name>` asks for the hook result and
prints one JSON object `{ target, name, status, hookResult? }` instead, and
`--hook-failure <rollback|keep>` names the failure policy. Topic commands
and `--topic` are removed.

Events and logs expose lifecycle milestones for direct connection, offer,
accept/resume/reset, transfer progress, verification, commit, recovery,
retention, and failure. They use short SHA-256 fingerprints and never expose
seeds, secret keys, full public keys, TAR contents, or session material.
Listener and logger failures cannot affect protocol correctness.

`Client.link(target, name, options?)` returns
`ClientLinkResult { target, name, status: 'LINKED' | 'UNCHANGED', hookResult? }`;
`options` is `{ hookFailure?: 'rollback' | 'keep', hookResult?: boolean }`,
`hookFailure` defaults to `rollback` and is always sent, and `hookResult` is
present only when requested and returned by the hook.
After the request write succeeds, the client `link` event reports `requested`
with `final: false`, followed by exactly one success status or stable error code
with `final: true`. A request-write failure after connection can emit only the
terminal failed event. Local argument validation, prior cancellation or closed
state, and connection failure can reject before any client `link` event. The
server `link` event reports one terminal `linked`, `unchanged`, `rejected`, or
`failed` status with the authenticated client fingerprint, target, name, and a
stable reason on error; a failed `afterLink` adds `rolledBack: true` when the
previous link and record were restored (with no `result`), or `result` when the
link stayed. Link errors also use each side's existing `failure` event.

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
