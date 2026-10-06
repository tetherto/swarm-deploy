# Managed Symlinks and Directory Artifacts Design

## Goal

Extend PR #9 so a server can maintain safe, declarative symlinks to the newest
uploaded matching file or directory. A configuration such as:

```sh
swarm-deploy server \
  ... \
  --symlink '/^\d+\.\d+\.\d+$/' latest
```

produces:

```text
<storage-root>/
├── 0.18.0/
├── 0.18.1/
└── latest -> 0.18.1/
```

The same option supports exact targets and regular files:

```sh
--symlink release.tar.gz current.tar.gz
```

Only server-managed commit records may become targets. Rules never resolve an
operator-supplied filesystem path, never traverse outside the storage root, and
never overwrite an unmanaged file, directory, or symlink.

## Public configuration

The server CLI accepts a repeatable two-value option:

```text
--symlink <selector> <symlink-name>
```

- A plain selector is an exact managed artifact basename.
- A selector beginning and ending with `/` is a regular expression with no
  flags. It is matched against managed artifact basenames only.
- `symlink-name` is a safe basename in the same directory as its target.
- The same rule applies to file and directory artifacts.
- Repeating `--symlink` configures multiple independent links.

Examples:

```sh
--symlink '/^\d+\.\d+\.\d+$/' latest
--symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/' app-latest.tar.gz
--symlink release.tar.gz current.tar.gz
```

`ServerOptions` gains:

```ts
export interface SymlinkRule {
  selector: string
  name: string
}

export interface ServerOptions {
  symlinks?: Iterable<SymlinkRule>
}
```

The constructor snapshots the iterable. It rejects malformed selectors,
unsafe or reserved link names, duplicate link names, exact targets equal to
their link name, and unsupported storage adapters.

Regex source is bounded, has no flags, and runs only against validated
100-byte artifact basenames. The regex is trusted operator configuration.
Invalid regexes are startup configuration errors.

## Selection semantics

Symlink candidates come only from validated `CommitRecord` values returned by
the commit store. The server never discovers candidates by scanning arbitrary
filesystem entries.

For an exact selector:

- The rule is dormant until the exact managed artifact exists.
- Once it exists, the symlink points to that artifact.

For a regex selector:

- All matching managed file and directory records are considered.
- The newest committed record wins by descending `committedAt`.
- Equal timestamps are resolved by transfer ID and then name, matching
  retention's deterministic commit-order comparison.
- Replacement history names are excluded from matching.

Selection is level-triggered and repeatable. Startup, successful commit,
already-committed retry, recovery, and retention reconciliation compute the
same desired result from commit records.

## Symlink form and placement

All configured links and current artifact paths are top-level siblings in the
dedicated storage root. A link target is always exactly the selected record's
basename:

```text
latest -> 0.18.1
```

