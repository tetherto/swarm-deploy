/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import process from '#process'
import {
  Client,
  ERRORS,
  keyPairFromSeed,
  type AfterLinkContext,
  type ServerOptions
} from '../../dist/index.js'
import { historyName } from '../../dist/files.js'
import { createTempDir, stateDirFor } from '../helpers/files.js'
import { Server } from '../helpers/server.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { writeTree, type TreeSpec } from '../helpers/trees.js'

const SERVER_SEED = b4a.alloc(32, 0xe1)
const CLIENT_SEED = b4a.alloc(32, 0xe2)

type UploadResult = Awaited<ReturnType<Client['upload']>>

function spec(version: number, files = 3): TreeSpec {
  const tree: TreeSpec = { 'nested/': '' }
  for (let index = 0; index < files; index++) {
    tree[`v${version}-${index}.bin`] = `v${version}-${index}`
  }
  tree[`nested/inner-${version}.txt`] = `inner ${version}`
  return tree
}

function shape(tree: TreeSpec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [relative, content] of Object.entries(tree)) {
    const parts = relative.split('/').filter(Boolean)
    for (let depth = 1; depth < parts.length; depth++) {
      out[`${parts.slice(0, depth).join('/')}/`] = ''
    }
    if (relative.endsWith('/')) out[`${parts.join('/')}/`] = ''
    else out[parts.join('/')] = content
  }
  return out
}

async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await fs.promises.readdir(root)).sort()) {
    const full = path.join(root, entry)
    const stat = await fs.promises.lstat(full)
    if (stat.isDirectory()) {
      out[`${prefix}${entry}/`] = ''
      Object.assign(out, await snapshot(full, `${prefix}${entry}/`))
    } else {
      out[`${prefix}${entry}`] = await fs.promises.readFile(full, 'utf8')
    }
  }
  return out
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function setup(t: Assert, options: Partial<ServerOptions> = {}) {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 64 * 1024,
    maxStagingBytes: 1024 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    ...options
  })
  const clients: Client[] = []
  // Each client runs one operation at a time, so a second connection is a second client.
  const connect = (clientOptions: { idleTimeout?: number } = {}): Client => {
    const client = new Client({
      seed: CLIENT_SEED,
      serverPublicKey: server.publicKey,
      connectTimeout: 5_000,
      idleTimeout: 20_000,
      dht: testnet.createNode(),
      ...clientOptions
    })
    clients.push(client)
    return client
  }
  t.teardown(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await server.close()
  })
  await server.listen()
  return { server, storage, testnet, connect, client: connect() }
}

/** A directory named `name` under a fixed parent folder, so equal content is an equal transfer. */
async function directory(t: Assert, name: string, tree: TreeSpec): Promise<string> {
  const target = path.join(await createTempDir(t), 'release', name)
  await writeTree(target, tree)
  return target
}

async function file(t: Assert, name: string, content: string): Promise<string> {
  const target = path.join(await createTempDir(t), 'release', name)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, content)
  return target
}

function idOf(result: UploadResult): string {
  return b4a.toString(result.transferId, 'hex')
}

async function retryWhileBusy(upload: () => Promise<UploadResult>): Promise<UploadResult> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return await upload()
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null
      if (code !== ERRORS.FILE_BUSY || Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

test('replacement is off by default: a changed file or directory under a taken name is refused', async (t) => {
  const { client, storage } = await setup(t)
  t.is((await client.upload(await directory(t, 'site', spec(1)))).status, 'COMMITTED')
  t.is((await client.upload(await file(t, 'notes.txt', 'one'))).status, 'COMMITTED')

  await t.exception(client.upload(await directory(t, 'site', spec(2))), {
    code: ERRORS.FILE_EXISTS
  })
  await t.exception(client.upload(await file(t, 'notes.txt', 'two')), { code: ERRORS.FILE_EXISTS })
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(1)))
  t.is(await fs.promises.readFile(path.join(storage, 'notes.txt'), 'utf8'), 'one')
})

