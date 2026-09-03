/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const packageRequire = createRequire(__filename)
const repoRoot = path.join(__dirname, '../..')

interface CompileResult {
  status: number | null
  output: string
  relativePath: string
}

/**
 * Type-checks deliberately unsound test code through the real
 * `tsconfig.test.json` settings and include globs, so a loosened compiler
 * option cannot pass unnoticed. The scratch file lives inside `test/` because
 * that is the only place the project include glob reaches.
 */
function compileThroughTestProject(source: string): CompileResult {
  const scratchDir = path.join(repoRoot, 'test', '__negative-control__')
  const scratchFile = path.join(scratchDir, 'unsound.ts')
  const relativePath = path.relative(repoRoot, scratchFile).split(path.sep).join('/')

  try {
    fs.mkdirSync(scratchDir, { recursive: true })
    fs.writeFileSync(scratchFile, source)
    const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.test.json', '--noEmit'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}`, relativePath }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
}

function listCompiledTests(directory: string): string[] {
  const found: string[] = []

  for (const entry of fs.readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (fs.statSync(absolute).isDirectory()) found.push(...listCompiledTests(absolute))
    else if (entry.endsWith('.js')) found.push(absolute)
  }

  return found
}

test('dist bin entry exists with node shebang', (t) => {
  const binPath = path.join(repoRoot, 'dist/bin/swarm-deploy.js')
  t.ok(fs.existsSync(binPath))
  const source = fs.readFileSync(binPath, 'utf8')
  t.ok(source.startsWith('#!/usr/bin/env node'))
})

test('package exports and entry fields target dist only', (t) => {
  const pkg = packageRequire('../../package.json') as {
    main: string
    types: string
    bin: Record<string, string>
    exports: { '.': { types: string; import: string; require: string; default: string } }
  }
  t.is(pkg.main, './dist/index.js')
  t.is(pkg.types, './dist/index.d.ts')
  t.is(pkg.bin['swarm-deploy'], './dist/bin/swarm-deploy.js')
  t.is(pkg.exports['.'].types, './dist/index.d.ts')
  t.is(pkg.exports['.'].import, './dist/index.js')
  t.is(pkg.exports['.'].require, './dist/index.js')
  t.is(pkg.exports['.'].default, './dist/index.js')
})

test('native ESM import resolves installed package export', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-deploy-esm-'))
  const pack = spawnSync('npm', ['pack', '--silent'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  t.is(pack.status, 0, pack.stderr)
  const tarballPath = path.join(repoRoot, pack.stdout.trim())

  try {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'esm-import-probe', private: true, type: 'module' })
    )
    const install = spawnSync('npm', ['install', tarballPath, '--silent'], {
      cwd: tmpDir,
      stdio: 'pipe'
    })
    t.is(install.status, 0, install.stderr?.toString())

    const probe = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `const api = await import('@tetherto/swarm-deploy')
const requireApi = (await import('node:module')).createRequire(import.meta.url)('@tetherto/swarm-deploy')
console.log(JSON.stringify({
  Server: typeof api.Server,
  Client: typeof api.Client,
  ERRORS: typeof api.ERRORS,
  PROTOCOL_VERSION: typeof api.PROTOCOL_VERSION,
  SwarmDeployError: typeof api.SwarmDeployError,
  sameModule: api.Server === requireApi.Server
}))`
      ],
      { cwd: tmpDir, encoding: 'utf8' }
    )
    t.is(probe.status, 0, `${probe.stderr}${probe.stdout}`)
    const parsed = JSON.parse(probe.stdout.trim()) as Record<string, string | boolean>
    t.is(parsed.Server, 'function')
    t.is(parsed.Client, 'function')
    t.is(parsed.ERRORS, 'object')
    t.is(parsed.PROTOCOL_VERSION, 'number')
    t.is(parsed.SwarmDeployError, 'function')
    t.is(parsed.sameModule, true, 'ESM and require must resolve the same export')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(tarballPath, { force: true })
  }
})

test('npm pack excludes src test and test-dist paths', (t) => {
  const { stdout, stderr } = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  const output = `${stdout}${stderr}`
  t.ok(output.includes('dist/index.js'))
  t.ok(output.includes('dist/index.d.ts'))
  t.ok(output.includes('dist/bin/swarm-deploy.js'))
  t.ok(!output.includes('src/'), 'pack output must exclude src/')
  t.ok(!output.includes('test/'), 'pack output must exclude test/')
  t.ok(!output.includes('.test-dist/'), 'pack output must exclude .test-dist/')
})

test('production build removes stale dist artifacts', (t) => {
  const distDir = path.join(repoRoot, 'dist')
  const stale = path.join(distDir, '__stale-artifact__.js')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(stale, 'module.exports = {}')
  t.ok(fs.existsSync(stale))
  execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' })
  t.absent(fs.existsSync(stale), 'stale artifact must be removed by clean build')
})

