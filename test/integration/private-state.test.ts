/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { main } from '../../dist/cli.js'
import { Client, ERRORS, keyPairFromSeed, type SwarmDeployError } from '../../dist/index.js'
import { STATE_ROOT_NAME } from '../../dist/storage/layout.js'
import { createTempDir, stateDirFor } from '../helpers/files.js'
import { Server } from '../helpers/server.js'
import { createStorage } from '../helpers/storage.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { writeTree } from '../helpers/trees.js'

const PRIVATE = new Set([
  '.swarm-deploy',
  'staging',
  'sessions',
  'commits',
  'journals',
  'publications',
  'links',
  'trash',
  'lock',
  'archive',
  'reset-pending.json',
  STATE_ROOT_NAME
])

/** Every path in the served root, relative and sorted; symlinks are listed and never followed. */
async function walk(root: string, directory = root): Promise<string[]> {
  const names: string[] = []
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const full = path.join(directory, name)
    names.push(path.relative(root, full))
    if ((await fs.promises.lstat(full)).isDirectory()) names.push(...(await walk(root, full)))
  }
  return names
}

function isPrivate(relative: string): boolean {
  return relative
    .split(path.sep)
    .some((part) => PRIVATE.has(part) || part.startsWith('lock.') || part.endsWith('.part'))
}

/** Lists the served root and fails if any entry in it is state, staging, a lock, or a journal. */
async function listServable(t: Assert, root: string, label: string): Promise<string[]> {
  const names = await walk(root)
  t.is(names.find(isPrivate), undefined, `${label}: nothing private is in the served root`)
  return names
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

async function eventually(read: () => Promise<string[]>, expected: string[]): Promise<string[]> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value.join('\n') === expected.join('\n') || Date.now() - started > 5_000) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

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

