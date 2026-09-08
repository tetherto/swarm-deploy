# Swarm Deploy Specification

## Purpose and scope

Swarm Deploy is a Node.js and Bare package for secure, resumable, one-way
artifact uploads from authorized CI clients to one server over Hyperswarm on
Linux and macOS. It receives and stores regular files only; it never executes,
unpacks, installs, serves, scans, downloads, or redistributes them.

Version 1 supports a file or a lexical, one-shot batch of a directory's
immediate regular-file children. Names match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`; directories, symlinks, and unsafe names
are not uploaded. The internal `.swarm-deploy` path is reserved. A direct file
in the top-level `history-` namespace is rejected with `INVALID_FILENAME`; a
regular child with that prefix in a directory batch is skipped with
`reserved-history`, and remaining entries continue.

The server OS account and a dedicated storage root are trusted against
concurrent local tampering. Existing or detected symlinks and parent-directory
identity changes fail closed. Native `openat`-style protection against a
malicious local writer is outside this version's scope.

## Identity, discovery, and authorization

Server and client identities use separate random persistent 32-byte seeds.
Seeds are represented as lowercase 64-character hexadecimal values in files
and environment variables, are never command-line arguments, and are never
logged. A public key is derived from each seed. The server identity remains
explicitly configured through its seed file or role-specific environment
variable. Operators must preserve that seed for the lifetime of a deployment:
a stable server seed produces a stable public key and topic.

The discovery topic is:

```text
SHA-256(UTF8("swarm-deploy/topic/v1\0") || serverPublicKey)
```

The topic is one 32-byte value, represented to operators as lowercase
64-character hexadecimal. It is both the discovery value and a cryptographic
commitment to the intended server public key; it is not a secret or an
authorization capability. The client is configured with this topic and does
not receive or pin a separate server public key. After discovery, it recomputes
the topic from the authenticated socket's `remotePublicKey` and rejects an
invalid or missing socket key before creating a Protomux channel or sending
metadata or application data. If `peerInfo.publicKey` is present, it must be a
valid 32-byte key equal to `remotePublicKey`.

Changing the server seed changes its public key and topic, so every client
configuration must be updated. An arbitrary topic combined with an ephemeral
server identity is not supported: that design would let a rogue receiver join
the advertised topic and report fake upload success. Knowledge of the committed
topic does not enable receiver impersonation under SHA-256 preimage-resistance
assumptions because an attacker must find a transport public key that hashes to
the committed topic.

HyperDHT Noise authenticates transport identities and encrypts the connection.
The server allowlists client public keys; its firewall and connection handler
both check the current allowlist. The receiver never serves stored binaries.
An allowlist reload is all-or-nothing; removing a key closes its connections
and deletes its active or resumable uploads, but does not delete committed
artifacts.

The protocol is `swarm-deploy/upload/1`. It uses SHA-256 whole-file and 1 MiB
chunk hashes, bounded compact-encoding control frames, a maximum of four
in-flight chunks, and deterministic transfer IDs over the authenticated client
key, name, size, digest, and chunk size. There is no wire-protocol change for
replacement support.

## Public interface and CLI

`ClientOptions` requires `seed: SeedInput` and `topic: BinaryInput`, where
`topic` is exactly 32 bytes. It has no `serverPublicKey` option. The existing
connection timeout, idle timeout, DHT, scheduler, clock, swarm factory, and
logger options remain optional. `maxReconnectAttempts` is an optional integer
from 0 through 100 and defaults to 3.

`ServerOptions` includes all existing required identity, storage, allowlist,
limit, lifecycle, retention, logging, timer, filesystem, and swarm options,
plus:

```ts
replaceNames?: Iterable<string>
```

`replaceNames` defaults to an empty iterable. Its values must be valid upload
names and must not begin with `history-`. The CLI server command accepts
repeatable `--replace-name <name>` and passes the resulting names as
`replaceNames`. An omitted option preserves create-only behavior for every
name.

Only exact names in `replaceNames` are mutable. Every other name is
create-only, including unknown top-level paths and names that merely share a
prefix with a configured mutable name. For a mutable name, an offer whose
current managed content has the same size and digest is
`ALREADY_COMMITTED`; different content replaces it. A mutable name occupied by
an unmanaged path is never replaced and returns the existing-name conflict.

`history-` paths are server-managed historical artifacts, not a restore
interface. The package has no restore API or CLI operation.

The root runtime API is exactly `Client`, `Server`, `ERRORS`,
`SwarmDeployError`, `generateSeed`, `keyPairFromSeed`, `parseAllowlist`,
`parsePublicKey`, `parseSeed`, `parseTopic`, `publicKeyFromSeed`, and
`topicFromServerPublicKey`, plus the public types needed to construct, inject,
and observe Client and Server. Storage implementations, file-manifest helpers,
protocol codecs/constants, and transfer-ID primitives remain internal
submodules.

The CLI provides `topic --seed-file <server.seed>`, which derives and prints
the full lowercase 64-character topic without printing the seed. The server
startup output includes that full topic rather than a topic fingerprint before
printing `ready`. The upload command accepts `--topic <64-lower-hex>` and does
not accept `--server-key`. Seed files and the role-specific seed environment
variables retain their existing precedence and secrecy rules.

## Storage, replacement, and accounting

The storage root contains visible current artifacts and managed historical
artifacts. `.swarm-deploy/` contains protected staging, session, commit
sidecar, journal, and lock state. Commit sidecars identify managed artifacts
by transfer ID and record the visible name, size, SHA-256, server commit time,
uploader fingerprint, and replacement metadata.

Replacing `release.tar.gz` preserves the previous managed inode as:

```text
history-<full-old-transfer-id>
```

The full lowercase hexadecimal prior transfer ID makes the history name
globally unambiguous and valid under the existing filename rule. The new
sidecar maps the original mutable name to its current transfer and records the
history transfer/name it superseded. The old sidecar becomes the record for its
history path while retaining its original transfer ID and content metadata.

Committed retention accounting includes the current artifact and every
history artifact exactly once, using each logical record's size. A replacement
therefore reserves the complete new logical size before publication; it does
not subtract the prior current file merely because both names temporarily
refer to the old inode. Normal age and storage-quota retention may evict
history records. The currently configured mutable name is pinned against
age- and quota-based retention, so retention does not remove its current
artifact. A later replacement may still create history from that current
artifact. Create-only artifacts and history artifacts participate in normal
retention. If capacity cannot be made available, the verified new session
remains resumable and no replacement is published.

Per-name serialization covers inspection, retention admission, replacement,
and recovery for a mutable name. It prevents concurrent replacements of the
same name without serializing unrelated names.

## Crash-safe v2 replacement protocol

Replacement uses a version-2 journal. The journal names the mutable final
path, expected old managed record and inode identity, destination history
path, new transfer record, staging inode identity, and phase. It is durable
before any visible mutation.

For a different-content replacement of a managed mutable name:

1. Re-read and hash the verified staging inode; validate the current sidecar
   and pin the old record and inode identity under the per-name lock.
2. Admit the full new logical size through retention while the old current is
   pinned. Persist and synchronize the v2 journal.
3. Hard-link the pinned old inode to its unique top-level history name and
   synchronize the root.
4. Hard-link the verified new staging inode to a private publication name.
5. Atomically rename that publication name over the mutable final path, then
   synchronize the root.
6. Persist the new current sidecar and transition the old sidecar to the
   history record, synchronizing the relevant metadata directory after each
   durable transition. The durable new current sidecar is the replacement
   linearization point.
7. Remove staging/session state, remove the journal, and run post-commit
   retention. Cleanup failure after linearization leaves the new current
   artifact authoritative and is retried by recovery.

Before the new current sidecar is durable, any failure or access revocation
restores the old final from the pinned old inode, removes the history and
private-new publication only when their inode identities match the journal,
and preserves the verified new staging session for retry. After the durable
new current sidecar, recovery treats the new content as linearized and must
preserve it; it finishes or repairs the history sidecar and cleanup rather
than rolling back to the old content.

Recovery recognizes every v2 phase and validates all journal-owned inode
identities, sizes, digests, sidecars, and names before acting. It can restore
the old current before linearization, finalize the new current after
linearization, retain valid staging for retry, or fail closed on corruption.
It never overwrites or deletes an unmanaged top-level path, including one at a
mutable or history name. Startup still recovers journals before accepting
uploads, re-hashes every managed committed file, removes invalid managed
records, preserves and reports unknown paths, restores valid resumable
sessions, and runs retention.

## Existing guarantees

Staging bytes and resumable reservations remain separately limited by required
`maxFileBytes` and `maxStagingBytes`. Optional committed retention uses
`maxAge` and `maxStorageBytes`; age deletion precedes oldest-record quota
deletion, with filename tie-breaking. Active receives are not removed by
scheduled cleanup. A committed success contains exactly the declared digest
and size, and failed or incomplete content never becomes visible as a final
artifact.

The serialized SessionStore offer path expires TTL-dead sessions that are not
active before checking the staging limit, then checks capacity again. Its
activity predicate includes only reservations whose staging offer has
successfully completed; a pending resume cannot make its own expired session
active before expiration runs. An active accepted session is never expired.
Expiration is internal to the store's serialized operation, so RetentionManager
does not re-enter SessionStore while an offer is in progress.

Initial discovery, including the discovery flush itself, is bounded by one
`connectTimeout` window. Every established
transport loss starts a fresh window so a long upload can reconnect, but each
loss consumes the total reconnect-attempt budget. Missing discovery,
reconnect-window expiry, and budget exhaustion use `CONNECT_TIMEOUT`.
`UPLOAD_IDLE_TIMEOUT` applies only to active transfer, response-drain, or
transport inactivity. Active-upload admission rejection uses
`ACTIVE_UPLOAD_LIMIT`; invalid textual topic parsing uses `INVALID_TOPIC`.

Events and logs use short SHA-256 fingerprints for peers and transfers; they
never expose seeds, session keys, or full public keys. Listener and logger
failures cannot change transfer or lifecycle correctness.

## TypeScript package and tests

Production code and tests are strict TypeScript: production sources live under
`src/`, and tests are `test/**/*.ts`. TypeScript targets ES2022 with
Node16 module and resolution behavior, while the published package remains
CommonJS. Supported production runtimes are Node.js 22 and 24 and the current
stable Bare runtime on Linux and macOS. Production JavaScript, declarations,
and source maps are generated under untracked `dist/`; test output is generated
under untracked `.test-dist/` and executed with Node and Bare.

Generated declarations are emitted under `dist/`. `main`, `types`, `bin`, and
public `exports` point only at `dist/`; internal modules are not public
exports. `npm test` builds before executing compiled Node and Bare tests.
`prepack` performs a clean build and validates the types and package. An
installed-tarball gate loads CommonJS and ESM under Node, require and import
under Bare, executes the CLI, and verifies key generation does not overwrite or
print seed material. There is no `prepare` script.

The public package is `@tetherto/swarm-deploy` version `0.1.0` with
`publishConfig.access` set to `public` and `publishConfig.provenance` set to
`true`. The README's primary API installation command is
`npm install @tetherto/swarm-deploy`; its primary CLI installation command is
`npm install --global @tetherto/swarm-deploy`. Primary user instructions do not
use `npx` or invoke `dist/` directly. Checkout build and direct-runtime commands
are contributor-only instructions.

CI owns the full pull-request and `main` test matrix: build, types, lint,
package, supported Node versions and operating systems, Bare operating systems,
and protocol property tests. The tag-triggered workflow performs only the
explicit release checks for an exact `vX.Y.Z` tag, a tag commit on `main`, a
matching `package.json` version, a clean distribution build, and a valid
package. It then invokes `holepunchto/actions/publish` at the reviewed immutable
revision `146b86c4d0237c124df06ecc992ddf2c585b3405`; it does not duplicate
the full CI test matrix. The workflow must build `dist/` before invoking the
action because the action publishes with `npm publish --ignore-scripts`. The
publish job grants `id-token: write` for npm trusted publishing and
`contents: write` for the GitHub release the action creates. The reviewed
composite action currently references `create-release@v1` internally; this
repository pins the composite action itself without vendoring that upstream
implementation.

npm trusted publishing is configured externally for the GitHub workflow and
its `npm` environment; the repository stores no npm publication token.
Rollback installs a previous immutable package version; a server must not be
downgraded across an in-flight v2 replacement journal, which the current
version must drain or recover first.
