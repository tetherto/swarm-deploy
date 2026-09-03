import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const validator = fileURLToPath(new URL('./validate-release-tag.mjs', import.meta.url))

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

console.log('release tag validation: 1 accepted, 6 rejected')
