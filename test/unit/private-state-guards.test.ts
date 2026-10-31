/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import os from '#os'
import path from '#path'
import {
  ERRORS,
  Server as PlainServer,
  keyPairFromSeed,
  type ServerOptions
} from '../../dist/index.js'
import type { DirectDhtNode } from '../../dist/direct-dht.js'
import {
  STATE_ROOT_NAME,
  assertNoDefaultStateConflict,
  assertSameMount,
  diagnoseCrossMount,
  findLayout,
  initLayout,
  shellQuote,
  sweepClaimTemporaries
} from '../../dist/storage/layout.js'
import { mountFor, parseMountInfo, readMountInfo } from '../../dist/storage/mounts.js'
import type { StorageAdapter } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { Server } from '../helpers/server.js'
import { createLocalTestnet } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 0xe3)
const CLIENT_KEY = keyPairFromSeed(b4a.alloc(32, 0xe4)).publicKey

type Call = (...args: unknown[]) => unknown

/** Replaces one `fs` function for the duration of `action`; the original is always restored. */
async function withPatchedFs<T>(
  name: string,
  make: (original: Call) => Call,
  action: () => Promise<T> | T
): Promise<T> {
  const patchable = fs as unknown as Record<string, Call>
  const original = patchable[name]
  patchable[name] = make((...args) => original.apply(fs, args))
  try {
    return await action()
  } finally {
    patchable[name] = original
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

async function modeOf(target: string): Promise<number> {
  return (await fs.promises.stat(target)).mode & 0o777
}

async function recordedRoot(state: string): Promise<string> {
  const text = await fs.promises.readFile(path.join(state, STATE_ROOT_NAME), 'utf8')
  return (JSON.parse(text) as { root: string }).root
}

function errno(code: string): Error {
  return Object.assign(new Error(`injected ${code}`), { code })
}

test('a racing initializer cannot replace the root a state directory was bound to first', async (t) => {
  const scratch = await createTempDir(t)
  const [rootA, rootB] = [path.join(scratch, 'a'), path.join(scratch, 'b')]
  const state = path.join(scratch, 'shared', 'state')

  // B finishes binding the directory after A inspected it and found no record, which is the
  // window between "no record yet" and "write mine" that used to let A replace B's record.
  let raced = false
  const failure = await withPatchedFs(
    'readdirSync',
    (original) =>
      (...args) => {
        const listing = original(...args)
        if (!raced && args[0] === state) {
          raced = true
          initLayout(rootB, state)
        }
        return listing
      },
    () => failureOf(() => initLayout(rootA, state))
  )
  t.ok(raced, 'the competing initializer ran inside the window')
  t.ok(failure?.message.includes(`belongs to output root ${rootB}, not ${rootA}`), failure?.message)
  t.is(await recordedRoot(state), rootB, 'the first binding is preserved')
  const residue = (await fs.promises.readdir(state)).filter((name) => name.endsWith('.tmp'))
  t.alike(residue, [], 'the loser leaves no temporary file')

  // The same root racing itself is harmless: whichever wins records the same root.
  const shared = path.join(scratch, 'shared', 'same')
  let again = false
  const layout = await withPatchedFs(
    'readdirSync',
    (original) =>
      (...args) => {
        const listing = original(...args)
        if (!again && args[0] === shared) {
          again = true
          initLayout(rootA, shared)
        }
        return listing
      },
    () => initLayout(rootA, shared)
  )
  t.ok(again)
  t.is(layout.internal, shared)
  t.is(await recordedRoot(shared), rootA)
})

test('the root record is synced before it is published and the directory after, and failures leave no residue', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'state')

  const events: string[] = []
  await withPatchedFs(
    'fsyncSync',
    (original) =>
      (...args) => {
        events.push('fsync')
        return original(...args)
      },
    () =>
      withPatchedFs(
        'linkSync',
        (original) =>
          (...args) => {
            events.push('link')
            return original(...args)
          },
        () => initLayout(root, state)
      )
  )
  t.alike(events, ['fsync', 'link', 'fsync'], 'file synced, then linked into place, then directory')
  t.is(await recordedRoot(state), root)

  const tempNames = async (directory: string): Promise<string[]> =>
    (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.tmp'))
  const failing: Array<[string, string, string, RegExp]> = [
    ['hard links unavailable', 'linkSync', 'EPERM', /hard links and fsync are required/],
    ['the record cannot be synced', 'fsyncSync', 'EIO', /Unable to record the output root/]
  ]
  for (const [label, name, code, pattern] of failing) {
    const fresh = path.join(scratch, `fresh-${name}`)
    const failure = await withPatchedFs(
      name,
      () => () => {
        throw errno(code)
      },
      () => failureOf(() => initLayout(root, fresh))
    )
    t.ok(failure !== null && pattern.test(failure.message), label)
    t.is(failure?.code, ERRORS.PROTOCOL_INVALID, label)
    t.absent(await exists(path.join(fresh, STATE_ROOT_NAME)), `${label}: nothing was published`)
    t.alike(await tempNames(fresh), [], `${label}: the temporary file is removed`)
    t.is(initLayout(root, fresh).internal, fresh, `${label}: a retry then succeeds`)
    t.is(await recordedRoot(fresh), root)
  }

  // A failure after the record was linked leaves it published; the retry finds it bound.
  const late = path.join(scratch, 'late')
  let syncs = 0
  const afterLink = await withPatchedFs(
    'fsyncSync',
    (original) =>
      (...args) => {
        syncs++
        if (syncs === 2) throw errno('EIO')
        return original(...args)
      },
    () => failureOf(() => initLayout(root, late))
  )
  t.ok(afterLink !== null, 'the directory sync failure is reported')
  t.alike(await tempNames(late), [])
  t.is(await recordedRoot(late), root)
  await t.execution(() => initLayout(root, late))
})

test('only old, regular claim temporaries are swept', async (t) => {
  const scratch = await createTempDir(t)
  const state = path.join(scratch, 'state')
  initLayout(path.join(scratch, 'out'), state)
  const stale = path.join(state, `${STATE_ROOT_NAME}.${'0'.repeat(16)}.tmp`)
  const folder = path.join(state, `${STATE_ROOT_NAME}.${'1'.repeat(16)}.tmp`)
  const unrelated = path.join(state, `${STATE_ROOT_NAME}.keep`)
  await fs.promises.writeFile(stale, 'partial')
  await fs.promises.mkdir(folder)
  await fs.promises.writeFile(unrelated, 'not a temporary')

  t.is(sweepClaimTemporaries(state), 0, 'a recent temporary may belong to a live initializer')
  t.ok(await exists(stale))
  t.is(sweepClaimTemporaries(state, Date.now() + 20 * 60 * 1000), 1)
  t.absent(await exists(stale), 'an abandoned one is removed')
  t.ok(await exists(folder), 'a directory with that name is never touched')
  t.ok(await exists(unrelated), 'neither is a file that is not a temporary')
  t.is(await recordedRoot(state), path.join(scratch, 'out'), 'the binding itself is untouched')
})

test('a refused directory keeps its permissions, and only proven state is restricted', async (t) => {
  const scratch = await createTempDir(t)
  const roots = ['f', 'o', 'n'].map((name) => path.join(scratch, name))
  const loosen = async (directory: string): Promise<void> => {
    await fs.promises.chmod(directory, 0o755)
  }

  const foreign = path.join(scratch, 'foreign')
  await fs.promises.mkdir(foreign)
  await fs.promises.writeFile(path.join(foreign, 'keep.txt'), 'someone else')
  await loosen(foreign)
  const notState = failureOf(() => initLayout(roots[0], foreign))
  t.ok(notState?.message.includes('does not hold Swarm Deploy state (found keep.txt)'))
  t.is(await modeOf(foreign), 0o755, 'a foreign directory is not restricted')
  t.alike(await fs.promises.readdir(foreign), ['keep.txt'])

  const other = path.join(scratch, 'other')
  initLayout(roots[1], other)
  await loosen(other)
  const elsewhere = failureOf(() => initLayout(roots[2], other))
  t.ok(elsewhere?.message.includes('belongs to output root'))
  t.is(await modeOf(other), 0o755, 'state bound to another root is not restricted')

  const nested = path.join(scratch, 'nested')
  await fs.promises.mkdir(path.join(nested, '.swarm-deploy'), { recursive: true })
  await loosen(nested)
  const hidden = failureOf(() => initLayout(roots[2], nested, { initializeState: true }))
  t.ok(hidden?.message.includes('Legacy private state is nested'))
  t.is(await modeOf(nested), 0o755, 'a nested legacy directory is refused before any change')

  const proven = path.join(scratch, 'proven')
  await fs.promises.mkdir(path.join(proven, 'archive'), { recursive: true })
  await loosen(proven)
  initLayout(roots[2], proven, { initializeState: true })
  t.is(await modeOf(proven), 0o700, 'state that is proven to be this root’s is restricted')
})

test('shellQuote writes one literal POSIX word for any text', (t) => {
  t.is(shellQuote('plain'), "'plain'")
  t.is(shellQuote(''), "''")
  t.is(shellQuote("it's"), "'it'\\''s'")
  t.is(shellQuote("'"), "''\\'''")
  t.is(shellQuote('a b $(touch x) `y` "z" \\ ! * ?'), '\'a b $(touch x) `y` "z" \\ ! * ?\'')
})

const childProcess =
  typeof Bare === 'undefined'
    ? (require('node:child_process') as typeof import('node:child_process'))
    : null

test('the printed commands treat unusual paths as literals and refuse to nest or follow a destination', async (t) => {
  if (childProcess === null) {
    t.pass('a shell is available to these tests only under Node')
    return
  }
  const run = (cwd: string, command: string) =>
    childProcess.spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8' })

  const scratch = await createTempDir(t)
  const hostile = path.join(scratch, 'it\'s $(touch ONE) `touch TWO` "q" back\\slash sp ace')
  const root = path.join(hostile, 'out')
  const state = path.join(scratch, "st'ate $(touch THREE)", 'state')
  const legacy = path.join(root, '.swarm-deploy')
  const seedLegacy = async (contents: string): Promise<void> => {
    await fs.promises.mkdir(path.join(legacy, 'archive'), { recursive: true })
    await fs.promises.writeFile(path.join(legacy, 'archive', 'sentinel.txt'), contents)
  }
  const sentinel = (directory: string): Promise<string> =>
    fs.promises.readFile(path.join(directory, 'archive', 'sentinel.txt'), 'utf8')
  const noExpansion = async (label: string): Promise<void> => {
    for (const name of ['ONE', 'TWO', 'THREE']) {
      t.absent(await exists(path.join(scratch, name)), `${label}: ${name} was never run`)
    }
  }

  await seedLegacy('first')
  const message = failureOf(() => initLayout(root, state))?.message ?? ''
  const commands = message
    .split('\n')
    .filter((line) => line.startsWith('  [ ! -e '))
    .map((line) => line.trim())
  t.is(commands.length, 2, 'a migration command and a rollback command are printed')
  const [migrate, rollback] = commands

  const moved = run(scratch, migrate)
  t.is(moved.status, 0, moved.stderr)
  t.is(await sentinel(state), 'first', 'the legacy directory arrived intact')
  t.absent(await exists(legacy), 'and left the output root')
  await noExpansion('migrate')

  // The destination exists now: the same command must refuse instead of nesting.
  await seedLegacy('second')
  const refused = run(scratch, migrate)
  t.not(refused.status, 0, 'an existing destination is refused')
  t.absent(await exists(path.join(state, '.swarm-deploy')), 'the legacy directory is not nested')
  t.is(await sentinel(legacy), 'second', 'and stays where it was')
  t.is(await sentinel(state), 'first', 'the destination is unchanged')

  // A dangling symlink at the destination is refused too, and never followed.
  await fs.promises.rm(state, { recursive: true })
  const nowhere = path.join(scratch, 'nowhere')
  await fs.promises.symlink(nowhere, state)
  const dangling = run(scratch, migrate)
  t.not(dangling.status, 0, 'a dangling symlink destination is refused')
  t.is(await fs.promises.readlink(state), nowhere)
  t.absent(await exists(nowhere), 'nothing was created through the link')
  t.is(await sentinel(legacy), 'second')
  await fs.promises.unlink(state)

  const again = run(scratch, migrate)
  t.is(again.status, 0, again.stderr)
  t.is(await sentinel(state), 'second')

  // The rollback moves it back, and refuses if the legacy path is taken.
  const back = run(scratch, rollback)
  t.is(back.status, 0, back.stderr)
  t.is(await sentinel(legacy), 'second', 'rolled back intact')
  t.absent(await exists(state))
  await fs.promises.mkdir(state, { recursive: true })
  const blocked = run(scratch, rollback)
  t.not(blocked.status, 0, 'the rollback refuses an existing legacy path')
  t.absent(await exists(path.join(legacy, path.basename(state))), 'and nests nothing')
  await noExpansion('rollback')
  t.alike(
    await fs.promises.readdir(scratch).then((names) => names.filter((n) => /^[A-Z]+$/.test(n))),
    []
  )
})

test('an existing destination gets separate guidance and no command that would nest', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, "ex'isting", 'state')
  await fs.promises.mkdir(path.join(root, '.swarm-deploy'), { recursive: true })
  await fs.promises.mkdir(state, { recursive: true })

  const message = failureOf(() => initLayout(root, state))?.message ?? ''
  t.ok(message.includes('would nest it inside'))
  t.ok(message.includes(`rmdir -- ${shellQuote(state)}`), 'an empty destination can be removed')
  t.absent(message.includes('mv --'), 'no move command is offered for it')
  t.absent(message.includes('--initialize-state'))
  t.ok(await exists(path.join(root, '.swarm-deploy')), 'nothing was moved')

  // A bound destination that already holds a nested legacy directory is refused as well,
  // rather than silently ignoring the records inside it.
  const bound = path.join(scratch, 'bound')
  initLayout(path.join(scratch, 'other'), bound)
  await fs.promises.mkdir(path.join(bound, '.swarm-deploy', 'commits'), { recursive: true })
  for (const open of [
    () => initLayout(path.join(scratch, 'other'), bound),
    () => findLayout(path.join(scratch, 'other'), bound)
  ]) {
    const nested = failureOf(open)
    t.ok(nested?.message.includes('Legacy private state is nested inside the state directory'))
  }
})

