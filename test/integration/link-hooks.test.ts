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
  type HookResult,
  type ServerHooks,
  type ServerOptions
} from '../../dist/index.js'
import { main } from '../../dist/cli.js'
import { loadHooksModule } from '../../dist/hooks-module.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 0xd1)
const CLIENT_SEED = b4a.alloc(32, 0xd2)

type RunPublisher = (
  command: string,
  args: string[],
  input: string,
  options?: { timeout?: number; killGrace?: number }
) => Promise<void>

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

test('Client.link returns the hook result only after the hook resolves, and only to a caller that asked', async (t) => {
  const held = gate()
  const contexts: AfterLinkContext[] = []
  let mode: 'valid' | 'invalid' = 'valid'
  const { client, storage, source } = await setup(t, {
    symlinks: [{ selector: 'release-1' }],
    hooks: {
      afterLink: async (context): Promise<HookResult> => {
        contexts.push(context)
        if (contexts.length === 1) await held.wait
        if (mode === 'invalid') return { submissionId: 'sk-secret', send: () => 1 } as never
        return {
          submissionId: `sub-${contexts.length}`,
          link: context.link.name,
          observed: context.status,
          evidence: ['https://example.test/review/evidence-marker']
        }
      }
    }
  })
  const events: unknown[] = []
  client.on('link', (event) => events.push(event))
  t.is((await client.upload(await write(source, 'release-1', 'first'))).status, 'COMMITTED')

  let resolved = false
  const pending = client.link('release-1', 'current', { hookResult: true }).then((result) => {
    resolved = true
    return result
  })
  await waitFor(() => contexts.length === 1)
  await settled()
  t.is(resolved, false, 'neither the status nor the data arrives while the hook runs')
  held.open()
  const first = await pending
  t.alike(first, {
    target: 'release-1',
    name: 'current',
    status: 'LINKED',
    hookResult: {
      submissionId: 'sub-1',
      link: 'current',
      observed: 'LINKED',
      evidence: ['https://example.test/review/evidence-marker']
    }
  })

  // The retry reruns the hook and returns what it returns this time.
  const retry = await client.link('release-1', 'current', { hookResult: true })
  t.is(retry.status, 'UNCHANGED')
  t.is((retry.hookResult as { submissionId: string }).submissionId, 'sub-2')
  t.is((retry.hookResult as { observed: string }).observed, 'UNCHANGED')

  // A caller that does not ask gets the plain result although the hook still ran and returned data.
  const plain = await client.link('release-1', 'current')
  t.alike(plain, { target: 'release-1', name: 'current', status: 'UNCHANGED' })
  t.alike(Object.keys(plain), ['target', 'name', 'status'])
  t.is(contexts.length, 3)
  t.absent(JSON.stringify(events).includes('evidence-marker'), 'link events never carry the data')

  // An unusable result is a sanitized HOOK_FAILED; the durable link and the retry are untouched.
  mode = 'invalid'
  const failure: unknown = await client.link('release-1', 'current', { hookResult: true }).then(
    () => null,
    (error: unknown) => error
  )
  t.ok(failure instanceof SwarmDeployError)
  t.is((failure as SwarmDeployError).code, ERRORS.HOOK_FAILED)
  t.absent((failure as SwarmDeployError).message.includes('sk-secret'))
  t.is(await fs.promises.readlink(path.join(storage, 'current')), 'release-1')
  t.is((await client.link('release-1', 'current')).status, 'UNCHANGED', 'a plain request is fine')
  mode = 'valid'
  const recovered = await client.link('release-1', 'current', { hookResult: true })
  t.is(recovered.status, 'UNCHANGED')
  t.is((recovered.hookResult as { link: string }).link, 'current')
})

