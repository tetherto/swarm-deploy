/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.join(__dirname, '../..')

test('dist bin entry exists with node shebang', (t) => {
  const binPath = path.join(repoRoot, 'dist/bin/swarm-deploy.js')
  t.ok(fs.existsSync(binPath))
  const source = fs.readFileSync(binPath, 'utf8')
  t.ok(source.startsWith('#!/usr/bin/env node'))
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
