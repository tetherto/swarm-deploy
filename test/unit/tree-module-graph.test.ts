/// <reference path="../types/brittle.d.ts" />

import fs from '#fs'
import path from '#path'
import process from '#process'
import test from 'brittle'

const distTarProtocol = path.join(__dirname, '../../dist/tar-protocol')

function readDistModule(name: string): string {
  return fs.readFileSync(path.join(distTarProtocol, `${name}.js`), 'utf8')
}

test('ustar dist does not depend on tree snapshot module', (t) => {
  const ustar = readDistModule('ustar')
  t.ok(!/require\("\.\/tree\.js"\)/.test(ustar), 'ustar must not require tree.js')
  t.ok(/require\("\.\/tree-path\.js"\)/.test(ustar), 'ustar must require tree-path.js')
})

test('tree-path dist stays free of ustar and tree', (t) => {
  const treePath = readDistModule('tree-path')
  t.ok(
    !/require\("\.\/(tree|ustar)\.js"\)/.test(treePath),
    'tree-path must not require tree or ustar'
  )
  t.ok(!treePath.includes('#fs'), 'tree-path must not import fs')
})

test('ustar-only load order never pulls tree.js', (t) => {
  if (typeof process.versions?.node !== 'string') {
    t.pass('load-order subprocess probe is Node-only')
    return
  }
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const node = process.execPath
  const ustarPath = path.join(distTarProtocol, 'ustar.js')
  const treeModule = path.join(distTarProtocol, 'tree.js')
  const loadProbe = `
    const Module = require('module')
    const loaded = new Set()
    const orig = Module._load
    Module._load = function (request, parent, isMain) {
      loaded.add(request)
      return orig.call(this, request, parent, isMain)
    }
    require(process.env.SWARM_DEPLOY_TEST_MODULE)
    process.stdout.write(JSON.stringify([...loaded].filter((p) => /tree\\.js$|hash\\.js$/.test(p))))
  `
  const loadedOnlyUstar = JSON.parse(
    execFileSync(node, ['-e', loadProbe], {
      encoding: 'utf8',
      env: { ...process.env, SWARM_DEPLOY_TEST_MODULE: ustarPath }
    }).trim()
  ) as string[]
  t.alike(loadedOnlyUstar, [], 'loading ustar alone must not load tree.js or hash.js')

  const orderProbe = `
    const Module = require('module')
    const loaded = []
    const orig = Module._load
    Module._load = function (request, parent, isMain) {
      loaded.push(request)
      return orig.call(this, request, parent, isMain)
    }
    require(process.env.SWARM_DEPLOY_TEST_MODULE_A)
    require(process.env.SWARM_DEPLOY_TEST_MODULE_B)
    const isLeaf = (request, leaf) =>
      request === leaf ||
      request === './' + leaf ||
      request.endsWith('/' + leaf) ||
      request.endsWith('\\\\' + leaf)
    process.stdout.write(
      JSON.stringify(loaded.filter((p) => isLeaf(p, 'ustar.js') || isLeaf(p, 'tree-path.js') || isLeaf(p, 'tree.js')))
    )
  `
  const ustarThenTree = JSON.parse(
    execFileSync(node, ['-e', orderProbe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SWARM_DEPLOY_TEST_MODULE_A: ustarPath,
        SWARM_DEPLOY_TEST_MODULE_B: treeModule
      }
    }).trim()
  ) as string[]
  const ends = (request: string, leaf: string): boolean =>
    request === leaf ||
    request === `./${leaf}` ||
    request.endsWith(`/${leaf}`) ||
    request.endsWith(`\\${leaf}`)
  t.ok(ends(ustarThenTree[0] ?? '', 'ustar.js'), 'ustar loads first')
  t.ok(
    ustarThenTree.some((p) => ends(p, 'tree-path.js')),
    'tree-path shared by ustar'
  )
  t.ok(
    ustarThenTree.some((p) => ends(p, 'tree.js')),
    'tree loads after ustar'
  )

  const treeThenUstar = JSON.parse(
    execFileSync(node, ['-e', orderProbe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SWARM_DEPLOY_TEST_MODULE_A: treeModule,
        SWARM_DEPLOY_TEST_MODULE_B: ustarPath
      }
    }).trim()
  ) as string[]
  t.ok(ends(treeThenUstar[0] ?? '', 'tree.js'), 'tree loads first when requested first')
  t.ok(
    treeThenUstar.some((p) => ends(p, 'ustar.js')),
    'ustar loads after tree'
  )
})
