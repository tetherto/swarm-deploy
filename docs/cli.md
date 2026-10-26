# CLI reference

Reference for the `swarm-deploy` command line. Back to the [README](../README.md).

## Contents

- [`keygen`](#keygen)
- [`public-key`](#public-key)
- [`server`](#server)
- [`upload`](#upload)
- [`link`](#link)
- [`reset-storage`](#reset-storage)
- [Seed sources](#seed-sources)
- [CLI exit codes](#cli-exit-codes)
- [CI uploader example](#ci-uploader-example)

Related guides: [artifact patterns and rotation](artifact-patterns.md),
[managed symlinks](managed-links.md), [deployment hooks](hooks.md),
[operations and storage](operations.md), and the [runtime API](api.md).

## `keygen`

```sh
swarm-deploy keygen --out <seed-file>
```

Creates a new seed file with owner-only permissions and prints its public key.
The destination must not already exist.

## `public-key`

```sh
swarm-deploy public-key --seed-file <seed-file>
swarm-deploy public-key --seed <64-lower-hex>
```

Reads a seed file or canonical seed string and prints its public key.

## `server`

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
  [--symlink <selector> [<link-name>]]... \
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
  See [Artifact patterns and rotation](artifact-patterns.md).
- `--max-count <count>`: keep the newest `<count>` releases per series. Requires
  at least one `--artifact-pattern`.
- `--max-versions <count>`: keep every release in the newest `<count>` distinct
  version groups per series. Requires a pattern containing `{version}` and
  `--version-granularity`.
- `--version-granularity <major|minor>`: how versions are grouped for
  `--max-versions`. It is rejected without `--max-versions`, and there is no
  default.
- `--symlink <selector> [<link-name>]`: repeatable managed-symlink policy.
  With two arguments, the server automatically points `<link-name>` at the
  newest matching managed artifact. With one argument, the rule creates no
  link by itself; it authorizes authenticated clients to choose any matching
  current managed artifact as a manual-link target. A selector that begins and
  ends with `/` is an unflagged regular expression matched against managed
  artifact basenames; anything else is an exact managed basename. See
  [Managed symlinks](managed-links.md).
- `--hooks <module>`: JavaScript module (`.js`, `.mjs`, or `.cjs`) exporting
  trusted lifecycle callbacks. The path is resolved against the working
  directory. See [Deployment hooks](hooks.md).

All counts are positive safe integers. Invalid combinations, malformed or
duplicate templates, and unloadable hook modules are configuration errors that
exit `2` before the server listens. Each hooks-module error names only the
module basename with a fixed reason, never module content.

The CLI requires at least one `--allow-key`. Its snapshot is immutable for the
life of the process.

## `upload`

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
  component (see [Source parent](artifact-patterns.md#source-parent)).
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

## `link`

```sh
swarm-deploy link \
  --seed-file <seed-file> \
  --server-key <64-lower-hex> \
  [--idle-timeout <milliseconds>] \
  <target> <link-name>
```

Replace `--seed-file <seed-file>` with `--seed <64-lower-hex>`, or use
`SWARM_DEPLOY_CLIENT_SEED`, exactly as for `upload`. `--server-key` pins the
server identity, and `--idle-timeout` has the same 60-second default and
inactivity semantics as upload.

The command asks the authenticated server to point `<link-name>` at the
existing managed file or directory `<target>`. The target must match a
one-argument `--symlink` rule. Success prints exactly:

```text
<link-name> -> <target> <LINKED|UNCHANGED>
```

`LINKED` means the link was created or repointed. `UNCHANGED` means the same
managed link already points at that target; the operation is idempotent.

When the server has an `afterLink` hook, success is printed only after the hook
returns, for as long as `--idle-timeout` allows. If the hook fails, the command
exits `1` and prints `HOOK_FAILED`; the link itself has already changed, and
running the same command again is safe and re-runs the hook. A hook slower than
`--idle-timeout` makes the command fail with a timeout instead, though the
server still finishes the hook (see
[Link publication hooks](hooks.md#link-publication-hooks)). The rules behind
manual links are in [Managed symlinks](managed-links.md).

## `reset-storage`

```sh
swarm-deploy reset-storage --storage <directory>
swarm-deploy reset-storage --storage <directory> --apply [--wait <milliseconds>]
```

Archives every piece of private server state under one storage root so the
next server start begins with empty metadata. It needs no seed and never
contacts the network.

- Without `--apply` the command is a read-only preview: it creates, moves,
  locks, and deletes nothing.
- `--apply` takes the storage lock and moves the metadata directories into a
  new `.swarm-deploy/archive/reset-<timestamp>-<random>/` directory. Nothing is
  copied or deleted.
- `--wait <milliseconds>` makes `--apply` poll until a live lock holder
  releases the lock instead of failing closed immediately.

The full behavior, the preview report, interruption recovery, the `reset.json`
marker, and the required operating-system user are described in
[Resetting storage with `reset-storage`](operations.md#resetting-storage-with-reset-storage).

## Seed sources

Server, upload, and link commands accept exactly one of:

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

## CLI exit codes

- `0`: the upload committed or was already committed, the link is linked or
  unchanged, or the storage reset preview or apply finished.
- `1`: upload, network, protocol, storage, cleanup, or runtime failure,
  including a storage reset refused because a running server holds the lock.
- `2`: usage or configuration error, including an unsafe or uninitialized
  storage root.

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