test('the nested-legacy command puts a directory in place, and stops if the state holds other entries', async (t) => {
  if (childProcess === null) {
    t.pass('a shell is available to these tests only under Node')
    return
  }
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  await fs.promises.mkdir(root)

  const state = path.join(scratch, "ne'sted $(touch FOUR)", 'state')
  await fs.promises.mkdir(path.join(state, '.swarm-deploy', 'archive'), { recursive: true })
  await fs.promises.writeFile(path.join(state, '.swarm-deploy', 'archive', 'kept.txt'), 'kept')
  const command = (failureOf(() => initLayout(root, state))?.message ?? '')
    .split('\n')
    .find((line) => line.startsWith('  [ ! -e '))
  t.ok(command !== undefined)
  const done = childProcess.spawnSync('/bin/sh', ['-c', (command ?? '').trim()], {
    cwd: scratch,
    encoding: 'utf8'
  })
  t.is(done.status, 0, done.stderr)
  t.is(await fs.promises.readFile(path.join(state, 'archive', 'kept.txt'), 'utf8'), 'kept')
  t.absent(await exists(path.join(scratch, 'FOUR')))

  const busy = path.join(scratch, 'busy')
  initLayout(root, busy)
  await fs.promises.mkdir(path.join(busy, '.swarm-deploy'), { recursive: true })
  const stops = childProcess.spawnSync(
    '/bin/sh',
    [
      '-c',
      (failureOf(() => initLayout(root, busy))?.message ?? '')
        .split('\n')
        .find((line) => line.startsWith('  [ ! -e '))!
        .trim()
    ],
    { cwd: scratch, encoding: 'utf8' }
  )
  t.not(stops.status, 0, 'rmdir refuses a state directory that holds other entries')
  t.ok(
    await exists(path.join(`${busy}.migrating`)),
    'the legacy directory waits at the temporary name'
  )
})

