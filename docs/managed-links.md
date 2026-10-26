# Managed symlinks

Managed symlinks support both automatic newest-match aliases and explicit
client promotions. Back to the [README](../README.md).

## Contents

- [Configuring managed links](#configuring-managed-links)
- [Selection and ownership rules](#selection-and-ownership-rules)
- [Removing a managed link](#removing-a-managed-link)
- [Safe promotion workflow](#safe-promotion-workflow)
- [Link requests and hooks](#link-requests-and-hooks)

Related guides: the [CLI reference](cli.md) for `--symlink` and
`swarm-deploy link`, [deployment hooks](hooks.md) for `afterLink`,
[artifact patterns and rotation](artifact-patterns.md) for how linked targets
are pinned against retention, the [runtime API](api.md) for `Client.link`, and
[Managed-link rollback warning](operations.md#managed-link-rollback-warning).

## Configuring managed links

Configure either form with repeatable `--symlink` options:

```sh
swarm-deploy server \
  --seed-file ./server.seed \
  --storage /srv/artifacts \
  --allow-key <64-lower-hex> \
  --max-file-bytes 1073741824 \
  --max-staging-bytes 4294967296 \
  --symlink '/^\d+\.\d+\.\d+$/' newest \
  --symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/'
```

The two-argument rule automatically reconciles `newest` to the newest matching
artifact. The one-argument rule is a target allowlist: it creates no link until
an authenticated client explicitly chooses a matching current artifact:

```sh
swarm-deploy link --seed-file ./client.seed --server-key "$SERVER_KEY" \
  app-2.4.1.tar.gz latest-app

# app-2.4.1.tar.gz is the tested target
# output: latest-app -> app-2.4.1.tar.gz LINKED
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
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'newest' },
    { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/' }
  ]
})
```

## Selection and ownership rules

Selectors are exact safe managed-artifact basenames or unflagged `/regex/`
expressions. Automatic selection uses only validated managed commit records.
The newest `committedAt` wins, tie-broken by transfer ID then name; replacement
history never matches, and a rule is dormant until a target exists. Automatic
link names are unique and reserved even while their rule is dormant, so a
manual request cannot claim one.

Manual targets must be current managed top-level files or directories, must
match a one-argument rule, and cannot be history names. Manual link names are
safe top-level basenames and cannot equal the target, an automatic link name,
or any managed artifact name. A missing destination may be created, and an
existing manual managed link may be repointed. An unmanaged file, directory,
unrecorded symlink, changed symlink, or foreign ownership record is never
replaced, moved, or deleted: the operation fails closed.

Manual links retain their selected target across restart and automatic
reconciliation. Removing their authorization rule prevents future requests
that need that rule but does not remove or rewrite the existing link.
Automatic and manual targets are pinned against age, count, SemVer, and quota
retention and still count toward those limits. Reconciliation and manual
mutation run under the storage-root lease, and uploads cannot claim any
persisted managed-link name.

## Removing a managed link

There is no unlink RPC. To remove a managed link safely, stop the server,
remove the visible symlink and its matching
`.swarm-deploy/links/<sha256(link-name)>.json` ownership record, then restart
the server. Never edit the ledger while the server runs. Removing all automatic
rules intentionally reconciles proven stale automatic links away; malformed or
conflicting ledgers still fail closed on the default symlink-capable storage.

## Safe promotion workflow

1. Upload a versioned artifact such as `app-2.4.1.tar.gz`.
2. QA that exact version through its deployed versioned URL.
3. Run `swarm-deploy link app-2.4.1.tar.gz latest` to point `latest` at the
   tested artifact.

## Link requests and hooks

The explicit link operation is a control request, not an upload. It supports
files and directories and is idempotent. It runs none of the upload hooks
(`beforeCommit`, `afterCommit`), but a server with an `afterLink` hook runs it
after the link is durable and before the result is returned; see
[Link publication hooks](hooks.md#link-publication-hooks).

`symlinks` requires `StorageAdapter.symlink` and `readlink`; the Node and Bare
default adapters provide them; a custom adapter without symlink rules stays
source-compatible.
