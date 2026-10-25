// An example publisher for hooks.mjs: reads one JSON request on stdin and records which
// artifact each link currently publishes in $SWARM_DEPLOY_PUBLISH_DIR/<link>.json.
// Replace `publish` with a real deployment step; keep the validation and the idempotency.
// Diagnostics go to stderr, and a non-zero exit makes the server answer HOOK_FAILED.
import fs from 'node:fs/promises'
import path from 'node:path'

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SHA256 = /^[0-9a-f]{64}$/

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Everything below this check is built from validated fields only.
function validate(request) {
  const artifact = request?.artifact
  if (
    request?.version !== 1 ||
    !SAFE_NAME.test(request.link) ||
    !SAFE_NAME.test(request.target) ||
    !SAFE_NAME.test(artifact?.name) ||
    !SHA256.test(artifact?.transferId) ||
    !SHA256.test(artifact?.sha256)
  ) {
    throw new Error('invalid publish request')
  }
  return request
}

async function publish(directory, request) {
  const file = path.join(directory, `${request.link}.json`)
  let published = null
  try {
    published = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Idempotent: this link already publishes this exact artifact (a retry, or an UNCHANGED relink).
  if (published?.artifact?.transferId === request.artifact.transferId) {
    console.error(`${request.link} already publishes ${request.target}`)
    return
  }
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, JSON.stringify(request, null, 2) + '\n')
  await fs.rename(temporary, file)
  console.error(`${request.link} now publishes ${request.target}`)
}

async function main() {
  const directory = process.env.SWARM_DEPLOY_PUBLISH_DIR
  if (!directory) throw new Error('SWARM_DEPLOY_PUBLISH_DIR is required')
  await publish(directory, validate(await readInput()))
}

main().catch((error) => {
  console.error(`publisher failed: ${error.message}`)
  process.exitCode = 1
})