/** Reports `change` for a stat of every path outside the output root. */
function outsideRoot(root: string, change: (stat: object) => object): (original: Call) => Call {
  return (original) =>
    (...args) => {
      const stat = original(...args) as object
      const target = String(args[0])
      if (target === root || target.startsWith(`${root}${path.sep}`)) return stat
      return change(stat)
    }
}

function withStat(stat: object, fields: Record<string, number>): object {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, fields)
}

test('an unrepresentable identity on an unrelated ancestor never hides the filesystem error', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'private', 'state')
  await fs.promises.mkdir(root)
  const huge = 2 ** 60

  const crossDevice = await withPatchedFs(
    'statSync',
    outsideRoot(root, (stat) => withStat(stat, { dev: huge, ino: huge })),
    () => failureOf(() => initLayout(root, state))
  )
  t.ok(
    crossDevice?.message.includes('different filesystem than the output root'),
    crossDevice?.message
  )
  t.absent(crossDevice?.message.includes('identity is unavailable'))
  t.ok(crossDevice?.message.includes('--state-dir'))
  t.absent(await exists(path.join(scratch, 'private')), 'nothing was created')

  // The same device with an unrepresentable inode is simply a different directory.
  const sameDevice = await withPatchedFs(
    'statSync',
    outsideRoot(root, (stat) => withStat(stat, { ino: huge })),
    () => failureOf(() => initLayout(root, state))
  )
  t.is(sameDevice, null, 'it is not mistaken for the output root')
  t.is(await recordedRoot(state), root)

  // The protected output root's own identity must still be exact.
  const rootless = await withPatchedFs(
    'statSync',
    (original) =>
      (...args) => {
        const stat = original(...args) as object
        return String(args[0]) === root ? withStat(stat, { ino: huge }) : stat
      },
    () => failureOf(() => initLayout(root, path.join(scratch, 'second')))
  )
  t.ok(rootless?.message.includes('Storage directory identity is unavailable'), rootless?.message)
  t.absent(await exists(path.join(scratch, 'second')))
})

