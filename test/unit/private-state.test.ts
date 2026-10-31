/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import os from '#os'
import path from '#path'
import process from '#process'
import { main, USAGE } from '../../dist/cli.js'
import { ERRORS, keyPairFromSeed, type ServerOptions } from '../../dist/index.js'
import type { DirectDhtNode } from '../../dist/direct-dht.js'
import {
  STATE_ROOT_NAME,
  defaultStateDirectory,
  findLayout,
  initLayout
} from '../../dist/storage/layout.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir, stateDirFor } from '../helpers/files.js'
import { Server } from '../helpers/server.js'
import { createLocalTestnet } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 0xe1)
const CLIENT_KEY = keyPairFromSeed(b4a.alloc(32, 0xe2)).publicKey
const METADATA = [
  'staging',
  'sessions',
  'commits',
  'journals',
  'publications',
  'links',
  'trash'
] as const

function output() {
  let text = ''
  return {
    stream: {
      write(value: string) {
        text += value
      }
    },
    text: () => text
  }
}

async function runReset(args: string[]) {
  const stdout = output()
  const stderr = output()
  const code = await main(
    ['reset-storage', ...args],
    {},
    { stdout: stdout.stream, stderr: stderr.stream }
  )
  return {
    code,
    stderr: stderr.text(),
    lines: stdout
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
  }
}

function serverOptions(storageDir: string, extra: Partial<ServerOptions> = {}): ServerOptions {
  return {
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    ...extra
  }
}

/** A DHT node that fails the test run if a server that must refuse to start ever touches it. */
function unusedDht(): { node: DirectDhtNode; calls: () => number } {
  let calls = 0
  const fail = (): never => {
    calls++
    throw new Error('the DHT must not be used')
  }
  const node = {
    destroyed: false,
    createServer: fail,
    connect: fail,
    on() {
      return this
    },
    destroy() {
      return Promise.resolve()
    }
  }
  return { node: node as unknown as DirectDhtNode, calls: () => calls }
}

function failureOf(action: () => unknown): (Error & { code?: string }) | null {
  try {
    action()
  } catch (error) {
    return error as Error & { code?: string }
  }
  return null
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

async function snapshot(directory: string, base = directory): Promise<string[]> {
  const lines: string[] = []
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const full = path.join(directory, name)
    const stat = await fs.promises.lstat(full)
    const relative = full.slice(base.length + 1)
    if (stat.isSymbolicLink()) lines.push(`${relative} -> ${await fs.promises.readlink(full)}`)
    else if (stat.isDirectory()) {
      lines.push(`${relative}/`)
      lines.push(...(await snapshot(full, base)))
    } else lines.push(`${relative} ${stat.size}`)
  }
  return lines
}

async function modeOf(target: string): Promise<number> {
  return (await fs.promises.stat(target)).mode & 0o777
}

/** Reports a device number different from the output root's for every path outside it. */
async function withForeignDevice<T>(root: string, action: () => Promise<T>): Promise<T> {
  const patchable = fs as unknown as {
    statSync: (...args: unknown[]) => { dev: number | bigint }
  }
  const original = patchable.statSync
  patchable.statSync = (...args) => {
    const stat = original.apply(fs, args)
    const target = String(args[0])
    if (target === root || target.startsWith(`${root}${path.sep}`)) return stat
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      dev: Number(stat.dev) + 1
    })
  }
  try {
    return await action()
  } finally {
    patchable.statSync = original
  }
}

test('default private state lives under the user home directory, never the working directory', async (t) => {
  const root = await createTempDir(t)
  const elsewhere = await createTempDir(t)
  const id = b4a.toString(sodiumSha256(b4a.from(root)), 'hex').slice(0, 32)
  const expected = path.join(os.homedir(), '.swarm-deploy', id)
  t.is(defaultStateDirectory(root), expected)

  const original = process.cwd()
  t.teardown(() => process.chdir(original))
  process.chdir(elsewhere)
  t.is(defaultStateDirectory(root), expected, 'the working directory does not matter')
  t.absent(defaultStateDirectory(root).startsWith(elsewhere))
  process.chdir(original)

  t.not(defaultStateDirectory(await createTempDir(t)), expected, 'another root, another state')
})

test('the default state location is canonical, so aliases of one root share one directory', async (t) => {
  const root = await createTempDir(t)
  const scratch = await createTempDir(t)
  const link = path.join(scratch, 'parent-link')
  await fs.promises.symlink(path.dirname(root), link)
  const expected = defaultStateDirectory(root)

  // Nothing exists yet, so the lookup fails read-only and names where the state would live.
  for (const alias of [root, path.join(link, path.basename(root))]) {
    const failure = failureOf(() => findLayout(alias))
    t.ok(failure?.message.includes(`no private state at ${expected};`), alias)
  }
  t.absent(await exists(expected), 'a read-only lookup creates nothing')
})

