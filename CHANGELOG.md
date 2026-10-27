# Changelog

All notable changes to this package are documented here.

## Unreleased

## 0.4.2

- An explicit manual link request (`Client.link`, `swarm-deploy link`) now takes over an existing symlink at the requested name that has no ownership record, such as one made by hand before the storage root was managed. After the target and name pass every existing check, the symlink itself is replaced atomically by the requested link and a manual ownership record is written; the first request returns `LINKED` (even if the old link already read as the target) and repeats return `UNCHANGED`. The old link is never followed, so whatever it pointed at (a legacy directory, a dangling, absolute, or outside path, a symlink chain, a self-reference) is left untouched and never imported, and no commit metadata is invented for it. Previously such a request failed with `LINK_CONFLICT`. There is no new option, flag, wire field, or client change, so existing clients work unchanged, and ordered `afterLink` hooks, restart, and retention pinning behave as for any manual link, including a retry after a failed hook (`UNCHANGED`).
- Only symlinks are taken over. A regular file or directory at the name, a symlink whose record is automatic, version 1, malformed, or foreign, a manual link changed externally since it was recorded, and automatic link names still fail closed, and automatic reconciliation and startup never take a symlink over. The server re-checks that the symlink is unchanged (text, and inode where the storage reports one) and unrecorded immediately before the swap and fails closed otherwise. This is not a compare-and-swap, which the storage adapter does not offer, so do not edit a running server's storage root. A crash after the swap and before the record is repaired by repeating the same request.
- Case-insensitive volumes: a request for another spelling of a recorded link (`Latest` for a recorded `latest`, automatic or manual, including a link renamed in case outside the server) is one directory entry with an existing owner, so it fails with `LINK_CONFLICT` instead of replacing it and leaving two records. Before the swap the entry must be listed under exactly the requested spelling, and no protected name that differs only in case (a recorded link, a configured automatic link name even while its rule is dormant and has no record, or a managed artifact) may resolve to the same entry; it fails closed if the storage reports no inode identities while such a name exists. On a case-sensitive volume those names are distinct entries and stay independent.
- The `reset-storage` report note about remaining symlinks now says that an explicit link request replaces them while an automatic `--symlink` rule for that name still fails closed.

## 0.4.1

- Release fix only; there is no runtime, API, or wire change. The `v0.4.0` publish workflow failed during action setup because its SHA-pinned `holepunchto/actions/publish` referenced `create-release@v1`, which no longer exists at `v1`. The `v0.4.0` tag is left as it is; use 0.4.1, which carries the 0.4.0 changes below.
- The CI and publish workflows now use the supported `holepunchto/actions/*@v1` pointer instead of commit SHAs, and publishing goes through the `publish@v1` alias. `npm run test:release-tag` now requires `@v1` on every Holepunch action reference. Tag and package validation, the `main` ancestry check, build-before-publish, the package checks, the `npm` environment, and OIDC provenance are unchanged.
- Documentation: the README is now a short entry point (features, requirements, install, identity model, quick start, and links). The detailed CLI, runtime API, operations and storage, artifact pattern, managed symlink, and hooks references moved to guides under `docs/` on GitHub, which the npm package does not include; the README links to them by URL. The protocol specification is unchanged.

## 0.4.0

