/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import fs from '#fs'
import path from '#path'
import * as api from '../../dist/index.js'

declare const require: (id: string) => unknown

const repoRoot = path.join(__dirname, '../..')
const testDist = path.join(repoRoot, '.test-dist')
const dist = path.join(repoRoot, 'dist')

interface PackageScripts {
  scripts: Record<string, string>
}

function listCompiledFiles(directory: string): string[] {
  const found: string[] = []

  for (const entry of fs.readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (fs.statSync(absolute).isDirectory()) {
      found.push(...listCompiledFiles(absolute))
    } else if (entry.endsWith('.js')) {
      found.push(absolute)
    }
  }

  return found
}

function relativeRequires(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /require\((["'])((?:\.|\.\.)\/[^"']*)\1\)/g
  let match = pattern.exec(source)

  while (match !== null) {
    specifiers.push(match[2])
    match = pattern.exec(source)
  }

  return specifiers
}

test('compiled package import maps resolve from package scope', (t) => {
  t.is(typeof api.Server, 'function')
  t.is(typeof api.Client, 'function')
  t.is(typeof (require('#crypto') as { createHash: unknown }).createHash, 'function')
  t.is(typeof (require('#events') as { EventEmitter: unknown }).EventEmitter, 'function')
  t.is(typeof (require('#fs') as { readFile: unknown }).readFile, 'function')
  t.is(typeof (require('#os') as { platform: unknown }).platform, 'function')
  t.is(typeof (require('#path') as { join: unknown }).join, 'function')
  t.is(typeof (require('#process') as { env: unknown }).env, 'object')
})

test('compiled tests resolve only compiled output, never TypeScript sources', (t) => {
  const compiled = listCompiledFiles(testDist)
  t.ok(compiled.length > 0, 'compiled test output must exist')

  const offenders: string[] = []

  for (const file of compiled) {
    const source = fs.readFileSync(file, 'utf8')

    for (const specifier of relativeRequires(source)) {
      const resolved = path.resolve(path.dirname(file), specifier)
      const compiledTest = resolved === testDist || resolved.startsWith(testDist + path.sep)
      const compiledPackage = resolved === dist || resolved.startsWith(dist + path.sep)
      const label = `${path.relative(repoRoot, file)} -> ${specifier}`

      if (!compiledTest && !compiledPackage) offenders.push(label)
      else if (!fs.existsSync(resolved)) offenders.push(`${label} (missing)`)
    }
  }

  t.alike(offenders, [], `compiled requires must stay inside .test-dist or dist: ${offenders}`)
})

test('runtime scripts and CI execute only compiled test output', (t) => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ) as PackageScripts
  t.is(pkg.scripts['build:test'], 'rm -rf .test-dist && tsc -p tsconfig.test.json')
  t.is(
    pkg.scripts['test:node'],
    'npm run build && npm run build:test && brittle-node .test-dist/run.js'
  )
  t.is(
    pkg.scripts['test:bare'],
    'npm run build && npm run build:test && brittle-bare .test-dist/run.js'
  )

  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  t.ok(
    workflow.includes('npx brittle-node .test-dist/unit/protocol-property.test.js'),
    'the property job must run emitted JavaScript'
  )
  t.absent(
    /brittle-(?:node|bare) (?!\.test-dist\/)/.test(workflow),
    'no CI job may run tests outside .test-dist'
  )
  t.ok(workflow.includes('npm run build && npm run test:types'), 'CI must compile before linting')
})
