import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const validator = fileURLToPath(new URL('./validate-release-tag.mjs', import.meta.url))
const workflow = fs.readFileSync(
  new URL('../.github/workflows/publish.yml', import.meta.url),
  'utf8'
)
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const reviewedAction = '146b86c4d0237c124df06ecc992ddf2c585b3405'

function validate(tag) {
  return spawnSync(process.execPath, [validator], {
    env: { ...process.env, GITHUB_REF_NAME: tag },
    encoding: 'utf8'
  })
}

const valid = validate('v0.1.0')
assert.equal(valid.status, 0, valid.stderr)

for (const tag of ['0.1.0', 'v0.1', 'v0.1.0-beta.1', 'v0.1.1', 'v01.1.0', '']) {
  const invalid = validate(tag)
  assert.notEqual(invalid.status, 0, `unexpectedly accepted release tag ${JSON.stringify(tag)}`)
  assert.match(invalid.stderr, /release tag/i)
}

assert.deepEqual(packageJson.publishConfig, { access: 'public', provenance: true })
assert.match(workflow, /contents:\s+write/)
assert.match(workflow, /id-token:\s+write/)
assert.match(workflow, /NPM_CONFIG_PROVENANCE:\s+['"]?true['"]?/)
assert.match(workflow, /git fetch --no-tags origin main/)
assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/)
assert.doesNotMatch(workflow, /^\s*run:\s+npm publish\b/m)
assert.doesNotMatch(workflow, /holepunchto\/actions\/publish@v1\b/)
assert.match(workflow, new RegExp(`holepunchto/actions/publish@${reviewedAction}`))
for (const duplicate of [
  'npm run test:node',
  'npm run test:bare',
  'protocol-property.test',
  'npm run build:test',
  'npm run lint',
  'setup-bare'
]) {
  assert.ok(!workflow.includes(duplicate), `publish workflow duplicates CI gate: ${duplicate}`)
}

const ordered = [
  'Validate release tag',
  'git merge-base --is-ancestor',
  'npm ci',
  'npm run build',
  'npm run test:types',
  'npm run validate:package',
  'npm run test:package',
  `holepunchto/actions/publish@${reviewedAction}`
]
let previous = -1
for (const marker of ordered) {
  const index = workflow.indexOf(marker)
  assert.ok(index > previous, `publish workflow step missing or out of order: ${marker}`)
  previous = index
}

console.log('release validation: 1 accepted, 6 rejected, workflow policy passed')
