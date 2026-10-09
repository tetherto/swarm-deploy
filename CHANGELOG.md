# Changelog

All notable changes to this package are documented here.

## Unreleased

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