- Add the optional `afterLink` server hook (`ServerOptions.hooks`, and `--hooks <module>` modules) so a link change can be published. It runs after a managed link is durable, for an upload that moved an automatic link (after `afterCommit`, once per link that now points at the uploaded artifact, including an already-committed retry) and for an explicit `Client.link` / `swarm-deploy link` that passed every policy check. Its context is the secret-free, frozen `{ link: { name, target, mode, path, targetPath }, artifact, status, trigger }`, exported as `AfterLinkContext`, `HookLink`, `HookLinkMode`, `HookLinkStatus` and `HookLinkTrigger`.
- The client receives no success (`COMMITTED`, `ALREADY_COMMITTED`, `LINKED`, `UNCHANGED`) until the applicable `afterLink` calls return. A failing hook reaches the caller as the existing sanitized `HOOK_FAILED` code in the ordinary `FAILED` link result, upload final, or admission record, so clients and the wire format are unchanged, and `swarm-deploy link` now prints `HOOK_FAILED`. The caller sees that code only while it is still waiting: a client waits at most its idle timeout (60 s by default, 5 min at most) for the whole answer, which covers verification and commit, `afterCommit`, every `afterLink` call one after another, hooks queued ahead for the same link, and retention. If that expires first the client reports `UPLOAD_IDLE_TIMEOUT` instead, while the server still finishes its hooks. The durable link and artifact are never rolled back. Hooks must be idempotent on `link.name` plus `artifact.transferId`: repeating an unchanged link request (`UNCHANGED`) or retrying an upload re-runs the hook, so a failed publication can be retried without changing the link.
- A failed `afterLink` is observable server-side: `onFailure` gets the new `afterLink` `HookFailureContext.phase` (with `link`, and the link path as `path`) after the client was answered, a `failure` event and a `Link hook failed` warning are emitted, and a failed link request's `link` event carries the new optional `result` (`LINKED` or `UNCHANGED`) with `reason: 'HOOK_FAILED'`.
- Hooks run after the storage-root lease is released, so a slow hook never blocks commits, retention, recovery, or other links and cannot deadlock on the lease. The context is therefore a snapshot: a later decision may already have repointed the link, and retention may have removed an unpinned previous target. For one link name, hooks start in decision order and never overlap (an in-memory first-in, first-out line reserved under the lease; it does not survive a restart, and there is still no hook timeout). Hooks do not run for rejected or unauthorized link requests, for a manual link whose target is replaced, or for startup, scheduled, or retention reconciliation.
- **Fix.** After a `HOOK_FAILED` answer (any hook phase) the server now ends its write side and destroys the connection once the peer closes it, or after 5 seconds, instead of destroying it right behind the write. Over a real stream the immediate destroy could reset the connection before the client read the record, so the caller saw a connection reset instead of `HOOK_FAILED`. Other failure answers still close immediately and are unchanged.
- Configuring `afterLink` defers the post-commit retention pass until the hooks succeed, like `afterCommit`, so this commit's own link reconciliation runs before this commit's retention pass. That narrows, but does not remove, the chance that the link already moved: another commit's retention or reconciliation can do it first, and the hook then sees `UNCHANGED`. `status` is the link decision the call observed (`LINKED` when it created or repointed the link or repaired an automatic link's ownership record, `UNCHANGED` otherwise, including a manual ownership-metadata refresh for the same target), never proof of publication. Servers without `afterLink` are unchanged, including `afterCommit` ordering and its deferred retention.
- Add the runnable, **Node-only** `examples/link-publisher` hooks module and publisher (they use `node:child_process` and the global `process`, so they do not run on Bare; library hooks themselves work on Node and Bare). Each link change is passed as one JSON document on stdin to a script started without a shell: `SWARM_DEPLOY_PUBLISHER` names a JavaScript module file run with the current Node executable, not an arbitrary executable. Each call has a 20 s deadline: the publisher then gets `SIGTERM` and, 5 s later, `SIGKILL` (that direct child only), and the call always rejects with a timeout, even if the publisher exits zero after `SIGTERM`. It settles only once the child has exited, so an abandoned publisher cannot write over the next publication of the same link, and a call takes at most 25 s. The example's header shows how to size the client idle timeout for several sequential calls (25 s each).
- Add `swarm-deploy reset-storage --storage <dir> [--apply [--wait <ms>]]`. Without `--apply` it is a read-only preview of the
  private state under one storage root: commit records and how many have no
  payload, sessions, journals, staging, publications, the managed-link ledger,
  trash, lock residue, earlier archives, and the visible payloads and symlinks
  that would remain. With `--apply` it takes the storage lock, renames those
  directories and lock residue into
  `.swarm-deploy/archive/reset-<timestamp>-<random>/` with a `reset.json`
  marker, recreates them empty, and releases the lock. Nothing is copied or
  deleted; an archive is restored by moving it back.