test('allowReplace replaces managed files and whole directories and keeps the old ones as history', async (t) => {
  const { client, storage } = await setup(t, { allowReplace: true })
  const first = await client.upload(await directory(t, 'site', spec(1)))
  const second = await client.upload(await directory(t, 'site', spec(2)))
  t.is(first.status, 'COMMITTED')
  t.is(second.status, 'COMMITTED')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)), 'the new tree is published')
  t.alike(
    await snapshot(path.join(storage, historyName(idOf(first)))),
    shape(spec(1)),
    'the old tree, empty directory included, is the history copy'
  )

  const oldFile = await client.upload(await file(t, 'notes.txt', 'one'))
  const newFile = await client.upload(await file(t, 'notes.txt', 'two'))
  t.is(newFile.status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(storage, 'notes.txt'), 'utf8'), 'two')
  t.is(await fs.promises.readFile(path.join(storage, historyName(idOf(oldFile))), 'utf8'), 'one')

  // The same content again is already committed, and nothing moves.
  const again = await client.upload(await directory(t, 'site', spec(2)))
  t.is(again.status, 'ALREADY_COMMITTED')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)))
})

test('an unmanaged path is preserved even where every name may be replaced', async (t) => {
  const { client, storage } = await setup(t, { allowReplace: true })
  await writeTree(path.join(storage, 'operator'), { 'keep.txt': 'mine' })
  await fs.promises.writeFile(path.join(storage, 'operator.txt'), 'mine too')
  await fs.promises.mkdir(path.join(storage, 'elsewhere'))
  await fs.promises.symlink('elsewhere', path.join(storage, 'linked'))

  await t.exception(client.upload(await directory(t, 'operator', spec(1))), {
    code: ERRORS.FILE_EXISTS
  })
  await t.exception(client.upload(await file(t, 'operator.txt', 'new')), {
    code: ERRORS.FILE_EXISTS
  })
  await t.exception(client.upload(await directory(t, 'linked', spec(1))), {
    code: ERRORS.FILE_EXISTS
  })
  // A managed directory is never replaced by a file, nor a managed file by a directory.
  await client.upload(await directory(t, 'site', spec(1)))
  await client.upload(await file(t, 'doc', 'text'))
  await t.exception(client.upload(await file(t, 'site', 'now a file')), {
    code: ERRORS.FILE_EXISTS
  })
  await t.exception(client.upload(await directory(t, 'doc', spec(1))), {
    code: ERRORS.FILE_EXISTS
  })

  t.alike(await snapshot(path.join(storage, 'operator')), { 'keep.txt': 'mine' })
  t.is(await fs.promises.readFile(path.join(storage, 'operator.txt'), 'utf8'), 'mine too')
  t.is(await fs.promises.readlink(path.join(storage, 'linked')), 'elsewhere')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(1)))
  t.is(await fs.promises.readFile(path.join(storage, 'doc'), 'utf8'), 'text')
})

test('a managed directory that was changed on disk is preserved', async (t) => {
  const { client, storage } = await setup(t, { allowReplace: true })
  await client.upload(await directory(t, 'site', spec(1)))
  await fs.promises.writeFile(path.join(storage, 'site', 'added-by-hand.txt'), 'hand')
  await t.exception(client.upload(await directory(t, 'site', spec(2))), {
    code: ERRORS.FILE_EXISTS
  })
  t.is(await fs.promises.readFile(path.join(storage, 'site', 'added-by-hand.txt'), 'utf8'), 'hand')
  t.is(await exists(path.join(storage, 'site', 'v2-0.bin')), false)
})

test('a selector names what may be replaced: exact names, templates, and bare {version}', async (t) => {
  const { client, storage } = await setup(t, {
    allowReplace: ['beta-{version}', 'latest.json', '{version}']
  })
  const replaced = async (name: string, from: number, to: number): Promise<void> => {
    await client.upload(await directory(t, name, spec(from)))
    const result = await client.upload(await directory(t, name, spec(to)))
    t.is(result.status, 'COMMITTED', name)
    t.alike(await snapshot(path.join(storage, name)), shape(spec(to)), name)
  }
  await replaced('beta-1.0.0', 1, 2)
  await replaced('0.18.1', 1, 2)

  await client.upload(await file(t, 'latest.json', '{"v":1}'))
  t.is((await client.upload(await file(t, 'latest.json', '{"v":2}'))).status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(storage, 'latest.json'), 'utf8'), '{"v":2}')

  for (const name of ['prod-1.0.0', 'app']) {
    await client.upload(await directory(t, name, spec(1)))
    await t.exception(client.upload(await directory(t, name, spec(2))), {
      code: ERRORS.FILE_EXISTS
    })
    t.alike(await snapshot(path.join(storage, name)), shape(spec(1)), `${name} is not selected`)
  }
})

