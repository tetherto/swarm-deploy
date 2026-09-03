/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const packageRequire = createRequire(__filename)
const repoRoot = path.join(__dirname, '../..')

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
  t.not(fs.existsSync(stale), 'stale artifact must be removed by clean build')
})