test('the served root holds only artifacts and links across upload, link, rollback, restart, and reset', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 0xf1)
  const clientSeed = b4a.alloc(32, 0xf2)
  const root = await createTempDir(t)
  const state = stateDirFor(root)
  const source = await createTempDir(t)
  let afterLink: 'record' | 'fail' = 'record'
  const rootDuringLink: string[][] = []
  const journalsDuringLink: string[][] = []
  const stagedPaths: string[] = []
  const rootBeforeCommit: string[][] = []

  const start = (): Server => {
    const server = new Server({
      seed: serverSeed,
      storageDir: root,
      allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
      maxFileBytes: 1024,
      maxStagingBytes: 4096,
      minFreeBytes: 0,
      replaceNames: ['config.txt'],
      symlinks: [{ selector: 'release-1' }],
      hooks: {
        beforeCommit: async ({ path: staged }) => {
          stagedPaths.push(staged)
          rootBeforeCommit.push(await walk(root))
        },
        afterLink: async () => {
          rootDuringLink.push(await walk(root))
          journalsDuringLink.push(await fs.promises.readdir(path.join(state, 'links')))
          if (afterLink === 'fail') throw new Error('publisher unavailable')
        }
      },
      hookModes: { afterLink: 'response' },
      dht: testnet.createNode()
    })
    t.teardown(() => server.close())
    return server
  }
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: keyPairFromSeed(serverSeed).publicKey,
    connectTimeout: 5_000,
    idleTimeout: 10_000,
    dht: testnet.createNode()
  })
  t.teardown(() => client.close())
  const write = async (name: string, contents: string): Promise<string> => {
    const file = path.join(source, name)
    await fs.promises.writeFile(file, contents)
    return file
  }
  const linkRecords = async (): Promise<string[]> =>
    (await fs.promises.readdir(path.join(state, 'links'))).sort()

  let server = start()
  await server.listen()
  t.alike(await listServable(t, root, 'fresh start'), [], 'a fresh start publishes nothing')
  t.ok(await exists(path.join(state, 'lock')), 'the lock is in the private state')

  t.is((await client.upload(await write('release-1', 'one'))).status, 'COMMITTED')
  t.is((await client.upload(await write('config.txt', 'v1'))).status, 'COMMITTED')
  const tree = await writeTree(path.join(source, 'site-1'), {
    'index.html': '<p>hi</p>',
    'assets/app.js': 'x'
  })
  t.is((await client.upload(tree)).status, 'COMMITTED')
  t.is((await client.upload(await write('config.txt', 'v2'))).status, 'COMMITTED')
  const uploaded = await listServable(t, root, 'after uploads')
  for (const name of ['release-1', 'config.txt', 'site-1', 'site-1/assets/app.js']) {
    t.ok(uploaded.includes(name), `${name} is published`)
  }
  t.ok(
    uploaded.some((name) => name.startsWith('history-')),
    'replacement history is a public artifact'
  )
  t.is(
    await fs.promises.readFile(path.join(root, 'config.txt'), 'utf8'),
    'v2',
    'the replacement is live'
  )

  const stagingPrefix = `${path.join(state, 'staging')}${path.sep}`
  t.ok(stagedPaths.length >= 4)
  t.ok(
    stagedPaths.every((staged) => staged.startsWith(stagingPrefix)),
    'every partial payload is staged in the private state'
  )
  t.absent(rootBeforeCommit[0].includes('release-1'), 'nothing is visible before it is verified')
  t.ok(rootBeforeCommit.every((names) => !names.some(isPrivate)))

  t.alike(await client.link('release-1', 'current'), {
    target: 'release-1',
    name: 'current',
    status: 'LINKED'
  })
  t.is(await fs.promises.readlink(path.join(root, 'current')), 'release-1')
  t.ok(rootDuringLink.at(-1)?.includes('current'))
  t.ok(
    journalsDuringLink.at(-1)?.some((name) => name.endsWith('.rollback.json')),
    'the rollback journal lives in the private state while the hook runs'
  )
  t.ok(rootDuringLink.every((names) => !names.some(isPrivate)))
  t.ok((await linkRecords()).every((name) => !name.endsWith('.rollback.json')))

  afterLink = 'fail'
  const failure = await client.link('release-1', 'previous').then(
    () => null,
    (error: unknown) => error as SwarmDeployError
  )
  t.is(failure?.code, ERRORS.HOOK_FAILED)
  t.absent(await exists(path.join(root, 'previous')), 'the failed link was rolled back')
  t.ok(journalsDuringLink.at(-1)?.some((name) => name.endsWith('.rollback.json')))
  t.ok((await linkRecords()).every((name) => !name.endsWith('.rollback.json')))
  const settled = await listServable(t, root, 'after rollback')

  await server.close()
  t.absent(await exists(path.join(state, 'lock')), 'closing releases the lock')
  server = start()
  await server.listen()
  t.alike(await listServable(t, root, 'after restart'), settled, 'a restart changes nothing')
  afterLink = 'record'
  t.is(
    (await client.link('release-1', 'current')).status,
    'UNCHANGED',
    'the restarted server remembers the link it owns, from its private state'
  )

  await server.close()
  const stdout = output()
  const stderr = output()
  const code = await main(
    ['reset-storage', '--storage', root, '--state-dir', state, '--apply'],
    {},
    { stdout: stdout.stream, stderr: stderr.stream }
  )
  t.is(code, 0, stderr.text())
  t.ok(stdout.text().includes(`archive: ${path.join(state, 'archive')}`))
  t.alike(await listServable(t, root, 'after reset'), settled, 'a reset leaves the root as it was')
  t.is(await fs.promises.readlink(path.join(root, 'current')), 'release-1')
})

test('retention rotates artifacts without leaving private entries in the served root', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 0xf3)
  const clientSeed = b4a.alloc(32, 0xf4)
  const root = await createTempDir(t)
  const state = stateDirFor(root)
  const source = await createTempDir(t)
  const server = new Server({
    seed: serverSeed,
    storageDir: root,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    artifactPatterns: ['{series}-{version}.bin'],
    maxCount: 1,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })
  await server.listen()

  for (const name of ['app-1.0.0.bin', 'app-1.1.0.bin']) {
    const file = path.join(source, name)
    await fs.promises.writeFile(file, name)
    t.is((await client.upload(file)).status, 'COMMITTED', name)
  }
  t.alike(
    await eventually(() => listServable(t, root, 'after rotation'), ['app-1.1.0.bin']),
    ['app-1.1.0.bin'],
    'the older version was rotated out of the root'
  )
  const records = await fs.promises.readdir(path.join(state, 'commits'))
  t.is(records.length, 1, 'the commit records are private state, one per remaining artifact')
  t.alike(await fs.promises.readdir(path.join(state, 'trash')), [])
})

interface LogRecord {
  level: 'info' | 'warn' | 'error'
  message: string
  details: Record<string, unknown> | undefined
}