test('a legacy replaceNames entry replaces a managed directory as well as a file', async (t) => {
  const { client, storage } = await setup(t, { replaceNames: ['site'] })
  await client.upload(await directory(t, 'site', spec(1)))
  t.is((await client.upload(await directory(t, 'site', spec(2)))).status, 'COMMITTED')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)))
  await client.upload(await directory(t, 'other', spec(1)))
  await t.exception(client.upload(await directory(t, 'other', spec(2))), {
    code: ERRORS.FILE_EXISTS
  })
})

test('a reader of the public path never sees the directory missing or half published', async (t) => {
  const { client, storage } = await setup(t, { allowReplace: true })
  const versions = [1, 2, 3, 4, 5]
  // One directory listing resolves the public name once, so it is a single tree's complete
  // listing or it is a failure; a walk of several paths could straddle two replacements.
  const top = (version: number): string =>
    Object.keys(spec(version, 8))
      .filter((relative) => !relative.includes('/') || relative === 'nested/')
      .map((relative) => relative.replace(/\/$/, ''))
      .sort()
      .join('|')
  const known = new Set(versions.map(top))
  await client.upload(await directory(t, 'site', spec(1, 8)))

  const violations: string[] = []
  const state = { stop: false, reads: 0 }
  const site = path.join(storage, 'site')
  const reader = (async () => {
    while (!state.stop) {
      try {
        const seen = (await fs.promises.readdir(site)).sort().join('|')
        await fs.promises.lstat(site)
        state.reads++
        if (!known.has(seen)) violations.push(seen)
      } catch (error: unknown) {
        violations.push(`missing: ${String((error as { code?: unknown }).code)}`)
      }
      await sleep(0)
    }
  })()
  for (const version of versions.slice(1)) {
    t.is((await client.upload(await directory(t, 'site', spec(version, 8)))).status, 'COMMITTED')
  }
  state.stop = true
  await reader
  t.alike(violations, [], 'no read saw the name missing or a mix of two trees')
  t.ok(state.reads > 0, 'the reader ran while directories were exchanged')
  t.alike(await snapshot(site), shape(spec(5, 8)))
})

test('an awaited hook keeps its artifact in place until it is done, then the replacement goes through', async (t) => {
  const gate = deferred()
  const entered = deferred()
  const { client, connect, storage } = await setup(t, {
    allowReplace: true,
    hooks: {
      afterCommit: async (context) => {
        if (context.artifact.name !== 'site') return
        entered.resolve()
        await gate.promise
      }
    },
    hookModes: { afterCommit: 'response' }
  })
  const other = connect()
  const first = client.upload(await directory(t, 'site', spec(1)))
  await entered.promise

  await t.exception(other.upload(await directory(t, 'site', spec(2))), {
    code: ERRORS.FILE_BUSY
  })
  t.is(
    (await other.upload(await directory(t, 'unrelated', spec(1)))).status,
    'COMMITTED',
    'another name is unaffected'
  )
  t.alike(
    await snapshot(path.join(storage, 'site')),
    shape(spec(1)),
    'nothing moved under the hook'
  )
  gate.resolve()
  t.is((await first).status, 'COMMITTED')
  t.is((await other.upload(await directory(t, 'site', spec(2)))).status, 'COMMITTED')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)))
})

test('a queued or running detached hook keeps its artifact in place until it ends', async (t) => {
  const gate = deferred()
  const entered = deferred()
  const { client, connect, storage } = await setup(t, {
    allowReplace: true,
    hooks: {
      afterCommit: async (context) => {
        if (context.artifact.name !== 'site') return
        entered.resolve()
        await gate.promise
      }
    }
  })
  const other = connect()
  t.is((await client.upload(await directory(t, 'site', spec(1)))).status, 'COMMITTED')
  await entered.promise
  await t.exception(other.upload(await directory(t, 'site', spec(2))), {
    code: ERRORS.FILE_BUSY
  })
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(1)))
  gate.resolve()
  const result = await retryWhileBusy(async () => other.upload(await directory(t, 'site', spec(2))))
  t.is(result.status, 'COMMITTED')
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)))
})