test('unbound state is refused for a root that already holds entries unless initialization is acknowledged', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  await fs.promises.mkdir(root)
  await fs.promises.writeFile(path.join(root, 'kept.txt'), 'published')
  const state = path.join(scratch, 'private', 'state')

  const refused = failureOf(() => initLayout(root, state))
  t.is(refused?.code, ERRORS.PROTOCOL_INVALID)
  t.ok(refused?.message.includes('--initialize-state'))
  t.ok(refused?.message.includes('the output root already holds entries'))
  t.ok(refused?.message.includes('stay unmanaged'))
  t.absent(await exists(path.join(scratch, 'private')), 'no state was created')
  t.ok(
    failureOf(() => findLayout(root, state))?.message.includes('no private state at'),
    'reset-storage finds no state to act on'
  )

  const layout = initLayout(root, state, { initializeState: true })
  t.is(await recordedRoot(state), root)
  t.alike(
    await fs.promises.readdir(root),
    ['kept.txt'],
    'the published file is neither moved nor removed'
  )
  t.is(await fs.promises.readFile(path.join(root, 'kept.txt'), 'utf8'), 'published')
  t.alike(await fs.promises.readdir(layout.commits), [], 'no record is invented for it')
  await t.execution(() => initLayout(root, state), 'bound state needs no flag')

  // An empty root and an empty or missing state directory never need it.
  const quiet = path.join(scratch, 'quiet')
  await t.execution(() => initLayout(quiet, path.join(scratch, 'quiet-state')))
  const empty = path.join(scratch, 'empty-state')
  await fs.promises.mkdir(empty)
  await t.execution(() => initLayout(path.join(scratch, 'quiet-two'), empty))

  // A state directory that holds entries but no record (migrated or restored) needs it too.
  const restored = path.join(scratch, 'restored')
  await fs.promises.mkdir(path.join(restored, 'commits'), { recursive: true })
  const unbound = failureOf(() => initLayout(path.join(scratch, 'quiet-three'), restored))
  t.ok(unbound?.message.includes('the state directory already holds entries'))
  t.absent(await exists(path.join(restored, STATE_ROOT_NAME)))
})

