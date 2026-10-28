# Deployment hooks

Hooks let a trusted server operator run code around the commit. They are
server-side only, run in the server process with its privileges, and receive no
seeds, secret keys, TAR bytes, or session material. Back to the
[README](../README.md).

## Contents

- [Lifecycle points](#lifecycle-points)
- [Invocation sequences](#invocation-sequences)
- [Link publication hooks](#link-publication-hooks)
- [onFailure](#onfailure)
- [Hook modules](#hook-modules)

Related guides: the [CLI reference](cli.md) for `--hooks <module>`,
[artifact patterns and rotation](artifact-patterns.md) for how hooks defer the
post-commit retention pass, [managed symlinks](managed-links.md) for the links
`afterLink` publishes, and the [runtime API](api.md) for the exported hook
types. A runnable Node-only example is in
[`examples/link-publisher`](../examples/link-publisher).

## Lifecycle points

- `beforeCommit(context)`: after verification, before any commit mutation. For a
  file, `path` is the verified `.part` staging file; for a directory, `path` is
  the verified `.tree` staging directory. Its failure aborts the commit.
- `afterCommit(context)`: after the artifact is durably committed and configured
  links are reconciled, before the terminal success reply. For a directory,
  `path` is the committed directory tree. Its failure fails the upload even
  though the artifact is already stored. When it is configured, post-commit
  rotation is deferred until it succeeds (see
  [Immediate effect](artifact-patterns.md#selection-rules)).
- `afterLink(context)`: after a managed link is durable, before the terminal
  success reply: for an upload, after `afterCommit` succeeded and for each
  automatic link now pointing at the uploaded artifact; for an explicit link
  request, after the request passed every policy check. Its failure fails the
  upload or link request though the artifact is already stored; an upload's
  automatic link stays, while an explicit link request rolls its link back unless
  it asked to keep it. See [Link publication hooks](#link-publication-hooks).
- `onFailure(context)`: once per failed connection whose metadata was decoded,
  and once per failed `afterLink`, after the client has been answered.

Callbacks may return `void` or a promise (only `afterLink` may return data; see
[Link publication hooks](#link-publication-hooks)), are called with no receiver,
and receive a frozen context. The artifact is
`{ name, kind, size, sha256, transferId, entryCount?, sourceParent?, release? }`,
where `entryCount` is present only for directories and `release` is
`{ series, version? }` when patterns are configured. These descriptive fields
come from decoded offer metadata, not yet from verified content.

| Callback       | Extra context                                                                |
| -------------- | ---------------------------------------------------------------------------- |
| `beforeCommit` | `path` (verified staging file or tree), `resumed`, `alreadyCommitted: false` |
| `afterCommit`  | `path` (committed artifact), `resumed`, `alreadyCommitted`                   |
| `afterLink`    | `link`, `status`, `trigger`                                                  |
| `onFailure`    | `path` (`string \| null`), `phase`, `resumed`, `alreadyCommitted`, `error`   |

`onFailure` also receives `link` when `phase` is `afterLink`. `resumed` is
`true` when the server admitted the connection as `RESUME` or `VERIFIED`.
Closing the server aborts the wait; a callback that outlives the abort
continues detached and its later result is ignored.

There is no hook timeout, and a hung callback holds more than its own
connection. On a fresh or resumed upload it also holds a `maxActiveUploads`
slot and the session's staging reservation for as long as it runs, so enough
simultaneously hung callbacks stop the server from admitting new uploads
(`ACTIVE_UPLOAD_LIMIT`) until the server is closed and the waits are aborted.
Only the already-committed path holds no upload slot. Write callbacks that
finish or throw; bounded hook timeout and anti-spam controls are tracked in
issue #8.

The **lifecycle** hooks `beforeCommit`, `afterCommit` and, for an upload,
`afterLink` never run concurrently for one transfer. Once a transfer ID
authenticates, that connection owns it for the whole verify/commit sequence; a
second connection offering the same transfer ID — fresh, resumed, verified, or
already committed — is rejected with `FILE_BUSY` before any lifecycle hook runs,
and that rejection is reported to `onFailure` once with `phase: 'offer'`.

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

## Invocation sequences

Fresh upload:

1. Offer inspected and admitted (`ACCEPT`), TAR received.
2. Verification.
3. `beforeCommit` (`resumed: false`).
4. Commit.
5. `afterCommit` (`resumed: false`, `alreadyCommitted: false`).
6. `afterLink` for each automatic link that now points at the artifact (only
   when an `afterLink` hook is configured and a rule selected the artifact).
7. `COMMITTED`.

Partial resume (`RESUME`): the same steps, with `resumed: true` in both hooks.

Verified reconnect (`VERIFIED`): the staged data was already verified, so the
server re-reads it, calls `beforeCommit` again with `resumed: true`, commits, and
calls `afterCommit` with `resumed: true`. A previous connection may have ended
after `beforeCommit` returned but before the commit finished.

Already committed: identical content is detected during offer inspection, so
there is no transfer, verification, or `beforeCommit`. The server calls
`afterCommit` with `resumed: false` and `alreadyCommitted: true`, then
`afterLink` for each automatic link that currently points at the artifact
(status `UNCHANGED` unless this run repaired the link), then replies
`ALREADY_COMMITTED`. A deferred retention pass follows only when this process
committed that transfer and its hooks have not yet succeeded. This path is
reached only while the artifact still exists; see the
[retry caveat](artifact-patterns.md#selection-rules).

Explicit link request: the request passes every policy check, the link is
created, kept, or repointed durably, and then `afterLink` runs
(`trigger: 'request'`, no upload hook). Only after it returns does the client
receive `LINKED` or `UNCHANGED`.

Failure sequences:

- `beforeCommit` throws: nothing is committed and the verified session remains.
  The client receives `HOOK_FAILED`; `onFailure` runs (`phase: 'beforeCommit'`).
  A retry reconnects as `VERIFIED` and calls `beforeCommit` again.
- `afterCommit` throws on a fresh or resumed upload: the artifact **stays
  durably committed** and its session is retired. The client receives
  `HOOK_FAILED`; `onFailure` runs (`phase: 'afterCommit'`, final path). Unless
  retention removed the artifact first (see the
  [retry caveat](artifact-patterns.md#selection-rules)), a retry takes the
  already-committed path and calls `afterCommit` with `alreadyCommitted: true`;
  otherwise it is a fresh upload.
- `afterCommit` throws on an already-committed retry: the offer is rejected with
  `HOOK_FAILED` and a later retry repeats `afterCommit`, subject to the same
  retry caveat.
- `afterLink` throws on a fresh or resumed upload: the artifact **and the link
  stay durable**, the session is retired, and the client receives
  `HOOK_FAILED`; `onFailure` runs (`phase: 'afterLink'`, `link` set, `path` the
  link). A retry takes the already-committed path and calls `afterCommit` again
  (`alreadyCommitted: true`) and then `afterLink` with `status: 'UNCHANGED'`.
  A failing `afterLink` on an already-committed retry rejects the offer with
  `HOOK_FAILED` and a later retry repeats it.
- `afterLink` throws on an explicit link request: by default the previous link
  and ownership record are restored (a new link is removed) before the client
  receives a `FAILED` link result with `HOOK_FAILED`, and `onFailure` runs after
  that. The same request again links afresh (`LINKED`) once the hook succeeds. With
  `hookFailure: 'keep'` the link stays as decided and the same request again
  returns `UNCHANGED`. See [Rollback and its limits](#rollback-and-its-limits).
- A failure after every hook succeeded (for example the terminal reply cannot be
  written) does not call `onFailure`.

Retries therefore can call hooks more than once for one transfer. **Make hooks
idempotent and key external side effects on `artifact.transferId`** (and, for
`afterLink`, on the link name too). Treat `afterCommit` and `afterLink` as
at-least-once: record the transfer ID when the deployment step finishes and skip
repeated calls.

## Link publication hooks

`afterLink` is for publishing a link: telling another system that the link
`latest` now means a given artifact. It runs after the link is durable and
exactly for these causes:

- **Upload** (`trigger: 'upload'`). A fresh, resumed, verified-reconnect, or
  already-committed upload of an artifact that an _automatic_ rule currently
  selects. There is one call per automatic link that points at that artifact,
  in rule order, after `afterCommit` succeeded. An upload no rule selects
  moves no link and calls no `afterLink`.
- **Request** (`trigger: 'request'`). An explicit `Client.link` or
  `swarm-deploy link` that passed every policy check and found a durable link
  state. There is one call.

It never runs for a request that is unauthorized, not allowed, targets a
missing artifact, or conflicts with an artifact or unmanaged path: those
fail before any link changes and run no hook, including `onFailure`. It also
does not run when a manual link's target is re-uploaded or replaced, or when
startup, scheduled, manual, or commit retention reconciliation changes a link;
only an upload or a link request does.

The context is `{ link, artifact, status, trigger }`, frozen and free of keys,
seeds, and TAR bytes:

- `link`: `{ name, target, mode, path, targetPath }`. `mode` is `automatic` or
  `manual`; `path` is the absolute path of the symlink and `targetPath` the
  absolute path of the committed target.
- `artifact`: the committed artifact the link was set to point at, shaped like
  every other hook artifact. For a request it is read from the durable commit
  record, so it has no `sourceParent`.
- `status`: the link decision this call observed, never proof of publication.
  `LINKED` when this call created or repointed the link, took over an
  unrecorded symlink (even one whose old text already read as the target, since
  the swap is what established ownership), or repaired an automatic link's
  ownership record; `UNCHANGED` when the link was already owned and already
  pointed at the target. An earlier attempt, another commit's retention pass or
  reconciliation, or a concurrent request may have moved the link first, so a
  fresh upload or request can still see `UNCHANGED`, and a manual
  ownership-metadata refresh for the same target is `UNCHANGED` too. Neither
  value says whether anything was published: decide that from your own record
  of `link.name` and `artifact.transferId`.
- `trigger`: `upload` or `request`.

**What the server guarantees.**

- **Nothing succeeds before the hook does.** A client never receives
  `COMMITTED`, `ALREADY_COMMITTED`, `LINKED`, or `UNCHANGED` until the
  applicable `afterLink` calls returned. A throw reaches the caller as the
  stable, sanitized `HOOK_FAILED` (fixed message; the raw exception never
  leaves the server and is passed only to `onFailure`). A link request carries
  it as the ordinary `FAILED` result code, so existing clients need no change.
  The caller sees that code only while it is still waiting; see the time budget
  below.
- **Time budget.** The server sets no hook deadline. A client waits for its
  answer for at most its idle timeout (60 seconds by default, 5 minutes at most:
  `--idle-timeout`, `ClientOptions.idleTimeout`), and that one wait covers
  everything the server does before it answers. For an upload that is
  verification and commit, `afterCommit`, every `afterLink` call for the upload
  one after another (one per automatic link the artifact moved), hooks queued
  ahead for the same link, and the deferred retention pass; for a link request,
  the queue ahead and the hook. If the client's wait expires first it reports
  `UPLOAD_IDLE_TIMEOUT` instead of `HOOK_FAILED` and closes the connection. The
  server still runs its hooks and finishes the request (an explicit link is
  finalized or restored as the hook decides; the artifact stays durable), so a
  retry is safe. Set the client idle timeout above the worst-case total, and
  make publishers fail on their own well before it.
- **The answer is delivered.** After writing a `HOOK_FAILED` answer the server
  ends its side of the stream and keeps the connection for up to 5 seconds, so
  the client reads the code instead of a connection reset. This applies to every
  `HOOK_FAILED` answer, including `beforeCommit` and `afterCommit`. Other
  failure answers are still followed by an immediate close, as before, so on a
  real network a client may see a reset rather than their stable code.
- **A failed link request is rolled back by default.** The link is made
  durable before the hook runs, so the hook sees it. When the hook then fails,
  returns a result that cannot be sent, or is cut off because the server is
  closing, the server restores the previous local symlink and its ownership
  record (or removes a link the request created) before it answers
  `HOOK_FAILED`. An adopted, unowned symlink comes back with its exact text,
  whatever it was; the text is only stored and written back, never followed. The
  request can opt out with `hookFailure: 'keep'` (`--hook-failure keep`), which
  leaves the new link in place as before. Either way the request waits for the
  hook and a failure is still `HOOK_FAILED`. See
  [Rollback and its limits](#rollback-and-its-limits). Automatic links of an
  upload are not rolled back.
- **Safe retry.** Repeating the same link request runs the hook again, and
  repeating the upload takes the already-committed path and runs the hooks
  again, so a failed publication is retried. After a rolled-back request the
  retry reports `LINKED`, because the link was restored; after `keep`, or for a
  request that changed nothing, it reports `UNCHANGED`. The result describes the
  link, not the publication.
- **Repeatable.** Every cause above can call the hook more than once for the
  same link and artifact. Write hooks that are idempotent, identify the work by
  `link.name` plus `artifact.transferId` (and `link.target`), and treat the
  context as at-least-once.
- **No lease across hook code.** Hook code runs with no storage-root lease held,
  so a slow or failing hook never blocks commits, uploads, retention, other
  links, or recovery, and a hook that calls back into the server cannot
  deadlock on it. The lease is taken only around the link change itself and
  around finalizing or restoring it.
- **Per-link order.** Explicit link requests for one link name run one at a time
  in arrival order, in both modes, from their decision through their hook to
  their finalize or restore. A request therefore never decides against another
  request's unfinished change, and a queued request does not even change the link
  until the one ahead has finished. Names are compared without regard to case,
  as one entry on a case-insensitive volume. Requests for different links run
  concurrently. The automatic links of an upload keep their own in-memory,
  first-in first-out line: an upload takes its place when it reconciles the link,
  so it holds that place while its `afterCommit` runs. Neither ordering is a
  transaction with your publisher, and a hook that never returns delays later
  requests for that link (and their clients, until the client's idle timeout) and
  keeps its own connection open, because there is no hook timeout. A hook must
  not wait for another link request or upload that involves the same link name
  on its own server, since that one is queued behind it.

### Rollback and its limits

A link request that changes something writes a small durable journal first: the
previous visible state (no link, or the symlink's exact text) and the previous
ownership record, beside the ownership records in `.swarm-deploy/links`. It is
removed once the hook has succeeded (before the answer is written, so a failed
write never undoes a successful hook) or the change has been restored. A request
that changes nothing writes no journal and has nothing to restore.

Removing the journal after a successful hook is the point of no return. As soon
as it succeeds the request is finished: the server refreshes its list of managed
names only afterwards, and if that refresh fails it is logged and nothing else
changes (the answer stays a success, and the link is never restored). The same
holds after a restore: a failed refresh is never reported as a failed restore.
Until the next successful refresh replaces the list, the name stays reserved, so
a failed refresh never makes admission less protective.

- **What is restored.** The link and the ownership record, together. A change to
  the record alone, such as a refreshed transfer ID for an unchanged link, is
  restored too. If creating the link itself fails, for example because the
  filesystem refused once, the record the request replaced is put back (it is
  never simply deleted), the journal is removed, and the next request for the name
  works. That only happens while the journal is still the request's own and the
  record is still the previous one or the one the request wrote; a record that
  is anything else is left as found. If that cannot be done, the answer is
  `LINK_FAILED` and the journal stays until a later request for the name finishes
  the restore or fails closed.
- **Never over a change somebody else made.** The restore only proceeds when the
  link and the record are still the previous state or the one this request
  made (same text and, where the filesystem reports it, the same inode). A
  regular file, another symlink, a replaced link, or an edited or removed record
  is left exactly as found. The request then fails with `LINK_FAILED` instead
  of `HOOK_FAILED`, `rolledBack` is not reported, the journal stays, and
  further requests for that name fail with `LINK_FAILED` until the state is
  resolved by an operator (remove the journal file only after making the link
  and record what you want). `onFailure` still runs for the hook's own failure.
  There is no compare-and-swap rename in the storage adapter, so a writer
  outside the server that changes the link in the instant between the check and
  the swap can still be replaced.
- **Only its own journal.** A request changes, restores, or removes nothing
  unless the journal on disk is still the one it wrote (same token and the same
  recorded states). If that file was removed, replaced by another request's, or
  edited, the request fails with `LINK_FAILED` and leaves the link, the record,
  and the file as found: it never erases a journal that is not its own.
- **Crash and restart.** A journal found at start-up means the outcome of that
  request is unknown and its client never heard success, so the previous link is
  restored before retention runs or a client connects. A journal that cannot be
  restored because the state changed is reported and kept: that name is blocked
  and the artifacts it names stay pinned, while the rest of the server starts. A
  corrupt journal stops the server from starting. If the server stops after the
  hook succeeded but before the journal is removed, the restore undoes a
  publication your system may have accepted: the client's retry runs the hook
  again, which is the existing at-least-once contract.
- **Retention.** While a journal exists, both the attempted and the previous
  artifact are kept from retention (the attempted one, the previous record's
  target, and the artifact an adopted symlink names), so the restore never
  points at a removed artifact. That symlink's text is only compared, never
  resolved: it names an artifact when it is exactly its name, `./name`, or
  `<this server's storage root>/name`, each optionally followed by one `/`. Any
  other spelling, including a path to the same file through a different route,
  pins nothing. The text itself is still restored exactly, whatever it says.
- **What is never undone.** The uploaded artifact, and anything the hook did
  elsewhere, such as a submission it made to an external store. The link is also
  visible to local consumers for as long as the hook runs, even when it is later
  restored.
- **Cannot be restored exactly.** A previous symlink whose text is empty, longer
  than 4096 bytes, contains NUL, or contains the Unicode replacement character
  (what decoding invalid UTF-8 leaves behind) is refused with `LINK_CONFLICT`
  before anything changes. Use `hookFailure: 'keep'` to adopt such a link, since
  that mode keeps no journal.
- **Older servers.** The request always carries its policy, so a server older
  than 0.6.0 rejects it instead of silently keeping a link you expected to be
  rolled back. Upgrade servers before clients. A 0.6.0 server treats a request
  without the field, from an older client, as `rollback`, which is a change of
  default for those clients.

**What it does not guarantee.** The hook runs after the lease is released, so the
context is the snapshot of one decision, not live state. By the time it runs,
another request may have repointed `link.path`, and a retention pass may have
removed `targetPath` if the link no longer pins it. Open or copy what you need
promptly, treat a missing `targetPath` or a changed `readlink(link.path)` as
"superseded", and let the newer decision's own call publish the final state.
Link removal has no hook because there is no unlink request.

**Returning a result to a link request.** `afterLink` may return a plain JSON
object, or nothing. A caller that asks for it
(`Client.link(target, name, { hookResult: true })`, or `swarm-deploy link --json`)
receives it as `ClientLinkResult.hookResult`, in the same answer as `LINKED` or
`UNCHANGED` and only after the hook has resolved. Use it to hand back what you
choose to report about the work the hook started: an external job or submission
ID, an evidence URL, a digest. Nothing is added from the context, the error, or
the environment, and the server adds no store-specific logic.

```ts
const hooks: ServerHooks = {
  async afterLink({ link, artifact }) {
    const submission = await submitToStore(link.name, artifact.sha256) // your code
    return { submissionId: submission.id, evidenceUrl: submission.url, accepted: true }
  }
}
```

- **Opt-in only.** An upload's automatic links, and a link request that did not
  ask, ignore the return value and never read it, even if it is not valid. Such
  callers see exactly what they saw before. A server without `afterLink`, and a
  hook that returns nothing (`undefined`), send no result; `{}` is sent as an
  empty object.
- **What is accepted.** A plain object (an object literal or a null-prototype
  object) whose values are strings, finite numbers, booleans, `null`, arrays,
  and plain nested objects, at most 8 levels deep and at most 3 KiB (3072 bytes)
  of compact JSON, so the answer fits one 4 KiB control record. Not accepted:
  `undefined` (also inside objects and arrays), functions, symbols, BigInt,
  `NaN` and `Infinity`, class instances such as `Date` and `Map`, `toJSON`
  methods, getters, symbol keys, a `__proto__` key, cycles, and a return value
  that is not an object (a string, number, array, or `null`). The exported
  `HookResult` and `HookResultValue` types describe the shape; annotate the
  return type as `HookResult` when branches return different object literals.
- **A refused result is a failed hook.** When the caller asked, an unusable
  result fails like a throw: the stable `HOOK_FAILED` with its fixed message, the
  link restored (or kept, with `hookFailure: 'keep'`), and the same safe retry.
  Asking for the result does not change the failure policy, and the policy does
  not change what is returned. `onFailure` receives an `Error`
  that names the reason and the path inside the result (for example `too large`
  or `unsupported function at $.run`), never a value. The server log carries no
  result data either.
- **At-least-once.** Every call, including a retry that reports `LINKED` after a
  rollback or `UNCHANGED`, runs the hook again and returns that run's result, so return the same ID for
  the same work, as you would for any idempotent hook.
- **Who sees it.** The result goes to the authenticated client that asked, so
  return only data that caller may see. Leave out credentials, tokens, and
  internal paths; the library cannot tell them from other strings.

The result is data transport, not proof. Three things are different:

1. **Link status** (`LINKED` or `UNCHANGED`): the server's decision about the
   symlink, as above.
2. **What your hook reports**: for example that an external store accepted a
   submission, with its ID. The library does not check it.
3. **Final published status**: whether the store later published it. That happens
   outside this call; verify it with your own tooling using the reported ID.

Keep the hook to the fast step, such as submitting the job and returning its ID.
The caller waits at most its idle timeout (5 minutes at most), and a store
review such as Flathub's can take longer than that, so do not wait for
publication inside the hook. The server keeps no queue, job store, or status
page; a publisher that needs one keeps its own. Store clients are separate from
this package.

An opted-in request needs a server of version 0.5.0 or later. An older server
rejects the request instead of answering it, so the call fails; it never returns
without the result. Upgrade servers before clients that ask.

**Observing a failure.** A failed `afterLink` is reported on the server as: a
`link` event with `status: 'failed'` and `reason: 'HOOK_FAILED'` for a link
request, carrying `rolledBack: true` when the previous link and record were
restored, and otherwise `result` (`LINKED` or `UNCHANGED`, the outcome that
stayed in place) when `keep` or a request that changed nothing left it; a
`failure` event with `HOOK_FAILED`; a `Link hook failed` warning with the link
name, target, trigger, and status (never callback text); and `onFailure` with
`phase: 'afterLink'`, the `link`, and the raw exception, once the link is restored
or final and the client has been answered. When a restore cannot be proven or
fails, the event and the answer are `LINK_FAILED`, `rolledBack` is absent, and a
`Managed link rollback failed` warning names the link and the error code, never a
path. Automatic links emit no `link` event, so an upload reports through the
other three.

A runnable, Node-only example is in
[`examples/link-publisher`](../examples/link-publisher). It uses
`node:child_process` and the global `process`, so it does not run on Bare
(library hooks themselves work on Node and Bare). It hands each link to a
publisher over stdin without a shell. `SWARM_DEPLOY_PUBLISHER` names a
JavaScript module file that the example runs with the current Node
executable; it is not an arbitrary executable. Each call has a 20-second
deadline: the publisher then gets `SIGTERM` and, 5 seconds later, `SIGKILL`, and
the call always rejects with a timeout, even if the publisher exits zero after
`SIGTERM`. It settles only once that child has exited, so an abandoned
publisher cannot write over the next publication of the same link, and a call
takes at most 25 seconds. The example's header shows how to size the client
idle timeout for several sequential calls (25 seconds each).

## onFailure

`phase` is one of `offer`, `transfer`, `verification`, `beforeCommit`, `commit`,
`afterCommit`, or `afterLink`. `offer` covers every failure before a staging
path exists: metadata or transfer-ID problems, unmatched patterns, file-size,
capacity and destination rejections, and inspection errors. `afterLink` is the
only phase that can also come from a connection with no upload: a failed
`afterLink` on an explicit link request reports it, with `resumed: false`,
`alreadyCommitted: true`, and the target's durable commit record as `artifact`.
Failed link requests that never changed a link do not call `onFailure`.

An `offer`-phase context is built from decoded metadata **before** the transfer
ID is authenticated, and it is also reported when that authentication is exactly
what failed. Its `transferId`, `name`, `size`, `sha256`, and `sourceParent` are
therefore attacker-chosen values from an allowlisted key, not verified identity.
Use them for logging and alerting only; never as audit records or idempotency
keys. Every later phase runs after authentication, so only `offer` carries this
caveat.

`error` is the original failure. For an exception thrown by `beforeCommit`,
`afterCommit`, or `afterLink`, hooks receive the **raw thrown value** (not a
wrapper) because hooks are trusted. The client and server events see only the
stable wire code `HOOK_FAILED` with a fixed message, so callback text never
reaches the wire. Other failures arrive as `SwarmDeployError` (or raw storage
errors). A failing `onFailure` is logged as a secondary warning and never
replaces the original failure.

`path` by phase:

| Situation                                                          | `path`                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| `offer`                                                            | `null`                                                  |
| `transfer`; fresh-upload `verification`                            | `<storage>/.swarm-deploy/staging/<transferId>.tar.part` |
| `beforeCommit`, `commit`; `verification` of a `VERIFIED` reconnect | `<storage>/.swarm-deploy/staging/<transferId>.part`     |
| `afterCommit` (including already committed)                        | `<storage>/<name>`                                      |
| `afterLink`                                                        | `<storage>/<link-name>`                                 |

## Hook modules

`--hooks <module>` accepts `.js`, `.mjs`, and `.cjs`; any other extension is
rejected at startup with exit code `2` before the module is loaded. ESM and
CommonJS examples:

```js
// hooks.mjs
export async function afterCommit({ artifact, path, alreadyCommitted }) {
  // Idempotent: keyed by artifact.transferId.
  await deploy(artifact.transferId, path)
}

export async function afterLink({ link, artifact, status }) {
  // Repeatable: publish "link.name means artifact.transferId" once, skip repeats.
  await publish(link.name, artifact.transferId, status)
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

- Only the own properties `beforeCommit`, `afterCommit`, `afterLink`, and
  `onFailure` are read. Other exports (helpers, configuration) are ignored,
  including a harmless non-object default export.
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
only the four callbacks, every callback a function. Unknown keys and
non-function values throw `PROTOCOL_INVALID`. The object is snapshotted at
construction, so later mutation has no effect.