test('an explicit link request keeps its target in place under either failure policy', async (t) => {
  for (const hookFailure of ['rollback', 'keep'] as const) {
    const gate = deferred()
    const entered = deferred()
    const { client, connect, storage } = await setup(t, {
      allowReplace: true,
      symlinks: [{ selector: 'site' }],
      hooks: {
        afterLink: async () => {
          entered.resolve()
          await gate.promise
        }
      },
      hookModes: { afterLink: 'response' }
    })
    const other = connect()
    await client.upload(await directory(t, 'site', spec(1)))
    const linking = client.link('site', 'current', { hookFailure })
    await entered.promise
    await t.exception(
      other.upload(await directory(t, 'site', spec(2))),
      { code: ERRORS.FILE_BUSY },
      hookFailure
    )
    t.alike(await snapshot(path.join(storage, 'site')), shape(spec(1)), hookFailure)
    gate.resolve()
    t.is((await linking).status, 'LINKED', hookFailure)
    const result = await retryWhileBusy(async () =>
      other.upload(await directory(t, 'site', spec(2)))
    )
    t.is(result.status, 'COMMITTED', hookFailure)
    t.is(await fs.promises.readlink(path.join(storage, 'current')), 'site')
    t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)), hookFailure)
  }
})

test('links follow a replaced name and run afterLink again for the new bytes', async (t) => {
  const contexts: AfterLinkContext[] = []
  const { client, storage } = await setup(t, {
    allowReplace: true,
    symlinks: [{ name: 'latest', selector: 'site' }, { selector: 'site' }],
    hooks: {
      afterLink: (context) => {
        contexts.push(context)
      }
    },
    hookModes: { afterLink: 'response' }
  })
  const first = await client.upload(await directory(t, 'site', spec(1)))
  t.alike(
    contexts.map((context) => [context.link.name, context.status, context.artifact.transferId]),
    [['latest', 'LINKED', idOf(first)]]
  )
  t.is((await client.link('site', 'current')).status, 'LINKED')

  const second = await client.upload(await directory(t, 'site', spec(2)))
  const automatic = contexts.filter((context) => context.link.name === 'latest')
  t.is(automatic.length, 2, 'the automatic link hook ran for the replacement')
  t.is(automatic[1].status, 'LINKED')
  t.is(automatic[1].artifact.transferId, idOf(second), 'with the new artifact')
  t.is(await fs.promises.readlink(path.join(storage, 'latest')), 'site')
  t.is(
    await fs.promises.readlink(path.join(storage, 'current')),
    'site',
    'the manual link is intact'
  )

  // Publishing again runs the hook again for the bytes that are there now.
  const before = contexts.length
  const relinked = await client.link('site', 'current')
  t.is(relinked.status, 'UNCHANGED')
  t.is(contexts.length, before + 1)
  const last = contexts[contexts.length - 1]
  t.is(last.link.name, 'current')
  t.is(last.trigger, 'request')
  t.is(last.status, 'UNCHANGED')
  t.is(last.artifact.transferId, idOf(second))
})

test('a slow commit outlives an impatient client and an exact retry finds it committed', async (t) => {
  const delay = 1_500
  let slow = true
  const { client, connect, storage } = await setup(t, {
    hooks: {
      afterCommit: async () => {
        if (slow) await sleep(delay)
      }
    },
    hookModes: { afterCommit: 'response' }
  })
  const impatient = connect({ idleTimeout: 500 })
  const artifact = await file(t, 'slow.txt', 'slow payload')
  await t.exception(impatient.upload(artifact), { code: ERRORS.UPLOAD_IDLE_TIMEOUT })
  await sleep(delay + 300)
  t.is(await fs.promises.readFile(path.join(storage, 'slow.txt'), 'utf8'), 'slow payload')
  slow = false
  t.is((await client.upload(artifact)).status, 'ALREADY_COMMITTED', 'an exact retry')

  // The default wait is long enough for the same slow commit. It is one wait for the answer,
  // restarted by every byte that moves, and not a deadline for the transfer.
  slow = true
  const patient = connect({ idleTimeout: undefined })
  t.is(patient.idleTimeout, 600_000)
  const started = Date.now()
  const result = await patient.upload(await file(t, 'slower.txt', 'slower payload'))
  t.is(result.status, 'COMMITTED')
  t.ok(Date.now() - started >= delay - 100, 'the answer waited for the hook')
})