test('the server refuses unbound state for a used root until initialization is acknowledged', async (t) => {
  const testnet = await createLocalTestnet(t)
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'state')
  await fs.promises.mkdir(root)
  await fs.promises.writeFile(path.join(root, 'kept.txt'), 'published')

  const unused = unusedDht()
  const refused = new Server(
    serverOptions(root, { stateDir: state, initializeState: false, dht: unused.node })
  )
  t.teardown(() => refused.close())
  await t.exception(() => refused.listen(), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /--initialize-state/
  })
  t.is(unused.calls(), 0)
  t.absent(await exists(state))

  const acknowledged = new Server(
    serverOptions(root, { stateDir: state, initializeState: true, dht: testnet.createNode() })
  )
  t.teardown(() => acknowledged.close())
  await acknowledged.listen()
  t.is(acknowledged.initializeState, true)
  await acknowledged.close()
  t.is(await fs.promises.readFile(path.join(root, 'kept.txt'), 'utf8'), 'published')
  t.alike(await fs.promises.readdir(path.join(state, 'commits')), [], 'it stays unmanaged')

  // Bound state restarts without the flag.
  const restarted = new Server(
    serverOptions(root, { stateDir: state, initializeState: false, dht: testnet.createNode() })
  )
  t.teardown(() => restarted.close())
  await restarted.listen()
  t.is(restarted.initializeState, false)

  await t.exception(
    () => new PlainServer(serverOptions(root, { initializeState: 'yes' as never })),
    { code: ERRORS.PROTOCOL_INVALID, message: /Invalid initializeState/ }
  )
})

