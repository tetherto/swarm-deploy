# Artifact patterns and rotation

Artifact patterns teach the server which uploads belong to which release
series and, optionally, which SemVer version each one carries. They drive count
and version rotation and are configured only on the server:
`ServerOptions.artifactPatterns` or repeatable `--artifact-pattern`. Back to the
[README](../README.md).

## Contents

- [Pattern templates](#pattern-templates)
- [Source parent](#source-parent)
- [Mandatory matching](#mandatory-matching)
- [Selection rules](#selection-rules)
- [Configuration and CLI examples](#configuration-and-cli-examples)

Related guides: [CLI reference](cli.md) for `--artifact-pattern`,
`--max-count`, `--max-versions`, and `--version-granularity`;
[managed symlinks](managed-links.md), which pin their targets against rotation;
[deployment hooks](hooks.md), whose ordering affects the post-commit retention
pass; and [Rollout and compatibility](operations.md#rollout-and-compatibility)
for upgrading to patterns, including
[Enabling or changing patterns](operations.md#enabling-or-changing-patterns).

## Pattern templates

A template is literal text plus the placeholders `{series}` and `{version}`:

- At least one placeholder is required; each may appear at most once.
- Two placeholders in one path segment must be separated by literal text.
- `{` and `}` are reserved. A template whose literal text still contains a
  brace after the exact `{series}` and `{version}` placeholders are removed
  (`{serie}-{version}.tar.gz`, `{{series}.zip`) is rejected at startup rather
  than matched literally.
- A template has one segment (matched against the basename) or two segments
  separated by one `/` (`<source-parent>/<basename>`). Empty segments, further
  `/` characters, and duplicate templates are rejected at startup.
- `{series}` captures one safe component. A template without `{series}` is a
  fixed series whose key is `fixed-` followed by the lowercase hex SHA-256 of
  the exact template text. `{version}/payments.tar.gz` therefore has the series
  `fixed-594ef13d9808171190f7827f7d2fb1dc33f000f531b69d55c1bd485a70ff8c4b`. The
  key is a 70-character safe basename, so it persists in commit records and
  stays identical across restarts and between Node.js and Bare. The root export
  `fixedSeriesKey(template)` derives the same value, so an operator can map a
  series in a sidecar or log line back to the template that produced it.
- That derived shape is a reserved namespace: a captured `{series}` of exactly
  `fixed-` plus 64 lowercase hex characters never matches, so an uploaded
  filename cannot place itself in a version-only pattern's rotation group. The
  offer is simply unmatched, which with mandatory matching means
  `INVALID_FILENAME`. Look-alikes (different length, uppercase, non-hex) are
  unaffected.
- `{version}` must be strict SemVer 2.0.0: no `v` prefix, no leading zeros, no
  padding. The stored version is the normalized `major.minor.patch[-prerelease]`;
  build metadata is accepted in a folder name but dropped, and it never
  influences precedence.
- Basenames never contain `+`, so build metadata can only appear in a
  source-parent segment.
- A malformed version is a non-match, not a partial match.

Examples:

| Template                    | Offer (`sourceParent`, basename)    | Series        | Version      |
| --------------------------- | ----------------------------------- | ------------- | ------------ |
| `{series}-{version}.tar.gz` | `payments-2.4.1.tar.gz`             | `payments`    | `2.4.1`      |
| `{series}-{version}.tar.gz` | `payments-3.0.0-rc.1.tar.gz`        | `payments`    | `3.0.0-rc.1` |
| `{version}/{series}.tar.gz` | `2.4.1+build.7` / `payments.tar.gz` | `payments`    | `2.4.1`      |
| `releases/{series}.zip`     | `releases` / `payments.zip`         | `payments`    | none         |
| `{version}/payments.tar.gz` | `1.8.0` / `payments.tar.gz`         | `fixed-594e…` | `1.8.0`      |
| `{series}.tar.gz`           | `payments.tar.gz`                   | `payments`    | none         |

With a series-first template such as `{series}-{version}.tar.gz`, the split
chosen is the right-most `-` that yields a valid SemVer, so hyphenated series
names and prereleases both work. A version-first template such as
`{version}-{series}.tar.gz` splits at the left-most valid position and cannot
tell a prerelease hyphen from the series separator; prefer series-first or a
folder-based version for prereleases.

Patterns are tried in declaration order and the first template that produces
coordinates wins. A template with a parent segment never matches an offer that
carries no `sourceParent`.

## Source parent

The client sends the immediate parent directory name of the resolved input as
optional authenticated metadata, never an absolute path or a higher component.
Uploading `/ci/2.4.1+build.7/payments.tar.gz` sends `sourceParent`
`2.4.1+build.7`; uploading a directory sends that directory's name for each
child.

The parent is sent only when it is a safe single component
(`[A-Za-z0-9][A-Za-z0-9._+-]*`, at most 100 UTF-8 bytes). A parent with a space,
a leading dot, a non-ASCII character, an overlong name, or the filesystem root
is omitted, and the upload keeps the pre-existing metadata shape. Consequently a
folder pattern rejects uploads whose parent is unsafe or omitted: stage release
files in a conforming directory. `sourceParent` is part of the transfer ID, so
it cannot change between resume attempts.

A client can also suppress it deliberately with `includeSourceParent: false`
(CLI `--no-source-parent`) where the staging folder name itself is sensitive.
The upload then sends no parent and derives the same transfer ID as a client
that predates the field, so a server pattern needing a parent segment rejects
it with `INVALID_FILENAME`.

## Mandatory matching

When `artifactPatterns` is non-empty, matching is mandatory for new uploads. An
offer that matches no pattern is rejected with `INVALID_FILENAME` before
session admission, staging, verification, commit, `beforeCommit`, and
`afterCommit`; the server then calls `onFailure` once with phase `offer`, a
`null` path, and no `release`. A server with no patterns accepts every
otherwise-valid name, and records get no release identity.

Release coordinates (`series` and, if the pattern has one, `version`) are
decided at commit time and persisted in the commit record, replacement history
inherits them, and they survive restarts and later pattern changes. A commit
record written before this feature, or by a server without patterns, has no
release and is never deleted by count or version rotation; it remains subject
to age and quota retention.

A new upload whose matched release differs from the persisted release of the
same transfer fails closed instead of reporting `ALREADY_COMMITTED`.

## Selection rules

Retention runs under the root lease at startup, on schedule, around every
commit, and manually. After session expiry and a committed-state scrub, its
stages run in this order, each working from the records the previous stage
left:

1. age (`maxAge`);
2. count (`maxCount`);
3. version (`maxVersions` with `versionGranularity`);
4. storage quota (`maxStorageBytes`).

**Count.** Records are grouped by series and ordered by commit order: newest
`committedAt` first, with transfer ID and then name as deterministic
tie-breakers. The newest `maxCount` records in each series are kept. Replacement
history records count like any other release.

**Version.** Records with a version are grouped by series and ordered by SemVer
precedence, not by commit time. With `major`, every record in the newest
`maxVersions` distinct majors is kept; with `minor`, in the newest
`maxVersions` distinct `major.minor` groups. Prereleases and history records in
a retained group are kept, so `2.0.0-rc.1` and `2.0.0` share group `2`. Series-only
records (no `{version}`) are never selected by version rotation.

**Combined limits.** A record may be removed by either configured bound, so
`maxCount` plus `maxVersions` retains the intersection of the two keep sets, and
age and quota then apply to what remains.

**Pinned mutable names.** The current artifact of a `--replace-name` name is
never deleted by any stage, but it still takes part in the accounting. If it
occupies a slot or falls outside a keep set, the limit is best-effort: the
series can hold more than the configured number until a later upload moves the
name on.

**Immediate effect.** Rotation also runs right after each commit, so an upload
that is older than the retained window (for example version `1.0.0` when
`maxVersions` is `2` and `3.x` and `2.x` exist) is committed and then removed in
that same pass. The exact ordering depends on [hooks](hooks.md):

- Without an `afterCommit` or `afterLink` hook, the post-commit pass runs
  immediately after the commit becomes durable, before `COMMITTED` is sent.
- With an `afterCommit` hook, the post-commit pass is deferred. Order:
  commit (the pre-commit quota and age checks still run first), `afterCommit`
  with the final path and sidecar present, and only after the callback
  succeeds the post-commit pass, then `COMMITTED` (or `ALREADY_COMMITTED`).
  Because the deferred pass runs before the terminal reply, a slow retention
  pass delays `COMMITTED` or `ALREADY_COMMITTED`. `beforeCommit`-only and
  `onFailure`-only servers do not defer.
- An `afterLink` hook defers the pass the same way, after `afterCommit` (when
  both are configured) and after every `afterLink` call for the upload has
  succeeded. Deferring makes this commit's own link reconciliation run before
  this commit's retention pass, which narrows but does not remove the chance
  that the link has already moved (another commit's retention pass or
  reconciliation can do it first, and the hook then sees `UNCHANGED`). An
  explicit link request never runs retention.
- These bullets describe `response` hooks. A configured `detached` hook defers the
  pass the same way until the commit's own awaited steps have finished, but the
  pass does not wait for the detached call (it starts after the answer): the
  artifact of a queued or running detached call is pinned against every retention
  pass instead, from registration until the call ends, in memory only.
- The final path exists when `afterCommit` begins in the sequential server
  flow, including for an out-of-window release, and for replacement commits
  (a replaced artifact's history record is also present). It is not a lock:
  a concurrent commit's retention pass, a scheduled retention pass, or a manual
  retention pass can remove the file while the callback runs. A hook that needs
  stable bytes should open or copy the file promptly at the start of the
  callback.
- If `afterCommit` (or `afterLink`) throws, no post-commit pass runs for that
  connection. The artifact and its record stay, and the server remembers in
  memory that this transfer still owes a pass. An immediate retry normally
  reaches `ALREADY_COMMITTED`, runs `afterCommit` again with the existing path,
  and runs the owed pass only after the hooks succeed. A failing
  already-committed `afterCommit` likewise skips the pass and keeps the
  transfer owed. See the retry caveat below.
- An ordinary duplicate offer — one whose `afterCommit` already succeeded, or
  that this process never committed — still calls `afterCommit` with
  `alreadyCommitted: true`, but starts **no** retention pass. Only a connection
  that committed in this process, or a retry of a transfer whose hook failed
  here, can trigger the deferred pass, so repeated duplicate offers cannot be
  used to force repeated full retention scans.
- The owed-transfer set lives only in memory. A server restart forgets it, and
  closing the server clears it; the artifact is then rotated by the next
  startup, scheduled, or commit-triggered pass instead.
- Post-commit retention failures stay non-fatal: they are logged and reported as
  `retention` events, and never fail the upload.

**Retry caveat.** There is no persistent "hook pending" marker. After
`afterCommit` fails for an out-of-window artifact, any intervening retention
pass can remove it before the client retries: a startup pass after a restart, a
scheduled or manual cleanup, or the retention pass of another concurrent commit.
The retry is then a normal fresh upload (transfer, verification, `beforeCommit`,
commit, `afterCommit` with `alreadyCommitted: false`), not `ALREADY_COMMITTED`.
Every statement in the [hooks guide](hooks.md) that a failed hook is retried as
`ALREADY_COMMITTED` assumes the artifact was not removed in between.

`retention` events and results report `ageDeleted`, `countDeleted`,
`versionDeleted`, and `storageDeleted` next to `expiredSessions` and `scrubbed`.
Logged deletions use the reasons `MAX_AGE`, `MAX_COUNT`, `MAX_VERSIONS`, and
`MAX_STORAGE`.

## Configuration and CLI examples

Filename versions, keeping the newest 5 builds per product and the newest two
minor lines:

```sh
swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
  --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 2147483648 \
  --artifact-pattern '{series}-{version}.tar.gz' \
  --max-count 5 --max-versions 2 --version-granularity minor
```

Folder versions (the source parent carries the version, build metadata
included), keeping the two newest majors:

```sh
swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
  --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 2147483648 \
  --artifact-pattern '{version}/{series}.tar.gz' \
  --max-versions 2 --version-granularity major

# client: /ci/out/2.4.1+build.7/payments.tar.gz is offered as
# sourceParent "2.4.1+build.7", name "payments.tar.gz"
swarm-deploy upload --seed-file client.seed --server-key "$SERVER_KEY" \
  /ci/out/2.4.1+build.7/payments.tar.gz
```

The runtime API takes the same values:

```ts
new Server({
  // ...required options
  artifactPatterns: ['{series}-{version}.tar.gz', 'releases/{series}.zip'],
  maxCount: 5,
  maxVersions: 2,
  versionGranularity: 'minor'
})
```

`maxCount` requires at least one pattern. `maxVersions` requires at least one
pattern containing `{version}` and a `versionGranularity`; a granularity without
`maxVersions` is invalid. These errors are raised at construction or CLI startup
(exit `2`). The pattern list is snapshotted at construction.
