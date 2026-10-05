# Changelog

All notable changes to this package are documented here.

## Unreleased

- Add server-configured artifact patterns (`artifactPatterns`, repeatable `--artifact-pattern`) with `{series}` and strict SemVer `{version}` placeholders over basenames and the immediate source parent. Configuring patterns makes matching mandatory: unmatched offers are rejected with `INVALID_FILENAME` before admission.
- Give a template without `{series}` the fixed series key `fixed-<lowercase hex SHA-256 of the template text>`. The previous key was the raw template, whose braces and slashes failed commit-record validation and made every version-only pattern fail at runtime.
- Reject an artifact pattern whose literal text still contains `{` or `}` after the exact `{series}` and `{version}` placeholders are removed.
- Add optional authenticated `sourceParent` offer metadata, sent only when it is a safe single component. Upgrade servers before clients: older servers reject the new metadata field.
- Persist normalized release coordinates in commit records, replacement history, journals, and recovery. Legacy records without coordinates are not count or version rotated.
- Add count rotation (`maxCount`, `--max-count`) and SemVer major/minor rotation (`maxVersions`, `versionGranularity`, `--max-versions`, `--version-granularity`) running after age and before storage-quota retention, with `countDeleted` and `versionDeleted` retention counters.
- Add `beforeCommit`, `afterCommit`, and `onFailure` server hooks (`ServerOptions.hooks` and `--hooks <module>` for `.js`, `.mjs`, and `.cjs` modules), the `HOOK_FAILED` error code, and exported hook and release types. Hooks run again on retries and must be idempotent by transfer ID; `afterCommit` can fail after the artifact is durably committed.
- Defer post-commit rotation until a configured `afterCommit` hook succeeds. The final path exists when `afterCommit` begins in the sequential server flow, but a concurrent commit's retention pass, a scheduled pass, or a manual pass can remove it while the callback runs, so hooks needing stable bytes should open or copy it promptly. The deferred pass runs before `COMMITTED` or `ALREADY_COMMITTED`, so a slow retention pass can delay the reply. Servers without `afterCommit` rotate immediately as before.
- Run the deferred post-commit retention pass from an already-committed offer only for a transfer this process committed whose `afterCommit` has not yet succeeded. Other duplicate offers still invoke `afterCommit` but start no retention pass, so they cannot force repeated full scans. The owed-transfer set is in memory only and is cleared by server close.
- Give an authenticated transfer ID a single in-flight owner. A second connection offering a transfer another connection already owns is rejected with `FILE_BUSY` during the offer phase, so hooks, staging, and commit never run concurrently for one transfer identity. The guard is per process, bounded by the connection limit, and released when the connection ends or the server closes.
- Retrying a failed `afterCommit` normally takes the `ALREADY_COMMITTED` path, but there is no persistent hook-pending marker: any intervening retention pass (startup after a restart, scheduled or manual cleanup, or a concurrent commit's retention) can remove an out-of-window artifact first, and the retry is then a fresh upload.
- Write a resumable session at on-disk version 3 only when it carries a `sourceParent`, and at version 2 otherwise. Both are readable. A downgrade therefore loses the resumability of parent-bearing sessions only, instead of every session written by this version; draining in-flight uploads before a rollback still avoids it.
- Never rewrite the durable release identity of a commit record. Enabling or changing `artifactPatterns` while uploads are in flight makes a retry of already-committed bytes fail closed (`FILE_EXISTS` for a create-only name, a release-identity conflict for a replaceable name retried under the same transfer ID), so drain in-flight uploads before changing patterns.
- Commit-record compatibility is asserted only in the reading direction: records without release coordinates are read and excluded from count and version rotation. Whether older code tolerates records this version writes is untested.
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
