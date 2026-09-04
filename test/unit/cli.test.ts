/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import { EventEmitter } from '#events'
import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import {
  SwarmDeployError,
  ERRORS,
  parseSeed,
  parseTopic,
  publicKeyFromSeed
} from '../../dist/index.js'
import type { PublicKey, Topic } from '../../dist/types.js'
import type { ServerOptions } from '../../dist/server.js'
import type { ClientOptions } from '../../dist/client.js'
import { createTempDir } from '../helpers/files.js'
import { topicFromServerPublicKey } from '../../dist/topic.js'
import { main } from '../../dist/cli.js'

const HEX64 = /^[0-9a-f]{64}$/
const SEED_A = 'ab'.repeat(32)
const SEED_B = 'cd'.repeat(32)
const PUBLIC_A = b4a.toString(publicKeyFromSeed(parseSeed(SEED_A)), 'hex')
const TOPIC_A = b4a.toString(topicFromServerPublicKey(parseSeed(PUBLIC_A)), 'hex')

type CliIo = NonNullable<Parameters<typeof main>[2]>
type ServerConstructor = NonNullable<CliIo['Server']>
type ClientConstructor = NonNullable<CliIo['Client']>

interface CapturedStream {
  write(chunk: unknown): boolean
}

interface IoOverrides {
  process?: EventEmitter
  Server?: ServerConstructor
  Client?: ClientConstructor
}

/** The CLI IO seam plus the capture helpers these tests assert against. */
interface TestIo extends CliIo {
  stdout: CapturedStream
  stderr: CapturedStream
  process: EventEmitter
  captured: { stdout: string[]; stderr: string[] }
  text(stream: 'stdout' | 'stderr'): string
}

interface ServerRunExtras {
  process?: EventEmitter
  Server?: ServerConstructor
  signal?: string
}

interface ServerRun {
  code: number
  io: TestIo
  server: FakeServer
  process: EventEmitter
}

/** The file handle members the keygen race replaces or forwards. */
interface KeygenDescriptor {
  fd: number
  chmod(...args: unknown[]): Promise<unknown>
  stat(...args: unknown[]): Promise<unknown>
  write(...args: unknown[]): Promise<unknown>
  sync(...args: unknown[]): Promise<unknown>
  close(): Promise<void>
}

/**
 * A mutable view of the runtime filesystem module. `#fs` is patched in place so
 * the CLI observes the injected behaviour; only the two replaced members are
 * described here.
 */
interface PatchableFs {
  promises: {
    open(openPath: string, flags?: unknown, mode?: unknown): Promise<KeygenDescriptor>
    unlink(unlinkPath: string): Promise<void>
  }
}

function createIo(overrides: IoOverrides = {}): TestIo {
  const stdout: string[] = []
  const stderr: string[] = []
  const io = {
    stdout: {
      write(chunk: unknown) {
        stdout.push(String(chunk))
        return true
      }
    },
    stderr: {
      write(chunk: unknown) {
        stderr.push(String(chunk))
        return true
      }
    },
    process: overrides.process || new EventEmitter(),
    ...overrides
  } as TestIo
  io.captured = { stdout, stderr }
  io.text = (stream) => (stream === 'stderr' ? stderr : stdout).join('')
  return io
}

function assertNoSecret(t: Assert, text: string, secret: string): void {
  t.ok(typeof secret === 'string' && secret.length > 0)
  t.absent(text.includes(secret), 'output must not contain secret material')
}

function publicKeyHex(seedHex: string): string {
  return b4a.toString(publicKeyFromSeed(parseSeed(seedHex)), 'hex')
}

async function writeSeedFile(filePath: string, seedHex: string, newline = true): Promise<void> {
  await fs.promises.writeFile(filePath, newline ? `${seedHex}\n` : seedHex, { mode: 0o600 })
}

async function writeAllowlist(filePath: string, keys: string[]): Promise<void> {
  await fs.promises.writeFile(filePath, keys.map((key) => `${key}\n`).join(''))
}

function topicHex(seedHex: string): string {
  return b4a.toString(topicFromServerPublicKey(publicKeyFromSeed(parseSeed(seedHex))), 'hex')
}

class FakeServer {
  static last: FakeServer | null = null

  options: ServerOptions
  publicKey: PublicKey
  topic: Topic
  closeCount: number
  closed: boolean
  listening: boolean