test('an explicit state directory inside, above, or aliasing the output root is refused before anything is created', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  await fs.promises.mkdir(path.join(root, 'sub'), { recursive: true })
  const elsewhere = path.join(scratch, 'elsewhere')
  await fs.promises.mkdir(elsewhere)
  const rootAlias = path.join(scratch, 'root-alias')
  const subAlias = path.join(scratch, 'sub-alias')
  const finalLink = path.join(scratch, 'state-link')
  await fs.promises.symlink(root, rootAlias)
  await fs.promises.symlink(path.join(root, 'sub'), subAlias)
  await fs.promises.symlink(elsewhere, finalLink)

  const outside = /must be outside the output root/
  const cases: Array<[string, string, RegExp]> = [
    ['the root itself', root, outside],
    ['inside the root', path.join(root, 'state'), outside],
    ['inside a subdirectory of the root', path.join(root, 'sub', 'state'), outside],
    ['through a symlink to the root', path.join(rootAlias, 'state'), outside],
    ['through a symlink into the root', path.join(subAlias, 'state'), outside],
    ['an ancestor of the root', scratch, /must not contain the output root/],
    ['a symlinked final directory', finalLink, /Unsafe storage directory/],
    ['a relative path', 'relative/state', /must be an absolute path/]
  ]
  for (const [label, state, pattern] of cases) {
    const failure = failureOf(() => initLayout(root, state))
    t.ok(failure !== null && pattern.test(failure.message), label)
    t.is(failure?.code, ERRORS.PROTOCOL_INVALID, label)
    t.alike(await fs.promises.readdir(root), ['sub'], `${label}: nothing was added to the root`)
    t.alike(await fs.promises.readdir(path.join(root, 'sub')), [], `${label}: nor to its folders`)
    t.alike(await fs.promises.readdir(elsewhere), [], `${label}: nor through the symlink`)
  }

  const server = new Server(serverOptions(root, { stateDir: path.join(root, 'state') }))
  t.is(server.stateDir, path.join(root, 'state'))
  await t.exception(() => server.listen(), { code: ERRORS.PROTOCOL_INVALID, message: outside })
  t.alike(await fs.promises.readdir(root), ['sub'], 'the server added nothing to the root either')
  await t.exception(() => new Server(serverOptions(root, { stateDir: 'relative' })), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /must be an absolute path/
  })
})

test('private state is created with mode 0700 and an over-permissive directory is restricted', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const layout = initLayout(root, path.join(scratch, 'state'))
  for (const directory of [layout.internal, ...METADATA.map((name) => layout[name])]) {
    t.is(await modeOf(directory), 0o700, directory)
  }

  const loose = path.join(scratch, 'loose')
  await fs.promises.mkdir(loose)
  await fs.promises.chmod(loose, 0o755)
  t.is(initLayout(root, loose).internal, loose)
  t.is(await modeOf(loose), 0o700, 'an existing directory is restricted to its owner')
})

test('a state directory serves exactly one output root, and each root keeps separate state', async (t) => {
  const scratch = await createTempDir(t)
  const [rootA, rootB, rootC] = ['a', 'b', 'c'].map((name) => path.join(scratch, name))
  const stateA = path.join(scratch, 'state-a')
  const layoutA = initLayout(rootA, stateA)
  const layoutB = initLayout(rootB, path.join(scratch, 'state-b'))
  t.not(layoutA.internal, layoutB.internal)
  await fs.promises.writeFile(path.join(layoutA.commits, 'only-in-a.json'), '{}')
  t.alike(await fs.promises.readdir(layoutB.commits), [], 'another root sees none of its state')
  t.alike(await fs.promises.readdir(rootA), [], 'the output root holds no state')

  const marker = path.join(stateA, STATE_ROOT_NAME)
  const bound = await fs.promises.readFile(marker, 'utf8')
  t.is((JSON.parse(bound) as { root: string }).root, rootA)
  await t.execution(() => initLayout(rootA, stateA))
  const reused = failureOf(() => initLayout(rootB, stateA))
  t.ok(reused?.message.includes(`belongs to output root ${rootA}, not ${rootB}`))
  t.is(await fs.promises.readFile(marker, 'utf8'), bound, 'the record is not rewritten')
  t.alike(await fs.promises.readdir(layoutA.commits), ['only-in-a.json'], 'its state is intact')

  const foreign = path.join(scratch, 'foreign')
  await fs.promises.mkdir(foreign)
  await fs.promises.writeFile(path.join(foreign, 'notes.txt'), 'not ours')
  const refused = failureOf(() => initLayout(rootC, foreign))
  t.ok(refused?.message.includes('does not hold Swarm Deploy state (found notes.txt)'))
  t.absent(await exists(path.join(foreign, STATE_ROOT_NAME)), 'a foreign directory is not claimed')

  // A migrated legacy directory holds only state, so it is adopted and bound to its root.
  const migrated = path.join(scratch, 'migrated')
  await fs.promises.mkdir(path.join(migrated, 'archive'), { recursive: true })
  await fs.promises.mkdir(path.join(migrated, 'commits'))
  await fs.promises.mkdir(path.join(migrated, `lock.retired-${'ab'.repeat(32)}`))
  await fs.promises.writeFile(path.join(migrated, 'archive', 'kept.txt'), 'kept')
  initLayout(rootC, migrated)
  t.is(await fs.promises.readFile(path.join(migrated, 'archive', 'kept.txt'), 'utf8'), 'kept')
  t.ok(await exists(path.join(migrated, STATE_ROOT_NAME)))
})

