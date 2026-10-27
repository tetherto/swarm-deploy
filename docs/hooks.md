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
  upload or link request though the artifact and link are already stored. See
  [Link publication hooks](#link-publication-hooks).
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
- `afterLink` throws on an explicit link request: the link stays as decided, the
  client receives a `FAILED` link result with `HOOK_FAILED`, and `onFailure`
  runs. The same request again returns `UNCHANGED` once the hook succeeds.
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
  server still runs its hooks, and the artifact and link stay durable, so a
  retry is safe. Set the client idle timeout above the worst-case total, and
  make publishers fail on their own well before it.
- **The answer is delivered.** After writing a `HOOK_FAILED` answer the server
  ends its side of the stream and keeps the connection for up to 5 seconds, so
  the client reads the code instead of a connection reset. This applies to every
  `HOOK_FAILED` answer, including `beforeCommit` and `afterCommit`. Other
  failure answers are still followed by an immediate close, as before, so on a
  real network a client may see a reset rather than their stable code.
- **No rollback.** The link is made durable before the hook runs and a failed
  hook never undoes it, nor the committed artifact. After `HOOK_FAILED` the
  link points where the request asked, unless a later request has moved it.
- **Safe retry.** Repeating the same link request returns `UNCHANGED` and runs
  the hook again, and repeating the upload takes the already-committed path
  and runs the hooks again, so a failed publication is retried without
  changing the link. The first attempt reports `HOOK_FAILED` and the retry
  reports `UNCHANGED`: the result describes the link.
- **Repeatable.** Every cause above can call the hook more than once for the
  same link and artifact. Write hooks that are idempotent, identify the work by
  `link.name` plus `artifact.transferId` (and `link.target`), and treat the
  context as at-least-once.
- **No lease across hook code.** Hook code runs after the storage-root lease is
  released, so a slow or failing hook never blocks commits, retention, other
  links, or recovery, and a hook that calls back into the server cannot
  deadlock on it.
- **Per-link order.** For one link name, hooks start in the order the durable
  link decisions were made and never overlap, so within one running server a
  slow publication of an older decision cannot overtake the publication of a
  newer one. Hooks for different links run concurrently. An upload takes its
  place when it reconciles the link, so it holds that place while its
  `afterCommit` runs. The ordering is in memory: it is not a transaction with
  your publisher and does not survive a restart, and a hook that never returns
  delays later hooks for that link (and their clients, until the client's idle
  timeout) and keeps its own connection open, because there is no hook
  timeout. A hook must not wait for another link request or upload that
  involves the same link name on its own server, since that one is queued
  behind it.

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
  link left in place, and the same safe retry. `onFailure` receives an `Error`
  that names the reason and the path inside the result (for example `too large`
  or `unsupported function at $.run`), never a value. The server log carries no
  result data either.
- **At-least-once.** Every call, including the retry that reports `UNCHANGED`,
  runs the hook again and returns that run's result, so return the same ID for
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
`link` event with `status: 'failed'`, `reason: 'HOOK_FAILED'` and `result`
(`LINKED` or `UNCHANGED`, the durable outcome) for a link request; a `failure`
event with `HOOK_FAILED`; a `Link hook failed` warning with the link name,
target, trigger, and status (never callback text); and `onFailure` with
`phase: 'afterLink'`, the `link`, and the raw exception. Automatic links
emit no `link` event, so an upload reports through the other three.

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