The target text is relative. It never contains `/`, `\`, `..`, an absolute
prefix, the storage root, or `.swarm-deploy`.

A link name is validated with the same safe-basename and 100-byte limits as an
artifact name. It may not use the reserved `history-` namespace or collide with
another configured link.

An upload whose artifact name equals a configured link name is rejected before
session admission. A configured link never masks a managed artifact.

## Ownership and unmanaged paths

Managed link ownership is persisted under:

```text
.swarm-deploy/links/<sha256(link-name)>.json
```

The record contains:

```ts
interface ManagedSymlinkRecord {
  version: 1
  name: string
  target: string
  transferId: string
  targetKind: 'file' | 'directory'
}
```

The server treats a destination as replaceable only when all of these agree:

- A valid managed-link record exists.
- The visible destination is a symbolic link.
- `readlink()` returns the recorded relative target.
- The selected target is a valid managed commit record.

A pre-existing regular file, directory, unrecorded symlink, changed symlink, or
foreign ownership record is unmanaged. The server leaves it untouched and
reports a configuration/runtime failure instead of replacing, moving, or
deleting it.

## Link update transaction

Creating a missing link uses `symlink()` and fails closed on `EEXIST`.

Updating an owned link:

1. Revalidate the storage root and managed-link directory identities.
2. Validate the current destination and ownership record.
3. Create a temporary relative symlink in the private publications directory.
4. Synchronize the private directory where supported.
5. Rename the temporary symlink over the proven managed destination.
6. Synchronize the storage root.
7. Atomically write the updated ownership record.

Recovery is level-triggered. If a crash occurs between visible link replacement
and ownership-record update, startup compares the configured rule, commit
records, current `readlink()` value, and old record before converging. A path
that cannot be proven managed is preserved and causes startup to fail closed.

Temporary symlinks are removed using `lstat`/`unlink`; regular-file helpers that
reject symlinks are not used.

## Retention interaction

Every selected symlink target is pinned against:

- age retention;
- count rotation;
- SemVer version rotation;
- storage quota deletion.

Pinned targets still count toward quota, matching mutable-name pin behavior.
When a newer regex match is committed, reconciliation moves the symlink first;
the old target becomes eligible for the following retention pass.

If a rule is removed, startup removes its ownership record and visible link
only when ownership is still proven. Its old target then becomes eligible for
retention.

Retention never leaves a managed dangling link. Before deleting a candidate,
the desired-link set is recomputed under the root lease. A target still
selected by any rule remains pinned.

## Directory upload behavior

Directory input becomes one recursively uploaded directory artifact instead of
a batch of independent immediate-child file uploads:

```sh
swarm-deploy upload ./0.18.1
```

commits one managed top-level directory named `0.18.1`.

This is a deliberate pre-1.0 CLI/API behavior change. Direct file upload remains
byte-compatible. Directory batch result/skip behavior is removed from the
default upload path and documented in the changelog and rollout notes.

The package does not expose an “atomic directory” user-facing term or option.
Atomicity is an internal commit/recovery guarantee.

## Canonical recursive directory artifact

Directory metadata uses a distinct artifact kind:

```ts
type ArtifactKind = 'file' | 'directory'
```

Existing file metadata remains byte-identical and omits `kind`. Directory
metadata adds:

- `kind: 'directory'`;
- `entryCount`;
- aggregate payload byte count;
- canonical tree digest;
- deterministic TAR size and digest;
- the existing transfer ID and optional source parent.

Directory transfer IDs use a new domain and include all directory metadata.
An old server rejects the unknown shape without mutating storage.

The deterministic tree archive:

- walks recursively;
- includes regular files and directories, including empty directories;
- sorts relative paths bytewise with parents before children;
- uses normalized file mode `0644` and directory mode `0755`;
- uses fixed uid, gid, mtime, uname, and gname;
- rejects symlinks, hardlinks, devices, sockets, FIFOs, sparse/special entries,
  and filesystem cycles;
- rejects `.`, `..`, empty, absolute, backslash, NUL, reserved, over-depth,
  over-count, and over-length paths;
- rejects duplicate and case-fold-colliding relative paths;
- snapshots file and directory identities and revalidates them during resume.

Limits:

- each component: safe basename and at most 100 UTF-8 bytes;
- whole TAR path: at most 100 UTF-8 bytes;
- maximum depth: 32;
- maximum entries: 10,000;
- aggregate regular-file bytes: existing `maxFileBytes`;
- aggregate persistent staging: existing `maxStagingBytes`.

The client rejects the whole directory upload if any entry is unsafe or changes
during traversal/generation. It never silently drops an entry from a directory
artifact.

## Directory verification and staging

Receiving sessions keep the TAR bytes as today. Verification extracts a
directory artifact into:

```text
.swarm-deploy/staging/<transfer-id>.tree/
```

Extraction:

- parses only the canonical USTAR fields needed for file/directory entries;
- reconstructs and byte-compares every canonical header;
- enforces strict entry ordering and parent-before-child relationships;
- creates paths exclusively under the per-session staging tree;
- uses `lstat`, exclusive/no-follow file opens, and revalidated parent
  identities;
- synchronizes files and directories before marking the session verified;
- recomputes the tree digest independently from extracted contents.

No archive path is concatenated to the storage root without component
validation. Extraction never follows a symlink.

New directory sessions use persisted session version 4. Existing file sessions
continue using versions 2 or 3 according to whether source-parent metadata is
present.

## Directory commit, records, and recovery

Directory commit records use record version 3 and include:

- `kind: 'directory'`;
- aggregate payload `size`;
- tree digest in `sha256`;
- `entryCount`;
- all existing uploader, transfer, time, and release fields.

Directory artifacts are create-only in this change. A directory offer whose
name appears in `replaceNames`, a file-to-directory kind change, or a
directory-to-file kind change is rejected. Directory replacement/history is
deferred because directories cannot use the file hardlink replacement
transaction safely.

Publication:

1. Validate the verified staging tree and digest.
2. Write and synchronize a kind-aware commit journal.
3. Revalidate that the final basename is absent.
4. Rename the staging tree to the final path under name/root leases.
5. Synchronize the storage root.
6. Atomically persist the directory commit sidecar.
7. Remove session/TAR/journal residue.
8. Reconcile managed symlinks.
9. Run hooks and retention in the existing safe order.

Recovery has explicit directory branches for crashes:

- after journal persistence but before rename;
- after rename but before sidecar persistence;
- after sidecar persistence but before session/journal cleanup;
- during symlink reconciliation.

Recovery never assumes directory staging and final paths are hardlinks.

## Directory deletion and scrub

Managed directories are deleted by first renaming them into a private trash
directory:

```text
.swarm-deploy/trash/<transfer-id>.tree
```

After the visible name is removed atomically:

- the sidecar is removed;
- the trash tree is recursively deleted using `lstat`, `unlink`, and `rmdir`
  without following symlinks;
- startup sweeps proven trash residue.

Scrub is kind-aware:

- scheduled/pre-commit passes validate type, sidecar, and root identity without
  recursively hashing every tree;
- startup recovery recursively hashes directory artifacts and verifies their
  canonical tree digest;
- a foreign or mutated directory is preserved as unknown while invalid managed
  metadata is removed according to existing fail-closed rules.

## Hook and event integration

`HookArtifact` gains:

```ts
kind: 'file' | 'directory'
entryCount?: number
```

For directories:

- `beforeCommit.path` is the verified `.tree` staging directory;
- `afterCommit.path` is the final committed directory;
- aliases are reconciled before `afterCommit`, so the hook observes the new
  configured link;
- `onFailure` path semantics remain phase-specific and documented.

Transfer, result, retention, and failure events retain current fields and add
artifact kind where needed to distinguish files and directories.

## Storage adapter

`StorageAdapter` gains optional:

```ts
symlink?(target: string, path: string): Promise<void>
readlink?(path: string): Promise<string>
```

Configuring symlink rules requires both methods. Node and Bare default adapters
provide them. Custom adapters without symlink rules remain source-compatible.

The layout adds private `links` and `trash` directories. Both are protected,
identity-checked, and synchronized like existing internal directories.

## Error handling

Configuration errors use existing CLI exit code 2.

Runtime failures distinguish:

- invalid/malicious archive or selector input;
- unmanaged link collision;
- managed link update/recovery failure;
- unsupported adapter capability;
- directory commit/recovery failure.

A link reconciliation failure after durable commit behaves like other
post-commit deployment failures: the artifact remains committed, the client
receives a stable failure, and an already-committed retry reruns reconciliation
before success.

No error message includes absolute source paths, archive contents, secrets, or
unvalidated symlink targets.

## Compatibility and rollout

- Direct file TAR bytes, transfer IDs, sessions, records, commit/replacement,
  hooks, and retention remain compatible.
- Directory CLI behavior changes from immediate-child batch upload to one
  recursive managed artifact.
- New directory metadata, session v4, record v3, journals, and directory trash
  are not downgrade-compatible. Drain uploads and do not roll back after
  committing directory artifacts without restoring from backup.
- New clients sending directory metadata fail closed against old servers.
- Symlink rules are dormant until their managed targets exist.
- Existing unmanaged storage-root paths are never adopted automatically.

## Testing

Focused tests cover:

- exact and regex rule parsing, repeatability, deterministic newest selection,
  malformed regexes, duplicate names, and 64-hex selectors;
- safe file and directory link creation, replacement, restart reconciliation,
  removed rules, ownership conflicts, and temporary-link crashes;
- prevention of absolute paths, traversal, root/internal targets, link-name
  collisions, foreign symlinks, and unmanaged overwrite;
- pinning through every retention policy and repoint-before-delete ordering;
- recursive deterministic TAR equality on Node and Bare;
- empty/nested directory preservation and resume at arbitrary TAR offsets;
- mutated source files/listings and prefix-reset behavior;
- malicious TAR traversal, links, devices, duplicates, case collisions,
  ordering, depth/count/size bombs, padding, digest, and trailing-data cases;
- session v4 restart, stray tree staging, and safe recursive cleanup;
- directory commit crash boundaries and startup recovery;
- create-only directory enforcement and file/directory kind conflicts;
- trash-rename deletion crashes and startup sweeping;
- hook paths, kinds, alias visibility, already-committed retry, close, and
  failure contexts;
- old file compatibility and package/public-type coverage;
- full Node and Bare suites, lint, type, property, package, and release checks.
