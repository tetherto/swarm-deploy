# Operations, storage, and rollback

How to run a Swarm Deploy server, how uploads are stored and retained, how to
reset a storage root, and how to upgrade or roll back. Back to the
[README](../README.md).

## Contents

- [Production operations](#production-operations)
- [Troubleshooting failed uploads](#troubleshooting-failed-uploads)
- [Transfer and resume behavior](#transfer-and-resume-behavior)
- [Storage, replacement, and retention](#storage-replacement-and-retention)
- [Resetting storage with `reset-storage`](#resetting-storage-with-reset-storage)
- [Rollout and compatibility](#rollout-and-compatibility)
  - [Private state moved out of the storage root (0.6.1)](#private-state-moved-out-of-the-storage-root-061)
  - [Shutdown cleanup hook (0.6.2)](#shutdown-cleanup-hook-062)
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
- Restrict the server seed and the private state directory to that account. The
  state directory (default `~/.swarm-deploy/<id>`, or `--state-dir`) must never
  be served and must be on the same filesystem (and, on Linux, the same mount)
  as the storage root; see [Private state](../README.md#private-state).
- Supervise the process and wait for the final `ready` line before marking it
  healthy.
- Upgrade servers before clients; see
  [Rollout and compatibility](#rollout-and-compatibility).
- Restart with the same seed, allowlist, limits, replacement names, artifact
  patterns, rotation limits, hooks module, storage root, and state directory (the
  same `--state-dir`, or the same user's default) so interrupted sessions and
  commit journals can recover. Every server and `reset-storage` run for one
  storage root must use the same user, `HOME`, and state settings: the lock lives
  in the state directory, so it only excludes instances that share it. Keep
  `--initialize-state` out of normal startup; it is a one-time acknowledgement for
  new, migrated, or restored state, and state already bound to the root needs it
  never. Alert on a logged `Legacy private state reappeared` error: an older
  release or another writer is using the root, and the server refuses new work.
- Alert on nonzero CLI exits and failed authentication, recovery, verification,
  commit, retention, and cleanup events.
- Never edit the private state directory while the server is running.
- To start a storage root over, stop the server, preview with
  `swarm-deploy reset-storage --storage <dir> [--state-dir <dir>]`, remove
  leftover visible payloads and symlinks by hand if a true empty start is wanted,
  then run it again with `--apply`; see
  [`reset-storage`](#resetting-storage-with-reset-storage).
- Stop the server cleanly before backing up or restoring the storage root
  together with its state directory.
- Publish stored artifacts through a separately configured artifact service or
  web server.
- Roll out an exact package version to a canary before wider deployment.

See [SECURITY.md](../SECURITY.md) for vulnerability reporting and operator
precautions.

## Troubleshooting failed uploads

A failed `swarm-deploy upload` or `link` (exit `1`) is one of two kinds, and
the output says which (see [Failure output](cli.md#failure-output) and
[Errors](api.md#where-a-client-failure-came-from-063)).

**The server answered.** The message, or for `link` the printed line, carries a
stable code, and `--json` reports `"origin": "server"`. The code is the server's
own, and its log has a matching `Direct upload failed` or `Direct link failed`
warning with the same `reason` (the answer never carries the server's raw error,
paths, or hook output; the log is where to look for those).

| Code                                   | Usually means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISK_RESERVE`                         | Less free space than the reserve plus the upload needs (default reserve 1 GiB), measured where the private state's staging is; or, from 0.6.3, an upload write that failed with a raw `ENOSPC`/`EDQUOT` the server did not wrap.                                                                                                                                                                                                                                                              |
| `STAGING_LIMIT`                        | Staged data would exceed `--max-staging-bytes`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FILE_TOO_LARGE`                       | The artifact exceeds `--max-file-bytes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `FILE_EXISTS`                          | The name already holds different content and is not a `--replace-name`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ACTIVE_UPLOAD_LIMIT`, `FILE_BUSY`     | The server is at its upload limit, or the same transfer is already running; retry later.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HOOK_FAILED`                          | A deployment hook failed; the log has the reason, and the artifact may already be committed.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COMMIT_FAILED`, `UNSUPPORTED_STORAGE` | The server could not write or commit. For an upload, a raw errno the server did not wrap maps here: permissions (`EACCES`, `EPERM`), a read-only volume (`EROFS`), an I/O error (`EIO`), or storage that cannot do the operation (`EXDEV`, `ENOSYS`, `ENOTSUP`, as `UNSUPPORTED_STORAGE`). The log names the errno as `systemCode`. The same errno inside a storage guard shows as `PROTOCOL_INVALID` instead.                                                                                |
| `SERVER_ERROR`                         | An upload hit a raw error the server did not expect and did not wrap (0.6.3 or newer). The log has `reason: SERVER_ERROR` and the `phase`. Link requests do not use it.                                                                                                                                                                                                                                                                                                                       |
| `PROTOCOL_INVALID`                     | A protocol check or a storage-state check failed on the server: a malformed record, a mismatched transfer ID, a field this server does not know, legacy state in the root, or a storage guard that wrapped a raw failure (for example it could not open or check a staging file or directory). It does not by itself say the request or the client version was at fault; the log's `phase` and `systemCode` say more. Through 0.6.2 it was also what any unwrapped raw upload error reported. |
| `LINK_*`                               | See the server log; a link request's unclassified failure is `LINK_FAILED`.                                                                                                                                                                                                                                                                                                                                                                                                                   |

Freeing space or raising a limit and retrying is safe: a retry resumes or
starts over and never publishes a partial artifact. Reporting the code does not
create capacity, and nothing here changes what the server stores or deletes.

**`DISK_RESERVE` and what it counts (0.7.0).** Admission needs the free space where
the private state's staging is to cover the reserve (`--min-free-bytes`, default
1 GiB), what the open sessions can still write, and the new upload. Before 0.7.0
every open session's whole reservation (TAR plus extracted payload) was counted
even where its bytes were already on disk, so a partly received upload was
counted twice. Now a receiving session counts its remaining TAR bytes plus its full
payload, which stays owed through extraction, and a verified or deleting session
counts nothing. This only stops the double count. A fresh upload still needs room
for its TAR and its extracted payload at the same time, and raising or lowering the
reserve neither frees space nor starts cleanup. To make room for the 1 GiB reserve
plus that peak, free disk space yourself, or enable
[scoped retention](artifact-patterns.md#scoped-retention) so the artifacts you can
age out are removed on the next scheduled pass; a refused upload does not start one.

The server log line is the ground truth for a failure: `reason`, the `phase` the
server was in, and `systemCode` when the failure was a known errno
([How a server reports its own failures](api.md#how-a-server-reports-its-own-failures-063)).
A client older than 0.6.3 cannot read `SERVER_ERROR`: it reports an invalid
answer (`PROTOCOL_INVALID`, raised by the client), so with an older client read
the server log, not the code. This does not affect any request that succeeds.

**The connection gave no reason.** The output says `No server reason was
received` and names where it was (`connecting`, `sending the request`, `waiting
for the server to accept the offer`, `sending the artifact`, `waiting for the
final answer`); `--json` reports `"origin": "transport"`. The code, if any,
says nothing about the server. Possible causes, which the client cannot tell
apart:

- While connecting: the server is down or unreachable, the pinned `--server-key`
  is wrong, or the client key is not in the server's `--allow-key` list. The
  server drops a key it does not allow before it answers anything, so no reason
  can ever be delivered for that.
- While waiting for admission or sending: the server crashed, restarted, hit its
  connection limit, or the network failed. A server older than 0.6.3 also reset
  the connection right behind a failure answer for every code except
  `HOOK_FAILED`, so look in its log for a `Direct upload failed` line with the
  real reason. The client version does not matter for that: a newer client cannot
  read an answer the server never delivered, and a server of 0.6.3 or newer
  delivers every answer it manages to write.
- While waiting for the final answer: the upload may already be committed.
  Repeating the identical upload returns `ALREADY_COMMITTED` if it was.
- A timeout (`UPLOAD_IDLE_TIMEOUT`, `CONNECT_TIMEOUT`) is a wait that ended with no
  answer, not a server decision; raise `--idle-timeout` only if the server's hooks
  are slow (see [Deployment hooks](hooks.md)). From 0.8.0 the client waits ten
  minutes by default and `--idle-timeout` / `ClientOptions.idleTimeout` accept any
  positive integer up to 2147483647 ms (the longest delay a timer accepts; a larger
  or invalid value is refused, never shortened). The wait is one wait for one
  answer, not a deadline for the transfer: every chunk that moves restarts it, and
  the final answer is a single wait that covers verification, commit and every
  awaited hook, including a directory replacement. The connect timeout is separate
  and unchanged (30 seconds, at most 5 minutes). The server's own `idleTimeout`
  (60 seconds) bounds how long the server waits for the client and is unchanged.

Upgrade servers before clients (see
[Rollout and compatibility](#rollout-and-compatibility)): the server decides
whether an answer reaches the client, and the client decides whether the code is
shown.

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

Inactive sessions expire after seven days by default (`resumeTtl` /
`--resume-ttl`): an interrupted receive, or an idle session that already finished
verification, is removed with its staged bytes once its last activity is older
than that, and the client then starts the upload over. A receive with a live
transfer, a verification in progress, and a session being deleted are protected
from expiry. A shorter TTL takes effect when the server restarts with it, through
the startup pass, then every scheduled pass and admission, and discards any
inactive progress older than the new value.

## Storage, replacement, and retention

The storage root contains visible current and historical artifacts and managed
public links, and nothing else: all internal state lives in the separate private
state directory (default `~/.swarm-deploy/<id>`, or `--state-dir`; see
[Private state](../README.md#private-state)). Do not modify that directory while
the server is running. Its `archive/` directory holds the archives written by
[`reset-storage`](#resetting-storage-with-reset-storage); the server ignores it.

Standalone file names are create-only by default: a new name is committed,
identical managed content returns `ALREADY_COMMITTED`, and a differing occupied
name returns `FILE_EXISTS`. Opt-in file replacement preserves the old managed
file as `history-<full-old-transfer-id>`.

Directory uploads merge files into a container named after the input basename.
For example, uploading `beta-0.21.0/flatpak/app.flatpak` and later uploading
`beta-0.21.0/QV.AC.snap` keeps both files. Files omitted from a later upload stay.
The containing directory need not have been created by Swarm. Empty directory
entries create nothing; zero-byte files are real files.

Unknown files are never adopted or removed. The scan logs an unknown top-level
name once when it appears (again if it goes away and returns), at most 32 names
per scan, with the rest counted. Invalid state and failed operations remain
reported each time.

### Replacing managed artifacts

Off by default, `--allow-replace` (`ServerOptions.allowReplace`) permits changed
Swarm-managed files under selected artifact names:

```sh
swarm-deploy server ... --allow-replace                     # every managed name
swarm-deploy server ... --allow-replace beta-{version}      # a template
swarm-deploy server ... --allow-replace latest.json --allow-replace 0.18.1
swarm-deploy server ... --allow-replace '{version}'         # SemVer names only
```

- Missing leaves can be added without replacement permission. A differing leaf
  is replaced only when Swarm owns it and its current bytes match its record.
  Identical content needs no physical rewrite; identical untracked content stays
  untracked. A differing untracked or edited file, symlink, case alias or kind
  conflict rejects the entire input before public changes.
- Selectors match the top-level artifact basename, not individual member paths.
  Each is an exact name or a release template in the artifact-pattern grammar;
  `/` is refused. A bare flag permits every name and still validates listed
  selectors. Legacy `--replace-name` names are also replacement permissions and
  keep their standing retention pin; `--allow-replace` adds no pin.
- An active awaited hook, queued/running detached hook, explicit link operation
  or open link rollback journal keeps the artifact busy (`FILE_BUSY`). New
  directory merges cannot change files under those users.
- Links still name the artifact's container. Automatic reconciliation runs after
  commit; explicit publication is a separate `link` request. Hooks on links see
  the committed owned-file aggregate, while upload results describe the input.
  A failed publishing hook applies the existing link rollback/keep policy and
  does not undo committed upload files.

#### Commit boundary and recovery

The server receives and verifies the complete input in private staging, then
checks the complete file merge plan. Only then does it durably journal the
planned changes and retain private preimages of replaced files. The containing
directory is never exchanged or recursively overwritten. New files are installed
and existing files replaced individually; a replaced path holds a complete old
or new file throughout. Concurrent HTTP readers can nevertheless see a mixture
of old and new files until the commit finishes. This is recoverable whole-commit
rollback, not an instantaneous multi-file namespace switch.

The durable owned-file catalog is the commit point. Failure before it restores
all files changed by the input; failure after it preserves the committed files
and retries cleanup. Interrupted operations are resolved on startup before the
server listens. A cleanup failure keeps the journal and retention pins. A later
merge of that name must finish the cleanup first; if it cannot, it returns
`FILE_BUSY` without advancing the catalog. Routine scrub also leaves a pending
catalog unchanged, so a restart cannot mistake earlier committed data for an
unfinished upload.

Directory merges keep no new public history tree. Their rollback preimages are
private and removed after commit. Standalone file history and recovery of earlier
whole-tree records/journals remain supported. The optional native directory
exchange capability is needed only for earlier whole-tree replacement recovery,
not for new merges.

#### Ownership and retention

One private catalog per artifact name records each owned leaf, digest and writer;
it does not own the container. The combined owned set is limited to 10,000 files,
with a bounded catalog and recent-transfer receipt list. An exact retry may be
recognized at admission; a subset retry can be received and verified again and
then perform no writes. Upload identity and committed owned-set identity differ.

Retention still selects artifact/version groups by age, count, versions, quota
and scoped selectors. It removes only owned files whose bytes still match their
records and prunes only empty containers, preserving foreign siblings. Thus a
collected version directory can remain if unrelated content still lives there.
Linked targets, active hooks and unresolved journals can keep more than the
configured count. Production names remain unaffected by beta/edge-only scopes.
Startup hashes owned leaves. Missing or edited leaves lose ownership without
being deleted; scheduled scans check existence/type/size without hashing every
byte. Other owned leaves in the same container remain managed. Do not edit owned
files while the server is running.

Earlier whole-tree ownership imports only after the entire old tree matches its
record. If it does not, its unknown files remain untouched; missing new leaves
can still be added without adopting that old content. Deleting metadata is not a
way to authorize replacement of unmanaged files. See the state barrier below.

Runtime defaults:

- 64 authenticated connections.
- 8 active uploads.
- 60-second upload inactivity timeout (the server's `idleTimeout`; the client's is
  10 minutes from 0.8.0, see below).
- 1 GiB minimum free-disk reserve.
- 15-minute cleanup interval.
- 7-day resumable-session lifetime.

The runtime API can override all of these values. From 0.7.0 the server CLI
exposes `--min-free-bytes`, `--cleanup-interval` and `--resume-ttl` as well, each
a positive integer passed on only when given (the CLI cannot turn the reserve off
and `--cleanup-interval` stops at 2147483647 ms), together with its required
limits, committed retention and rotation, scoped retention, replacement policy,
artifact patterns, and hooks module.

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
state: /home/artifacts/.swarm-deploy/0123456789abcdef0123456789abcdef
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

The `state:` line is the exact private state directory being inspected. It is
resolved exactly as the server resolves it: pass the same `--state-dir` the
server uses, or none when the server uses the default under its user's home. A
missing state directory, a legacy `<storage>/.swarm-deploy` that has not been
[migrated](../README.md#upgrading-from-060-or-earlier), or a state directory that
belongs to another storage root makes the command exit `2` without changing
anything.

With `--apply` the command takes the storage lock, moves the state directory's
`staging`, `sessions`, `commits`, `journals`, `publications`, `links`, and
`trash` plus retired or abandoned lock directories into
`<state>/archive/reset-<timestamp>-<random>/`, recreates the seven
directories empty, writes a `reset.json` marker with `status: "completed"`,
releases the lock, and prints the same report followed by `archive: <path>`.
Every move is a rename inside the state directory, so nothing is copied, nothing
is deleted, and an archive is restored by stopping the server and moving its
directories back over the empty ones. Each completed reset creates its own
archive; earlier archives, unrecognised files inside the state directory, and
everything visible in the root are left untouched.

What the reset does not do, and the report says so:

- It never removes visible payloads, `history-*` files, directories, or
  symlinks from the root. A remaining payload keeps its name occupied, so a
  fresh upload of that name returns `FILE_EXISTS`. A remaining symlink loses
  its ownership record, so an automatic `--symlink` rule for that name fails
  closed with `LINK_CONFLICT`, while an explicit `link` request replaces it
  (see [Managed symlinks](managed-links.md)). `fresh start: yes` is
  printed only when the root holds nothing at all; remove leftovers by hand
  before or after the reset to get there.
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
`<state>/reset-pending.json` marker that names it. This holds for a
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
stop the service, return ownership of the state directory (the `state:` line
of the preview), and start it again. When state is under a home directory, run
the reset as the service user so it resolves that user's home:

```sh
sudo chown -R artifacts:artifacts /var/lib/swarm-deploy/artifacts
```

The report is refreshed after acquiring the lock, so an upload completed while
`--wait` was waiting appears among the retained payloads.

A symlinked storage root or ancestor, a symlinked state directory, a metadata
directory replaced by a symlink or file, a filesystem root, a missing root, a
root without private state, a state directory inside or aliasing the root or on
another filesystem, or a root that still holds legacy `.swarm-deploy/` state is
rejected before any metadata is moved. Use the canonical storage path (for
example `/private/tmp` rather than macOS's `/tmp` alias). A malformed
pending-reset marker is also refused for manual reconciliation.

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

### Directory replacement and the state barrier (0.8.0)

The first new file catalog durably changes `.swarm-deploy-state.json` to require
`file-catalog-v1` before writing a new journal or catalog. Its form is:

```json
{ "version": 2, "root": { "path": "<root>", "requires": ["file-catalog-v1"] } }
```

Existing required features are preserved. Older servers stop before processing
these journals, catalogs or sessions. This barrier can be written by adding a
file through a directory upload, even without replacement permission.
`reset-storage` preserves it and archives catalogs along with other live state.
Never remove or edit it to force a downgrade. To go back, stop the server and
restore the public root and private state together from a backup made before the
first new-format commit.

Earlier whole-directory replacement journals (version 4,
`directory-replacement-v1`) still recover using their original exchange and
history rules. New directory uploads use version 5 merge journals and private
per-file catalogs instead. Standalone file records/journals retain their prior
formats. If no new state feature has been written, let this server finish startup
recovery and stop cleanly with no pending journals before running an earlier
release; an interrupted returning-content file replacement (A, B, A) still needs
this release to recover it first.

### Private state moved out of the storage root (0.6.1)

Through 0.6.0 the private state sat in `<storage>/.swarm-deploy`. From 0.6.1 it
lives outside the storage root (see [Private state](../README.md#private-state)),
and a server or `reset-storage` that finds the old directory refuses to run until
you move it with the server stopped, using the quoted commands the error prints.
Start the moved state once with `--initialize-state` to bind it to its root, and
then without. To roll the server back to 0.6.0 or earlier, stop it, run the
rollback command from the same error (it moves the state directory back to
`<storage>/.swarm-deploy`), and start the older release; deleting the old
directory instead loses ownership and recovery data that cannot be restored
automatically, and starting fresh state beside published files needs
`--initialize-state` too. Do not run an older release against a root that a 0.6.1
server manages: it would recreate `<storage>/.swarm-deploy`, which the server then
refuses to work beside.

### Managed-link rollback warning

**Do not roll a server back to v0.2.0 after an upgraded server has created,
repaired, or repointed any managed link.** Those operations write a v2
ownership record, which v0.2.0 cannot read. Rollback requires restoring the
complete pre-upgrade storage backup (including visible links and the
`links` directory of the state directory, or `.swarm-deploy/links` before 0.6.1),
or keeping the upgraded server in place.

`swarm-deploy link` requires an upgraded server; v0.2.0 does not recognize
link control requests.

### Shutdown cleanup hook (0.6.2)

A hooks module (or `ServerOptions.hooks`) may now register `beforeClose`, the
server's teardown callback. Without it nothing changes: closing aborts the waits on
operation hooks, abandons a callback that is still running, and stays bounded even
if that callback never settles. With it, the first `close()` (including the one a
`SIGINT` or `SIGTERM` triggers) stops admission, notes the artifacts its detached
calls hold, calls the hook at once, aborts the operations as before, stops scheduled
retention (waiting for a pass that is already running) before the wait on the hook,
and releases the storage lock and emits `close` only after the hook and the
operations finished, so another server cannot take the root while the hook is still
draining external work. The noted artifacts stay protected from retention until its
stop has completed, so a pass that runs while the transport is still closing cannot
delete what a cancelled callback is still using; the callbacks themselves end, and
give up their own pins, at the abort. A long retention pass that is running when the
server closes delays the lock release (and not the hook, which was called first).

- **The hook owns its bounds.** The server adds no timeout and never abandons it: a
  `beforeClose` that never settles keeps the process from exiting and the root
  locked. Give it a cancellation and a deadline of its own.
- **Failure.** If it throws or rejects, `close()` rejects with `HOOK_FAILED` (fixed
  message), the `close` event reports `failed`, the log names only the code, and the
  server still releases its own resources, lock included; the CLI exits `1` with
  `Cleanup failed`. Treat it as "external cleanup not proven".
- **Upgrade.** The callback needs 0.6.2. An older server ignores a `beforeClose`
  module export without error, so a module that needs it must require 0.6.2 or
  newer. No wire format, persisted state or dependency changes.

### Detached post-operation hooks (0.6.0)

**Behavior change.** `afterCommit`, `afterLink` and `onFailure` are now `detached`
unless declared `response` (`ServerOptions.hookModes`, a `hookModes` module
export, or `swarm-deploy server --hooks <module> --hook-mode <hook>=response`).
Until 0.5.x every one of them was awaited and a failure failed the upload or the
link request. A detached hook runs after the answer and nothing waits for it, so
**a deployment or publishing step that must succeed has to be declared
`response`** or its failures stop failing uploads and link requests; the same
holds for a hook module you do not control. The migration steps are in
[Migrating to 0.6.0](hooks.md#migrating-to-060).

- **What the server keeps.** Detached calls live in the server process only: at
  most 1024 are queued or running, one at a time per link name and per artifact
  name, in order. There is no queue on disk, no retry and no exactly-once promise.
  Closing the server drops the queued ones and abandons a running one, so work
  that must not be lost is a `response` hook. Failures are logged as
  `Detached hook failed`, `Detached hook skipped` (server closing) and
  `Detached hook dropped` (over the bound), each with the hook name and, for a
  link or artifact, its name, and never callback text.
- **Retention.** While a detached call is queued or running its artifact is pinned
  against every retention pass; the pin is in memory and is gone after a restart.
- **Wire and clients.** Uploads and link requests that do not ask for hook data
  are byte for byte what they were, so no client needs to change. An upload that
  asks (`Client.upload(path, { hookResult: true })`, `swarm-deploy upload --json`)
  carries one new optional field in its offer, which a server older than 0.6.0
  rejects: upgrade servers before clients that ask. The field is not part of the
  transfer identity.

### Link hooks and compatibility

`afterLink` is optional and adds no wire format, persisted state, or dependency.
A failed `response` hook reaches every client as the existing stable `HOOK_FAILED` code in
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

**Behavior change (0.6.0).** When an explicit link request's `response`
`afterLink` hook fails, the server now restores the previous local symlink and its ownership
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
  `<state>/links/<sha256(link-name)>.rollback.json` (at most 32 KiB), before
  it changes anything, and removes it when the request is finalized or restored.
  An idle, normally stopped server has none. After a crash the next start restores
  the previous link and record before retention runs or any client connects, and
  logs `Restored a managed link after an unfinished request` with the link name.
  If the link or record was changed from outside in the meantime, that name is
  left alone and blocked (`Managed link rollback is blocked by a change made
since`), its artifacts stay pinned, and the rest of the server starts; see
  [Removing a managed link](managed-links.md#removing-a-managed-link) for how to
  clear it. A corrupt journal stops the server from starting. A request whose own
  journal was removed, replaced, or edited while it ran fails with `LINK_FAILED`
  and leaves the link, record, and file as found. After a request is finished, a
  failure to refresh the server's managed-name list is logged as `Managed link
names could not be refreshed` with the link name; it does not change the answer
  or the link.
- **Rolling back the server** to a version before 0.6.0 is safe once no journal
  remains (stop the server normally and check `<state>/links`): an older
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
