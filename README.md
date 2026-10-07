<h1 align="center">Swarm Deploy</h1>

<p align="center">
  Authenticated, encrypted, resumable artifact uploads over direct HyperDHT.
</p>

<p align="center">
  <a href="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/tetherto/swarm-deploy/blob/main/package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/tetherto/swarm-deploy?filename=package.json&amp;label=version&amp;style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 and 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933?logo=nodedotjs&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://github.com/holepunchto/bare"><img alt="Bare supported" src="https://img.shields.io/badge/Bare-supported-171717?logo=javascript&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="Strict TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://github.com/tetherto/swarm-deploy/blob/main/LICENSE.md"><img alt="Apache-2.0 license" src="https://img.shields.io/github/license/tetherto/swarm-deploy?style=flat-square"></a>
</p>

Swarm Deploy moves build artifacts from authorized clients to one receiving
server. Each file uses a fresh direct HyperDHT connection authenticated and
encrypted with Noise. The client pins the server's public key, while the server
accepts only client public keys in its immutable startup allowlist.

The receiver is upload-only. It does not execute, serve, or provide a download
protocol for stored artifacts.

## Requirements

- Node.js 22 or 24, or the current stable Bare runtime.
- A persistent server seed and at least one independently generated client seed.
- A dedicated server storage directory.
- Network access suitable for HyperDHT.

## Install

Install the runtime API in an application:

```sh
npm install swarm-deploy
```

Install the CLI globally for a receiving server or CI uploader:

```sh
npm install --global swarm-deploy
swarm-deploy --help
```

## Security and identity model

Three values have different roles:

- **Seed:** private 32-byte identity material. Prefer a protected seed file or
  environment secret. The CLI also accepts `--seed <64-lower-hex>`, but command
  arguments can be exposed through shell history, process listings, and CI
  tracing. Never put a seed in an allowlist or application log.
- **Client public key:** derived from a client seed and installed in the
  server's allowlist.
- **Server public key:** derived from the server seed and pinned by every
  client. It is both the direct HyperDHT destination and the server identity
  commitment.

HyperDHT Noise authenticates both peers and encrypts the transport. Application
SHA-256 checks verify the deterministic TAR and extracted file bytes.

There is no topic, swarm discovery, Protomux channel, dynamic allowlist reload,
or reconnect budget. Changing an allowed client key requires a controlled
server restart.

Keep seeds stable to preserve identity. Copying one client seed to several
machines intentionally gives all of them the same uploader identity; use
separate client seeds when independent authorization is required.

## Provision identities

Generate separate server and client seed files:

```sh
swarm-deploy keygen --out server.seed
swarm-deploy keygen --out client.seed
```

`keygen` creates an owner-only file, refuses to overwrite an existing path, and
prints the corresponding public key—not the seed.

Recover public keys later:

```sh
SERVER_KEY=$(swarm-deploy public-key --seed-file server.seed)
CLIENT_KEY=$(swarm-deploy public-key --seed-file client.seed)
```

Public keys are lowercase 64-character hexadecimal strings and are safe to use
as configuration values.

## Quick start

Start the receiver:

```sh
swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
  --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 2147483648
```

The server prints its full public key and then `ready` after storage recovery,
scrub, retention initialization, and HyperDHT listening complete:

```text
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
ready
```

Upload a file:

```sh
swarm-deploy upload --seed-file client.seed --server-key "$SERVER_KEY" \
  --idle-timeout 60000 ./artifact.bin
```

Successful output is:

```text
artifact.bin COMMITTED
```

Uploading the same managed content again returns `ALREADY_COMMITTED` without
retransmitting its TAR bytes.

## CLI reference

### `keygen`

```sh
swarm-deploy keygen --out <seed-file>
```

Creates a new seed file with owner-only permissions and prints its public key.
The destination must not already exist.

### `public-key`

```sh
swarm-deploy public-key --seed-file <seed-file>
swarm-deploy public-key --seed <64-lower-hex>
```

Reads a seed file or canonical seed string and prints its public key.

### `server`

```sh
swarm-deploy server \
  --seed-file <seed-file> \
  --storage <directory> \
  --allow-key <64-lower-hex> \
  --max-file-bytes <bytes> \
  --max-staging-bytes <bytes> \
  [--allow-key <64-lower-hex>]... \
  [--max-storage-bytes <bytes>] \
  [--max-age-days <days>] \
  [--replace-name <safe-basename>]... \
  [--artifact-pattern <template>]... \
  [--max-count <count>] \
  [--max-versions <count> --version-granularity <major|minor>] \
  [--symlink <selector> <link-name>]... \
  [--hooks <module>]
```

Replace `--seed-file <seed-file>` with `--seed <64-lower-hex>` to provide the
seed inline.

Required options:

- Exactly one seed source: `--seed-file`, `--seed`, or
  `SWARM_DEPLOY_SERVER_SEED`.
- `--storage`: dedicated artifact and internal-state root.
- `--allow-key`: authorized client public key. Repeat for multiple identities;
  duplicates and malformed keys are rejected.
