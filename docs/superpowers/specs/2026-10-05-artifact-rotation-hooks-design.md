# Artifact Rotation and Custom Hooks Design

## Goal

Implement issue #6 by adding deterministic count- and SemVer-based artifact
rotation plus server lifecycle hooks loaded from a JavaScript module. The
feature must work through both `ServerOptions` and the existing server CLI,
preserve existing age/quota retention, and remain compatible with clients and
commit records that predate the feature.

## Release identity and filename patterns

The server identifies releases with ordered, server-configured artifact
patterns. `ServerOptions.artifactPatterns` accepts an iterable of template
strings, and the CLI exposes the repeatable `--artifact-pattern <template>`
option.

Templates are literal-safe: all text is matched literally except the
placeholders `{series}` and `{version}`. A template must contain at least one
placeholder. It may contain each placeholder at most once.

Examples:

- `{series}-{version}.tar.gz` matches a basename such as
  `payments-2.4.1.tar.gz`.
- `{version}/{series}.tar.gz` matches an immediate source parent plus basename,
  such as `2.4.1/payments.tar.gz`.
- `releases/{series}-{version}.zip` restricts the match to the literal
  `releases` source parent.
- `{series}.tar.gz` is valid for count-only rotation.
- `{version}/payments.tar.gz` assigns matching artifacts to the fixed series
  represented by that pattern.

The client includes an optional `sourceParent` field containing only the
immediate source-parent basename. Absolute paths and higher path components are
never sent. Matching first tries the artifact basename and then
`sourceParent/basename`. Patterns are evaluated in declaration order, and the
first match wins. Duplicate templates are rejected.

`sourceParent`, when present, is included in transfer-ID derivation so it cannot
change across resume attempts. Old clients may omit it, preserving protocol
compatibility. Session metadata persists it so a verified resumed upload
retains the same release identity.

A client may also suppress the field deliberately. `ClientOptions.includeSourceParent`
defaults to `true`; setting it to `false` (CLI `--no-source-parent`, a flag that
takes no value) omits the parent from the manifest and from transfer-ID
derivation, making the upload indistinguishable from one by a client predating
the field. A parent-dependent server pattern then rejects it as unmatched. This
keeps a sensitive staging folder name off the wire without weakening the
authenticated identity of what is sent.

Because the session record only needs version 3 when it carries a
`sourceParent`, a parentless session is persisted at version 2. Both versions
are readable, so a server downgrade loses only the resumability of
parent-bearing sessions.

The server validates `{version}` with strict SemVer rules and stores the
normalized `{series, version}` release coordinates in the commit record.
Coordinates are decided at commit time and remain stable across restarts and
later configuration changes. Replacement history inherits the old record's
coordinates. Legacy commit records remain subject to age and storage-quota
retention but are not deleted by count or version rotation.

Configuring one or more artifact patterns makes matching mandatory for new
uploads. An offered basename plus optional source parent that matches no
configured pattern is rejected with `INVALID_FILENAME` before staging,
verification, commit, or hooks. A server with no artifact patterns preserves
the existing accept behavior. If a local source parent cannot be represented
as one safe metadata component, the client omits it; a server pattern that
requires that parent then rejects the unmatched offer.

For a pattern with `{series}`, the captured safe text is the series key. For a
pattern without `{series}`, the key is `fixed-<lowercase hex SHA-256 of the
template text>`. The template text itself cannot be the key: its braces and
slashes fail the commit-record basename rules, so every version-only pattern
would be unpersistable. The hash is a 70-byte safe basename, is stable across
restarts, is identical on Node.js and Bare, and keeps distinct templates
distinct. Validity of the derived key is checked when the matcher is
constructed, not at commit time.

The derived shape is a reserved namespace: a captured `{series}` of exactly
`fixed-` plus 64 lowercase hex characters is not a valid capture, so an offered
filename cannot place itself in the rotation group of a version-only template.
`fixedSeriesKey` is part of the root API so operators can map a persisted series
back to its template.

A template is also rejected at construction when its literal text still
contains `{` or `}` after the exact `{series}` and `{version}` placeholders are
removed, since literals are matched verbatim and a stray brace is always a
typo. Empty captures, unsafe path components, malformed SemVer values, and
ambiguous template definitions are rejected or treated as non-matches without
weakening ordinary upload validation.

Release identity in a commit record is durable and is never rewritten.
Enabling patterns, or editing one an in-flight upload already matched, makes a
retry of already-committed bytes compute a different identity and fail closed
(`FILE_EXISTS` for a create-only name, a release-identity conflict for a
replaceable name). Operators drain in-flight uploads before changing patterns.

## Public configuration

`ServerOptions` gains:

