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

test('controls dist stays free of the tree snapshot module and a direct fs import', (t) => {
  const controls = readDistModule('controls')
  t.ok(!/require\("\.\/tree\.js"\)/.test(controls), 'controls must not require tree.js')
  t.ok(/require\("\.\/tree-path\.js"\)/.test(controls), 'controls must require tree-path.js')
  t.ok(!controls.includes('#fs'), 'controls must not import fs')
  t.ok(!/MAX_TREE_ENTRIES\s*=\s*1e4|MAX_TREE_ENTRIES\s*=\s*10_?000/.test(controls))
  const treePath = readDistModule('tree-path')
  t.ok(/MAX_TREE_ENTRIES\s*=\s*(10000|1e4|10_000)/.test(treePath), 'tree-path owns the limit')
})

test('loading controls alone never loads tree.js or hash.js', (t) => {
  if (typeof process.versions?.node !== 'string') {
    t.pass('load-order subprocess probe is Node-only')
    return
  }
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const probe = `
    const Module = require('module')
    const loaded = []
    const orig = Module._load
    Module._load = function (request, parent, isMain) {
      loaded.push(request)
      return orig.call(this, request, parent, isMain)
    }
    const controls = require(process.env.SWARM_DEPLOY_TEST_MODULE)
    process.stdout.write(
      JSON.stringify({
        loaded: loaded.filter((p) => /tree\\.js$|hash\\.js$/.test(p)),
        limit: typeof controls.encodeTreeMetadataRecord
      })
    )
  `
  const result = JSON.parse(
    execFileSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SWARM_DEPLOY_TEST_MODULE: path.join(distTarProtocol, 'controls.js')
      }
    }).trim()
  ) as { loaded: string[]; limit: string }
  t.is(result.limit, 'function', 'controls loaded and exposes the tree record codec')
  t.alike(result.loaded, [], 'controls must not load tree.js or hash.js')
})

test('tree.js re-exports the entry limit owned by tree-path', (t) => {
  const { MAX_TREE_ENTRIES: fromTree } =
    require('../../dist/tar-protocol/tree.js') as typeof import('../../dist/tar-protocol/tree.js')
  const { MAX_TREE_ENTRIES: fromPath } =
    require('../../dist/tar-protocol/tree-path.js') as typeof import('../../dist/tar-protocol/tree-path.js')
  t.is(fromTree, 10_000)
  t.is(fromPath, fromTree)
})