test('a state directory on another filesystem fails before anything is published', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'private', 'state')
  await fs.promises.mkdir(root)
  const unused = unusedDht()
  const server = new Server(serverOptions(root, { stateDir: state, dht: unused.node }))
  t.teardown(() => server.close())

  await withForeignDevice(root, async () => {
    const failure = failureOf(() => initLayout(root, state))
    t.is(failure?.code, ERRORS.PROTOCOL_INVALID)
    t.ok(failure?.message.includes('different filesystem than the output root'))
    t.ok(failure?.message.includes('--state-dir'), 'the message names the way out')
    await t.exception(() => server.listen(), {
      code: ERRORS.PROTOCOL_INVALID,
      message: /Pass --state-dir/
    })
  })
  t.is(unused.calls(), 0, 'the server never reached the network')
  t.alike(await fs.promises.readdir(root), [], 'nothing was published or staged in the root')
  t.absent(await exists(path.join(scratch, 'private')), 'no state was created either')
})

test('legacy state inside the output root stops the server and reset-storage and is never touched', async (t) => {
  const root = await createTempDir(t)
  const state = stateDirFor(root)
  const legacy = path.join(root, '.swarm-deploy')
  for (const name of [...METADATA, 'archive']) {
    await fs.promises.mkdir(path.join(legacy, name), { recursive: true })
  }
  await fs.promises.writeFile(path.join(legacy, 'archive', 'sentinel.txt'), 'kept')
  const before = await snapshot(root)

  const unused = unusedDht()
  const refused = new Server(serverOptions(root, { dht: unused.node }))
  t.teardown(() => refused.close())
  await t.exception(() => refused.listen(), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /Legacy private state found inside the output root/
  })
  const message = failureOf(() => initLayout(root, state))?.message ?? ''
  t.ok(message.includes(`mv "${legacy}" "${state}"`), 'it spells out the offline move')
  t.ok(message.includes(`move "${state}" back to "${legacy}"`), 'and the rollback')
  t.ok(message.includes('--state-dir'))
  t.is(unused.calls(), 0)
  t.alike(await snapshot(root), before, 'the legacy directory is exactly as it was')
  t.absent(await exists(state), 'no fresh state was started beside it')

  const reset = await runReset(['--storage', root, '--state-dir', state, '--apply'])
  t.is(reset.code, 2)
  t.ok(reset.stderr.startsWith('Legacy private state found inside the output root'))
  t.alike(await snapshot(root), before)

  // The documented offline migration keeps every entry, and the move back is the rollback.
  await fs.promises.mkdir(path.dirname(state), { recursive: true })
  await fs.promises.rename(legacy, state)
  const testnet = await createLocalTestnet(t)
  const migrated = new Server(serverOptions(root, { dht: testnet.createNode() }))
  await migrated.listen()
  t.is(await fs.promises.readFile(path.join(state, 'archive', 'sentinel.txt'), 'utf8'), 'kept')
  t.alike(await fs.promises.readdir(root), [], 'the output root holds nothing private')
  await migrated.close()
  await fs.promises.rename(state, legacy)
  t.is(await fs.promises.readFile(path.join(legacy, 'archive', 'sentinel.txt'), 'utf8'), 'kept')
  const rolledBack = new Server(serverOptions(root, { dht: unused.node }))
  t.teardown(() => rolledBack.close())
  await t.exception(() => rolledBack.listen(), { message: /Legacy private state found/ })

  // Removing it instead gives a fresh state; the old ownership and recovery data is not restored.
  await fs.promises.rm(legacy, { recursive: true })
  const fresh = new Server(serverOptions(root, { dht: testnet.createNode() }))
  t.teardown(() => fresh.close())
  await fresh.listen()
  t.absent(await exists(path.join(state, 'archive', 'sentinel.txt')))
  t.alike(await fs.promises.readdir(root), [])
})

