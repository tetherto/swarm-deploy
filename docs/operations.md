# Operations, storage, and rollback

How to run a Swarm Deploy server, how uploads are stored and retained, how to
reset a storage root, and how to upgrade or roll back. Back to the
[README](../README.md).

## Contents

- [Production operations](#production-operations)
- [Transfer and resume behavior](#transfer-and-resume-behavior)
- [Storage, replacement, and retention](#storage-replacement-and-retention)
- [Resetting storage with `reset-storage`](#resetting-storage-with-reset-storage)
- [Rollout and compatibility](#rollout-and-compatibility)
  - [Managed-link rollback warning](#managed-link-rollback-warning)
  - [Link hooks and compatibility](#link-hooks-and-compatibility)
  - [Overlapping retries now get `FILE_BUSY`](#overlapping-retries-now-get-file_busy)
  - [Enabling or changing patterns](#enabling-or-changing-patterns)
  - [Session records and rollback](#session-records-and-rollback)

Related guides: [CLI reference](cli.md),
[artifact patterns and rotation](artifact-patterns.md),
[managed symlinks](managed-links.md), [deployment hooks](hooks.md), the
[runtime API](api.md), and the
[protocol specification](spec/swarm-deploy.md). Package releases and their
rollback procedure are in [RELEASING.md](../RELEASING.md).

## Production operations

- Run the server under a dedicated non-root account.
- Restrict the server seed and storage root to that account.
- Supervise the process and wait for the final `ready` line before marking it
  healthy.
- Upgrade servers before clients; see
  [Rollout and compatibility](#rollout-and-compatibility).
- Restart with the same seed, allowlist, limits, replacement names, artifact
  patterns, rotation limits, hooks module, and storage root so interrupted
  sessions and commit journals can recover.
- Alert on nonzero CLI exits and failed authentication, recovery, verification,
  commit, retention, and cleanup events.
- Never edit `.swarm-deploy/` while the server is running.
- To start a storage root over, stop the server, preview with
  `swarm-deploy reset-storage --storage <dir>`, remove leftover visible
  payloads and symlinks by hand if a true empty start is wanted, then run it
  again with `--apply`; see
  [`reset-storage`](#resetting-storage-with-reset-storage).
- Stop the server cleanly before backing up or restoring the complete storage
  root.
- Publish stored artifacts through a separately configured artifact service or
  web server.
- Roll out an exact package version to a canary before wider deployment.

See [SECURITY.md](../SECURITY.md) for vulnerability reporting and operator
precautions.

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
while the server is running. `.swarm-deploy/archive/` holds the archives
written by [`reset-storage`](#resetting-storage-with-reset-storage); the server
ignores it.

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
  [Artifact patterns and rotation](artifact-patterns.md).
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

## Resetting storage with `reset-storage`

```sh
swarm-deploy reset-storage --storage <directory>
swarm-deploy reset-storage --storage <directory> --apply [--wait <milliseconds>]
```

Archives every piece of private server state under one storage root so the
next server start begins with empty metadata. Use it after deleting committed
payloads by hand, or whenever leftover sessions, journals, staging files, the
managed-link ledger, trash, or lock residue should stop influencing a server.
It needs no seed and never contacts the network.

Without `--apply` the command is a read-only preview: it creates, moves,
locks, and deletes nothing, and prints one `key: value` line per fact:

```text
storage: /srv/artifacts
lock: free
commits: 3 records (2 missing payloads)
staging: 1 entries
sessions: 1 entries
journals: 0 entries
publications: 0 entries
links: 1 records
trash: 0 entries
obsolete locks: 2
archives: 0
remaining payloads: 1 (app-2.4.1.tar.gz)
remaining symlinks: 1 (latest)
fresh start: no
note: remaining payloads keep their names occupied; uploading the same name returns FILE_EXISTS until you remove them manually
note: remaining symlinks have no ownership record after the reset; an automatic --symlink rule for that name fails closed with LINK_CONFLICT until you remove them manually, while an explicit link request replaces them
result: preview only, nothing changed; re-run with --apply to archive this metadata
```

With `--apply` the command takes the storage lock, moves
`.swarm-deploy/staging`, `sessions`, `commits`, `journals`, `publications`,
`links`, and `trash` plus retired or abandoned lock directories into
`.swarm-deploy/archive/reset-<timestamp>-<random>/`, recreates the seven
directories empty, writes a `reset.json` marker with `status: "completed"`,
releases the lock, and prints the same report followed by `archive: <path>`.
Every move is a rename inside the storage root,
so nothing is copied, nothing is deleted, and an archive is restored by
stopping the server and moving its directories back over the empty ones.
Each completed reset creates its own archive; earlier archives, unrecognised
files inside `.swarm-deploy/`, and everything visible in the root are left
untouched.

What the reset does not do, and the report says so:

- It never removes visible payloads, `history-*` files, directories, or
  symlinks from the root. A remaining payload keeps its name occupied, so a
  fresh upload of that name returns `FILE_EXISTS`. A remaining symlink loses
  its ownership record, so an automatic `--symlink` rule for that name fails
  closed with `LINK_CONFLICT`, while an explicit `link` request replaces it
  (see [Managed symlinks](managed-links.md)). `fresh start: yes` is
  printed only when the root holds nothing besides `.swarm-deploy/`; remove
  leftovers by hand before or after the reset to get there.
- It never signals a process. The lock records only a PID, and a PID proves
  nothing about which program owns it, so the reset cannot verify that a live
  holder is the server for this exact root. A live holder makes `--apply`
  fail closed with exit `1` and the PID. Stop that server yourself (the CLI
  server shuts down cleanly on `SIGINT` or `SIGTERM`) and re-run, or pass
  `--wait <milliseconds>` so the reset polls until the holder releases the
  lock, then proceeds with exclusive access. A holder whose PID no longer
  exists is retired and archived automatically.
- A live PID can belong to an unrelated process after a crash. The command
  cannot prove that, and offers no PID override. An unreadable lock also
  refuses reset because it may hide a live server. Stop the service and
  reconcile its lock before trying again.

Startup recovery already drops a commit record whose payload is gone, so a
missing payload alone does not need a reset. The reset is for clearing the
rest of the private state at once, with an archive to fall back on.

An interrupted `--apply` leaves a partly filled archive and a
`.swarm-deploy/reset-pending.json` marker that names it. This holds for a
crash, kill, or power loss as well as for an error, because every move is a
single rename and the archive directory itself is the record of what moved.
This version of the server refuses startup while that marker exists, before
metadata recovery. Stop any service supervisor before maintenance; older
server versions do not know this guard.

Re-run `--apply` to finish. The retry resumes the archive the marker names
instead of starting a second one: it reads what that archive physically holds,
moves only the directories still live, recreates them empty, and rewrites
`reset.json` with `status: "completed"`. The output then says `resumed: yes`
and names what the archive already held. One reset therefore always ends as
exactly one archive, and restoring that archive restores everything the reset
moved.

`reset.json` is a bounded record, no matter how many retired locks a stopped
server left behind or how many times a reset is retried. The restore evidence
is the archive itself, and the marker keeps only a summary of it:

- `version`: `2`. Version 1 markers stay readable.
- `status`, `root`, `completedAt`, and the first attempt's `startedAt` and
  `pid`.
- `moved`: the metadata directories the archive holds, at most seven names.
- `locks`: `count` and `sha256` for the retired and abandoned lock directories
  in the archive's `locks/` directory. The names stay there; the digest is
  over each sorted name followed by a newline, so
  `ls <archive>/locks | LC_ALL=C sort | sha256sum` (`shasum -a 256` on macOS)
  reproduces it and shows whether anything was removed from the archive by
  hand.
- `attempts` and `attemptCount`: the newest 16 attempts with their
  `startedAt`, `pid`, and any `failed` reason clipped to 256 characters, and
  the total number of attempts, which links an interrupted run to each retry.

An archive written by an earlier build has a version 1 marker that listed every
lock directory by name. It stays readable and a completed one is never touched.
When a retry resumes an interrupted one, the original marker is first copied
verbatim to `reset.v1.json` in the archive, so its full list is kept, and then
`reset.json` is rewritten in the bounded format.

While a reset is interrupted, trust the archive directory over `reset.json`:
its counts can lag the last move after a hard stop. The preview prints
`reset pending: yes (resumes archive <name>)` and, for each interrupted
archive, `interrupted archive: <name> holds <entries>` read from the
filesystem, with lock directories counted rather than listed. The retry fails
closed with exit `2` and moves nothing if the
archive and the live directory both hold data for the same entry, or if the
pending marker names an archive that is missing, symlinked, or unreadable. In
either case reconcile by hand, keeping the archive, and remove
`reset-pending.json` only once the metadata is in the state you want. Archives
from other resets are never modified or deleted.

Run `reset-storage` as the same operating-system user that runs the server.
`--apply` recreates the metadata directories, the archive, and its marker with
that user's ownership and mode `0700`. Applied as `root` (for example with plain
`sudo`) to a root owned by a service account, it leaves metadata the service
cannot read or write, and the server cannot start. Run the preview as the
service user too, so it sees the permissions the server will. With a service
account named `artifacts` (replace it with yours):

```sh
sudo -u artifacts -- swarm-deploy reset-storage --storage /srv/artifacts
sudo -u artifacts -- swarm-deploy reset-storage --storage /srv/artifacts --apply --wait 60000
```

Use the full path to `swarm-deploy` if it is not on that account's `PATH`. The
command does not check which user runs it. If it was applied as the wrong user,
stop the service, return ownership of the internal directory, and start it
again:

```sh
sudo chown -R artifacts:artifacts /srv/artifacts/.swarm-deploy
```

The report is refreshed after acquiring the lock, so an upload completed while
`--wait` was waiting appears among the retained payloads.

A symlinked storage root or ancestor, a symlinked `.swarm-deploy/`, a metadata
directory replaced by a symlink or file, a filesystem root, a missing root, or
a root without `.swarm-deploy/` is rejected before any metadata is moved. Use
the canonical storage path (for example `/private/tmp` rather than macOS's
`/tmp` alias). A malformed pending-reset marker is also refused for manual
reconciliation.

## Rollout and compatibility

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

### Managed-link rollback warning

**Do not roll a server back to v0.2.0 after an upgraded server has created,
repaired, or repointed any managed link.** Those operations write a v2
ownership record, which v0.2.0 cannot read. Rollback requires restoring the
complete pre-upgrade storage backup (including visible links and
`.swarm-deploy/links`), or keeping the upgraded server in place.

`swarm-deploy link` requires an upgraded server; v0.2.0 does not recognize
link control requests.

### Link hooks and compatibility

`afterLink` is optional and adds no wire format, persisted state, or dependency.
A failed hook reaches every client as the existing stable `HOOK_FAILED` code in
the ordinary `FAILED` link result (or upload final or admission record), which
older clients already decode, so clients need no upgrade. Only the CLI
differs: `swarm-deploy link` prints `HOOK_FAILED` from this version on, and an
older CLI prints a generic message for the same failure. A server without
`afterLink` behaves exactly as before, including `afterCommit` ordering and its
deferred retention. Configuring `afterLink` defers the post-commit retention
pass the same way `afterCommit` does (see
[Artifact patterns and rotation](artifact-patterns.md#selection-rules)). Nothing
needs rolling back: removing the hook returns the server to the previous
behavior.

Returning data from `afterLink` is a separate, opt-in addition (0.5.0): a
client asks for it with `Client.link(..., { hookResult: true })` or
`swarm-deploy link --json`, and only then does the link request and answer carry
one extra field. Servers must be upgraded before clients that ask, because a
server older than 0.5.0 rejects the opted-in request. Clients that do not ask,
including every older client and CLI, see the unchanged request and answer
whatever the hook returns, so no client needs to change. Nothing is stored and no
dependency is added.

### Link hook failure policy

**Behavior change (0.6.0).** When an explicit link request's `afterLink` hook
fails, the server now restores the previous local symlink and its ownership
record (or removes a link the request created) before answering `HOOK_FAILED`;
until 0.5.x the new link stayed. A request opts out with `hookFailure: 'keep'`
(`swarm-deploy link --hook-failure keep`). The hook is still awaited in both
modes, a failure is still `HOOK_FAILED`, the uploaded artifact and anything the
hook did elsewhere are never undone, and an upload's automatic links are
unchanged.

- **Upgrade servers first.** Current clients and the CLI always send the policy,
  which a server older than 0.6.0 rejects, so a new client against an old server
  fails instead of keeping a link it expected to be rolled back. Older clients
  against a 0.6.0 server send no policy and are handled as `rollback`: for them
  the default changed, and the retry after a failed hook now reports `LINKED`
  rather than `UNCHANGED`. Automation that relied on the link surviving a failed
  hook should pass `keep`.
- **Persisted state.** A request that changes a link writes a journal,
  `.swarm-deploy/links/<sha256(link-name)>.rollback.json` (at most 32 KiB), before
  it changes anything, and removes it when the request is finalized or restored.
  An idle, normally stopped server has none. After a crash the next start restores
  the previous link and record before retention runs or any client connects, and
  logs `Restored a managed link after an unfinished request` with the link name.
  If the link or record was changed from outside in the meantime, that name is
  left alone and blocked (`Managed link rollback is blocked by a change made
since`), its artifacts stay pinned, and the rest of the server starts; see
  [Removing a managed link](managed-links.md#removing-a-managed-link) for how to
  clear it. A corrupt journal stops the server from starting.
- **Rolling back the server** to a version before 0.6.0 is safe once no journal
  remains (stop the server normally and check `.swarm-deploy/links`): an older
  server ignores the file and cannot restore a link whose request was interrupted.
- **Time.** Requests for one link name now queue from decision through hook to
  finalize or restore, so a slow hook delays later requests for the same name
  (they still wait at most the client's idle timeout) while other links, uploads,
  and retention are unaffected.

### Overlapping retries now get `FILE_BUSY`

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

### Enabling or changing patterns

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

### Session records and rollback

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