- `artifactPatterns?: Iterable<string>`
- `maxCount?: number`
- `maxVersions?: number`
- `versionGranularity?: 'major' | 'minor'`
- `hooks?: ServerHooks | null`

The server CLI gains:

- repeatable `--artifact-pattern <template>`
- `--max-count <positive-integer>`
- `--max-versions <positive-integer>`
- `--version-granularity <major|minor>`
- `--hooks <module-path>`

`maxCount` requires at least one artifact pattern. `maxVersions` requires at
least one pattern containing `{version}` and requires `versionGranularity`.
`versionGranularity` without `maxVersions` is invalid. These are startup
configuration errors and produce CLI exit code 2. Existing `maxAge`,
`maxStorageBytes`, and replacement options retain their current behavior.

## Rotation selection

Retention runs continue to serialize under the root lease. After session
expiry and committed-state scrubbing, policies execute in this order:

1. age retention;
2. count rotation;
3. version rotation;
4. storage-quota retention.

Every stage works from the records left by the previous stage. A record that
violates either configured rotation bound may be removed; configuring both is
therefore an intersection of their keep sets.

Count rotation groups records by persisted series and keeps the newest
`maxCount` records in each series. Newness is commit order: descending
`committedAt`, followed by transfer ID and name as deterministic tie-breakers.
Replacement history is an ordinary release record for selection purposes.

Version rotation groups records by persisted series, parses normalized SemVer,
and orders versions by SemVer precedence rather than commit time. With
`major`, it keeps all records in the newest `maxVersions` distinct major
groups. With `minor`, it keeps all records in the newest `maxVersions`
distinct `major.minor` groups. All releases, including replacement history and
prereleases, that belong to a retained group are kept. Build metadata does not
change precedence.

Current mutable artifacts remain pinned as they are today. They participate in
selection accounting but are never deleted. A pinned record can therefore make
a configured limit best-effort; retention reports completion rather than
deleting the active mutable path.

Retention results and events add `countDeleted` and `versionDeleted`. Deletion
logs use the stable reasons `MAX_COUNT` and `MAX_VERSIONS`.

### Post-commit ordering when `afterCommit` is configured

A server with an `afterCommit` hook defers the post-commit retention pass until
that callback succeeds, so rotation cannot delete the artifact out from under
the callback in the server's own sequential flow. The deferred pass then runs
before the terminal `COMMITTED` or `ALREADY_COMMITTED` reply, which means a slow
pass delays the reply. Servers without the hook rotate immediately, as before.

Deferral is not a lock. A concurrent commit's pre-commit pass, a scheduled pass,
or a manual pass can still remove the file while the callback runs, so a hook
that needs stable bytes opens or copies the path promptly. Note that the
replacement transaction keeps its own pre-commit pass regardless of deferral.

The deferred pass is owed to a specific transfer. The server tracks, in memory,
the transfer IDs it committed whose `afterCommit` has not yet succeeded, and
only those may start a deferred pass from an already-committed retry. An
ordinary duplicate offer still invokes `afterCommit`, but starts no retention
pass, so duplicates cannot be used to force repeated full scans. The owed set is
cleared once the hook succeeds and its pass has been attempted, and on server
close. It is bounded at 1024 entries, matching the connection ceiling, and
evicts the oldest owed transfer first when a persistently failing hook fills it.
Because it is neither persisted nor unbounded, a restart or an eviction falls
back to the next startup, scheduled, or commit-triggered pass.

## Hook API and module loading

The root package exports `ServerHooks` and the hook context types. Every
callback may return `void` or a promise:

- `beforeCommit(context)` runs after successful archive verification and
  before any commit mutation.
- `afterCommit(context)` runs after the artifact is durably committed and
  before terminal success is sent.
- `onFailure(context)` runs once when an upload with decoded artifact metadata
  fails.

The common context includes safe artifact metadata, release coordinates when
available, retry flags, and the lifecycle phase. `beforeCommit` receives the
absolute verified staging path. `afterCommit` receives the absolute final path.
`onFailure` receives the best path known for its phase and the original error.
Hooks are trusted server-side code; seeds, secret keys, raw TAR data, and
unrelated session material are never included.

`ServerOptions.hooks` accepts a validated callback object directly, which keeps
the runtime API usable on Node.js and Bare. The CLI resolves `--hooks` relative
to the current working directory and dynamically loads plain JavaScript. The
resolved path's extension must be exactly `.js`, `.mjs`, or `.cjs`, checked
before the load so an unsupported extension gives a precise startup error. It
accepts ESM named callback exports, an ESM default hook object, or the
equivalent CommonJS export. Module resolution, loading, or shape failures abort
startup as configuration errors before the server listens.