test('an explicit state directory cannot fork the default state already bound to the same root', async (t) => {
  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const defaultState = path.join(scratch, 'home', 'id')
  const custom = path.join(scratch, 'custom')
  initLayout(root, defaultState)

  const conflict = failureOf(() => assertNoDefaultStateConflict(root, custom, defaultState))
  t.is(conflict?.code, ERRORS.PROTOCOL_INVALID)
  t.ok(conflict?.message.includes(`already exists at ${defaultState}`))
  t.ok(conflict?.message.includes('Omit --state-dir'))

  const alias = path.join(scratch, 'alias')
  await fs.promises.symlink(defaultState, alias)
  t.is(
    failureOf(() => assertNoDefaultStateConflict(root, alias, defaultState)),
    null,
    'same directory'
  )
  t.is(
    failureOf(() => assertNoDefaultStateConflict(root, defaultState, defaultState)),
    null
  )

  const otherRoot = path.join(scratch, 'other')
  const otherDefault = path.join(scratch, 'home', 'other-id')
  initLayout(otherRoot, otherDefault)
  t.is(
    failureOf(() => assertNoDefaultStateConflict(root, custom, otherDefault)),
    null,
    'state bound to another root is not this root’s default'
  )
  t.is(
    failureOf(() => assertNoDefaultStateConflict(root, custom, path.join(scratch, 'absent'))),
    null,
    'a default that does not exist conflicts with nothing'
  )
  const torn = path.join(scratch, 'home', 'torn')
  await fs.promises.mkdir(torn, { recursive: true })
  await fs.promises.writeFile(path.join(torn, STATE_ROOT_NAME), '')
  t.is(
    failureOf(() => assertNoDefaultStateConflict(root, custom, torn)),
    null,
    'unreadable'
  )
})

const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
  '31 22 8:1 /srv/data /srv/artifacts rw,relatime shared:1 master:2 - ext4 /dev/sda1 rw',
  '32 22 8:1 /srv/state /srv/pri\\040vate rw,relatime - ext4 /dev/sda1 rw',
  '33 22 0:40 / /mnt/back\\134slash rw - tmpfs tmpfs rw',
  '34 31 8:1 /inner /srv/artifacts/inner rw - ext4 /dev/sda1 rw',
  '35 22 8:1 /srv/data /srv/artifacts rw - ext4 /dev/sda1 rw',
  'garbage',
  '36 22 8:1 / relative rw - ext4 /dev/sda1 rw',
  '37 22 8:1 / /broken rw ext4',
  ''
].join('\n')

test('mountinfo is parsed with escaped mount points, stacking, and boundaries', (t) => {
  const mounts = parseMountInfo(MOUNTINFO)
  t.alike(
    mounts.map((mount) => mount.mountPoint),
    [
      '/',
      '/srv/artifacts',
      '/srv/pri vate',
      '/mnt/back\\slash',
      '/srv/artifacts/inner',
      '/srv/artifacts'
    ],
    'malformed, relative, and separator-less lines are skipped'
  )
  t.alike(mounts[0], { id: 22, device: '8:1', mountPoint: '/' })

  const idOf = (target: string): number | undefined => mountFor(mounts, target)?.id
  t.is(idOf('/srv/artifacts/out'), 35, 'of stacked mounts the last one is visible')
  t.is(idOf('/srv/artifacts/inner/x'), 34, 'the longest mount point wins')
  t.is(idOf('/srv/artifactsX'), 22, 'a mount point matches whole path components only')
  t.is(idOf('/srv/pri vate/state'), 32)
  t.is(idOf('/mnt/back\\slash'), 33)
  t.is(idOf('/'), 22)
  t.is(mountFor([], '/srv'), null)
  t.is(mountFor(mounts.slice(1, 2), '/elsewhere'), null, 'a path no mount holds is unplaced')
})

