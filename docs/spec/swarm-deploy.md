# Swarm Deploy Specification

## Purpose and scope

Swarm Deploy is a Node.js and Bare package for secure, resumable, one-way
artifact uploads from authorized CI clients to one server over Hyperswarm on
Linux and macOS. It receives and stores regular files only; it never executes,
unpacks, installs, serves, scans, downloads, or redistributes them.

Version 1 supports a file or a lexical, one-shot batch of a directory's
immediate regular-file children. Names match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`; directories, symlinks, and unsafe names
are not uploaded. The internal `.swarm-deploy` path is reserved. The
top-level `history-` namespace is also reserved: clients cannot upload any
name beginning with `history-`.

The server OS account and a dedicated storage root are trusted against
concurrent local tampering. Existing or detected symlinks and parent-directory
identity changes fail closed. Native `openat`-style protection against a
malicious local writer is outside this version's scope.

## Identity, discovery, and authorization

Server and client identities use separate random persistent 32-byte seeds.
Seeds are represented as lowercase 64-character hexadecimal values in files
and environment variables, are never command-line arguments, and are never
logged. A public key is derived from each seed. The server allowlists client
public keys; every client pins the server public key.

The discovery topic is:

```text
SHA-256(UTF8("swarm-deploy/topic/v1\0") || serverPublicKey)
```

It is a discovery value, not a secret or authorization capability. HyperDHT
Noise authenticates transport identities and encrypts the connection. The
server firewall and connection handler both check the current allowlist. The
client rejects an unpinned peer before sending application data. An allowlist
reload is all-or-nothing; removing a key closes its connections and deletes
its active or resumable uploads, but does not delete committed artifacts.

The protocol is `swarm-deploy/upload/1`. It uses SHA-256 whole-file and 1 MiB
chunk hashes, bounded compact-encoding control frames, a maximum of four
in-flight chunks, and deterministic transfer IDs over the authenticated client
key, name, size, digest, and chunk size. There is no wire-protocol change for
replacement support.

## Public interface and CLI

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
`publishConfig.access` set to `public`. CI first builds and type-checks, then
runs compiled Node and Bare tests. A tag-triggered release workflow publishes
to npm using OIDC and provenance only for tags matching `vX.Y.Z` whose version
matches `package.json`. npm trusted publishing is configured externally for
the GitHub workflow and its `npm` environment; the repository stores no npm
publication token. Rollback installs a previous immutable package version; a
server must not be downgraded across an in-flight v2 replacement journal, which
the current version must drain or recover first.
