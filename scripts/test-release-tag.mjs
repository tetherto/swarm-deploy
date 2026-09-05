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
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version)
assert.ok(versionMatch, `package version is not stable semver: ${packageJson.version}`)
const [, major, minor, patch] = versionMatch

function parsePublishJob(source) {
  const lines = source.split('\n')
  const scalar = (value) => value.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '')
  const jobStart = lines.indexOf('  publish:')
  assert.notEqual(jobStart, -1, 'publish job is missing')
  const stepsStart = lines.indexOf('    steps:', jobStart)
  assert.notEqual(stepsStart, -1, 'publish steps are missing')

  const values = (section, indent) => {
    const start = lines.indexOf(`${' '.repeat(indent)}${section}:`, jobStart)
    assert.notEqual(start, -1, `${section} section is missing`)
    const result = {}
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index]
      if (!line.startsWith(' '.repeat(indent + 2))) break
      const match = /^\s+([^:]+):\s*(.*)$/.exec(line)
      if (match) result[match[1]] = scalar(match[2])
    }
    return result
  }

  const steps = []
  for (let index = stepsStart + 1; index < lines.length; index++) {
    const match = /^      - (name|uses|run):\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const step = { [match[1]]: scalar(match[2]) }
    if (match[1] === 'name') {
      const next = /^        (uses|run):\s*(.*)$/.exec(lines[index + 1] || '')
      if (next) {
        step[next[1]] = scalar(next[2])
        index++
      }
    }
    if (step.run === '|') {
      const commands = []
      while (/^          \S/.test(lines[index + 1] || '')) {
        commands.push(lines[++index].trim())
      }
      step.run = commands.join('\n')
    }
    steps.push(step)
  }
  return { env: values('env', 4), permissions: values('permissions', 4), steps }
}

function validate(tag) {
  return spawnSync(process.execPath, [validator], {
    env: { ...process.env, GITHUB_REF_NAME: tag },
    encoding: 'utf8'
  })
}

const validTag = `v${packageJson.version}`
const valid = validate(validTag)
assert.equal(valid.status, 0, valid.stderr)

const invalidTags = [
  packageJson.version,
  `v${major}.${minor}`,
  `${validTag}-beta.1`,
  `v${major}.${minor}.${Number(patch) + 1}`,
  `v0${major}.${minor}.${patch}`,
  ''
]
for (const tag of invalidTags) {
  const invalid = validate(tag)
  assert.notEqual(invalid.status, 0, `unexpectedly accepted release tag ${JSON.stringify(tag)}`)
  assert.match(invalid.stderr, /release tag/i)
}

assert.deepEqual(packageJson.publishConfig, { access: 'public', provenance: true })
const publish = parsePublishJob(workflow)
assert.deepEqual(publish.permissions, { contents: 'write', 'id-token': 'write' })
assert.equal(publish.env.NPM_CONFIG_PROVENANCE, 'true')
const ancestry = publish.steps.find((step) => step.name === 'Verify tagged commit is on main')
assert.deepEqual(
  ancestry?.run?.split('\n'),
  ['git fetch --no-tags origin main', 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main'],
  JSON.stringify(publish.steps)
)
assert.ok(
  publish.steps.some((step) => step.uses === `holepunchto/actions/publish@${reviewedAction}`)
)
assert.ok(!publish.steps.some((step) => step.run === 'npm publish'))
assert.ok(!publish.steps.some((step) => step.uses === 'holepunchto/actions/publish@v1'))
for (const duplicate of [
  'npm run test:node',
  'npm run test:bare',
  'protocol-property.test',
  'npm run build:test',
  'npm run lint',
  'setup-bare'
]) {
  assert.ok(
    !publish.steps.some((step) => step.run?.includes(duplicate)),
    `publish workflow duplicates CI gate: ${duplicate}`
  )
}

const policy = [
  { uses: `holepunchto/actions/checkout@${reviewedAction}` },
  { uses: `holepunchto/actions/setup-node@${reviewedAction}` },
  { name: 'Validate release tag', run: 'node scripts/validate-release-tag.mjs' },
  { name: 'Verify tagged commit is on main' },
  { run: 'npm ci' },
  { name: 'Build untracked distribution', run: '|' },
  { run: 'npm run test:types' },
  { run: 'npm run validate:package' },
  { run: 'npm run test:package' },
  { uses: `holepunchto/actions/publish@${reviewedAction}` }
]
assert.equal(publish.steps.length, policy.length)
for (let index = 0; index < policy.length; index++) {
  for (const [key, expected] of Object.entries(policy[index])) {
    if (expected === '|') assert.ok(publish.steps[index].run.includes('npm run build'))
    else assert.equal(publish.steps[index][key], expected, `unexpected publish step ${index}`)
  }
}

console.log(
  `release validation: ${validTag} accepted, ${invalidTags.length} rejected, workflow policy passed`
)