// Opt-in: point this at an installed `swarm-deploy` 0.7.x package directory to start the real
// older release on a state directory a directory replacement has marked.
const OLD_SERVER = process.env?.SWARM_DEPLOY_OLD_SERVER ?? ''

test('a 0.7 server refuses the state directory of a replaced directory before it reads anything', async (t) => {
  if (OLD_SERVER === '') {
    t.pass('skipped: SWARM_DEPLOY_OLD_SERVER is not set, so no real 0.7 server was started')
    return
  }
  const { server, storage, client, testnet } = await setup(t, { allowReplace: true })
  const first = await client.upload(await directory(t, 'site', spec(1)))
  await client.upload(await directory(t, 'site', spec(2)))
  await client.close()
  await server.close()

  const state = stateDirFor(path.resolve(storage))
  const before = {
    commits: (await fs.promises.readdir(path.join(state, 'commits'))).sort(),
    record: await fs.promises.readFile(path.join(state, '.swarm-deploy-state.json'), 'utf8')
  }
  const { Server: Earlier } = require(path.join(OLD_SERVER, 'dist', 'index.js')) as {
    Server: new (options: Record<string, unknown>) => { listen(): Promise<unknown> }
  }
  const older = new Earlier({
    seed: SERVER_SEED,
    storageDir: storage,
    stateDir: state,
    initializeState: true,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 64 * 1024,
    maxStagingBytes: 1024 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  await t.exception(() => older.listen(), { message: /Malformed state directory record/ })

  t.alike((await fs.promises.readdir(path.join(state, 'commits'))).sort(), before.commits)
  t.is(
    await fs.promises.readFile(path.join(state, '.swarm-deploy-state.json'), 'utf8'),
    before.record
  )
  t.alike(
    await snapshot(path.join(storage, historyName(idOf(first)))),
    shape(spec(1)),
    'nothing was touched'
  )
  t.alike(await snapshot(path.join(storage, 'site')), shape(spec(2)))
})

// Opt-in compatibility with earlier clients: a comma-separated list of installed `swarm-deploy`
// package directories (for example 0.3.0 and 0.6.3), each of which uploads, and replaces, both a
// file and a directory against this server. They share the server's local test network, because
// separate local networks cannot find each other.
const OLD_CLIENTS = (process.env?.SWARM_DEPLOY_OLD_CLIENTS ?? '').split(',').filter(Boolean)

test('earlier clients replace managed files and directories against a server that allows it', async (t) => {
  if (OLD_CLIENTS.length === 0) {
    t.pass('skipped: SWARM_DEPLOY_OLD_CLIENTS is not set, so no earlier client was run')
    return
  }
  const { server, storage, testnet } = await setup(t, { allowReplace: true })
  const load = (packageDirectory: string): typeof Client =>
    (require(path.join(packageDirectory, 'dist', 'index.js')) as { Client: typeof Client }).Client
  for (const [index, entry] of OLD_CLIENTS.entries()) {
    const Earlier = load(entry)
    const earlier = new Earlier({
      seed: CLIENT_SEED,
      serverPublicKey: server.publicKey,
      connectTimeout: 5_000,
      idleTimeout: 20_000,
      dht: testnet.createNode()
    } as ConstructorParameters<typeof Client>[0])
    t.teardown(() => earlier.close())
    const label = `${entry} (#${index})`
    const name = `earlier-${index}.txt`
    t.is((await earlier.upload(await file(t, name, 'one'))).status, 'COMMITTED', label)
    t.is((await earlier.upload(await file(t, name, 'two'))).status, 'COMMITTED', label)
    t.is(await fs.promises.readFile(path.join(storage, name), 'utf8'), 'two', label)
    const site = `earlier-${index}-site`
    t.is((await earlier.upload(await directory(t, site, spec(1)))).status, 'COMMITTED', label)
    t.is((await earlier.upload(await directory(t, site, spec(2)))).status, 'COMMITTED', label)
    t.alike(await snapshot(path.join(storage, site)), shape(spec(2)), label)
  }
})