  constructor(options: ServerOptions) {
    FakeServer.last = this
    this.options = options
    this.publicKey = publicKeyFromSeed(options.seed)
    this.topic = topicFromServerPublicKey(this.publicKey)
    this.closeCount = 0
    this.closed = false
    this.listening = false
    if (options.logger) {
      options.logger.info?.('fake-server-constructed')
      options.logger.warn?.('fake-server-warn')
      options.logger.error?.('fake-server-error')
    }
  }

  async listen(): Promise<this> {
    if (this.closed) throw new Error('server already closed')
    this.listening = true
    return this
  }

  close(): Promise<void> {
    this.closeCount++
    this.closed = true
    return Promise.resolve()
  }
}

class FakeClient {
  static last: FakeClient | null = null
  static uploadImpl: ((inputPath: string, client: FakeClient) => Promise<unknown>) | null = null

  options: ClientOptions
  closeCount: number
  closed: boolean

  constructor(options: ClientOptions) {
    FakeClient.last = this
    this.options = options
    this.closeCount = 0
    this.closed = false
  }

  async upload(inputPath: string): Promise<unknown> {
    if (typeof FakeClient.uploadImpl === 'function') return FakeClient.uploadImpl(inputPath, this)
    return { name: path.basename(inputPath), status: 'COMMITTED' }
  }

  close(): Promise<void> {
    this.closeCount++
    this.closed = true
    return Promise.resolve()
  }
}

const fakeServer = FakeServer as unknown as ServerConstructor
const fakeClient = FakeClient as unknown as ClientConstructor

function asServerConstructor(value: unknown): ServerConstructor {
  return value as ServerConstructor
}

function asClientConstructor(value: unknown): ClientConstructor {
  return value as ClientConstructor
}

function allowedKeys(options: ServerOptions): Set<string> {
  return options.allowedKeys as Set<string>
}