test('two mounts of one filesystem are different places for publication', (t) => {
  const mounts = parseMountInfo(MOUNTINFO)
  const failure = failureOf(() =>
    assertSameMount('/srv/artifacts/out', '/srv/pri vate/state', '/srv/pri vate/state', mounts)
  )
  t.is(failure?.code, ERRORS.PROTOCOL_INVALID)
  t.ok(failure?.message.includes('different mount (/srv/pri vate)'), failure?.message)
  t.ok(failure?.message.includes('(/srv/artifacts)'))
  t.ok(failure?.message.includes('EXDEV'))
  t.ok(failure?.message.includes('--state-dir'))
  t.is(
    failureOf(() =>
      assertSameMount('/srv/artifacts/out', '/srv/artifacts/state', '/srv/artifacts/state', mounts)
    ),
    null,
    'one mount'
  )
  t.is(
    failureOf(() =>
      assertSameMount('/srv/artifacts/out', '/elsewhere', '/elsewhere', mounts.slice(1, 2))
    ),
    null,
    'a path the table cannot place is left to the device check'
  )
})

test('the Linux mount table is read where it exists and ignored elsewhere', async (t) => {
  const mounts = readMountInfo()
  if (os.platform() !== 'linux') {
    t.is(mounts, null, 'other platforms rely on the device check alone')
    return
  }
  t.ok(mounts !== null && mounts.length > 0, 'the real table is readable')
  const tmp = await fs.promises.realpath(os.tmpdir())
  t.ok(mounts !== null && mountFor(mounts, tmp) !== null, 'the temporary directory is on a mount')

  const scratch = await createTempDir(t)
  const root = path.join(scratch, 'out')
  const state = path.join(scratch, 'private', 'state')
  await fs.promises.mkdir(root)
  const escaped = (value: string): string => value.replace(/\\/g, '\\134').replace(/ /g, '\\040')
  const canonical = await fs.promises.realpath(root)
  const serve =
    (table: string) =>
    (original: Call) =>
    (...args: unknown[]) =>
      args[0] === '/proc/self/mountinfo' ? table : original(...args)

  // The output root is its own mount of the same device; the state would be on the parent mount.
  const split = [
    '1 0 8:1 / / rw - ext4 /dev/x rw',
    `2 1 8:1 /out ${escaped(canonical)} rw - ext4 /dev/x rw`
  ].join('\n')
  const refused = await withPatchedFs('readFileSync', serve(split), () =>
    failureOf(() => initLayout(root, state))
  )
  t.ok(refused?.message.includes('different mount'), refused?.message)
  t.absent(await exists(path.join(scratch, 'private')), 'nothing was created')

  const whole = '1 0 8:1 / / rw - ext4 /dev/x rw\n'
  const accepted = await withPatchedFs('readFileSync', serve(whole), () =>
    failureOf(() => initLayout(root, state))
  )
  t.is(accepted, null, 'one mount is accepted')
})

test('a rename or link refused across mounts is reported once and rethrown unchanged', async (t) => {
  let notified = 0
  const crossed = errno('EXDEV')
  const storage = {
    rename: () => Promise.reject(crossed),
    link: (_from: string, _to: string) => Promise.reject(errno('EIO')),
    lstat: () => Promise.resolve('lstat result')
  } as unknown as StorageAdapter
  const diagnosed = diagnoseCrossMount(storage, () => {
    notified++
  })

  t.is(
    await diagnosed.rename('a', 'b').then(
      () => null,
      (error: unknown) => error
    ),
    crossed
  )
  t.is(notified, 1)
  const other = await diagnosed.link('a', 'b').then(
    () => null,
    (error: unknown) => error
  )
  t.is((other as { code: string }).code, 'EIO', 'other failures pass through')
  t.is(notified, 1, 'and are not reported as a mount problem')
  t.is(await diagnosed.lstat('p'), 'lstat result' as never, 'everything else is delegated')
})