test('reset-storage resolves the same state location as the server and honours --state-dir', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'private', 'state')
  const layout = initLayout(root, state)
  const id = 'a1'.repeat(32)
  await fs.promises.writeFile(
    path.join(layout.commits, `${id}.json`),
    JSON.stringify({
      version: 1,
      name: 'gone.txt',
      size: 1,
      sha256: '00'.repeat(32),
      committedAt: 1,
      uploaderFingerprint: '11'.repeat(32),
      transferId: id
    })
  )

  const preview = await runReset(['--storage', root, '--state-dir', state])
  t.is(preview.code, 0, preview.stderr)
  t.ok(preview.lines.includes(`state: ${state}`))
  t.ok(preview.lines.includes('commits: 1 records (1 missing payloads)'))

  // Without --state-dir the reset looks where the server would by default, and finds nothing.
  const defaulted = await runReset(['--storage', root])
  t.is(defaulted.code, 2)
  t.ok(defaulted.stderr.includes(`no private state at ${defaultStateDirectory(root)};`))

  const applied = await runReset(['--storage', root, '--state-dir', state, '--apply'])
  t.is(applied.code, 0, applied.stderr)
  t.ok(applied.lines.some((line) => line.startsWith(`archive: ${path.join(state, 'archive')}`)))
  t.alike(await fs.promises.readdir(layout.commits), [])
  t.alike(await fs.promises.readdir(root), [], 'the reset wrote nothing into the output root')

  const other = path.join(scratch, 'other')
  await fs.promises.mkdir(other)
  const wrong = await runReset(['--storage', other, '--state-dir', state])
  t.is(wrong.code, 2)
  t.ok(wrong.stderr.includes('belongs to output root'))
  const asState = await runReset(['--storage', state, '--state-dir', path.join(scratch, 'x')])
  t.is(asState.code, 2)
  t.ok(asState.stderr.startsWith('Refusing to use a private state directory as the output root'))
})

test('the storage lock lives in the private state, is per root, and survives a restart', async (t) => {
  const testnet = await createLocalTestnet(t)
  const scratch = await createTempDir(t)
  const [rootA, rootB] = [path.join(scratch, 'a'), path.join(scratch, 'b')]
  const [stateA, stateB] = [path.join(scratch, 'state-a'), path.join(scratch, 'state-b')]
  const start = (root: string, stateDir: string) => {
    const server = new Server(serverOptions(root, { stateDir, dht: testnet.createNode() }))
    t.teardown(() => server.close())
    return server
  }

  const first = start(rootA, stateA)
  await first.listen()
  t.ok(await exists(path.join(stateA, 'lock')), 'the lock is private state')
  t.alike(await fs.promises.readdir(rootA), [], 'the output root holds no lock')
  await t.exception(() => start(rootA, stateA).listen(), { code: ERRORS.FILE_BUSY })

  const other = start(rootB, stateB)
  await other.listen()
  t.ok(await exists(path.join(stateB, 'lock')), 'another root locks its own state')

  const marker = await fs.promises.readFile(path.join(stateA, STATE_ROOT_NAME), 'utf8')
  await first.close()
  t.absent(await exists(path.join(stateA, 'lock')), 'closing releases the lock')
  const restarted = start(rootA, stateA)
  await restarted.listen()
  t.is(await fs.promises.readFile(path.join(stateA, STATE_ROOT_NAME), 'utf8'), marker)
  t.alike(await fs.promises.readdir(rootA), [], 'a restart leaves the root clean')
  t.alike(await fs.promises.readdir(rootB), [])
})

test('swarm-deploy server passes --state-dir through and documents it', async (t) => {
  const root = await createTempDir(t)
  const state = stateDirFor(root)
  const captured: ServerOptions[] = []
  let stop: (() => void) | null = null
  class FakeServer {
    publicKey = keyPairFromSeed(SERVER_SEED).publicKey
    constructor(value: ServerOptions) {
      captured.push(value)
    }
    listen() {
      queueMicrotask(() => stop?.())
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const signals = {
    on(_signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
      stop = listener
    },
    off() {}
  }
  const base = [
    'server',
    '--seed',
    b4a.toString(SERVER_SEED, 'hex'),
    '--storage',
    root,
    '--allow-key',
    b4a.toString(CLIENT_KEY, 'hex'),
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '4096'
  ]
  for (const extra of [['--state-dir', state], []]) {
    const stderr = output()
    const code = await main(
      [...base, ...extra],
      {},
      {
        Server: FakeServer as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: signals,
        stdout: output().stream,
        stderr: stderr.stream
      }
    )
    t.is(code, 0, stderr.text())
  }
  t.is(captured[0].stateDir, state)
  t.is(captured[1].stateDir, undefined, 'omitting it selects the default under the home directory')
  t.ok(USAGE.includes('--storage <dir> [--state-dir <dir>] --allow-key'))
  t.ok(USAGE.includes('[--apply [--wait <milliseconds>]] [--state-dir <dir>]'))
})