async function waitForText(
  io: TestIo,
  stream: 'stdout' | 'stderr',
  snippet: string,
  timeout = 2_000
): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (io.text(stream).includes(snippet)) return io.text(stream)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${snippet}: ${io.text(stream)} ${io.text('stderr')}`)
}

async function runServerCommand(
  args: string[],
  env: Record<string, string | undefined> = {},
  extras: ServerRunExtras = {}
): Promise<ServerRun> {
  const proc = extras.process || new EventEmitter()
  const io = createIo({
    process: proc,
    Server: extras.Server || fakeServer
  })
  const running = main(['server', ...args], env, io)
  await waitForText(io, 'stdout', 'ready')
  proc.emit(extras.signal || 'SIGINT')
  const code = await running
  return { code, io, server: FakeServer.last!, process: proc }
}

test('main never calls process.exit and --help exits 0', async (t) => {
  const proc = new EventEmitter()
  ;(proc as unknown as { exit: () => never }).exit = () => {
    throw new Error('process.exit must not be called from main')
  }
  const io = createIo({ process: proc })
  const code = await main(['--help'], {}, io)
  t.is(code, 0)
  const help = io.text('stdout')
  t.ok(help.includes('keygen'))
  t.ok(help.includes('public-key'))
  t.ok(help.includes('topic'))
  t.ok(help.includes('server'))
  t.ok(help.includes('upload'))
  t.ok(help.includes('--topic <64-lower-hex>'))
  t.absent(help.includes('--server-key'))
  t.ok(help.includes('--seed-file'))
  t.ok(help.includes('[--replace-name <safe-basename>]...'))
  t.absent(help.includes('SWARM_DEPLOY_SERVER_SEED'))
  t.absent(help.includes('SWARM_DEPLOY_CLIENT_SEED'))
  t.absent(/(^|\s)--seed(\s|=|$)/.test(help))
})

test('unknown commands, unknown options, and raw --seed fail with usage', async (t) => {
  const dir = await createTempDir(t)
  const cases = [
    [],
    ['nope'],
    ['keygen', '--verbose', '--out', path.join(dir, 'a.seed')],
    ['keygen', '--out', path.join(dir, 'b.seed'), '--seed', SEED_A],
    ['public-key', '--seed', SEED_A],
    [
      'server',
      '--seed',
      SEED_A,
      '--storage',
      dir,
      '--allowlist',
      path.join(dir, 'a'),
      '--max-file-bytes',
      '1',
      '--max-staging-bytes',
      '1'
    ],
    ['upload', '--seed', SEED_A, '--topic', TOPIC_A, path.join(dir, 'file.bin')],
    ['keygen', '--out=file.seed'],
    [
      'upload',
      '--server-key',
      PUBLIC_A,
      '--seed-file',
      path.join(dir, 'c.seed'),
      path.join(dir, 'x.bin'),
      '--extra'
    ]
  ]

  for (const argv of cases) {
    const io = createIo()
    t.is(await main(argv, {}, io), 2, argv.join(' ') || '(empty)')
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
  }
})

test('keygen writes owner-only canonical seed, prints public key only, and refuses overwrite', async (t) => {
  const dir = await createTempDir(t)
  const out = path.join(dir, 'owner.seed')
  const io = createIo()

  t.is(await main(['keygen', '--out', out], {}, io), 0)
  const written = await fs.promises.readFile(out, 'utf8')
  t.ok(/^[0-9a-f]{64}\n$/.test(written))
  const seedHex = written.slice(0, 64)
  const published = io.text('stdout').trim()
  t.ok(HEX64.test(published))
  t.is(published, publicKeyHex(seedHex))
  t.is(io.text('stdout'), `${published}\n`)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), seedHex)

  const stat = await fs.promises.lstat(out)
  t.ok(stat.isFile())
  t.is(stat.mode & 0o777, 0o600)

  const again = createIo()
  t.is(
    await main(['node', path.join(dir, 'swarm-deploy.js'), 'keygen', '--out', out], {}, again),
    2
  )
  t.is(await fs.promises.readFile(out, 'utf8'), written)
  assertNoSecret(t, again.text('stdout') + again.text('stderr'), seedHex)
})

test('keygen requires --out and rejects extra positionals', async (t) => {
  const dir = await createTempDir(t)
  const io = createIo()
  t.is(await main(['keygen'], {}, io), 2)
  t.is(await main(['keygen', '--out'], {}, createIo()), 2)
  t.is(await main(['keygen', '--out', path.join(dir, 'a.seed'), 'extra'], {}, createIo()), 2)
})

test('public-key reads a bounded seed file and prints only the public key', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'client.seed')
  await writeSeedFile(seedPath, SEED_A)
  const io = createIo()

  t.is(await main(['public-key', '--seed-file', seedPath], {}, io), 0)
  t.is(io.text('stdout'), `${PUBLIC_A}\n`)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
})

test('public-key accepts a seed file without a trailing newline', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'plain.seed')
  await writeSeedFile(seedPath, SEED_B, false)
  const io = createIo()
  t.is(await main(['public-key', '--seed-file', seedPath], {}, io), 0)
  t.is(io.text('stdout'), `${publicKeyHex(SEED_B)}\n`)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_B)
})

test('topic safely derives and prints only the full committed topic', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  await writeSeedFile(seedPath, SEED_A)
  const before = await fs.promises.readFile(seedPath)
  const io = createIo()

  t.is(await main(['topic', '--seed-file', seedPath], {}, io), 0)
  t.is(io.text('stdout'), `${TOPIC_A}\n`)
  t.alike(parseTopic(io.text('stdout').trim()), parseTopic(TOPIC_A))
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
  t.alike(await fs.promises.readFile(seedPath), before)
})

test('topic rejects unsafe seed inputs and has no seed environment source', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const linkPath = path.join(dir, 'server-link.seed')
  await writeSeedFile(seedPath, SEED_A)
  await fs.promises.symlink(seedPath, linkPath)

  for (const args of [
    ['topic'],
    ['topic', '--seed-file', linkPath],
    ['topic', '--seed-file', seedPath, 'extra'],
    ['topic', '--seed-file', seedPath, '--server-key', PUBLIC_A]
  ]) {
    const io = createIo()
    t.is(await main(args, { SWARM_DEPLOY_SERVER_SEED: SEED_B }, io), 2)
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_B)
  }
})

test('public-key rejects non-canonical, oversized, linked, and missing seed files', async (t) => {
  const dir = await createTempDir(t)
  const cases = [
    ['AA'.repeat(32)],
    [`${SEED_A}\n\n`],
    [`${SEED_A} \n`],
    ['not-hex'],
    [SEED_A + 'ab']
  ]

  for (const [contents] of cases) {
    const seedPath = path.join(dir, `bad-${contents.length}.seed`)
    await fs.promises.writeFile(seedPath, contents)
    const io = createIo()
    t.is(await main(['public-key', '--seed-file', seedPath], {}, io), 2)
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
    t.absent(io.text('stdout').includes(contents.trim()))
    t.absent(io.text('stderr').includes(contents.trim()))
  }

  const missing = createIo()
  t.is(await main(['public-key', '--seed-file', path.join(dir, 'missing.seed')], {}, missing), 2)

  const target = path.join(dir, 'target.seed')
  const link = path.join(dir, 'link.seed')
  await writeSeedFile(target, SEED_A)
  await fs.promises.symlink(target, link)
  const linked = createIo()
  t.is(await main(['public-key', '--seed-file', link], {}, linked), 2)
  assertNoSecret(t, linked.text('stdout') + linked.text('stderr'), SEED_A)
})

test('server requires options and accepts file or env seed but not both', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)

  const required = [
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  t.is(await main(['server', ...required], {}, createIo({ Server: fakeServer })), 2)
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        seedPath,
        '--allowlist',
        allowlist,
        '--max-file-bytes',
        '1',
        '--max-staging-bytes',
        '1'
      ],
      {},
      createIo({ Server: fakeServer })
    ),
    2
  )
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        seedPath,
        '--storage',
        storage,
        '--max-file-bytes',
        '1',
        '--max-staging-bytes',
        '1'
      ],
      {},
      createIo({ Server: fakeServer })
    ),
    2
  )
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        seedPath,
        '--storage',
        storage,
        '--allowlist',
        allowlist,
        '--max-staging-bytes',
        '1'
      ],
      {},
      createIo({ Server: fakeServer })
    ),
    2
  )

  const fileOnly = await runServerCommand([
    '--seed-file',
    seedPath,
    ...required,
    '--max-storage-bytes',
    '4096',
    '--max-age-days',
    '7'
  ])
  t.is(fileOnly.code, 0)
  t.alike(fileOnly.server.options.seed, parseSeed(SEED_A))
  t.is(fileOnly.server.options.storageDir, storage)
  t.is(fileOnly.server.options.maxFileBytes, 1024)
  t.is(fileOnly.server.options.maxStagingBytes, 2048)
  t.is(fileOnly.server.options.maxStorageBytes, 4096)
  t.is(fileOnly.server.options.maxAge, 7 * 24 * 60 * 60 * 1000)
  t.is(fileOnly.server.options.allowlistPath, allowlist)
  t.ok(allowedKeys(fileOnly.server.options).has(PUBLIC_A))
  t.is(fileOnly.io.text('stdout'), `${PUBLIC_A}\n${topicHex(SEED_A)}\nready\n`)
  assertNoSecret(t, fileOnly.io.text('stdout') + fileOnly.io.text('stderr'), SEED_A)

  const envOnly = await runServerCommand(required, { SWARM_DEPLOY_SERVER_SEED: SEED_B })
  t.is(envOnly.code, 0)
  t.alike(envOnly.server.options.seed, parseSeed(SEED_B))
  assertNoSecret(t, envOnly.io.text('stdout') + envOnly.io.text('stderr'), SEED_B)

  const conflict = createIo({ Server: fakeServer })
  t.is(
    await main(
      ['server', '--seed-file', seedPath, ...required],
      { SWARM_DEPLOY_SERVER_SEED: SEED_B },
      conflict
    ),
    2
  )
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_A)
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_B)
})

test('server accepts repeatable replacement names and passes an exact set', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  const base = [
    '--seed-file',
    seedPath,
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  const configured = await runServerCommand([
    ...base,
    '--replace-name',
    'release.tar.gz',
    '--replace-name',
    'latest.bin'
  ])
  t.is(configured.code, 0)
  t.alike(configured.server.options.replaceNames, new Set(['release.tar.gz', 'latest.bin']))

  const defaults = await runServerCommand(base)
  t.is(defaults.code, 0)
  t.alike(defaults.server.options.replaceNames, new Set())
})

test('replacement flag validates names without relaxing strict option parsing', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  const base = [
    'server',
    '--seed-file',
    seedPath,
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  const invalid = [
    [...base, '--replace-name', '../release.tar.gz'],
    [...base, '--replace-name', 'history-release.tar.gz'],
    [...base, '--replace-name', 'release.tar.gz', '--replace-name', 'release.tar.gz'],
    [...base, '--max-file-bytes', '4096'],
    [
      'upload',
      '--seed-file',
      seedPath,
      '--topic',
      TOPIC_A,
      '--replace-name',
      'release.tar.gz',
      path.join(dir, 'artifact.bin')
    ]
  ]

  for (const argv of invalid) {
    const io = createIo({ Server: fakeServer, Client: fakeClient })
    t.is(await main(argv, {}, io), 2, argv.join(' '))
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
  }
})

test('server rejects non-canonical byte and day options', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  const base = [
    '--seed-file',
    seedPath,
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  const invalid: Array<{ replace?: Record<string, string>; extra?: string[] }> = [
    { replace: { '--max-file-bytes': '0' } },
    { replace: { '--max-file-bytes': '-1' } },
    { replace: { '--max-file-bytes': '1.5' } },
    { replace: { '--max-file-bytes': '1e3' } },
    { replace: { '--max-file-bytes': '01' } },
    { replace: { '--max-file-bytes': '+1024' } },
    { replace: { '--max-file-bytes': '9007199254740992' } },
    { replace: { '--max-staging-bytes': '0' } },
    { extra: ['--max-storage-bytes', '1.0'] },
    { extra: ['--max-age-days', '0'] },
    { extra: ['--max-age-days', '1.5'] },
    { extra: ['--max-age-days', String(Math.floor(Number.MAX_SAFE_INTEGER / 86400000) + 1)] }
  ]

  for (const case_ of invalid) {
    const args = [...base]
    if (case_.replace) {
      for (const [option, value] of Object.entries(case_.replace)) {
        const index = args.indexOf(option)
        args[index + 1] = value
      }
    }
    if (case_.extra) args.push(...case_.extra)
    const io = createIo({ Server: fakeServer })
    const label = JSON.stringify(case_.replace || case_.extra)
    t.is(await main(['server', ...args], {}, io), 2, label)
    assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
  }
})

test('server config failures exit 2 and listen failures exit 1', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, ['not-a-key'])
  await fs.promises.mkdir(storage)
  const args = [
    '--seed-file',
    seedPath,
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  const invalidAllowlist = createIo({ Server: fakeServer })
  t.is(await main(['server', ...args], {}, invalidAllowlist), 2)

  await writeAllowlist(allowlist, [PUBLIC_A])
  class CtorFail {
    constructor() {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid server options')
    }
  }
  const ctor = createIo({ Server: asServerConstructor(CtorFail) })
  t.is(await main(['server', ...args], {}, ctor), 2)

  class ListenFail extends FakeServer {
    async listen(): Promise<this> {
      throw new Error('swarm bind failed')
    }
  }
  const listen = createIo({ Server: asServerConstructor(ListenFail) })
  t.is(await main(['server', ...args], {}, listen), 1)
  t.is(ListenFail.last!.closeCount, 1)
  assertNoSecret(t, listen.text('stdout') + listen.text('stderr'), SEED_A)
  t.absent(listen.text('stdout').includes('ready'))

  class ProtocolListenFail extends FakeServer {
    async listen(): Promise<this> {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Malformed runtime frame')
    }
  }
  const protocol = createIo({ Server: asServerConstructor(ProtocolListenFail) })
  t.is(await main(['server', ...args], {}, protocol), 1)
  t.is(ProtocolListenFail.last!.closeCount, 1)
  assertNoSecret(t, protocol.text('stdout') + protocol.text('stderr'), SEED_A)
})

test('SIGINT and SIGTERM close the server once and remain idempotent', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  const args = [
    '--seed-file',
    seedPath,
    '--storage',
    storage,
    '--allowlist',
    allowlist,
    '--max-file-bytes',
    '1024',
    '--max-staging-bytes',
    '2048'
  ]

  for (const signal of ['SIGINT', 'SIGTERM']) {
    FakeServer.last = null
    const first = await runServerCommand(args, {}, { signal })
    t.is(first.code, 0, signal)
    t.is(first.server.closeCount, 1)
    t.is(first.server.closed, true)
    first.process.emit(signal)
    first.process.emit('SIGINT')
    t.is(first.server.closeCount, 1)
  }

  const proc = new EventEmitter()
  const io = createIo({ process: proc, Server: fakeServer })
  const running = main(['server', ...args], {}, io)
  await waitForText(io, 'stdout', 'ready')
  proc.emit('SIGINT')
  proc.emit('SIGTERM')
  t.is(await running, 0)
  t.is(FakeServer.last!.closeCount, 1)
})

test('server logger exceptions are contained', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  const proc = new EventEmitter()
  const io = createIo({ process: proc, Server: fakeServer })
  io.stderr.write = () => {
    throw new Error('stderr unavailable')
  }
  const running = main(
    [
      'server',
      '--seed-file',
      seedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '2048'
    ],
    {},
    io
  )
  await waitForText(io, 'stdout', 'ready')
  proc.emit('SIGTERM')
  t.is(await running, 0)
  t.is(FakeServer.last!.closeCount, 1)
})

test('upload requires options and accepts file or env seed but not both', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'client.seed')
  const artifact = path.join(dir, 'artifact.bin')
  await writeSeedFile(seedPath, SEED_A)
  await fs.promises.writeFile(artifact, 'bytes')

  t.is(
    await main(['upload', '--topic', TOPIC_A, artifact], {}, createIo({ Client: fakeClient })),
    2
  )
  t.is(
    await main(['upload', '--seed-file', seedPath, artifact], {}, createIo({ Client: fakeClient })),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--topic', TOPIC_A],
      {},
      createIo({ Client: fakeClient })
    ),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--topic', 'AA'.repeat(32), artifact],
      {},
      createIo({ Client: fakeClient })
    ),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--topic', 'ab', artifact],
      {},
      createIo({ Client: fakeClient })
    ),
    2
  )

  FakeClient.last = null
  const fileOnly = createIo({ Client: fakeClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, fileOnly),
    0
  )
  t.alike(FakeClient.last!.options.seed, parseSeed(SEED_A))
  t.alike(FakeClient.last!.options.topic, parseTopic(TOPIC_A))
  t.is(fileOnly.text('stdout'), 'artifact.bin COMMITTED\n')
  t.is(FakeClient.last!.closeCount, 1)
  assertNoSecret(t, fileOnly.text('stdout') + fileOnly.text('stderr'), SEED_A)
  t.absent(fileOnly.text('stdout').includes(TOPIC_A))

  FakeClient.last = null
  const envOnly = createIo({ Client: fakeClient })
  t.is(
    await main(
      ['upload', '--topic', TOPIC_A, artifact],
      { SWARM_DEPLOY_CLIENT_SEED: SEED_B },
      envOnly
    ),
    0
  )
  t.alike(FakeClient.last!.options.seed, parseSeed(SEED_B))
  assertNoSecret(t, envOnly.text('stdout') + envOnly.text('stderr'), SEED_B)

  const conflict = createIo({ Client: fakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact],
      { SWARM_DEPLOY_CLIENT_SEED: SEED_B },
      conflict
    ),
    2
  )
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_A)
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_B)

  const obsolete = createIo({ Client: fakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      {},
      obsolete
    ),
    2
  )
})

test('upload exits 0 for committed batches, 1 for transfer or discovery failure, and 2 for identity mismatch', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'client.seed')
  const artifact = path.join(dir, 'batch')
  await writeSeedFile(seedPath, SEED_A)

  FakeClient.uploadImpl = async () => ({
    status: 'COMMITTED',
    results: [
      { name: 'ok.bin', status: 'COMMITTED' },
      { name: 'again.bin', status: 'ALREADY_COMMITTED' }
    ],
    skipped: [{ name: 'nested', reason: 'directory' }]
  })
  const ok = createIo({ Client: fakeClient })
  t.is(await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, ok), 0)
  t.ok(ok.text('stdout').includes('ok.bin COMMITTED'))
  t.ok(ok.text('stdout').includes('again.bin ALREADY_COMMITTED'))
  t.ok(ok.text('stdout').includes('nested skipped directory'))

  FakeClient.uploadImpl = async () => ({
    status: 'FAILED',
    results: [
      { name: 'ok.bin', status: 'COMMITTED' },
      { name: 'bad.bin', status: 'FILE_EXISTS' }
    ],
    skipped: [{ name: 'link', reason: 'symlink' }]
  })
  const partial = createIo({ Client: fakeClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, partial),
    1
  )
  t.ok(partial.text('stdout').includes('ok.bin COMMITTED'))
  t.ok(partial.text('stdout').includes('bad.bin FILE_EXISTS'))
  t.ok(partial.text('stdout').includes('link skipped symlink'))
  assertNoSecret(t, partial.text('stdout') + partial.text('stderr'), SEED_A)

  FakeClient.uploadImpl = async () => {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }
  const discovery = createIo({ Client: fakeClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, discovery),
    1
  )

  FakeClient.uploadImpl = async () => {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Malformed server frame')
  }
  const malformed = createIo({ Client: fakeClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, malformed),
    1
  )
  assertNoSecret(t, malformed.text('stdout') + malformed.text('stderr'), SEED_A)

  FakeClient.uploadImpl = null
  const mismatch = createIo()
  t.is(
    await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, mismatch),
    2
  )
})

test('client-only env is ignored by server and server-only env is ignored by upload', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'role.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  const artifact = path.join(dir, 'artifact.bin')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  await fs.promises.writeFile(artifact, 'bytes')

  const server = await runServerCommand(
    [
      '--seed-file',
      seedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '2048'
    ],
    { SWARM_DEPLOY_CLIENT_SEED: SEED_B }
  )
  t.is(server.code, 0)
  t.alike(server.server.options.seed, parseSeed(SEED_A))

  FakeClient.last = null
  const upload = createIo({ Client: fakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact],
      { SWARM_DEPLOY_SERVER_SEED: SEED_B },
      upload
    ),
    0
  )
  t.alike(FakeClient.last!.options.seed, parseSeed(SEED_A))
})

test('parser errors stay generic and never echo unique raw seed tokens', async (t) => {
  const dir = await createTempDir(t)
  const seedEquals = 'e1'.repeat(32)
  const seedCommand = 'c2'.repeat(32)
  const seedOption = 'd3'.repeat(32)
  const seedPath = 'f4'.repeat(32)

  const equals = createIo()
  t.is(await main(['keygen', `--seed=${seedEquals}`], {}, equals), 2)
  assertNoSecret(t, equals.text('stdout') + equals.text('stderr'), seedEquals)
  t.ok((equals.text('stdout') + equals.text('stderr')).includes('Raw seeds are not accepted'))

  const command = createIo()
  t.is(await main([seedCommand], {}, command), 2)
  assertNoSecret(t, command.text('stdout') + command.text('stderr'), seedCommand)
  t.ok((command.text('stdout') + command.text('stderr')).includes('Raw seeds are not accepted'))

  const unknown = createIo()
  t.is(await main(['keygen', `--verbose=${seedOption}`], {}, unknown), 2)
  assertNoSecret(t, unknown.text('stdout') + unknown.text('stderr'), seedOption)
  t.absent((unknown.text('stdout') + unknown.text('stderr')).includes('--verbose'))

  const missing = createIo()
  t.is(
    await main(
      ['public-key', '--seed-file', path.join(dir, seedPath, 'missing.seed')],
      {},
      missing
    ),
    2
  )
  assertNoSecret(t, missing.text('stdout') + missing.text('stderr'), seedPath)
})

test('wrong-role env alone is a missing seed source', async (t) => {
  const dir = await createTempDir(t)
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  const artifact = path.join(dir, 'artifact.bin')
  const wrongServer = 'a7'.repeat(32)
  const wrongClient = 'b8'.repeat(32)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)
  await fs.promises.writeFile(artifact, 'bytes')

  const server = createIo({ Server: fakeServer })
  t.is(
    await main(
      [
        'server',
        '--storage',
        storage,
        '--allowlist',
        allowlist,
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '2048'
      ],
      { SWARM_DEPLOY_CLIENT_SEED: wrongServer },
      server
    ),
    2
  )
  assertNoSecret(t, server.text('stdout') + server.text('stderr'), wrongServer)

  const upload = createIo({ Client: fakeClient })
  t.is(
    await main(
      ['upload', '--topic', TOPIC_A, artifact],
      { SWARM_DEPLOY_SERVER_SEED: wrongClient },
      upload
    ),
    2
  )
  assertNoSecret(t, upload.text('stdout') + upload.text('stderr'), wrongClient)
})

test('failed keygen unlinks only its own exclusive inode', async (t) => {
  const dir = await createTempDir(t)
  const out = path.join(dir, 'race.seed')
  const replacement = '99'.repeat(32)
  const patchable = fs as unknown as PatchableFs
  const originalOpen = patchable.promises.open
  const originalUnlink = patchable.promises.unlink
  let unlinked = false

  patchable.promises.open = async function patchedOpen(
    this: unknown,
    filePath: string,
    flags?: unknown,
    mode?: unknown
  ): Promise<KeygenDescriptor> {
    const handle = await originalOpen.call(this, filePath, flags, mode)
    if (filePath !== out) return handle
    return {
      fd: handle.fd,
      chmod: (...args: unknown[]) => handle.chmod(...args),
      stat: (...args: unknown[]) => handle.stat(...args),
      write: () => Promise.reject(new Error('injected write failure')),
      sync: (...args: unknown[]) => handle.sync(...args),
      close: async () => {
        await handle.close()
        await originalUnlink(out)
        await fs.promises.writeFile(out, `${replacement}\n`, { flag: 'wx', mode: 0o600 })
      }
    }
  }
  patchable.promises.unlink = function patchedUnlink(filePath: string): Promise<void> {
    if (filePath === out) unlinked = true
    return originalUnlink(filePath)
  }
  t.teardown(() => {
    patchable.promises.open = originalOpen
    patchable.promises.unlink = originalUnlink
  })

  const io = createIo()
  t.is(await main(['keygen', '--out', out], {}, io), 2)
  t.absent(unlinked)
  let remaining: string | null = null
  try {
    remaining = await fs.promises.readFile(out, 'utf8')
  } catch {
    t.fail('replacement seed file was removed')
  }
  t.is(remaining, `${replacement}\n`)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), replacement)
})

test('server close failure after ready exits 1 with generic cleanup output', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  const leaked = 'c4'.repeat(32)
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)

  class CloseFailServer extends FakeServer {
    close(): Promise<void> {
      this.closeCount++
      this.closed = true
      return Promise.reject(new Error(`close leaked ${leaked}`))
    }
  }

  const result = await runServerCommand(
    [
      '--seed-file',
      seedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '2048'
    ],
    {},
    { Server: asServerConstructor(CloseFailServer) }
  )
  t.is(result.code, 1)
  t.is(result.server.closeCount, 1)
  t.ok(result.io.text('stderr').includes('Cleanup failed'))
  t.absent(result.io.text('stderr').includes('close leaked'))
  assertNoSecret(t, result.io.text('stdout') + result.io.text('stderr'), leaked)
  assertNoSecret(t, result.io.text('stdout') + result.io.text('stderr'), SEED_A)
})

test('listen failure still exits 1 when a signal arrives first', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'server.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  await writeSeedFile(seedPath, SEED_A)
  await writeAllowlist(allowlist, [PUBLIC_A])
  await fs.promises.mkdir(storage)

  class DelayedListenFail extends FakeServer {
    async listen(): Promise<this> {
      await new Promise((resolve) => setTimeout(resolve, 40))
      throw new Error('swarm bind failed')
    }
  }

  const proc = new EventEmitter()
  const io = createIo({ process: proc, Server: asServerConstructor(DelayedListenFail) })
  const running = main(
    [
      'server',
      '--seed-file',
      seedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '2048'
    ],
    {},
    io
  )
  await new Promise((resolve) => setTimeout(resolve, 5))
  proc.emit('SIGINT')
  t.is(await running, 1)
  t.is(DelayedListenFail.last!.closeCount, 1)
  t.absent(io.text('stdout').includes('ready'))
})

test('upload success with a rejecting client close exits 1', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'client.seed')
  const artifact = path.join(dir, 'artifact.bin')
  const leaked = 'e5'.repeat(32)
  await writeSeedFile(seedPath, SEED_A)
  await fs.promises.writeFile(artifact, 'bytes')

  class CloseFailClient extends FakeClient {
    close(): Promise<void> {
      this.closeCount++
      this.closed = true
      return Promise.reject(new Error(`close leaked ${leaked}`))
    }
  }

  const io = createIo({ Client: asClientConstructor(CloseFailClient) })
  t.is(await main(['upload', '--seed-file', seedPath, '--topic', TOPIC_A, artifact], {}, io), 1)
  t.is(CloseFailClient.last!.closeCount, 1)
  t.ok(io.text('stdout').includes('artifact.bin COMMITTED'))
  t.ok(io.text('stderr').includes('Cleanup failed'))
  t.absent(io.text('stderr').includes('close leaked'))
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), leaked)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
})
