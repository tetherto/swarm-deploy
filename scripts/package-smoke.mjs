import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-deploy-package-'))
let tarball = null

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: consumer,
    encoding: 'utf8',
    ...options
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`
  )
  return result
}

try {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  for (const snippet of [
    'npm install @tetherto/swarm-deploy',
    'npm install --global @tetherto/swarm-deploy',
    'swarm-deploy topic --seed-file server.seed',
    'swarm-deploy upload',
    "require('@tetherto/swarm-deploy')",
    "from '@tetherto/swarm-deploy'"
  ]) {
    assert.ok(readme.includes(snippet), `README missing installed-package example: ${snippet}`)
  }
  assert.ok(!readme.includes('npx swarm-deploy'), 'README must use the installed global CLI')
  const primaryReadme = readme.split('## Contributor development')[0]
  assert.ok(!primaryReadme.includes('node dist/'), 'primary README must not invoke checkout dist')
  assert.ok(!primaryReadme.includes('bare dist/'), 'primary README must not invoke checkout dist')

  const packed = run('npm', ['pack', '--json'], { cwd: root })
  const [manifest] = JSON.parse(packed.stdout)
  assert.equal(manifest.name, '@tetherto/swarm-deploy')
  assert.equal(manifest.version, '0.1.0')
  assert.ok(manifest.size <= 512 * 1024, `packed size ${manifest.size} exceeds 512 KiB`)
  assert.ok(
    manifest.unpackedSize <= 2 * 1024 * 1024,
    `unpacked size ${manifest.unpackedSize} exceeds 2 MiB`
  )

  tarball = path.join(root, manifest.filename)
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]))
  const requiredTopLevel = [
    'CHANGELOG.md',
    'LICENSE.md',
    'NOTICE.md',
    'README.md',
    'RELEASING.md',
    'SECURITY.md',
    'package.json'
  ]
  for (const file of requiredTopLevel) assert.ok(entries.has(file), `missing ${file}`)
  for (const file of entries.keys()) {
    assert.ok(
      requiredTopLevel.includes(file) || /^dist\/.+\.(?:d\.ts|js|js\.map)$/.test(file),
      `unexpected packed path ${file}`
    )
  }

  const javascript = [...entries.keys()].filter(
    (file) => file.startsWith('dist/') && file.endsWith('.js')
  )
  assert.ok(javascript.length > 0, 'package contains no runtime JavaScript')
  for (const file of javascript) {
    assert.ok(entries.has(`${file}.map`), `missing source map for ${file}`)
    assert.ok(entries.has(file.replace(/\.js$/, '.d.ts')), `missing declaration for ${file}`)
  }
  assert.equal(entries.get('dist/bin/swarm-deploy.js').mode, 0o755, 'CLI is not executable')

  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'swarm-deploy-consumer', private: true, type: 'commonjs' })
  )
  run('npm', [
    'install',
    tarball,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock'
  ])

  const loadProbe =
    "const api = require('@tetherto/swarm-deploy'); if (typeof api.Server !== 'function') process.exit(1)"
  const importProbe =
    "import('@tetherto/swarm-deploy').then(api => { if (typeof api.Client !== 'function') process.exit(1) }, err => { console.error(err); process.exit(1) })"
  run(process.execPath, ['-e', loadProbe])
  run(process.execPath, ['--input-type=module', '-e', importProbe])
  run('bare', ['-e', loadProbe])
  run('bare', ['-e', importProbe])

  const packageRoot = path.join(consumer, 'node_modules/@tetherto/swarm-deploy')
  const cliModule = path.join(packageRoot, 'dist/bin/swarm-deploy.js')
  const executable = path.join(consumer, 'node_modules/.bin/swarm-deploy')
  run(executable, ['--help'])
  run(process.execPath, [cliModule, '--help'])
  run('bare', [cliModule, '--help'])

  const seedFile = path.join(consumer, 'consumer.seed')
  const generated = run(executable, ['keygen', '--out', seedFile])
  assert.match(generated.stdout.trim(), /^[0-9a-f]{64}$/)
  const secret = fs.readFileSync(seedFile, 'utf8').trim()
  assert.match(secret, /^[0-9a-f]{64}$/)
  assert.notEqual(generated.stdout.trim(), secret)
  assert.ok(
    !`${generated.stdout}${generated.stderr}`.includes(secret),
    'keygen printed seed material'
  )
  assert.equal(fs.statSync(seedFile).mode & 0o777, 0o600, 'seed permissions are not owner-only')

  const topic = run(executable, ['topic', '--seed-file', seedFile])
  assert.match(topic.stdout, /^[0-9a-f]{64}\n$/)
  assert.ok(!`${topic.stdout}${topic.stderr}`.includes(secret), 'topic printed seed material')

  const before = fs.readFileSync(seedFile)
  const overwrite = spawnSync(executable, ['keygen', '--out', seedFile], {
    cwd: consumer,
    encoding: 'utf8'
  })
  assert.equal(overwrite.status, 2, overwrite.stderr)
  assert.deepEqual(fs.readFileSync(seedFile), before, 'keygen overwrote the existing seed')
  assert.ok(
    !`${overwrite.stdout}${overwrite.stderr}`.includes(secret),
    'overwrite failure printed seed material'
  )

  const globalPrefix = path.join(consumer, 'global')
  run('npm', [
    'install',
    '--global',
    '--prefix',
    globalPrefix,
    tarball,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund'
  ])
  const globalBin = path.join(globalPrefix, 'bin/swarm-deploy')
  run(globalBin, ['--help'])
  const globalTopic = run(globalBin, ['topic', '--seed-file', seedFile])
  assert.equal(globalTopic.stdout, topic.stdout)

  console.log(
    `package smoke: ${manifest.entryCount} files, ${manifest.size} packed bytes, ${manifest.unpackedSize} unpacked bytes`
  )
} finally {
  fs.rmSync(consumer, { recursive: true, force: true })
  if (tarball) fs.rmSync(tarball, { force: true })
}