test('test build removes stale compiled test artifacts', (t) => {
  const testDist = path.join(repoRoot, '.test-dist')
  const stale = path.join(testDist, '__stale-test-artifact__.js')
  fs.mkdirSync(testDist, { recursive: true })
  fs.writeFileSync(stale, 'module.exports = {}')
  t.ok(fs.existsSync(stale))
  execSync('npm run build:test', { cwd: repoRoot, stdio: 'pipe' })
  t.absent(fs.existsSync(stale), 'stale compiled test artifact must be removed by clean build')
  t.ok(fs.existsSync(path.join(testDist, 'run.js')), 'clean build must re-emit the runner')
})

test('tracked test sources contain no JavaScript', (t) => {
  const tracked = execSync('git ls-files -- test', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry.length > 0)
  t.ok(tracked.length > 0, 'test sources must be tracked')

  const javascript = tracked.filter((entry) => entry.endsWith('.js'))
  t.alike(javascript, [], `tracked test JavaScript must not exist: ${javascript}`)

  const generated = execSync('git ls-files -- dist .test-dist', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry.length > 0)
  t.alike(generated, [], `generated output must not be tracked: ${generated}`)
})

test('project test compiler settings reject unsound test code', (t) => {
  // Both statements only fail while `strict` is on: the first needs
  // `noImplicitAny`, the second needs `strictNullChecks`.
  const compiled = compileThroughTestProject(
    [
      'export function size(value) {',
      '  return value.length',
      '}',
      '',
      'export const name: string = null',
      ''
    ].join('\n')
  )

  t.not(compiled.status, 0, 'the project test config must reject the negative control')
  t.ok(
    compiled.output.includes(compiled.relativePath),
    `the failure must name the offending file: ${compiled.output}`
  )
  t.ok(
    compiled.output.includes('error TS7006'),
    `implicit any must be rejected: ${compiled.output}`
  )
  t.ok(
    compiled.output.includes('error TS2322'),
    `null assignment must be rejected: ${compiled.output}`
  )
})

test('brittle comparison assertions reject drifted expectations', (t) => {
  const compiled = compileThroughTestProject(
    [
      'import test from "brittle"',
      '',
      'declare const code: "ERR_ABORTED" | "ERR_CHECKSUM_MISMATCH"',
      '',
      'test("union drift", (t) => {',
      '  t.is(code, "ERR_CHEKSUM_MISMATCH")',
      '})',
      ''
    ].join('\n')
  )

  t.not(compiled.status, 0, 'a misspelled expected union member must not type-check')
  t.ok(
    compiled.output.includes(compiled.relativePath),
    `the failure must name the offending file: ${compiled.output}`
  )
  t.ok(
    compiled.output.includes('ERR_CHEKSUM_MISMATCH'),
    `the failure must name the drifted expectation: ${compiled.output}`
  )
})

test('compiled tests emit source maps that point back to TypeScript', (t) => {
  const testDist = path.join(repoRoot, '.test-dist')
  const compiled = listCompiledTests(testDist)
  t.ok(compiled.length > 0, 'compiled test output must exist')

  const offenders: string[] = []

  for (const file of compiled) {
    const label = path.relative(repoRoot, file)
    const mapPath = `${file}.map`

    if (!fs.readFileSync(file, 'utf8').includes(`//# sourceMappingURL=${path.basename(mapPath)}`)) {
      offenders.push(`${label} (no sourceMappingURL)`)
      continue
    }
    if (!fs.existsSync(mapPath)) {
      offenders.push(`${label} (no source map)`)
      continue
    }

    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as {
      version: number
      sources: string[]
      mappings: string
    }

    if (map.version !== 3) offenders.push(`${label} (unexpected map version ${map.version})`)
    if (map.mappings.length === 0) offenders.push(`${label} (empty mappings)`)

    for (const source of map.sources) {
      const resolved = path.resolve(path.dirname(mapPath), source)
      const inTestSources = resolved.startsWith(path.join(repoRoot, 'test') + path.sep)

      if (!source.endsWith('.ts')) offenders.push(`${label} -> ${source} (not TypeScript)`)
      else if (!inTestSources) offenders.push(`${label} -> ${source} (outside test sources)`)
      else if (!fs.existsSync(resolved)) offenders.push(`${label} -> ${source} (missing source)`)
    }
  }

  t.alike(offenders, [], `every compiled test must map back to its source: ${offenders}`)
})

test('source-mapped stacks report TypeScript test frames', (t) => {
  const probe = spawnSync(
    'node',
    [
      '--enable-source-maps',
      '-e',
      `const files = require(${JSON.stringify(path.join(repoRoot, '.test-dist/helpers/files.js'))})
try {
  files.digestBuffer(null)
} catch (err) {
  console.log(err.stack)
}`
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )

  t.is(probe.status, 0, probe.stderr)
  t.ok(
    probe.stdout.includes(`${path.join('test', 'helpers', 'files.ts')}:`),
    `the stack must name the TypeScript helper: ${probe.stdout}`
  )
  t.absent(
    probe.stdout.includes(`${path.join('.test-dist', 'helpers', 'files.js')}:`),
    `the stack must not name the emitted JavaScript: ${probe.stdout}`
  )
})
