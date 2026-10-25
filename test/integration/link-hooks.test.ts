/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import {
  Client,
  ERRORS,
  Server,
  SwarmDeployError,
  keyPairFromSeed,
  type AfterLinkContext,
  type ServerHooks,
  type ServerOptions
} from '../../dist/index.js'
import { loadHooksModule } from '../../dist/hooks-module.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 0xd1)
const CLIENT_SEED = b4a.alloc(32, 0xd2)

function gate(): { wait: Promise<void>; open(): void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = (): void => resolve()
  })
  return { wait, open }
}

function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300))
}

async function setup(
  t: Assert,
  options: Pick<ServerOptions, 'symlinks'> & { hooks: ServerHooks }
): Promise<{
  server: Server
  client: Client
  testnet: Awaited<ReturnType<typeof createLocalTestnet>>
  storage: string
  source: string
}> {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const source = await createTempDir(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    ...options
  })
  const client = new Client({
    seed: CLIENT_SEED,
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
  return { server, client, testnet, storage, source }
}

async function write(directory: string, name: string, contents: string): Promise<string> {
  const file = path.join(directory, name)
  await fs.promises.writeFile(file, contents)
  return file
}

test('Client.link settles only after afterLink returns, and a failure reaches the caller as HOOK_FAILED', async (t) => {
  const held = gate()
  let mode: 'hold' | 'fail' | 'pass' = 'hold'
  const contexts: AfterLinkContext[] = []
  const { client, storage, source } = await setup(t, {
    symlinks: [{ selector: 'release-1' }],
    hooks: {
      afterLink: async (context) => {
        contexts.push(context)
        if (mode === 'hold') await held.wait
        if (mode === 'fail') throw new Error('publisher token sk-secret rejected')
      }
    }
  })
  const events: string[] = []
  client.on('link', (event) => events.push(`${event.name}:${event.status}:${event.final}`))
  t.is((await client.upload(await write(source, 'release-1', 'first'))).status, 'COMMITTED')

  let resolved = false
  const pending = client.link('release-1', 'current').then((result) => {
    resolved = true
    return result
  })
  await waitFor(() => contexts.length === 1)
  await settled()
  t.is(resolved, false, 'the caller waits while the hook runs')
  t.is(await fs.promises.readlink(path.join(storage, 'current')), 'release-1')
  held.open()
  t.alike(await pending, { target: 'release-1', name: 'current', status: 'LINKED' })

  mode = 'fail'
  const failure: unknown = await client.link('release-1', 'second').then(
    () => null,
    (error: unknown) => error
  )
  t.ok(failure instanceof SwarmDeployError)
  t.is((failure as SwarmDeployError).code, ERRORS.HOOK_FAILED)
  t.absent((failure as SwarmDeployError).message.includes('sk-secret'), 'the caller sees no text')
  t.is(
    await fs.promises.readlink(path.join(storage, 'second')),
    'release-1',
    'the failed publication leaves the link in place'
  )

  mode = 'pass'
  t.alike(await client.link('release-1', 'second'), {
    target: 'release-1',
    name: 'second',
    status: 'UNCHANGED'
  })
  t.alike(
    contexts.map((context) => `${context.link.name}:${context.status}`),
    ['current:LINKED', 'second:LINKED', 'second:UNCHANGED']
  )
  t.alike(events, [
    'current:requested:false',
    'current:LINKED:true',
    'second:requested:false',
    'second:HOOK_FAILED:true',
    'second:requested:false',
    'second:UNCHANGED:true'
  ])
})

test('Client.upload waits for afterLink on an automatic link and retries a failed one as ALREADY_COMMITTED', async (t) => {
  const held = gate()
  let mode: 'hold' | 'fail' | 'pass' = 'hold'
  const contexts: AfterLinkContext[] = []
  const { client, storage, source } = await setup(t, {
    symlinks: [{ selector: '/^release-\\d+$/', name: 'latest' }],
    hooks: {
      afterLink: async (context) => {
        contexts.push(context)
        if (mode === 'hold') await held.wait
        if (mode === 'fail') throw new Error('deploy failed')
      }
    }
  })

  let resolved = false
  const first = client.upload(await write(source, 'release-1', 'first')).then((result) => {
    resolved = true
    return result
  })
  await waitFor(() => contexts.length === 1)
  await settled()
  t.is(resolved, false, 'COMMITTED is withheld while the hook runs')
  t.is(await fs.promises.readlink(path.join(storage, 'latest')), 'release-1')
  held.open()
  t.is((await first).status, 'COMMITTED')

  mode = 'fail'
  const second = await write(source, 'release-2', 'second')
  await t.exception(client.upload(second), { code: ERRORS.HOOK_FAILED })
  t.is(await fs.promises.readlink(path.join(storage, 'latest')), 'release-2', 'the link is durable')
  t.is(await fs.promises.readFile(path.join(storage, 'release-2'), 'utf8'), 'second')

  mode = 'pass'
  t.is((await client.upload(second)).status, 'ALREADY_COMMITTED')
  t.alike(
    contexts.map((context) => `${context.link.target}:${context.status}:${context.trigger}`),
    ['release-1:LINKED:upload', 'release-2:LINKED:upload', 'release-2:UNCHANGED:upload']
  )
})

test('an unauthorized client can neither link nor reach afterLink', async (t) => {
  const calls: string[] = []
  const { client, testnet, source } = await setup(t, {
    symlinks: [{ selector: '/^release-\\d$/' }],
    hooks: {
      afterLink: () => void calls.push('afterLink'),
      onFailure: () => void calls.push('onFailure')
    }
  })
  t.is((await client.upload(await write(source, 'release-1', 'first'))).status, 'COMMITTED')

  const stranger = new Client({
    seed: b4a.alloc(32, 0xd3),
    serverPublicKey: client.serverPublicKey,
    connectTimeout: 1_000,
    idleTimeout: 1_000,
    dht: testnet.createNode()
  })
  t.teardown(() => stranger.close())
  await t.exception(stranger.link('release-1', 'current'))
  // The exact policy code is asserted on fake sockets: a real stream may be reset before a
  // non-hook failure record is read, so only the rejection itself is stable here.
  await t.exception(client.link('release-9', 'current'))
  t.alike(calls, [], 'no hook runs for a request that changed no link')
})

test('the link-publisher example publishes each link change through a no-shell publisher', async (t) => {
  if (typeof Bare !== 'undefined') {
    t.pass('the example spawns a Node child process')
    return
  }
  const published = await createTempDir(t)
  const hooks = await loadHooksModule(
    path.resolve(__dirname, '../../examples/link-publisher/hooks.mjs'),
    process.cwd()
  )
  t.alike(Object.keys(hooks), ['afterLink'])
  const previous = process.env.SWARM_DEPLOY_PUBLISH_DIR
  process.env.SWARM_DEPLOY_PUBLISH_DIR = published
  t.teardown(() => {
    if (previous === undefined) delete process.env.SWARM_DEPLOY_PUBLISH_DIR
    else process.env.SWARM_DEPLOY_PUBLISH_DIR = previous
  })
  const { client, storage, source } = await setup(t, {
    symlinks: [
      { selector: '/^app-\\d+\\.tar$/', name: 'latest' },
      { selector: '/^app-\\d+\\.tar$/' }
    ],
    hooks
  })
  const read = async (name: string): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.promises.readFile(path.join(published, `${name}.json`), 'utf8'))

  const uploaded = await client.upload(await write(source, 'app-1.tar', 'app payload'))
  const transferId = b4a.toString(uploaded.transferId, 'hex')
  const latest = await read('latest')
  t.is(latest.link, 'latest')
  t.is(latest.target, 'app-1.tar')
  t.is(latest.mode, 'automatic')
  t.is(latest.status, 'LINKED')
  t.is(latest.trigger, 'upload')
  t.is((latest.artifact as { transferId: string }).transferId, transferId)

  t.is((await client.link('app-1.tar', 'stable')).status, 'LINKED')
  const stable = await read('stable')
  t.is(stable.mode, 'manual')
  t.is(stable.trigger, 'request')
  t.is((await client.link('app-1.tar', 'stable')).status, 'UNCHANGED')
  t.alike(await read('stable'), stable, 'a repeated request publishes nothing new')

  process.env.SWARM_DEPLOY_PUBLISH_DIR = path.join(published, 'missing')
  await t.exception(client.link('app-1.tar', 'beta'), { code: ERRORS.HOOK_FAILED })
  t.is(await fs.promises.readlink(path.join(storage, 'beta')), 'app-1.tar')
  process.env.SWARM_DEPLOY_PUBLISH_DIR = published
  t.is((await client.link('app-1.tar', 'beta')).status, 'UNCHANGED')
  t.is((await read('beta')).link, 'beta', 'the retry published the change the failure missed')
})