- The reset never signals a process. A live lock holder makes `--apply` fail
  closed with exit `1`; `--wait` polls until the holder releases the lock, a
  holder whose PID is gone is retired automatically. Live and unreadable
  locks cannot be bypassed by a PID override.
- The report states what still blocks a true fresh start: remaining payloads
  keep their names (`FILE_EXISTS`) and remaining symlinks lose their ownership
  record (`LINK_CONFLICT`). `fresh start: yes` is printed only for a root with
  nothing visible left. Unsafe roots, symlinked internal paths, filesystem
  roots, and uninitialized roots are rejected with exit `2` before any change.
- Block server recovery after an interrupted reset until a reset retry
  completes, reject symlink ancestors, and refresh retained-file reporting
  after waiting for exclusive access.
- A retry after an interrupted reset, including a crash or power loss that
  skips error handling, resumes the archive the pending marker names instead of
  creating a second one. Progress is reconciled from what the archive holds,
  and a retry fails closed when the archive and the live directory both hold
  data or the named archive is gone. One reset always ends as one archive, so
  restoring it restores everything.
- Keep the archive marker bounded. `reset.json` is version 2: it names the
  metadata directories, summarizes lock residue as a count and a SHA-256 of the
  sorted names, and keeps the first attempt, the newest 16 attempts, and a total
  count with failure text clipped. A marker therefore stays readable after any
  number of stopped servers or retries, instead of becoming unreadable once its
  lock list outgrew the reader. Version 1 markers stay readable at the shared
  metadata size bound, a retry that resumes one first preserves it verbatim as
  `reset.v1.json`, and the preview counts lock residue rather than listing it.
- Document that `reset-storage` must run as the server's operating-system user:
  applying it as another user, such as `root`, leaves metadata the service
  cannot use. The command does not enforce this.
- Export `resolveLayout`, `inspectStorageLock`, and `isProcessAlive` from the
  storage layout module for the reset; existing lock behaviour is unchanged.

## 0.3.1

- Normalize verified published artifact permissions before they become visible:
  directory roots and members are `0755`, and regular files (including
  single-file artifacts) are `0644`, independent of restrictive staging modes
  or the server process umask. Storage adapters without descriptor mode support
  now fail closed before publication.
- **Operator note.** Artifacts published by 0.3.0 are not repaired
  retroactively; apply a one-time manual `chmod` or re-upload them after
  upgrading.

## 0.3.0

- Add authenticated client-managed symlinks: one-argument
  `--symlink <selector>` rules authorize current managed file or directory
  targets, `Client.link(target, name)` and `swarm-deploy link` create or
  idempotently repoint durable manual links, and `LINKED`/`UNCHANGED` results,
  typed link events, stable policy/target errors, retention pinning, and v2
  mode-aware ledger records preserve fail-closed managed ownership.
- **Rollback warning.** After an upgraded server creates, repairs, or repoints
  any managed link, its v2 ledger record is unreadable by v0.2.0. Rollback
  requires restoring the complete pre-upgrade storage backup or staying on the
  upgraded server. `swarm-deploy link` also requires an upgraded server.
- **Type change.** `SymlinkRule` is now a closed union of automatic
  `{ selector, name }` and manual `{ selector }` rule shapes, rather than an
  extendable interface.

## 0.2.0