function recordingLogger(records: LogRecord[]) {
  return {
    info(message: string, details?: Record<string, unknown>) {
      records.push({ level: 'info', message, details })
    },
    warn(message: string, details?: Record<string, unknown>) {
      records.push({ level: 'warn', message, details })
    },
    error(message: string, details?: Record<string, unknown>) {
      records.push({ level: 'error', message, details })
    }
  }
}

test('legacy state that reappears while the server runs refuses new work and maintenance and is reported', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 0xf5)
  const clientSeed = b4a.alloc(32, 0xf6)
  const root = await createTempDir(t)
  const source = await createTempDir(t)
  const records: LogRecord[] = []
  const server = new Server({
    seed: serverSeed,
    storageDir: root,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    symlinks: [{ selector: 'release-1' }],
    logger: recordingLogger(records),
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 10_000,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })
  await server.listen()
  const upload = async (name: string): Promise<unknown> => {
    const file = path.join(source, name)
    await fs.promises.writeFile(file, name)
    return client.upload(file).then(
      () => null,
      (error: unknown) => error
    )
  }
  const alerts = (): number =>
    records.filter((record) => record.message.includes('Legacy private state reappeared')).length

  t.is(await upload('release-1'), null)
  t.is((await client.link('release-1', 'current')).status, 'LINKED')
  const published = await listServable(t, root, 'before')

  // An older release, or another writer, recreates the directory inside the served root.
  await fs.promises.mkdir(path.join(root, '.swarm-deploy', 'commits'), { recursive: true })
  const refused = (await upload('release-2')) as SwarmDeployError | null
  t.is(refused?.code, ERRORS.PROTOCOL_INVALID, 'a new upload is refused')
  t.absent(await exists(path.join(root, 'release-2')), 'and nothing was published')
  const linkFailure = await client.link('release-1', 'other').then(
    () => null,
    (error: unknown) => error as SwarmDeployError
  )
  t.is(linkFailure?.code, ERRORS.LINK_FAILED, 'a new link request is refused')
  t.absent(await exists(path.join(root, 'other')))
  await upload('release-3')
  t.is(alerts(), 1, 'one alert is logged for as long as the directory stays')
  t.absent(JSON.stringify(records).includes(root), 'and it names no path')

  // Maintenance refuses too: this instance's records must not delete a second writer's files.
  const retention = (server as unknown as { retention: { run(o: object): Promise<unknown> } })
    .retention
  await t.exception(() => retention.run({ trigger: 'manual' }), {
    code: ERRORS.PROTOCOL_INVALID,
    message: /Legacy private state reappeared/
  })
  t.alike(
    (await walk(root)).filter((name) => !name.startsWith('.swarm-deploy')),
    published,
    'no artifact or link was touched'
  )

  // Once the operator resolves it, work resumes and a later reappearance is reported again.
  await fs.promises.rm(path.join(root, '.swarm-deploy'), { recursive: true })
  t.is(await upload('release-2'), null)
  await t.execution(() => retention.run({ trigger: 'manual' }))
  await fs.promises.mkdir(path.join(root, '.swarm-deploy'))
  await upload('release-4')
  t.is(alerts(), 2)
})

test('a publication refused across mounts is reported once with the way out', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 0xf7)
  const clientSeed = b4a.alloc(32, 0xf8)
  const root = await createTempDir(t)
  const source = await createTempDir(t)
  const records: LogRecord[] = []
  const storage = createStorage({
    beforeOperation(name, _target, ...rest) {
      if (name === 'link' && String(rest[0]).startsWith(`${root}${path.sep}`)) {
        throw Object.assign(new Error('injected cross-device link'), { code: 'EXDEV' })
      }
    }
  })
  const server = new Server({
    seed: serverSeed,
    storageDir: root,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    storage,
    logger: recordingLogger(records),
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 10_000,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })
  await server.listen()

  for (const name of ['first.bin', 'second.bin']) {
    const file = path.join(source, name)
    await fs.promises.writeFile(file, name)
    const failure = await client.upload(file).then(
      () => null,
      (error: unknown) => error
    )
    t.ok(failure !== null, `${name} fails when publication crosses a mount`)
  }
  t.alike(await listServable(t, root, 'after the failures'), [], 'nothing was published')
  const reports = records.filter((record) =>
    record.message.includes('across a filesystem or mount')
  )
  t.is(reports.length, 1, 'the problem is reported once')
  t.is(reports[0].level, 'error')
  t.is(reports[0].details?.reason, 'EXDEV')
  t.ok(String(reports[0].details?.hint).includes('--state-dir'))
  t.absent(JSON.stringify(records).includes(root), 'and no log carries a path')
})