The lifecycle hooks never run concurrently for one transfer. An authenticated
transfer ID has a single in-flight owner: a second connection offering the same
ID is rejected with `FILE_BUSY` during the offer phase, before any staging work
or lifecycle hook, and that rejection is reported once through `onFailure`. The
guard is per process, holds at most one entry per connection, and is released
when the connection ends or the server closes. Hooks for different transfers
still run concurrently.

`onFailure` is excluded from that serialization on purpose. It observes an
outcome the connection has already settled, so the connection hands the
transfer back before awaiting it; otherwise a slow callback would reject the
client's own retry with `FILE_BUSY`. The release clears the connection's
handle, so the later `finally` cannot revoke ownership that a subsequent
connection has since acquired. A retry may therefore run its lifecycle hooks
while a previous `onFailure` is still pending, and each connection still
reports at most once.

There is no hook timeout. A hung callback on a fresh or resumed upload holds its
connection, an active-upload slot, and its session's staging reservation, so
enough hung callbacks exhaust upload capacity (`ACTIVE_UPLOAD_LIMIT`) until the
server closes and aborts the waits; only the already-committed path holds no
upload slot. Bounded timeout and anti-spam controls are deferred to issue #8.

Hook exceptions produce the stable public error code `HOOK_FAILED`. The server
then invokes `onFailure`. An `onFailure` exception is logged as a secondary
error and never replaces the original upload failure.

## Retry and failure semantics

For a fresh upload, the lifecycle is:

`verify -> beforeCommit -> commit -> afterCommit -> COMMITTED`

A transfer that reconnects in the already-verified state invokes
`beforeCommit` again with `resumed: true`. Hook modules must make
`beforeCommit` idempotent because a previous connection may have ended after
the callback returned but before commit completed.

An already-committed offer skips verification and `beforeCommit`, then invokes
`afterCommit` with `alreadyCommitted: true` before the server returns
`ALREADY_COMMITTED`. This lets a client retry deployment work when an earlier
connection ended after durable commit or when `afterCommit` previously failed.

If `beforeCommit` fails, no commit mutation occurs and the verified session
remains resumable. If `afterCommit` fails, the artifact remains durably
committed but the client receives failure. A retry normally follows the
already-committed path and invokes `afterCommit` again. Hook modules must
therefore make `afterCommit` idempotent and use the transfer ID as a stable
operation key when coordinating external systems.

That retry path is not guaranteed, because nothing marks the artifact as
hook-pending on disk. An intervening retention pass — startup recovery after a
restart, a scheduled or manual pass, or a concurrent commit's pass — can remove
an out-of-window artifact first, in which case the retry is an ordinary fresh
upload.

The server invokes `onFailure` at most once per failed connection after
metadata has been decoded. Context identifies whether failure occurred during
offer inspection, transfer, verification, `beforeCommit`, commit, or
`afterCommit`, and whether the connection represented a resumed or
already-committed transfer. An `offer`-phase context is assembled before the
transfer ID is authenticated and is delivered even when that authentication is
the failure, so its artifact fields are unauthenticated peer input and must not
be used as audit or idempotency keys.

## Error handling and compatibility

All new numeric values are positive safe integers and follow existing
configuration error conventions. Pattern collections and hook objects are
snapshotted during server construction. Caller mutations after construction do
not alter behavior.

Old clients, sessions, and commit records remain readable. Missing
`sourceParent` remains valid protocol metadata, although a configured
parent-dependent pattern can reject that offer as unmatched. Missing release
coordinates on legacy commit records mean that count/version rotation does not
select that record. Existing create-only, replacement, recovery, scrub, age,
quota, cancellation, and protocol guarantees remain unchanged. Compatibility is
asserted only in the reading direction; whether older code tolerates the
release-bearing records this version writes is untested.

Release coordinates become validated optional commit-record fields. Record
comparison, journal serialization, recovery, history conversion, and
replacement deduplication include them so crash recovery cannot silently
change rotation identity.

## Testing

Focused unit tests cover:

- template validation and ordered matching against filenames and immediate
  parent folders;
- strict SemVer parsing, prerelease precedence, build metadata, and fixed
  series patterns;
- count ordering and deterministic ties;
- major/minor distinct-version grouping;
- combined count/version policies;
- replacement history and pinned current records;
- legacy and unmatched records;
- persisted coordinates across restart and recovery;
- CLI parsing and invalid option combinations;
- ESM, CommonJS, default, and named hook module loading;
- callback ordering and context for fresh, verified-resumed, and
  already-committed uploads;
- `beforeCommit`, commit, `afterCommit`, and `onFailure` failures;
- public API type coverage and old-client compatibility.

The full Node.js and Bare suites, formatting/lint checks, type tests, property
tests, release-tag tests, and package smoke tests run before the pull request is
opened. README usage, runtime API documentation, the protocol specification,
and the changelog document configuration, lifecycle points, retry/idempotency
requirements, and retention interaction.
