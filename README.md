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

## Features

- **Direct and authenticated:** a fresh direct HyperDHT connection per file, with
  Noise authentication and encryption, a pinned server key, and a static client
  allowlist. There is no topic or swarm discovery.
- **Resumable:** incomplete uploads keep durable TAR progress and resume after
  the client verifies the stored prefix.
- **Verified:** files and directories are sent as deterministic TAR and checked
  with SHA-256 before an explicit terminal `COMMITTED` result.
- **Safe storage:** names are create-only by default, named files can opt in to
  replacement with history, and unmanaged files are never overwritten or deleted.
- **Retention and rotation:** age and storage-quota limits, plus count and
  SemVer rotation driven by artifact patterns.
- **Managed symlinks:** automatic newest-match aliases and explicit client
  promotions such as `latest`.
- **Trusted hooks:** server-side `beforeCommit`, `afterCommit`, `afterLink`, and
  `onFailure` callbacks. The post-operation ones run after the answer (`detached`)
  unless declared `response`, in which case they are awaited and may add JSON to it.
- **CLI and API:** the `swarm-deploy` command and a strict-TypeScript API on
  Node.js and Bare.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Security and identity model](#security-and-identity-model)
- [Private state](#private-state)
- [Provision identities](#provision-identities)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [Examples](#examples)
- [Project documents](#project-documents)

## Requirements

- Node.js 22 or 24, or the current stable Bare runtime.
- A persistent server seed and at least one independently generated client seed.
- A dedicated output directory (`--storage`) and a private state directory on the
  same filesystem (see [Private state](#private-state)).
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

Operator essentials:

- Run the server under a dedicated non-root account with a dedicated storage
  root, and restrict the seed and private state directory to that account.
- Protect the startup allowlist as security-sensitive configuration.
- Never serve the private state directory, never edit it while the server is
  running, and stop the server cleanly before backing up or restoring the output
  root together with its state directory.
- Report vulnerabilities privately as described in
  [SECURITY.md](https://github.com/tetherto/swarm-deploy/blob/main/SECURITY.md).

## Private state

`--storage` is the output root. It holds published artifacts and managed public
links only, so a web server may serve it. Staging, sessions, commit and link
records, journals, locks, and reset archives are private state in a separate
directory:

- **Default:** `~/.swarm-deploy/<id>`, under the home directory of the user
  running the server, never the working directory. `<id>` is a hash of the real
  path of `--storage`, so every output root has its own state, and the same
  state is found again after a restart or through an alias of the path.
- **Override:** `--state-dir <absolute-dir>` (`ServerOptions.stateDir`), for
  example `/var/lib/swarm-deploy/artifacts`.
- **Same filesystem:** publication, link replacement, and retention use atomic
  renames and hard links between the output root and the state directory, so both
  must be on one filesystem. Otherwise the server refuses to start and tells you
  to pass `--state-dir`; there is no copy fallback. A home directory on another
  filesystem than `--storage` needs an explicit `--state-dir`.
- **Outside the root:** it cannot be the output root, inside it, above it, or
  reach it through a symlink, and its final directory cannot be a symlink.
  It is created, and kept, at mode `0700`, and it records the output root it
  serves, so it is never reused for another root.
- **One setting per root:** the lock lives in the state directory. Run the server
  and every `reset-storage` for one output root as the same user with the same
  `--state-dir` (or the same default). Instances with different state settings do
  not exclude each other.
- **Moving the root:** state is tied to the real path of the output root. After
  renaming or moving `--storage`, a default location would start empty and a custom
  `--state-dir` refuses the new path. To keep the state, stop the server, set
  `root` in the state directory's `.swarm-deploy-state.json` to the new real path,
  and pass that state directory as `--state-dir`. Edit it only when the state
  really belongs to the moved root.
- **Finding it:** the server logs `Private state directory` at startup, and
  `reset-storage` prints a `state:` line. Pass the same `--state-dir` to
  `reset-storage` that the server uses; it resolves the location exactly as the
  server does.

### Upgrading from 0.6.0 or earlier

Earlier releases kept this state in `<storage>/.swarm-deploy`, inside the output
root, where a web server that serves the root can expose it. This release refuses
to start, and `reset-storage` refuses to run, while that directory exists. It
never reads, moves, or deletes it. Migrate it offline:

1. Stop every server and `reset-storage` run for the root.
2. Run `swarm-deploy server …` with your usual options once. It exits with the
   exact command for your resolved state location, shaped like:

   ```sh
   mkdir -p "$HOME/.swarm-deploy" && mv /srv/artifacts/.swarm-deploy "$HOME/.swarm-deploy/<id>"
   ```

   The destination must not exist yet and must be on the same filesystem as the
   output root. Add `--state-dir` to every command to choose another location.

3. Run the command, then start the server with the same `--state-dir` (or none).
   Ownership and recovery data move with the directory, intact.

To roll back, stop the server, move the directory back to
`<storage>/.swarm-deploy`, and start the previous release.

If you delete `<storage>/.swarm-deploy` instead, the next start creates fresh
state. Ownership and recovery data cannot be restored automatically: unfinished
uploads start over, existing artifacts become unmanaged (their names stay
occupied until you remove them), and managed links lose their ownership records.

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

## Documentation

The detailed guides live in `docs/` in the repository and are not included in
the npm package, so these links point to GitHub.

- [CLI reference](https://github.com/tetherto/swarm-deploy/blob/main/docs/cli.md):
  every command and option (`keygen`, `public-key`, `server`, `upload`, `link`,
  `reset-storage`), seed sources, exit codes, and a
  [CI uploader example](https://github.com/tetherto/swarm-deploy/blob/main/docs/cli.md#ci-uploader-example).
- [Runtime API](https://github.com/tetherto/swarm-deploy/blob/main/docs/api.md):
  identity helpers, `Server`, `Client`, link and upload results, events,
  logging, and errors.
- [Operations, storage, and rollback](https://github.com/tetherto/swarm-deploy/blob/main/docs/operations.md):
  the production checklist, transfer and resume behavior, storage, replacement,
  and retention, resetting a storage root, and rollout, compatibility, and
  rollback.
- [Artifact patterns and rotation](https://github.com/tetherto/swarm-deploy/blob/main/docs/artifact-patterns.md):
  pattern templates, source parent, mandatory matching, and count and version
  rotation.
- [Managed symlinks](https://github.com/tetherto/swarm-deploy/blob/main/docs/managed-links.md):
  automatic and manual links, ownership rules, removal, and the promotion
  workflow.
- [Deployment hooks](https://github.com/tetherto/swarm-deploy/blob/main/docs/hooks.md):
  response and detached hooks, lifecycle points, invocation sequences, link
  publication, `onFailure`, hook modules, and the 0.6.0 migration.
- [Protocol specification](https://github.com/tetherto/swarm-deploy/blob/main/docs/spec/swarm-deploy.md):
  the complete transport, deterministic TAR, resumability, storage,
  replacement, recovery, retention, threat-model, and package requirements.

## Examples

[`examples/link-publisher`](https://github.com/tetherto/swarm-deploy/tree/main/examples/link-publisher)
is a runnable, Node-only `afterLink` hooks module and publisher. See
[Link publication hooks](https://github.com/tetherto/swarm-deploy/blob/main/docs/hooks.md#link-publication-hooks)
for how it behaves.

## Project documents

- [Contributing](https://github.com/tetherto/swarm-deploy/blob/main/docs/contributing.md):
  build, test, and lint commands.
- [RELEASING.md](https://github.com/tetherto/swarm-deploy/blob/main/RELEASING.md):
  the release and rollback procedure. Version tags use `v<package-version>`.
- [SECURITY.md](https://github.com/tetherto/swarm-deploy/blob/main/SECURITY.md):
  vulnerability reporting and operator precautions.
- [CHANGELOG.md](https://github.com/tetherto/swarm-deploy/blob/main/CHANGELOG.md):
  release history.
- [LICENSE.md](https://github.com/tetherto/swarm-deploy/blob/main/LICENSE.md):
  Apache-2.0.
