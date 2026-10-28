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
[artifact patterns and rotation](artifact-patterns.md) for the retention stages
and post-commit rotation ordering (the rule that pins link targets against
retention is under
[Selection and ownership rules](#selection-and-ownership-rules)), the
[runtime API](api.md) for `Client.link`, and
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
existing manual managed link may be repointed.

**Taking over an existing symlink.** An explicit manual request may also take
over a symlink at the requested name that has no ownership record, for example
one created by hand before the storage root was managed. It happens only after
the target and name pass every check above: the symlink itself is replaced
atomically by the requested link and a manual ownership record is written. The
first such request returns `LINKED`, even if the old link already read as the
target, and repeats return `UNCHANGED`. The old link is never followed, so
whatever it pointed at (an older legacy directory, a dangling, absolute, or
outside path, another symlink) is neither inspected, modified, nor imported, and
no commit metadata is invented for it. Only symlinks are taken over.

Everything else still fails closed and is never replaced, moved, or deleted: an
unmanaged file or directory, a symlink whose ownership record is automatic,
version 1, malformed, or foreign, a manual link that was changed externally
since it was recorded, and any automatic link name. Automatic rules and server
startup never take over an unrecorded symlink.

Immediately before the swap the server re-checks that the destination is still
the same symlink (same text, and same inode where the storage reports one) with
no ownership record, and fails closed otherwise. That is not an atomic
compare-and-swap, which the storage adapter does not offer: a process that edits
the storage root while the server runs can still have its change replaced in
that window, so do not edit a running server's storage root. If the server stops
after the swap and before the record is written, repeat the same request: it
takes the link over again and returns `LINKED`. A failing `afterLink` hook
leaves the taken-over link in place only when the request asked to `keep` it, and
the retry then returns `UNCHANGED`. By default the old symlink comes back with its
exact text and the retry returns `LINKED` (see
[Rollback and its limits](hooks.md#rollback-and-its-limits)).

**Case-insensitive volumes.** Ownership records are keyed by the exact spelling
of a link name, but on a case-insensitive filesystem (the default on macOS and
Windows) `Latest` and `latest` are one directory entry. A request for another
spelling of a recorded link, automatic or manual, is therefore never treated as
an unrecorded symlink: before the swap the server requires the entry to be listed
in the root under exactly the requested spelling and compares its inode with that
of every protected name that differs only in case (each recorded link, each
configured automatic link name even while its rule is dormant, and each managed
artifact), and fails with `LINK_CONFLICT` if one resolves to the same entry. This
also covers a recorded link that someone renamed in case outside the server, and
it fails closed if the storage reports no inode identities while such a protected
variant exists. On a case-sensitive filesystem, `latest` and `Latest` are
distinct entries and stay independent.

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

A link request that is waiting for its hook, or whose restore could not be
finished, also has a rollback journal, `.swarm-deploy/links/<sha256(link-name)>.rollback.json`.
It is removed by the server when the request is finalized or restored, and a
server stopped normally leaves none. If one remains because the link or record was
changed from outside, or the journal itself was edited, requests for that name fail with `LINK_FAILED` and the
journal keeps the artifacts it names from retention. After making the symlink and
its ownership record what you want, stop the server and remove that one journal
file; do not edit it.

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
[Link publication hooks](hooks.md#link-publication-hooks). If that hook fails, the
previous link and ownership record are restored by default, or kept with
`swarm-deploy link --hook-failure keep` (`hookFailure: 'keep'`). Requests for one
link name run one at a time, from decision through hook to finalize or restore,
while other links, uploads, and retention carry on. A request can also ask for the
JSON object the hook returned (`swarm-deploy link --json`, or
`Client.link(target, name, { hookResult: true })`); that needs a server of
version 0.5.0 or later, and the failure policy needs 0.6.0 or later.

`symlinks` requires `StorageAdapter.symlink` and `readlink`; the Node and Bare
default adapters provide them; a custom adapter without symlink rules stays
source-compatible.