- `--max-file-bytes`: maximum extracted artifact size.
- `--max-staging-bytes`: aggregate persistent staging reservation. An admitted
  transfer reserves its deterministic TAR size plus extracted file size, so
  this commonly needs to be at least twice the largest simultaneously staged
  payload.

Optional options:

- `--max-storage-bytes`: maximum total managed committed storage. Oldest
  eligible artifacts are removed first.
- `--max-age-days`: remove eligible committed artifacts at or beyond this age.
- `--replace-name`: permit replacement of this exact basename. Repeat for
  multiple mutable names.
- `--artifact-pattern <template>`: identify releases and make matching
  mandatory. Repeat for multiple templates; declaration order is match order.
  See [Artifact patterns and rotation](#artifact-patterns-and-rotation).
- `--max-count <count>`: keep the newest `<count>` releases per series. Requires
  at least one `--artifact-pattern`.
- `--max-versions <count>`: keep every release in the newest `<count>` distinct
  version groups per series. Requires a pattern containing `{version}` and
  `--version-granularity`.
- `--version-granularity <major|minor>`: how versions are grouped for
  `--max-versions`. It is rejected without `--max-versions`, and there is no
  default.
- `--symlink <selector> <link-name>`: declarative managed symlink rule.
  Repeat for multiple links. A selector that begins and ends with `/` is an
  unflagged regular expression matched against managed artifact basenames;
  anything else is an exact managed basename. The link name must be a safe
  single-component basename and must not collide with another rule.
- `--hooks <module>`: JavaScript module (`.js`, `.mjs`, or `.cjs`) exporting
  trusted lifecycle callbacks. The path is resolved against the working
  directory. See [Deployment hooks](#deployment-hooks).

All counts are positive safe integers. Invalid combinations, malformed or
duplicate templates, and unloadable hook modules are configuration errors that
exit `2` before the server listens. Each hooks-module error names only the
module basename with a fixed reason, never module content.

The CLI requires at least one `--allow-key`. Its snapshot is immutable for the
life of the process.

### `upload`

```sh
swarm-deploy upload \
  --seed-file <seed-file> \
  --server-key <64-lower-hex> \
  [--idle-timeout <milliseconds>] \
  [--no-source-parent] \
  <file-or-directory>
```

Replace `--seed-file <seed-file>` with `--seed <64-lower-hex>` to provide the
seed inline.

- `--server-key` is the full pinned server public key.
- `--idle-timeout` defaults to 60 seconds and bounds inactive protocol reads and
  backpressured writes.
- The input may be any regular binary file; Swarm Deploy creates the canonical
  one-entry USTAR stream automatically. Pre-tarring is not required.
- A direct file retains its basename.
- Each upload also carries the immediate local parent directory name as
  optional `sourceParent` metadata, but only when that name is a safe single
  component (see [Source parent](#source-parent)).
- `--no-source-parent` takes no value and suppresses that metadata for every
  file in the run. The upload then keeps the legacy transfer identity and
  cannot match a server pattern with a parent segment.
- A directory input commits exactly one recursive managed directory artifact
  named after the input basename. Every member must be a safe regular file or
  directory; symlinks, hard links, devices, sockets, FIFOs, unsafe names,
  over-depth, over-count, or over-length members reject the whole upload.
  Nothing is silently skipped.
- On success the CLI prints one line: `<name> <kind> <status>` (for example
  `0.18.1 directory COMMITTED`).

Accepted names start with an ASCII letter or digit, contain only letters,
digits, `.`, `_`, and `-`, and occupy at most 100 UTF-8 bytes. `history-` is
reserved for server-managed replacement history.

If a basename is exactly 64 lowercase hexadecimal characters, pass it with a
directory component such as `./<name>` so the CLI does not treat it as an
accidentally pasted seed.

### Seed sources

Server and upload commands accept exactly one of:

- `--seed-file <seed-file>`
- `--seed <64-lower-hex>`
- the role-specific `SWARM_DEPLOY_SERVER_SEED` or
  `SWARM_DEPLOY_CLIENT_SEED` environment variable

String values must contain exactly 64 lowercase hexadecimal characters.
Combining seed sources is an error.

The `public-key` command accepts `--seed-file` or `--seed`; it does not consume a
role-specific environment variable.

Prefer seed files or protected environment variables in production. Use
`--seed` only when exposure through command history, process inspection, and
tooling logs is acceptable.

### CLI exit codes

- `0`: the upload committed or was already committed.
- `1`: upload, network, protocol, storage, cleanup, or runtime failure.
- `2`: usage or configuration error.

## CI uploader example

Store the client seed as a protected CI secret and the server public key as a
nonsecret variable:

```yaml
- name: Install uploader
  run: npm install --global swarm-deploy

- name: Upload artifact
  env:
    SWARM_DEPLOY_CLIENT_SEED: ${{ secrets.SWARM_DEPLOY_CLIENT_SEED }}
    SWARM_DEPLOY_SERVER_KEY: ${{ vars.SWARM_DEPLOY_SERVER_KEY }}
  run: |
    swarm-deploy upload \
      --server-key "$SWARM_DEPLOY_SERVER_KEY" \
      --idle-timeout 60000 \
      ./dist/artifact-linux-x64.tar.gz
```

Do not enable shell tracing around commands that read seed environment
variables or pass `--seed`.

## Transfer and resume behavior

Each file follows this lifecycle:

1. The client connects directly to the pinned server public key with its seeded
   HyperDHT identity.
2. The server firewall and connection handler verify the authenticated client
   key against the startup allowlist.
3. The client sends bounded metadata containing the name, file size and digest,
   deterministic TAR size and digest, transfer ID, and optional `sourceParent`.
4. The server responds with `ACCEPT`, `RESUME`, `VERIFIED`,
   `ALREADY_COMMITTED`, or a stable rejection.
5. The client sends exactly the required deterministic one-entry USTAR bytes.
6. The server validates the canonical archive, extracted size, and both
   SHA-256 values before durable commit.
7. Success requires an explicit terminal `COMMITTED` result. EOF or socket
   closure is never success.

Incomplete uploads retain only durable TAR progress. On reconnect, the server
returns a TAR-byte offset and SHA-256 of that prefix. The client regenerates and
compares the prefix before sending the suffix. A mismatch closes that connection
and retries once from zero with explicit reset intent.

The server coalesces network fragments into 1 MiB durability batches plus the
final remainder. A disconnect can require retransmitting only the uncheckpointed
in-memory tail; it never advertises bytes that were not durably published.

Inactive sessions expire after seven days by default. Active receives and
verification are protected from expiry.

## Storage, replacement, and retention

The storage root contains visible current and historical artifacts plus the
reserved `.swarm-deploy/` internal directory. Do not modify that directory
while the server is running.

Names are create-only by default:

- New content for an unused name is committed atomically.
- Identical managed content returns `ALREADY_COMMITTED`.
- Different content for an occupied create-only name returns `FILE_EXISTS`.
- Unmanaged files and paths are never overwritten or deleted.

Names configured with `--replace-name` or `ServerOptions.replaceNames` are
mutable:

- Different verified content atomically becomes current.
- The prior managed inode and record are preserved as
  `history-<full-old-transfer-id>`.
- The current mutable name is pinned against age and quota retention.
- Historical versions remain eligible for retention.

Commit journals and inode checks recover interrupted create and replacement
operations. Recovery rolls back mutations before the durable new current
sidecar and rolls forward operations after that linearization point.

Optional retention applies to managed artifacts only:

- `maxAge`/`--max-age-days` removes eligible artifacts by age.
- `maxStorageBytes`/`--max-storage-bytes` removes the oldest eligible artifacts
  until under quota.
- `maxCount`/`--max-count` and `maxVersions`/`--max-versions` rotate released
  artifacts by series; see
  [Artifact patterns and rotation](#artifact-patterns-and-rotation).
- Directory artifacts are create-only. A directory offer for a configured
  `replaceNames` entry, a file-to-directory kind change, or a directory-to-file
  kind change is rejected. Directory replacement and history are deferred.
- Committed artifacts, including directories, are immutable on disk. Do not write
  into a committed directory after publish: hooks must not run `npm ci`, create
  `.cache`, dotfiles, or extra symlinks inside the tree. If the tree changes,
  startup hash scrub drops the sidecar while leaving the bytes in place, the
  name stays occupied (`FILE_EXISTS`), the tree falls outside quota and rotation,
  and a managed `latest` link can move to an older release.
- Managed directories are deleted by renaming into `.swarm-deploy/trash` before
  recursive removal. Startup sweeps proven trash residue.
- Startup recovery re-hashes managed files and recursively verifies directory
  tree digests. Scheduled and pre-commit passes validate type, sidecar, and root
  identity without re-hashing entire trees on every tick.

Runtime defaults:

- 64 authenticated connections.
- 8 active uploads.
- 60-second upload inactivity timeout.
- 1 GiB minimum free-disk reserve.
- 15-minute cleanup interval.
- 7-day resumable-session lifetime.

The advanced runtime API can override these values; the server CLI intentionally
exposes only its required limits, committed retention and rotation, replacement
policy, artifact patterns, and hooks module.

## Artifact patterns and rotation

Artifact patterns teach the server which uploads belong to which release
series and, optionally, which SemVer version each one carries. They drive count
and version rotation and are configured only on the server:
`ServerOptions.artifactPatterns` or repeatable `--artifact-pattern`.

### Pattern templates

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

### Source parent

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

### Mandatory matching

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

### Selection rules

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
that same pass. The exact ordering depends on hooks:

- Without an `afterCommit` hook, the post-commit pass runs immediately after the
  commit becomes durable, before `COMMITTED` is sent.
- With an `afterCommit` hook, the post-commit pass is deferred. Order:
  commit (the pre-commit quota and age checks still run first), `afterCommit`
  with the final path and sidecar present, and only after the callback
  succeeds the post-commit pass, then `COMMITTED` (or `ALREADY_COMMITTED`).
  Because the deferred pass runs before the terminal reply, a slow retention
  pass delays `COMMITTED` or `ALREADY_COMMITTED`. `beforeCommit`-only and
  `onFailure`-only servers do not defer.
- The final path exists when `afterCommit` begins in the sequential server
  flow, including for an out-of-window release, and for replacement commits
  (a replaced artifact's history record is also present). It is not a lock:
  a concurrent commit's retention pass, a scheduled retention pass, or a manual
  retention pass can remove the file while the callback runs. A hook that needs stable bytes should open or
  copy the file promptly at the start of the callback.
- If `afterCommit` throws, no post-commit pass runs for that connection. The
  artifact and its record stay, and the server remembers in memory that this
  transfer still owes a pass. An immediate retry normally reaches
  `ALREADY_COMMITTED`, runs `afterCommit` again with the existing path, and runs
  the owed pass only after that call succeeds. A failing already-committed
  `afterCommit` likewise skips the pass and keeps the transfer owed. See the
  retry caveat below.
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
Every statement below that a failed hook is retried as `ALREADY_COMMITTED`
assumes the artifact was not removed in between.

`retention` events and results report `ageDeleted`, `countDeleted`,
`versionDeleted`, and `storageDeleted` next to `expiredSessions` and `scrubbed`.
Logged deletions use the reasons `MAX_AGE`, `MAX_COUNT`, `MAX_VERSIONS`, and
`MAX_STORAGE`.

### Configuration and CLI examples

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

### Rollout and compatibility

Upgrade every server before any client. An older server decodes upload metadata
with an exact key set and rejects the new `sourceParent` field, so a new client
that sends a parent to an old server fails.

A new server remains compatible with older clients: they never send
`sourceParent`, no-pattern servers are unaffected, filename-only patterns still
match, and patterns that need a parent reject their offers as unmatched. Older
sessions and commit records stay readable, and older commit records are not
count or version rotated.

Roll out the server, then the pattern configuration, then clients that stage
into conforming folders.

#### Overlapping retries now get `FILE_BUSY`

**Behavior change.** A transfer ID may have only one in-flight commit
lifecycle. If a client (or a job runner that fans the same artifact out to
parallel workers) opens a second connection for a transfer that is still
verifying or committing, that second connection is now rejected with
`FILE_BUSY` instead of being admitted alongside the first. Sequential retries,
resumes, and verified reconnects are unaffected, and so is a retry issued after
the previous attempt failed — the server releases the transfer before running
its observational `onFailure`, so a slow callback never blocks the retry.

Audit any automation that uploads the same artifact from more than one worker
at a time, and treat `FILE_BUSY` on an upload as "retry after the in-flight
attempt finishes" rather than a permanent failure.

#### Enabling or changing patterns

A commit record's release identity is durable and is never rewritten in place.
Enabling patterns, or editing one that an in-flight upload already matched,
therefore changes the identity a retry computes for bytes that are already
committed, and the server fails closed rather than relabelling them:

- A create-only name whose record carries a different release (or none) is no
  longer recognised as the same commit, so the retry is rejected with
  `FILE_EXISTS`.
- A replaceable name retried under the same transfer ID with a different
  release is rejected as a release-identity conflict.

Drain or complete in-flight uploads before enabling or changing
`artifactPatterns`. Uploads started after the change are unaffected, and a
rejected legacy retry is resolved by re-uploading under a new transfer (new
content or a new staged name), not by editing records on disk.

#### Session records and rollback

A resumable session is written at on-disk version 3 only when it carries a
`sourceParent`; a session without one is written at version 2, exactly as an
older server would. The new server reads both. An older server cannot read
version 3, so only parent-bearing resumable sessions are lost to a downgrade:
they cannot resume and must be re-uploaded. Draining in-flight uploads before
rolling a server back avoids this entirely.

Commit-record compatibility with older code is covered only by what this
version's tests assert: an older record without release coordinates is read by
this version and is not count or version rotated. Whether older code tolerates
the release coordinates this version writes is untested.

## Managed symlinks

Configure repeatable managed symlinks so the server keeps versioned artifacts
and maintains declarative links in the storage root:

```sh
swarm-deploy server \
  --seed-file ./server.seed \
  --storage /srv/artifacts \
  --allow-key <64-lower-hex> \
  --max-file-bytes 1073741824 \
  --max-staging-bytes 4294967296 \
  --symlink '/^\d+\.\d+\.\d+$/' latest \
  --symlink release.tar.gz current.tar.gz
```

Resulting layout:

```text
/srv/artifacts/
├── 0.18.0/
├── 0.18.1/
└── latest -> 0.18.1
```

Runtime equivalent:

```js
const server = new Server({
  seed,
  storageDir: '/srv/artifacts',
  allowedKeys,
  maxFileBytes: 1024 ** 3,
  maxStagingBytes: 4 * 1024 ** 3,
  symlinks: [
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz', name: 'current.tar.gz' }
  ]
})
```

Selection uses only validated managed commit records. The newest `committedAt`
wins, tie-broken by transfer ID then name. Replacement history names never
match. A rule is dormant until its target exists.

Safety: an unmanaged file, directory, unrecorded symlink, changed symlink, or
foreign ownership record is never replaced, moved, or deleted and causes a
fail-closed error. An upload whose name equals a configured link name is
rejected before admission.

Retention pins every selected symlink target against age, count, SemVer, and
quota deletion. Pinned targets still count toward the quota. The desired-link
set is recomputed under the root lease before any deletion, so a repoint always
precedes the old target becoming eligible. Removing a rule removes its ownership
record and visible link only while ownership is still proven.

`symlinks` requires `StorageAdapter.symlink` and `readlink`. The Node and Bare
default adapters provide them; a custom adapter without symlink rules stays
source-compatible.

## Deployment hooks

Hooks let a trusted server operator run code around the commit. They are
server-side only, run in the server process with its privileges, and receive no
seeds, secret keys, TAR bytes, or session material.

### Lifecycle points

- `beforeCommit(context)`: after verification, before any commit mutation. For a
  file, `path` is the verified `.part` staging file; for a directory, `path` is
  the verified `.tree` staging directory. Its failure aborts the commit.
- `afterCommit(context)`: after the artifact is durably committed and configured
  links are reconciled, before the terminal success reply. For a directory,
  `path` is the committed directory tree. Its failure fails the upload even
  though the artifact is already stored. When it is configured, post-commit
  rotation is deferred until it succeeds (see "Immediate effect" above).
- `onFailure(context)`: once per failed connection whose metadata was decoded,
  after the client has been answered.

Callbacks may return `void` or a promise, are called with no receiver, and
receive a frozen context. The artifact is
`{ name, kind, size, sha256, transferId, entryCount?, sourceParent?, release? }`,
where `entryCount` is present only for directories and `release` is
`{ series, version? }` when patterns are configured. These descriptive fields
come from decoded offer metadata, not yet from verified content.

| Callback       | Extra context                                                                |
| -------------- | ---------------------------------------------------------------------------- |
| `beforeCommit` | `path` (verified staging file or tree), `resumed`, `alreadyCommitted: false` |
| `afterCommit`  | `path` (committed artifact), `resumed`, `alreadyCommitted`                   |
| `onFailure`    | `path` (`string \| null`), `phase`, `resumed`, `alreadyCommitted`, `error`   |

`resumed` is `true` when the server admitted the connection as `RESUME` or
`VERIFIED`. Closing the server aborts the wait; a callback that outlives the
abort continues detached and its later result is ignored.

There is no hook timeout, and a hung callback holds more than its own
connection. On a fresh or resumed upload it also holds a `maxActiveUploads`
slot and the session's staging reservation for as long as it runs, so enough
simultaneously hung callbacks stop the server from admitting new uploads
(`ACTIVE_UPLOAD_LIMIT`) until the server is closed and the waits are aborted.
Only the already-committed path holds no upload slot. Write callbacks that
finish or throw; bounded hook timeout and anti-spam controls are tracked in
issue #8.

The **lifecycle** hooks `beforeCommit` and `afterCommit` never run concurrently
for one transfer. Once a transfer ID authenticates, that connection owns it for
the whole verify/commit sequence; a second connection offering the same transfer
ID — fresh, resumed, verified, or already committed — is rejected with
`FILE_BUSY` before any lifecycle hook runs, and that rejection is reported to
`onFailure` once with `phase: 'offer'`.

`onFailure` is observational and is **not** covered by that guarantee. A failed
connection hands the transfer back before awaiting its `onFailure`, because the
callback only reports an outcome and the connection has already finished
mutating state. A slow callback must not reject the client's legitimate retry,
so a retry of the same transfer can be admitted — and can run its own
`beforeCommit`/`afterCommit` — while the previous `onFailure` is still running.
Each connection still calls `onFailure` at most once, so write it to tolerate
overlapping with the next attempt and key any external effect on
`artifact.transferId`.

Hooks for **different** transfers always run concurrently.

### Invocation sequences

Fresh upload:

1. Offer inspected and admitted (`ACCEPT`), TAR received.
2. Verification.
3. `beforeCommit` (`resumed: false`).
4. Commit.
5. `afterCommit` (`resumed: false`, `alreadyCommitted: false`).
6. `COMMITTED`.

Partial resume (`RESUME`): the same steps, with `resumed: true` in both hooks.

Verified reconnect (`VERIFIED`): the staged data was already verified, so the
server re-reads it, calls `beforeCommit` again with `resumed: true`, commits, and
calls `afterCommit` with `resumed: true`. A previous connection may have ended
after `beforeCommit` returned but before the commit finished.

Already committed: identical content is detected during offer inspection, so
there is no transfer, verification, or `beforeCommit`. The server calls
`afterCommit` with `resumed: false` and `alreadyCommitted: true`, then replies
`ALREADY_COMMITTED`. A deferred retention pass follows only when this process
committed that transfer and its `afterCommit` has not yet succeeded. This path
is reached only while the artifact still exists; see the
[retry caveat](#artifact-patterns-and-rotation).

Failure sequences:

- `beforeCommit` throws: nothing is committed and the verified session remains.
  The client receives `HOOK_FAILED`; `onFailure` runs (`phase: 'beforeCommit'`).
  A retry reconnects as `VERIFIED` and calls `beforeCommit` again.
- `afterCommit` throws on a fresh or resumed upload: the artifact **stays
  durably committed** and its session is retired. The client receives
  `HOOK_FAILED`; `onFailure` runs (`phase: 'afterCommit'`, final path). Unless
  retention removed the artifact first (see the
  [retry caveat](#artifact-patterns-and-rotation)), a retry takes the
  already-committed path and calls `afterCommit` with `alreadyCommitted: true`;
  otherwise it is a fresh upload.
- `afterCommit` throws on an already-committed retry: the offer is rejected with
  `HOOK_FAILED` and a later retry repeats `afterCommit`, subject to the same
  retry caveat.
- A failure after both hooks succeeded (for example the terminal reply cannot be
  written) does not call `onFailure`.

Retries therefore can call hooks more than once for one transfer. **Make hooks
idempotent and key external side effects on `artifact.transferId`.** Treat
`afterCommit` as at-least-once: record the transfer ID when the deployment step
finishes and skip repeated calls.

### onFailure

`phase` is one of `offer`, `transfer`, `verification`, `beforeCommit`, `commit`,
or `afterCommit`. `offer` covers every failure before a staging path exists:
metadata or transfer-ID problems, unmatched patterns, file-size, capacity and
destination rejections, and inspection errors.

An `offer`-phase context is built from decoded metadata **before** the transfer
ID is authenticated, and it is also reported when that authentication is exactly
what failed. Its `transferId`, `name`, `size`, `sha256`, and `sourceParent` are
therefore attacker-chosen values from an allowlisted key, not verified identity.
Use them for logging and alerting only; never as audit records or idempotency
keys. Every later phase runs after authentication, so only `offer` carries this
caveat.

`error` is the original failure. For an exception thrown by `beforeCommit` or
`afterCommit`, hooks receive the **raw thrown value** (not a wrapper) because
hooks are trusted. The client and server events see only the stable wire code
`HOOK_FAILED` with a fixed message, so callback text never reaches the wire. Other
failures arrive as `SwarmDeployError` (or raw storage errors).
A failing `onFailure` is logged as a secondary warning and never replaces the
original failure.

`path` by phase:

| Situation                                                          | `path`                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `offer`                                                            | `null`                                                  |
| `transfer`; fresh-upload `verification`                            | `<storage>/.swarm-deploy/staging/<transferId>.tar.part` |
| `beforeCommit`, `commit`; `verification` of a `VERIFIED` reconnect | `<storage>/.swarm-deploy/staging/<transferId>.part`     |
| `afterCommit` (including already committed)                        | `<storage>/<name>`                                      |

### Hook modules

`--hooks <module>` accepts `.js`, `.mjs`, and `.cjs`; any other extension is
rejected at startup with exit code `2` before the module is loaded. ESM and
CommonJS examples:

```js
// hooks.mjs
export async function afterCommit({ artifact, path, alreadyCommitted }) {
  // Idempotent: keyed by artifact.transferId.
  await deploy(artifact.transferId, path)
}

export function onFailure({ phase, artifact, error }) {
  console.error('deploy failed', phase, artifact.transferId, error)
}
```

```js
// hooks.cjs
module.exports = {
  beforeCommit({ artifact, path }) {
    // Return or throw; a throw rejects the upload with HOOK_FAILED.
  },
  async afterCommit({ artifact, path }) {
    await deploy(artifact.transferId, path)
  }
}
```

Loader rules:

- Only the own properties `beforeCommit`, `afterCommit`, and `onFailure` are
  read. Other exports (helpers, configuration) are ignored, including a
  harmless non-object default export.
- Named exports take precedence over callbacks on a default export object; a
  named export set to `undefined` does not override it.
- A hook name that is present must be a function, the callbacks must be plain
  own properties, and at least one must exist; otherwise startup fails.
- One level of compiled-CommonJS interop (`__esModule` with `default`) is
  unwrapped; deeper nesting is ignored.
- Modules are loaded once with `import()` and cached by the runtime. Top-level
  code runs with the server's privileges during startup, so the module is fully
  trusted.

`ServerOptions.hooks` is stricter: it must be a hook object whose own keys are
only the three callbacks, every callback a function. Unknown keys and
non-function values throw `PROTOCOL_INVALID`. The object is snapshotted at
construction, so later mutation has no effect.

## Runtime API

The package is strict TypeScript and exposes the same root API to ESM and
CommonJS consumers.

### Identity helpers

```ts
import {
  generateSeed,
  keyPairFromSeed,
  parsePublicKey,
  parseSeed,
  publicKeyFromSeed
} from 'swarm-deploy'

const seed = generateSeed() // 32 random bytes
const restored = parseSeed(process.env.SEED!) // strict lowercase hex
const keyPair = keyPairFromSeed(restored)
const publicKey = publicKeyFromSeed(restored)
const peer = parsePublicKey(process.env.PEER_PUBLIC_KEY!)
```

`parseSeed` and `parsePublicKey` require exactly 64 lowercase hexadecimal
characters. `keyPairFromSeed` is deterministic.

`parseAllowlist(text)` parses lowercase client public keys separated by
newlines. Blank lines and lines beginning with `#` are ignored; malformed or
duplicate keys throw. It returns a `Set<string>` suitable for
`ServerOptions.allowedKeys`.

`fixedSeriesKey(template)` returns the series a template without `{series}`
persists, so an operator reading `fixed-…` in a commit sidecar, retention log,
or hook context can identify which configured pattern owns it:

```ts
import { fixedSeriesKey } from 'swarm-deploy'

const owner = patterns.find((template) => fixedSeriesKey(template) === record.release?.series)
```

### Server

```ts
import { Server, parsePublicKey } from 'swarm-deploy'

const server = new Server({
  seed: process.env.SWARM_DEPLOY_SERVER_SEED!,
  storageDir: '/srv/artifacts',
  allowedKeys: [
    parsePublicKey(process.env.CLIENT_A_PUBLIC_KEY!),
    parsePublicKey(process.env.CLIENT_B_PUBLIC_KEY!)
  ],
  maxFileBytes: 1024 ** 3,
  maxStagingBytes: 4 * 1024 ** 3,
  maxConnections: 64,
  maxActiveUploads: 8,
  idleTimeout: 60_000,
  cleanupInterval: 15 * 60_000,
  resumeTtl: 7 * 24 * 60 * 60_000,
  minFreeBytes: 1024 ** 3,
  maxAge: 15 * 24 * 60 * 60_000,
  maxStorageBytes: 100 * 1024 ** 3,
  replaceNames: ['release.tar.gz', 'latest.json']
})

await server.listen()
console.log(server.publicKey.toString('hex'))

// Later, after draining or on process shutdown:
await server.close()
```

Required `ServerOptions`:

- `seed: Buffer | string`
- `storageDir: string`
- `allowedKeys: Iterable<Buffer | string>`
- `maxFileBytes: number`
- `maxStagingBytes: number`

Optional operational limits and policies:

- `maxConnections`, `maxActiveUploads`, `idleTimeout`
- `cleanupInterval`, `resumeTtl`, `minFreeBytes`
- `maxAge`, `maxStorageBytes`, `replaceNames`
- `artifactPatterns?: Iterable<string>`, `maxCount?: number`,
  `maxVersions?: number`, and `versionGranularity?: 'major' | 'minor'`; see
  [Artifact patterns and rotation](#artifact-patterns-and-rotation).
- `hooks?: ServerHooks | null`; see [Deployment hooks](#deployment-hooks).

The root package exports the `ServerHooks`, `BeforeCommitContext`,
`AfterCommitContext`, `HookFailureContext`, `HookFailurePhase`, `HookArtifact`,
`ReleaseCoordinates`, and `VersionGranularity` types:

```ts
import type { ServerHooks } from 'swarm-deploy'

const hooks: ServerHooks = {
  async afterCommit({ artifact, path, alreadyCommitted }) {
    // Idempotent: skip work already recorded for artifact.transferId.
  },
  onFailure({ phase, path, error }) {
    console.error(phase, path, error)
  }
}
```

Advanced integration and test seams:

- `dht` or `dhtFactory` for an injected HyperDHT node.
- `storage` for a compatible filesystem adapter.
- `scheduler` for timeout and interval control.
- `logger` with optional `info`, `warn`, and `error` methods.

### Client

```ts
import { Client, parsePublicKey } from 'swarm-deploy'

const client = new Client({
  seed: process.env.SWARM_DEPLOY_CLIENT_SEED!,
  serverPublicKey: parsePublicKey(process.env.SWARM_DEPLOY_SERVER_KEY!),
  connectTimeout: 30_000,
  idleTimeout: 60_000
})

const result = await client.upload('./dist/release.tar.gz')
console.log(result.status, result.name, result.size)

await client.close()
```

`ClientOptions.seed` accepts a Buffer or canonical lowercase 64-character hex
string. `serverPublicKey` is a Buffer produced by `parsePublicKey`. Optional
values are `connectTimeout`, `idleTimeout`, `includeSourceParent`, `dht`,
`dhtFactory`, and `logger`.

`connectTimeout` defaults to 30 seconds. `idleTimeout` defaults to 60 seconds.
`includeSourceParent` defaults to `true`; set it to `false` to suppress the
[source parent](#source-parent) for every upload the client makes.
Calling `close()` aborts pending work, closes active sockets, and is idempotent.

### Upload results

A direct file resolves to:

```ts
interface UploadResult {
  status: 'COMMITTED' | 'ALREADY_COMMITTED'
  kind: 'file' | 'directory'
  name: string
  size: number
  digest: Buffer
  transferId: Buffer
  entryCount?: number
}
```

Files and directories share the same result shape. For a directory, `size` is
aggregate payload bytes and `entryCount` counts stored entries (files and
directories).

### Events

`Server` and `Client` are event emitters. Listener and logger exceptions are
contained and cannot change protocol correctness.

Public peer and transfer correlation fields use 12-character SHA-256
fingerprints. Events never expose seeds, secret keys, full remote public keys,
TAR contents, or resumable session material. Internal storage warnings may
include a full SHA-256 uploader fingerprint, but never the uploader key itself.

Server events:

- `authentication`: accepted client fingerprint.
- `connection`, `connection-open`, `connection-close`: authenticated connection
  lifecycle and current count.
- `offer`: accepted, resumed, reset, rejected, or already-committed state.
  Includes artifact `kind`.
- `progress`: durable TAR bytes received and total TAR bytes. Includes artifact
  `kind`.
- `verification`: started, succeeded, or failed.
- `commit`: succeeded or failed.
- `recovery`: startup, per-journal, corruption, resumable, and completion
  outcomes.
- `retention`: startup, scheduled, manual, commit, or post-commit outcomes,
  with `expiredSessions`, `scrubbed`, `ageDeleted`, `countDeleted`,
  `versionDeleted`, and `storageDeleted` counters.
- `failure`: stable failure code and peer fingerprint.
- `listening`: local server-key fingerprint.
- `close`: closed or failed outcome.

Client events:

- `connection`, `connection-open`, `connection-close`
- `offer`: offered, accepted, resumed, reset, rejected, or already committed.
- `progress`: cumulative TAR `bytesSent` and full `totalBytes`, including a
  durable resume offset.
- `verification`, `commit`
- `result`: terminal upload result with artifact `kind`.
- `failure`, `close`

Use the exported `ServerEventMap`, `ClientEventMap`, `ServerEventName`, and
`ClientEventName` types for event-name-specific payload narrowing:

```ts
client.on('progress', ({ name, bytesSent, totalBytes }) => {
  console.log(name, `${bytesSent}/${totalBytes}`)
})

server.on('recovery', (event) => {
  if (event.status === 'failed') console.error(event.phase, event.reason)
})
```

### Logging

Both constructors accept:

```ts
interface Logger {
  info?(message: string, details?: Record<string, unknown>): void
  warn?(message: string, details?: Record<string, unknown>): void
  error?(message: string, details?: Record<string, unknown>): void
}
```

Logger exceptions are ignored. Logger detail objects are diagnostic rather than
a stable ingestion schema; use typed event payloads or `SwarmDeployError.code`
for automation. Do not use fingerprints as credentials.

### Errors

Configuration, authentication, protocol, transfer, and managed-storage failures
generally reject with `SwarmDeployError`. Raw operating-system or adapter errors
may propagate while selecting or opening a local input, initializing or locking
the server storage root, or performing filesystem operations:

```ts
import { ERRORS, SwarmDeployError } from 'swarm-deploy'

try {
  await client.upload('./artifact.tgz')
} catch (error) {
  if (error instanceof SwarmDeployError) {
    console.error(error.code, error.message)
    if (error.code === ERRORS.CONNECT_TIMEOUT) {
      // Server could not be reached and authenticated before the deadline.
    }
  } else {
    console.error(error)
  }
}
```

`HOOK_FAILED` is the stable code for a failed `beforeCommit` or `afterCommit`
callback. Its message is fixed and the original exception is available only as
`cause` and to `onFailure`.

Stable codes include authentication and server-key rejection, invalid
configuration and protocol records, file and staging limits, disk reserve,
filename and replacement conflicts, checksum failures, connection or upload
timeouts, aborts, commit failures, cleanup failures, and managed-link failures
(`LINK_CONFLICT`, `LINK_FAILED`, `UNSUPPORTED_STORAGE`). A link reconciliation
failure after a durable commit behaves like other post-commit deployment
failures: the artifact stays committed, the client receives a stable failure,
and an already-committed retry reruns reconciliation before succeeding. Import
`ERRORS` rather than matching exception messages.

## Production operations

- Run the server under a dedicated non-root account.
- Restrict the server seed and storage root to that account.
- Supervise the process and wait for the final `ready` line before marking it
  healthy.
- Upgrade servers before clients; see
  [Rollout and compatibility](#rollout-and-compatibility).
- Restart with the same seed, allowlist, limits, replacement names, artifact
  patterns, rotation limits, hooks module, and storage root so interrupted sessions and commit journals can recover.
- Alert on nonzero CLI exits and failed authentication, recovery, verification,
  commit, retention, and cleanup events.
- Never edit `.swarm-deploy/` while the server is running.
- Stop the server cleanly before backing up or restoring the complete storage
  root.
- Publish stored artifacts through a separately configured artifact service or
  web server.
- Roll out an exact package version to a canary before wider deployment.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and operator
precautions.

## Contributor development

Production and tests are strict TypeScript. Build output is generated under
untracked `dist/` and `.test-dist/`. Tests generate binary payloads in temporary
directories and use an isolated local HyperDHT testnet, not the public DHT.

```sh
npm install
npm run build
npm run build:test
npm run test:types
npm run format:check
npm run lint
npm run test:node
npm run test:bare
npm run test:property
npm run test:package
npm run test:release-tag
```

Exercise the built CLI directly:

```sh
node dist/bin/swarm-deploy.js --help
bare dist/bin/swarm-deploy.js --help
```

## Release

Version tags use `v<package-version>`. The tag workflow validates the version,
builds the untracked distribution, checks package contents and types, and
publishes through the configured npm environment with provenance.

See [RELEASING.md](RELEASING.md) for the release and rollback procedure.

## Protocol specification

See [docs/spec/swarm-deploy.md](docs/spec/swarm-deploy.md) for the complete
transport, deterministic TAR, resumability, storage, replacement, recovery,
retention, threat-model, and package requirements.
