// An example `--hooks` module that hands every managed-link change to a publisher.
//
//   SWARM_DEPLOY_PUBLISH_DIR=/srv/published \
//   swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
//     --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 4294967296 \
//     --symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/' latest \
//     --symlink '/^app-\d+\.\d+\.\d+\.tar\.gz$/' \
//     --hooks examples/link-publisher/hooks.mjs
//
// `afterLink` runs once the link is durable: after an upload moved an automatic link
// (`latest` above), or after an explicit `swarm-deploy link app-1.2.3.tar.gz stable`. The
// client is told nothing until it returns, and a rejection reaches the client as HOOK_FAILED.
//
// The publisher gets one JSON document on stdin. It is started without a shell and with
// no argument derived from the deployment, so artifact and link names cannot inject
// anything. Write your own publisher the same way: parse and validate the JSON, never
// interpolate its fields into a command line.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PUBLISHER =
  process.env.SWARM_DEPLOY_PUBLISHER ?? fileURLToPath(new URL('./publisher.mjs', import.meta.url))
const PUBLISH_TIMEOUT = 60_000

// May run more than once for the same link and artifact (a retry after HOOK_FAILED, or a
// repeated link request), so the publisher must be idempotent on `artifact.transferId`.
export function afterLink({ link, artifact, status, trigger }) {
  return run(
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

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: PUBLISH_TIMEOUT
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`publisher exited with ${code ?? signal}`))
    })
    // The publisher may exit before it has read everything; its exit status decides.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
