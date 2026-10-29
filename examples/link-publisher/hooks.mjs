// An example `--hooks` module that hands every managed-link change to a publisher.
//
// Node-only: it uses `node:child_process` and the global `process`, so run it with
// `swarm-deploy` on Node. The `afterLink` hook itself works on Node and Bare, but this
// example does not run on Bare.
//
//   SWARM_DEPLOY_PUBLISH_DIR=/srv/published \
//   swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
//     --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 4294967296 \
//     --symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/' latest \
//     --symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/' \
//     --hooks examples/link-publisher/hooks.mjs
//
// `afterLink` runs once the link is durable: after an upload moved an automatic link
// (`latest` above), or after an explicit `swarm-deploy link app-1.2.3.tar.gz stable`. This
// publishing step is a gate, so it is declared `response` below: the client is told nothing
// until it returns, and a rejection reaches the client as HOOK_FAILED (an explicit link is
// then rolled back unless the request asked to keep it). Without that declaration the hook
// would be `detached`: the client would be answered first and a failure here would only be
// logged, so it could never fail the request.
//
// Time budget. The server has no hook deadline, and a client waits for its answer for at
// most its idle timeout: 60 s by default, 5 minutes at most (`--idle-timeout <ms>` on
// `upload` and `link`, `ClientOptions.idleTimeout`). That one wait covers everything the
// server does first: verification and commit, `afterCommit`, every `afterLink` call for the
// upload one after another (one per automatic link the artifact moved), hooks queued ahead
// for the same link, and retention. Each publisher call below takes at most PUBLISH_TIMEOUT
// plus KILL_GRACE (25 s) to settle: it is not done until its child has exited. Give clients
// an idle timeout above (links moved + queued hooks ahead) x 25 s plus that other work, for
// example `--idle-timeout 120000` for two links. A client whose wait expires first reports
// UPLOAD_IDLE_TIMEOUT instead of HOOK_FAILED; the server still runs its hooks, the artifact
// and link stay durable, and a retry is safe.
//
// The publisher is a JavaScript module file, run with this process's own Node executable
// (`process.execPath`): `SWARM_DEPLOY_PUBLISHER` names such a file, not an arbitrary
// executable. It gets one JSON document on stdin. It is started without a shell and with
// no argument derived from the deployment, so artifact and link names cannot inject
// anything. Write your own publisher the same way: parse and validate the JSON, never
// interpolate its fields into a command line.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PUBLISHER =
  process.env.SWARM_DEPLOY_PUBLISHER ?? fileURLToPath(new URL('./publisher.mjs', import.meta.url))
// With KILL_GRACE, well under the 60 s default client idle timeout, so one slow publication
// still fails here as HOOK_FAILED; see the time budget above for several calls.
const PUBLISH_TIMEOUT = 20_000
// How long after SIGTERM a publisher may keep running before it is sent SIGKILL.
const KILL_GRACE = 5_000

// Read as data when the module loads, never guessed from the callback. `--hook-mode
// afterLink=detached` on the command line overrides it.
export const hookModes = { afterLink: 'response' }

// May run more than once for the same link and artifact (a retry after HOOK_FAILED, or a
// repeated link request), so the publisher must be idempotent on `artifact.transferId`.
export function afterLink({ link, artifact, status, trigger }) {
  return runPublisher(
    process.execPath,
    [PUBLISHER],
    JSON.stringify({
      version: 1,
      link: link.name,
      target: link.target,
      mode: link.mode,
      linkPath: link.path,
      targetPath: link.targetPath,
      artifact: {
        name: artifact.name,
        kind: artifact.kind,
        sha256: artifact.sha256,
        transferId: artifact.transferId
      },
      status,
      trigger
    })
  )
}

// Runs `command` once, without a shell, with `input` on stdin. Resolves only on a clean
// exit before the deadline. At the deadline the child gets SIGTERM, and SIGKILL `killGrace`
// later if it is still running, and the call then ALWAYS rejects, even if the child exits
// zero after SIGTERM. It settles only once that child has exited, never earlier: the
// per-link hook queue releases the next publication when this settles, so an old
// publisher that was merely abandoned could still write after (and over) the next one.
// Only the direct child is signalled and awaited: a publisher that starts its own
// subprocesses must clean them up itself. (A child the operating system cannot kill, for
// example one stuck in uninterruptible I/O, keeps this pending rather than release the
// queue early.) Exported so the example's tests can scale the timings; the hooks loader
// ignores it.
export function runPublisher(
  command,
  args,
  input,
  { timeout = PUBLISH_TIMEOUT, killGrace = KILL_GRACE } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'inherit', 'inherit'] })
    let timedOut = false
    let settled = false
    let force
    const settle = (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(force)
      if (error) reject(error)
      else resolve()
    }
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      force = setTimeout(() => child.kill('SIGKILL'), killGrace)
    }, timeout)
    // Without a pid nothing ever started. Any later 'error' (a signal that could not be
    // delivered) leaves the child running, so we keep waiting for it to exit. The listener
    // stays attached: SIGTERM and then SIGKILL can both be refused, and an 'error' with no
    // listener would throw and take the whole server down.
    child.on('error', (error) => {
      if (child.pid === undefined) settle(error)
    })
    child.once('exit', (code, signal) => {
      if (timedOut) settle(new Error(`publisher timed out after ${timeout} ms`))
      else settle(code === 0 ? null : new Error(`publisher exited with ${code ?? signal}`))
    })
    // The publisher may exit before it has read everything; its exit status decides.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