function output(): { stream: { write(value: string): void }; text(): string } {
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

test('swarm-deploy link --json prints the hook result through a real client and plain output is unchanged', async (t) => {
  let calls = 0
  const { server, client, testnet, source } = await setup(t, {
    symlinks: [{ selector: 'release-1' }],
    hooks: {
      afterLink: (context): HookResult | undefined => {
        calls++
        if (context.link.name === 'quiet') return undefined
        return { submissionId: `sub-${calls}`, state: 'accepted', details: { queued: true } }
      }
    }
  })
  t.is((await client.upload(await write(source, 'release-1', 'first'))).status, 'COMMITTED')
  const env = { SWARM_DEPLOY_CLIENT_SEED: b4a.toString(CLIENT_SEED, 'hex') }
  const run = async (...args: string[]) => {
    const stdout = output()
    const stderr = output()
    const code = await main(
      ['link', '--server-key', b4a.toString(server.publicKey, 'hex'), ...args],
      env,
      {
        dht: testnet.createNode(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        connectTimeout: 5_000,
        idleTimeout: 10_000
      }
    )
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  const linked = await run('--json', 'release-1', 'current')
  t.is(linked.code, 0)
  t.is(linked.stdout.endsWith('\n'), true)
  t.alike(JSON.parse(linked.stdout), {
    target: 'release-1',
    name: 'current',
    status: 'LINKED',
    hookResult: { submissionId: 'sub-1', state: 'accepted', details: { queued: true } }
  })
  t.is(linked.stdout.trimEnd().includes('\n'), false, 'one object on one line')
  t.absent(linked.stderr.includes('sub-1'), 'diagnostics never carry the data')

  const again = await run('release-1', '--json', 'current')
  t.is(again.code, 0)
  t.is(JSON.parse(again.stdout).status, 'UNCHANGED')
  t.is(JSON.parse(again.stdout).hookResult.submissionId, 'sub-2', 'a retry reruns the hook')

  const quiet = await run('--json', 'release-1', 'quiet')
  t.alike(JSON.parse(quiet.stdout), { target: 'release-1', name: 'quiet', status: 'LINKED' })

  const plain = await run('release-1', 'current')
  t.is(plain.code, 0)
  t.is(plain.stdout, 'current -> release-1 UNCHANGED\n')
  t.absent(plain.stdout.includes('sub-'))
  t.is(calls, 4, 'the hook runs for every request')

  const missing = await run('--json', 'release-9', 'current')
  t.is(missing.code, 1)
  t.is(missing.stdout, '', 'a failure prints no JSON')
  t.ok(missing.stderr.length > 0)
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

test('the link-publisher example rejects at its deadline whatever the publisher does and ends the child', async (t) => {
  if (typeof Bare !== 'undefined') {
    t.pass('the example spawns a Node child process')
    return
  }
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  const example = path.resolve(__dirname, '../../examples/link-publisher/hooks.mjs')
  const loaded: { runPublisher: RunPublisher } = await import(pathToFileURL(example).href)
  const { runPublisher } = loaded
  const work = await createTempDir(t)
  const node = process.execPath
  const pids: number[] = []
  t.teardown(() => {
    // Hygiene only: a regression that leaves a child running must not outlive the test.
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  })
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as { code?: string }).code !== 'ESRCH'
    }
  }
  // Each script gets a file path as argv[1]; the long-running ones write their pid there
  // only after installing their SIGTERM handler.
  const pidFile = (name: string): string => path.join(work, name)
  const readPid = async (name: string): Promise<number> => {
    const pid = Number(await fs.promises.readFile(pidFile(name), 'utf8'))
    pids.push(pid)
    return pid
  }
  const hang = (handler: string): string =>
    `process.on('SIGTERM',${handler});require('fs').writeFileSync(process.argv[1],String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`
  const echo =
    "let d='';process.stdin.on('data',(c)=>{d+=c});process.stdin.on('end',()=>{require('fs').writeFileSync(process.argv[1],d)})"
  const generous = { timeout: 10_000, killGrace: 1_000 }
  const late = `process.on('SIGTERM',()=>setTimeout(()=>{require('fs').writeFileSync(process.argv[2],'old');process.exit(0)},100));require('fs').writeFileSync(process.argv[1],String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`
  const timings = { timeout: 1_500, killGrace: 1_000 }
  const publish = (script: string, name: string, ...rest: string[]): Promise<void> =>
    runPublisher(node, ['-e', script, pidFile(name), ...rest], 'payload', timings)

  await runPublisher(node, ['-e', echo, pidFile('received')], 'payload', generous)
  const received = await fs.promises.readFile(pidFile('received'), 'utf8')
  t.is(received, 'payload', 'a clean exit resolves and the publisher read its input')

  await t.exception(publish('process.exit(3)', 'fails'), /exited with 3/)

  // Catches SIGTERM and exits zero: still a timeout failure, and the child is gone by then.
  let started = Date.now()
  await t.exception(publish(hang('()=>process.exit(0)'), 'exits'), /timed out/)
  t.ok(Date.now() - started >= timings.timeout - 100, 'it waited for the deadline')
  t.ok(Date.now() - started < timings.timeout + 1_000, 'it settled right after SIGTERM')
  t.absent(alive(await readPid('exits')), 'the child had exited when the call settled')

  // Ignores SIGTERM: the call settles only after SIGKILL, bounded by the grace period.
  started = Date.now()
  await t.exception(publish(hang('()=>{}'), 'ignores'), /timed out/)
  const waited = Date.now() - started
  t.ok(waited >= timings.timeout + timings.killGrace - 100, 'it waited for the escalation')
  t.ok(waited < timings.timeout + timings.killGrace + 2_000, 'the escalation is bounded')
  t.absent(alive(await readPid('ignores')), 'SIGKILL had ended the child when the call settled')

  // Writes late on SIGTERM: it has finished writing before the call settles, so the next
  // publication of the same link cannot be overwritten afterwards.
  const result = pidFile('result')
  await t.exception(publish(late, 'late', result), /timed out/)
  const settledWith = await fs.promises.readFile(result, 'utf8')
  t.is(settledWith, 'old', 'the old publisher had finished writing when the call settled')
  await fs.promises.writeFile(result, 'new')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const finalContents = await fs.promises.readFile(result, 'utf8')
  t.is(finalContents, 'new', 'a stopped publisher cannot overwrite the next publication')
})

// Run in a separate Node process: it replaces `spawn` in `node:child_process` with a fake
// child whose every signal is refused (an 'error' event, as when the kill gets EPERM), so
// nothing leaks into the main test runner.
const REFUSED_SIGNALS = `
const { EventEmitter } = require('node:events')
const cp = require('node:child_process')
const kills = []
let child
cp.spawn = () => {
  child = new EventEmitter()
  child.pid = 4242
  child.stdin = { on() {}, end() {} }
  child.kill = (signal) => {
    kills.push(signal)
    setImmediate(() => child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })))
    return false
  }
  return child
}
require('node:module').syncBuiltinESMExports()
process.on('uncaughtException', (error) => {
  console.log(JSON.stringify({ uncaught: error.message }))
  process.exit(2)
})
import(process.argv[1]).then(async ({ runPublisher }) => {
  let outcome = 'pending'
  const call = runPublisher('publisher', [], 'input', { timeout: 50, killGrace: 50 }).then(
    () => { outcome = 'resolved' },
    (error) => { outcome = error.message }
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const before = { kills: kills.slice(), outcome }
  child.emit('exit', 0, null)
  await call
  console.log(JSON.stringify({ before, after: outcome }))
})
`

test('the link-publisher example survives refused signals and stays pending until the child exits', async (t) => {
  if (typeof Bare !== 'undefined') {
    t.pass('the example spawns a Node child process')
    return
  }
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  const { execFile } = require('node:child_process') as typeof import('node:child_process')
  const example = path.resolve(__dirname, '../../examples/link-publisher/hooks.mjs')
  const { error, stdout } = await new Promise<{ error: Error | null; stdout: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        ['-e', REFUSED_SIGNALS, pathToFileURL(example).href],
        { timeout: 15_000 },
        (failure, out) => resolve({ error: failure, stdout: out })
      )
    }
  )
  const report = JSON.parse(stdout) as {
    uncaught?: string
    before: { kills: string[]; outcome: string }
    after: string
  }
  t.absent(report.uncaught, 'a refused signal raises no unhandled error')
  t.is(error, null, 'the process exits normally')
  t.alike(report.before.kills, ['SIGTERM', 'SIGKILL'], 'it escalated although both were refused')
  t.is(report.before.outcome, 'pending', 'the hook stays pending while the child is still running')
  t.is(report.after, 'publisher timed out after 50 ms', 'a later exit, even zero, is a timeout')
})
