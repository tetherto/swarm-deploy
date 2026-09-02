/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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
    exports: { '.': { types: string; require: string } }
  }
  t.is(pkg.main, './dist/index.js')
  t.is(pkg.types, './dist/index.d.ts')
  t.is(pkg.bin['swarm-deploy'], './dist/bin/swarm-deploy.js')
  t.is(pkg.exports['.'].require, './dist/index.js')
  t.is(pkg.exports['.'].types, './dist/index.d.ts')
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