- **Behavior change.** A directory upload now commits exactly one recursive managed directory artifact instead of a batch of immediate-child file uploads. `BatchUploadResult`, `BatchUploadFailure`, `SkippedUploadEntry`, `SkippedUploadReason`, and the client `skipped` event are removed, `ClientUploadResult` is now `UploadResult`, and `UploadResult` gains `kind` and, for a directory, `entryCount`. Direct file upload stays byte-compatible. Automation that relied on per-child results must now treat the directory as one artifact.
- Add recursive directory artifacts: a canonical deterministic multi-entry USTAR archive with normalized file mode `0644`, directory mode `0755`, fixed uid, gid, mtime, uname, and gname; bytewise entry ordering with parents before children; empty directories preserved; and symlinks, hardlinks, devices, sockets, FIFOs, cycles, traversal, duplicate, and case-fold-colliding paths rejected. Limits are 100 UTF-8 bytes per component, 100 UTF-8 bytes per stored TAR name, depth 32, 10,000 entries, `maxFileBytes` aggregate payload, and `maxStagingBytes` aggregate staging.
- Add directory offer metadata with `kind: 'directory'`, `entryCount`, `payloadBytes`, and a canonical `treeSha256`, and the `swarm-deploy/direct-tree/v1` transfer-ID domain. The key set is disjoint from the file record's, so an older server rejects it without mutating storage. Upgrade servers before clients.
- Add directory sessions at persisted version 4, verified into `.swarm-deploy/staging/<transfer-id>.tree/` by rebuilding and byte-comparing every canonical header and independently recomputing the tree digest. File sessions keep versions 2 and 3.
- Add directory commit records at version 3 and directory journals at version 3. A directory is published by renaming its verified staging tree under the name and root leases, with explicit recovery for crashes before the rename, after the rename, after the sidecar, and during symlink reconciliation.
- Directory artifacts are create-only. A directory offer for a configured `replaceNames` entry, a file-to-directory kind change, and a directory-to-file kind change are all rejected. Directory replacement and history are deferred because a directory cannot use the file hardlink replacement transaction safely.
- Delete a managed directory by renaming it into `.swarm-deploy/trash/<transfer-id>.tree` and then removing it recursively with `lstat`, `unlink`, and `rmdir` without following symlinks. Startup sweeps proven trash residue.
- Make storage scrubbing kind aware: scheduled and pre-commit passes validate type, sidecar, and root identity, while startup recovery recursively hashes a directory artifact and verifies its canonical tree digest. A mutated managed directory is preserved as unknown and its invalid metadata removed.
- Add server-managed symlinks: `ServerOptions.symlinks` and the repeatable two-value CLI option `--symlink <selector> <link-name>`. A selector that begins and ends with `/` is an unflagged regular expression matched against managed artifact basenames; anything else is an exact managed basename. Selection uses only validated commit records and picks the newest `committedAt`, tie-broken by transfer ID then name. A rule is dormant until its target exists and replacement history names never match.
- Persist managed-link ownership in `.swarm-deploy/links/<sha256(link-name)>.json`. A destination is replaced only when a valid record exists, the destination is a symbolic link, and `readlink()` returns the recorded or desired target. A pre-existing file, directory, unrecorded symlink, changed symlink, or foreign ownership record is unmanaged: it is never replaced, moved, or deleted, and the server fails closed. Reconciliation is level-triggered from startup, commit, already-committed retry, recovery, and retention.
- Reject an upload whose artifact name equals a configured symlink name before session admission, so a configured link never masks a managed artifact.
- Pin every selected symlink target against age, count, SemVer, and quota retention. Pinned targets still count toward the quota, and the desired-link set is recomputed under the root lease before any deletion, so a repoint always precedes the old target becoming eligible. Removing a rule removes its ownership record and visible link only while ownership is still proven.
- Add optional `StorageAdapter.symlink` and `readlink`. Configuring symlink rules requires both; the Node and Bare default adapters provide them, and a custom adapter without symlink rules stays source-compatible.
- Add `HookArtifact.kind` and optional `entryCount`, and the artifact kind to server transfer, offer, progress, and client result events. For a directory, `beforeCommit.path` is the verified `.tree` staging directory and `afterCommit.path` is the final committed directory; configured links are reconciled before `afterCommit`, so a hook observes the new link.
- Add the `LINK_CONFLICT`, `LINK_FAILED`, and `UNSUPPORTED_STORAGE` error codes. A link reconciliation failure after a durable commit behaves like other post-commit deployment failures: the artifact stays committed, the client receives a stable failure, and an already-committed retry reruns reconciliation before succeeding.
- Add the private `.swarm-deploy/links` and `.swarm-deploy/trash` directories, protected, identity-checked, and synchronized like the existing internal directories.
- Directory metadata, session version 4, commit record version 3, directory journals, and directory trash are not downgrade-compatible. Drain uploads before upgrading and do not roll back after committing a directory artifact without restoring from backup.
- The package exposes no user-facing "atomic directory" term or option; atomicity is an internal commit and recovery guarantee.
- Add server-configured artifact patterns (`artifactPatterns`, repeatable `--artifact-pattern`) with `{series}` and strict SemVer `{version}` placeholders over basenames and the immediate source parent. Configuring patterns makes matching mandatory: unmatched offers are rejected with `INVALID_FILENAME` before admission.
- Give a template without `{series}` the fixed series key `fixed-<lowercase hex SHA-256 of the template text>`. The previous key was the raw template, whose braces and slashes failed commit-record validation and made every version-only pattern fail at runtime.
- Reject an artifact pattern whose literal text still contains `{` or `}` after the exact `{series}` and `{version}` placeholders are removed.
- Add optional authenticated `sourceParent` offer metadata, sent only when it is a safe single component. Upgrade servers before clients: older servers reject the new metadata field.
- Add `ClientOptions.includeSourceParent` (default `true`) and the valueless upload CLI flag `--no-source-parent` to suppress `sourceParent` where the staging folder name is itself sensitive. An opted-out upload keeps the legacy transfer identity and is rejected by server patterns that need a parent segment.
- Persist normalized release coordinates in commit records, replacement history, journals, and recovery. Legacy records without coordinates are not count or version rotated.
- Add count rotation (`maxCount`, `--max-count`) and SemVer major/minor rotation (`maxVersions`, `versionGranularity`, `--max-versions`, `--version-granularity`) running after age and before storage-quota retention, with `countDeleted` and `versionDeleted` retention counters.
- Add `beforeCommit`, `afterCommit`, and `onFailure` server hooks (`ServerOptions.hooks` and `--hooks <module>` for `.js`, `.mjs`, and `.cjs` modules), the `HOOK_FAILED` error code, and exported hook and release types. Hooks run again on retries and must be idempotent by transfer ID; `afterCommit` can fail after the artifact is durably committed.
- Defer post-commit rotation until a configured `afterCommit` hook succeeds. The final path exists when `afterCommit` begins in the sequential server flow, but a concurrent commit's retention pass, a scheduled pass, or a manual pass can remove it while the callback runs, so hooks needing stable bytes should open or copy it promptly. The deferred pass runs before `COMMITTED` or `ALREADY_COMMITTED`, so a slow retention pass can delay the reply. Servers without `afterCommit` rotate immediately as before.
- Run the deferred post-commit retention pass from an already-committed offer only for a transfer this process committed whose `afterCommit` has not yet succeeded. Other duplicate offers still invoke `afterCommit` but start no retention pass, so they cannot force repeated full scans. The owed-transfer set is in memory only and is cleared by server close.
- Reject a `--hooks` path whose extension is not exactly `.js`, `.mjs`, or `.cjs` before the module is loaded, so an unsupported extension gives a precise startup error instead of a runtime loader message.
- **Behavior change.** Give an authenticated transfer ID a single in-flight owner. A second connection offering a transfer another connection already owns is rejected with `FILE_BUSY` during the offer phase, so staging, commit, `beforeCommit`, and `afterCommit` never run concurrently for one transfer identity. Sequential retries, resumes, and verified reconnects are unaffected, but automation that uploads one artifact from several workers at once must now treat `FILE_BUSY` as "retry once the in-flight attempt finishes". The guard is per process, bounded by the connection limit, and released when the connection ends or the server closes.
- Release the transfer guard before awaiting `onFailure`, so a slow or hung failure callback cannot reject the client's legitimate retry. `onFailure` is observational and may therefore overlap the next attempt's lifecycle hooks; each connection still reports at most once, and the serialization of `beforeCommit`/`afterCommit` per transfer is unchanged.
- Bound the owed post-commit retention set at 1024 transfers, matching the connection ceiling, evicting the oldest owed transfer first. An evicted transfer keeps its committed artifact and leaves rotation to the next startup, scheduled, or commit-triggered pass.
- Reserve the derived fixed-series namespace: a captured `{series}` of exactly `fixed-` plus 64 lowercase hex characters never matches, so an uploaded filename cannot place itself in a version-only pattern's rotation group.
- Export `fixedSeriesKey` from the root API so operators can map a series in a commit sidecar or log line back to the template that produced it.
- Retrying a failed `afterCommit` normally takes the `ALREADY_COMMITTED` path, but there is no persistent hook-pending marker: any intervening retention pass (startup after a restart, scheduled or manual cleanup, or a concurrent commit's retention) can remove an out-of-window artifact first, and the retry is then a fresh upload.
- Write a resumable session at on-disk version 3 only when it carries a `sourceParent`, and at version 2 otherwise. Both are readable. A downgrade therefore loses the resumability of parent-bearing sessions only, instead of every session written by this version; draining in-flight uploads before a rollback still avoids it.
- Never rewrite the durable release identity of a commit record. Enabling or changing `artifactPatterns` while uploads are in flight makes a retry of already-committed bytes fail closed (`FILE_EXISTS` for a create-only name, a release-identity conflict for a replaceable name retried under the same transfer ID), so drain in-flight uploads before changing patterns.
- Commit-record compatibility is asserted only in the reading direction: records without release coordinates are read and excluded from count and version rotation. Whether older code tolerates records this version writes is untested.
- Document that a hung hook callback on a fresh or resumed upload also holds an active-upload slot and its staging reservation, so enough hung callbacks exhaust upload capacity until the server closes. Bounded timeout and anti-spam controls are tracked in issue #8.
- Document that an `offer`-phase `onFailure` context is built before the transfer ID is authenticated and is delivered even when that authentication failed, so its artifact fields must not be used as audit or idempotency keys.
- Document rollout, retry, path, and compatibility semantics.

## 0.1.0

- Initial public release.
- Publish under the unscoped `swarm-deploy` npm package name.
- Add authenticated, encrypted direct-HyperDHT uploads pinned to the server public key and a static server allowlist.
- Add bounded one-file and immediate-directory uploads with canonical TAR verification and TAR-byte-offset resumable staging.
- Add crash-safe create-only commits, startup recovery, storage scrubbing, and retention cleanup.
- Add opt-in atomic replacement for exact configured names with retained version history and v2 journal recovery.
- Add Node.js and Bare APIs, CLI identity provisioning, structured lifecycle events, and safe exit codes.
- Accept canonical 64-character seed strings in runtime constructors and through
  the CLI `--seed` option, alongside seed files and role-specific environment
  variables.
- Wrap arbitrary regular binary inputs in byte-stable canonical one-entry USTAR
  archives automatically.
- Reserve direct `history-*` inputs and report batch children as `reserved-history` skips.
- Reclaim expired inactive staging before offer admission while preserving active uploads.
- Add stable `ACTIVE_UPLOAD_LIMIT` and `CONNECT_TIMEOUT` errors.
- Require an explicit terminal result; EOF and close are not success.
- Keep recovery logs on 12-character transfer fingerprints and narrow the supported root API to Client/Server usage.
- Pin the release publish action to the reviewed immutable Holepunch actions revision.
- Release a session's staging reservation even when its files cannot be unlinked, so a failed cleanup no longer exhausts staging capacity or leaves the name permanently busy.
- Keep expired-session sweeps from aborting on the first failure, so one unremovable session no longer rejects every later upload; the count is exposed as `strandedSessions`.
- Report a peer that half-closes mid-phase as a typed `PROTOCOL_INVALID` truncation instead of an untyped runtime error.
- Report an unsafe staging path as a typed error instead of dereferencing a null error cause.
- Validate received archives against the canonical framing directly and take the payload by offset, removing the redundant second parse and its unreachable entry checks.
- Consolidate the canonical USTAR constants, header, and size math into one module, with a test pinning the header against the packer.
- Keep a failed post-commit session cleanup from reporting a durably committed upload as a failure.
- Share one null-safe error-code helper instead of seven private copies.
