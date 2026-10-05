/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import path from '#path'
import process from '#process'
import { main } from '../../dist/cli.js'
import { parseAllowlist } from '../../dist/allowlist.js'
import { keyPairFromSeed } from '../../dist/identity.js'
import {
  ERRORS,
  SwarmDeployError,
  type ClientOptions,
  type ServerOptions
} from '../../dist/index.js'
import { createTempDir } from '../helpers/files.js'
import { waitFor } from '../helpers/testnet.js'

const EventEmitter = events.EventEmitter
const CLIENT_SEED = b4a.alloc(32, 71)
const SERVER_SEED = b4a.alloc(32, 72)
const ALTERNATE_SEED = b4a.alloc(32, 73)
const CLIENT_KEY = keyPairFromSeed(CLIENT_SEED).publicKey
const SERVER_KEY = keyPairFromSeed(SERVER_SEED).publicKey

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

test('allowlist parsing rejects duplicate canonical keys', (t) => {
  const key = b4a.toString(CLIENT_KEY, 'hex')
  let failure: unknown = null
  try {
    parseAllowlist(`${key}\n${key}\n`)
  } catch (error) {
    failure = error
  }
  t.is((failure as Error | null)?.message, 'Duplicate allowlist key')
})

test('CLI passes --server-key only to the direct client', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'client.seed')
  const artifact = path.join(root, 'artifact.txt')
  await fs.promises.writeFile(seedPath, `${b4a.toString(CLIENT_SEED, 'hex')}\n`, { mode: 0o600 })
  await fs.promises.writeFile(artifact, 'small direct upload')

  let options: ClientOptions | null = null
  class Client {
    constructor(value: ClientOptions) {
      options = value
    }
    upload() {
      return Promise.resolve({
        status: 'COMMITTED' as const,
        name: 'artifact.txt',
        size: 19,
        digest: b4a.alloc(32),
        transferId: b4a.alloc(32)
      })
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  const stderr = output()
  t.is(
    await main(
      [
        'upload',
        '--seed-file',
        seedPath,
        '--server-key',
        b4a.toString(SERVER_KEY, 'hex'),
        '--idle-timeout',
        '4321',
        artifact
      ],
      {},
      {
        Client: Client as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    ),
    0
  )
  const clientOptions = options as unknown as ClientOptions
  t.alike(clientOptions.serverPublicKey, SERVER_KEY)
  t.is(clientOptions.idleTimeout, 4321)
  t.absent('topic' in clientOptions)
  t.is(stdout.text(), 'artifact.txt COMMITTED\n')
  t.is(stderr.text(), '')
})

test('CLI snapshots repeatable --allow-key values for the direct server', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'server.seed')
  await fs.promises.writeFile(seedPath, `${b4a.toString(SERVER_SEED, 'hex')}\n`, { mode: 0o600 })

  let options: ServerOptions | null = null
  let stop: (() => void) | null = null
  class Server {
    publicKey = SERVER_KEY
    constructor(value: ServerOptions) {
      options = value
    }
    listen() {
      queueMicrotask(() => stop?.())
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  const stderr = output()
  const signals = {
    on(_signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
      stop = listener
    },
    off() {}
  }
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        seedPath,
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      {},
      {
        Server: Server as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: signals,
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    ),
    0
  )
  const serverOptions = options as unknown as ServerOptions
  t.alike([...serverOptions.allowedKeys], [CLIENT_KEY])
  t.is(stdout.text(), `${b4a.toString(SERVER_KEY, 'hex')}\nready\n`)
  t.is(stderr.text(), '')
})

test('CLI accepts canonical --seed strings and rejects competing seed sources', async (t) => {
  const root = await createTempDir(t)
  const artifact = path.join(root, 'string-seed.txt')
  const seedPath = path.join(root, 'client.seed')
  const clientSeed = b4a.toString(CLIENT_SEED, 'hex')
  const serverSeed = b4a.toString(SERVER_SEED, 'hex')
  await fs.promises.writeFile(artifact, 'string seed upload')
  await fs.promises.writeFile(seedPath, `${clientSeed}\n`)

  const publicKeyOut = output()
  t.is(await main(['public-key', '--seed', clientSeed], {}, { stdout: publicKeyOut.stream }), 0)
  t.is(publicKeyOut.text(), `${b4a.toString(CLIENT_KEY, 'hex')}\n`)
  const malformedSeed = output()
  const uppercaseSeed = 'AB'.repeat(32)
  t.is(await main(['public-key', '--seed', uppercaseSeed], {}, { stderr: malformedSeed.stream }), 2)
  t.absent(malformedSeed.text().includes(uppercaseSeed))

  let clientOptions: ClientOptions | null = null
  class Client {
    constructor(options: ClientOptions) {
      clientOptions = options
    }
    upload() {
      return Promise.resolve({
        status: 'COMMITTED' as const,
        name: 'string-seed.txt',
        size: 18,
        digest: b4a.alloc(32),
        transferId: b4a.alloc(32)
      })
    }
    close() {
      return Promise.resolve()
    }
  }
  const uploadOut = output()
  const uploadErr = output()
  t.is(
    await main(
      ['upload', '--seed', clientSeed, '--server-key', b4a.toString(SERVER_KEY, 'hex'), artifact],
      {},
      {
        Client: Client as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stdout: uploadOut.stream,
        stderr: uploadErr.stream
      }
    ),
    0
  )
  t.alike((clientOptions as unknown as ClientOptions).seed, CLIENT_SEED)
  t.absent(`${uploadOut.text()}${uploadErr.text()}`.includes(clientSeed))

  const proc = new EventEmitter()
  let serverOptions: ServerOptions | null = null
  class Server {
    publicKey = SERVER_KEY
    constructor(options: ServerOptions) {
      serverOptions = options
    }
    listen() {
      queueMicrotask(() => proc.emit('SIGTERM'))
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const serverOut = output()
  t.is(
    await main(
      [
        'server',
        '--seed',
        serverSeed,
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      {},
      {
        Server: Server as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: proc,
        stdout: serverOut.stream
      }
    ),
    0
  )
  t.alike((serverOptions as unknown as ServerOptions).seed, SERVER_SEED)
  t.absent(serverOut.text().includes(serverSeed))

  for (const extra of [['--seed-file', seedPath], [] as string[]]) {
    const stderr = output()
    const env = extra.length === 0 ? { SWARM_DEPLOY_CLIENT_SEED: clientSeed } : {}
    t.is(
      await main(
        [
          'upload',
          '--seed',
          clientSeed,
          ...extra,
          '--server-key',
          b4a.toString(SERVER_KEY, 'hex'),
          artifact
        ],
        env,
        { stderr: stderr.stream }
      ),
      2
    )
    t.absent(stderr.text().includes(clientSeed))
  }
})

test('CLI accepts role-specific environment seeds, rejects file conflicts, and hides secrets', async (t) => {
  const root = await createTempDir(t)
  const clientSeedPath = path.join(root, 'client.seed')
  const serverSeedPath = path.join(root, 'server.seed')
  const artifact = path.join(root, 'artifact.txt')
  await fs.promises.writeFile(clientSeedPath, `${b4a.toString(CLIENT_SEED, 'hex')}\n`)
  await fs.promises.writeFile(serverSeedPath, `${b4a.toString(SERVER_SEED, 'hex')}\n`)
  await fs.promises.writeFile(artifact, 'environment seed upload')

  let clientOptions: ClientOptions | null = null
  class Client {
    constructor(options: ClientOptions) {
      clientOptions = options
    }
    upload() {
      return Promise.resolve({
        status: 'COMMITTED' as const,
        name: 'artifact.txt',
        size: 23,
        digest: b4a.alloc(32),
        transferId: b4a.alloc(32)
      })
    }
    close() {
      return Promise.resolve()
    }
  }
  const uploadOut = output()
  const uploadErr = output()
  t.is(
    await main(
      ['upload', '--server-key', b4a.toString(SERVER_KEY, 'hex'), artifact],
      { SWARM_DEPLOY_CLIENT_SEED: b4a.toString(ALTERNATE_SEED, 'hex') },
      {
        Client: Client as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stdout: uploadOut.stream,
        stderr: uploadErr.stream
      }
    ),
    0
  )
  t.alike((clientOptions as unknown as ClientOptions).seed, ALTERNATE_SEED)

  const conflictOut = output()
  const conflictErr = output()
  t.is(
    await main(
      [
        'upload',
        '--seed-file',
        clientSeedPath,
        '--server-key',
        b4a.toString(SERVER_KEY, 'hex'),
        artifact
      ],
      { SWARM_DEPLOY_CLIENT_SEED: b4a.toString(ALTERNATE_SEED, 'hex') },
      { stdout: conflictOut.stream, stderr: conflictErr.stream }
    ),
    2
  )

  const proc = new EventEmitter()
  let serverOptions: ServerOptions | null = null
  class Server {
    publicKey = SERVER_KEY
    constructor(options: ServerOptions) {
      serverOptions = options
    }
    listen() {
      queueMicrotask(() => proc.emit('SIGTERM'))
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const serverOut = output()
  const serverErr = output()
  t.is(
    await main(
      [
        'server',
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      { SWARM_DEPLOY_SERVER_SEED: b4a.toString(ALTERNATE_SEED, 'hex') },
      {
        Server: Server as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: proc,
        stdout: serverOut.stream,
        stderr: serverErr.stream
      }
    ),
    0
  )
  t.alike((serverOptions as unknown as ServerOptions).seed, ALTERNATE_SEED)

  const serverConflict = output()
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        serverSeedPath,
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      { SWARM_DEPLOY_SERVER_SEED: b4a.toString(ALTERNATE_SEED, 'hex') },
      { stderr: serverConflict.stream }
    ),
    2
  )

  const combined =
    uploadOut.text() +
    uploadErr.text() +
    conflictOut.text() +
    conflictErr.text() +
    serverOut.text() +
    serverErr.text() +
    serverConflict.text()
  for (const secret of [CLIENT_SEED, SERVER_SEED, ALTERNATE_SEED]) {
    t.absent(combined.includes(b4a.toString(secret, 'hex')))
  }
  t.absent((uploadOut.text() + uploadErr.text()).includes(b4a.toString(SERVER_KEY, 'hex')))
  t.absent((serverOut.text() + serverErr.text()).includes(b4a.toString(CLIENT_KEY, 'hex')))
})

test('CLI rejects malformed and duplicate repeatable allow keys as configuration failures', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'server.seed')
  await fs.promises.writeFile(seedPath, `${b4a.toString(SERVER_SEED, 'hex')}\n`)
  const valid = b4a.toString(CLIENT_KEY, 'hex')
  const cases = [[valid.toUpperCase()], ['ab'], [valid, valid]]

  for (const allowed of cases) {
    const stderr = output()
    const args = [
      'server',
      '--seed-file',
      seedPath,
      '--storage',
      root,
      ...allowed.flatMap((value) => ['--allow-key', value]),
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '4096'
    ]
    t.is(await main(args, {}, { stderr: stderr.stream }), 2)
    t.ok(stderr.text().includes('Invalid --allow-key'))
    t.absent(stderr.text().includes(valid))
    t.absent(stderr.text().includes(b4a.toString(SERVER_SEED, 'hex')))
  }
})

test('CLI keeps configuration and runtime exit classifications stable and private', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'client.seed')
  const artifact = path.join(root, 'artifact.txt')
  await fs.promises.writeFile(seedPath, `${b4a.toString(CLIENT_SEED, 'hex')}\n`)
  await fs.promises.writeFile(artifact, 'runtime classification')
  const common = ['upload', '--seed-file', seedPath, '--server-key']

  const malformed = output()
  t.is(await main([...common, 'not-a-key', artifact], {}, { stderr: malformed.stream }), 2)

  class RuntimeFailureClient {
    upload() {
      return Promise.reject(new SwarmDeployError(ERRORS.FILE_BUSY, 'runtime busy'))
    }
    close() {
      return Promise.resolve()
    }
  }
  const runtime = output()
  t.is(
    await main(
      [...common, b4a.toString(SERVER_KEY, 'hex'), artifact],
      {},
      {
        Client: RuntimeFailureClient as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stderr: runtime.stream
      }
    ),
    1
  )
  t.ok(runtime.text().includes('runtime busy'))

  class ConfigFailureClient {
    constructor() {
      throw new SwarmDeployError(ERRORS.SERVER_KEY_MISMATCH, 'invalid pin configuration')
    }
  }
  const constructor = output()
  t.is(
    await main(
      [...common, b4a.toString(SERVER_KEY, 'hex'), artifact],
      {},
      {
        Client: ConfigFailureClient as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stderr: constructor.stream
      }
    ),
    2
  )
  const combined = malformed.text() + runtime.text() + constructor.text()
  t.absent(combined.includes(b4a.toString(CLIENT_SEED, 'hex')))
  t.absent(combined.includes(b4a.toString(SERVER_KEY, 'hex')))
})

test('CLI SIGINT and SIGTERM close server and upload resources exactly once', async (t) => {
  const root = await createTempDir(t)
  const artifact = path.join(root, 'signal.txt')
  await fs.promises.writeFile(artifact, 'signal behavior')

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const serverProcess = new EventEmitter()
    const serverOut = output()
    let serverCloses = 0
    class SignalServer {
      publicKey = SERVER_KEY
      listen() {
        return Promise.resolve(this)
      }
      close() {
        serverCloses++
        return Promise.resolve()
      }
    }
    const serving = main(
      [
        'server',
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      { SWARM_DEPLOY_SERVER_SEED: b4a.toString(SERVER_SEED, 'hex') },
      {
        Server: SignalServer as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: serverProcess,
        stdout: serverOut.stream
      }
    )
    await waitFor(() => serverProcess.listenerCount(signal) === 1)
    serverProcess.emit(signal)
    t.is(await serving, 0, `${signal} server exit`)
    t.is(serverCloses, 1, `${signal} server close`)
    t.absent(serverOut.text().includes(b4a.toString(CLIENT_KEY, 'hex')))
    t.absent(serverOut.text().includes(b4a.toString(SERVER_SEED, 'hex')))

    const uploadProcess = new EventEmitter()
    let uploadCloses = 0
    let rejectUpload: ((error: Error) => void) | null = null
    class SignalClient {
      upload() {
        return new Promise((_resolve, reject) => {
          rejectUpload = reject
        })
      }
      close() {
        uploadCloses++
        rejectUpload?.(new SwarmDeployError(ERRORS.ABORTED, 'Operation aborted'))
        return Promise.resolve()
      }
    }
    const stderr = output()
    const uploading = main(
      ['upload', '--server-key', b4a.toString(SERVER_KEY, 'hex'), artifact],
      { SWARM_DEPLOY_CLIENT_SEED: b4a.toString(CLIENT_SEED, 'hex') },
      {
        Client: SignalClient as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        process: uploadProcess,
        stderr: stderr.stream
      }
    )
    await waitFor(() => uploadProcess.listenerCount(signal) === 1)
    uploadProcess.emit(signal)
    t.is(await uploading, 1, `${signal} upload exit`)
    t.is(uploadCloses, 1, `${signal} upload close`)
    t.absent(stderr.text().includes(b4a.toString(CLIENT_SEED, 'hex')))
    t.absent(stderr.text().includes(b4a.toString(SERVER_KEY, 'hex')))
  }
})

type ServerConstructor = new (options: ServerOptions) => import('../../dist/server.js').Server

async function runServerCli(
  root: string,
  extra: string[],
  io: { cwd?: string; Server?: ServerConstructor } = {}
) {
  let options: ServerOptions | null = null
  let constructed = 0
  let listened = 0
  class Server {
    publicKey = SERVER_KEY
    constructor(value: ServerOptions) {
      constructed++
      options = value
    }
    listen() {
      listened++
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  const stderr = output()
  const proc = new EventEmitter()
  const running = main(
    [
      'server',
      '--storage',
      root,
      '--allow-key',
      b4a.toString(CLIENT_KEY, 'hex'),
      '--max-file-bytes',
      '1024',
      '--max-staging-bytes',
      '4096',
      ...extra
    ],
    { SWARM_DEPLOY_SERVER_SEED: b4a.toString(SERVER_SEED, 'hex') },
    {
      Server: (io.Server || (Server as unknown as ServerConstructor)) as ServerConstructor,
      process: proc,
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: io.cwd
    }
  )
  // A started server waits for a signal; a rejected configuration never registers one.
  const settled = await Promise.race([
    running,
    waitFor(() => proc.listenerCount('SIGINT') === 1).then(() => 'waiting' as const)
  ])
  if (settled === 'waiting') {
    proc.emit('SIGINT')
    await running
  }
  return {
    code: settled === 'waiting' ? await running : settled,
    options: options as ServerOptions | null,
    constructed,
    listened,
    stdout: stdout.text(),
    stderr: stderr.text()
  }
}

const HOOK_LOG = '__swarmDeployCliHookLog'

function hookLog(): string[] {
  const holder = globalThis as unknown as Record<string, string[] | undefined>
  holder[HOOK_LOG] = []
  return holder[HOOK_LOG]
}

async function callAll(hooks: ServerOptions['hooks']): Promise<void> {
  await hooks?.beforeCommit?.({} as never)
  await hooks?.afterCommit?.({} as never)
  await hooks?.onFailure?.({} as never)
}

test('CLI loads CommonJS, named ESM, and default ESM hook modules relative to cwd', async (t) => {
  const root = await createTempDir(t)
  const record = (name: string) => `globalThis.${HOOK_LOG}.push('${name}')`
  await fs.promises.writeFile(
    path.join(root, 'hooks.cjs'),
    `module.exports = {
  beforeCommit: async () => { ${record('cjs:before')} },
  afterCommit: async () => { ${record('cjs:after')} },
  onFailure: async () => { ${record('cjs:failure')} }
}\n`
  )
  await fs.promises.writeFile(
    path.join(root, 'plain.js'),
    `exports.beforeCommit = () => { ${record('js:before')} }\n`
  )
  await fs.promises.writeFile(
    path.join(root, 'hooks.mjs'),
    `export async function beforeCommit () { ${record('mjs:named')} }
export default {
  beforeCommit: async () => { ${record('mjs:default-before')} },
  afterCommit: async () => { ${record('mjs:default-after')} }
}\n`
  )
  await fs.promises.writeFile(
    path.join(root, 'default-only.mjs'),
    `export default { onFailure: async () => { ${record('default:failure')} } }\n`
  )

  const cases: [string, string[], string[]][] = [
    [
      'hooks.cjs',
      ['beforeCommit', 'afterCommit', 'onFailure'],
      ['cjs:before', 'cjs:after', 'cjs:failure']
    ],
    ['plain.js', ['beforeCommit'], ['js:before']],
    ['hooks.mjs', ['afterCommit', 'beforeCommit'], ['mjs:named', 'mjs:default-after']],
    ['default-only.mjs', ['onFailure'], ['default:failure']]
  ]
  for (const [file, names, expected] of cases) {
    const log = hookLog()
    const result = await runServerCli(root, ['--hooks', `./${file}`], { cwd: root })
    t.is(result.code, 0, file)
    t.is(result.stderr, '', file)
    const hooks = result.options?.hooks
    t.ok(Object.isFrozen(hooks), `${file} snapshot is frozen`)
    t.alike(Object.keys(hooks || {}).sort(), names.slice().sort(), `${file} hook names`)
    await callAll(hooks)
    t.alike(log, expected, `${file} callbacks`)
  }
})

test('CLI resolves a relative --hooks path against the current working directory by default', async (t) => {
  const root = await createTempDir(t)
  const file = path.join(root, 'cwd-hooks.cjs')
  await fs.promises.writeFile(file, 'module.exports = { afterCommit () {} }\n')
  const relative = path.relative(process.cwd(), file)
  const result = await runServerCli(root, ['--hooks', relative])
  t.is(result.code, 0)
  t.alike(Object.keys(result.options?.hooks || {}), ['afterCommit'])
})

test('CLI rejects unusable hook modules as startup configuration errors', async (t) => {
  const root = await createTempDir(t)
  const secret = 'hook-module-secret-text'
  const modules: Record<string, string> = {
    'throws.cjs': `throw new Error('${secret}')\n`,
    'throws.mjs': `throw new Error('${secret}')\n`,
    'syntax.cjs': `module.exports = { ${secret} \n`,
    'typo-only.cjs': `module.exports = { beforeComit () {}, helper: 1 }\n`,
    'typo-only.mjs': `export function beforeComit () {}\nexport default { helper: 1 }\n`,
    'known-non-function-named.mjs': `export const beforeCommit = '${secret}'\nexport default { beforeCommit () {} }\n`,
    'known-non-function-default.cjs': `module.exports = { afterCommit: null, beforeCommit () {} }\n`,
    'throws-object.cjs': `throw { code: 'ERR_MODULE_NOT_FOUND', message: '${secret}' }\n`,
    'throws-code-getter.cjs': `throw { get code () { throw new Error('${secret}') }, message: '${secret}' }\n`,
    'throws-code-proxy.cjs': `throw new Proxy({}, { get () { throw new Error('${secret}') }, getPrototypeOf () { throw new Error('${secret}') } })\n`,
    'throws-code-getter.mjs': `throw { get code () { throw new Error('${secret}') } }\n`,
    'not-function.cjs': `module.exports = { beforeCommit: '${secret}' }\n`,
    'not-function.mjs': `export default { afterCommit: 42 }\n`,
    'primitive.cjs': `module.exports = '${secret}'\n`,
    'null.cjs': 'module.exports = null\n',
    'array.cjs': `module.exports = [() => {}]\n`,
    'empty.cjs': 'module.exports = {}\n'
  }
  for (const [name, source] of Object.entries(modules)) {
    await fs.promises.writeFile(path.join(root, name), source)
  }

  for (const name of [...Object.keys(modules), 'missing.cjs']) {
    const result = await runServerCli(root, ['--hooks', name], { cwd: root })
    t.is(result.code, 2, name)
    t.is(result.constructed, 0, `${name} never constructs the server`)
    t.is(result.listened, 0, `${name} never listens`)
    t.ok(result.stderr.includes(name), `${name} is named in the error`)
    t.absent(result.stderr.includes(secret), `${name} does not leak module content`)
    t.absent(result.stderr.includes(root), `${name} does not leak the module directory`)
    t.is(result.stdout, '', `${name} prints nothing on stdout`)
  }
})

test('CLI rejects a missing, empty, or repeated --hooks option before construction', async (t) => {
  const root = await createTempDir(t)
  await fs.promises.writeFile(path.join(root, 'a.cjs'), 'module.exports = { onFailure () {} }\n')
  await fs.promises.writeFile(path.join(root, 'b.cjs'), 'module.exports = { onFailure () {} }\n')
  const cases = [
    ['--hooks', 'a.cjs', '--hooks', 'b.cjs'],
    ['--hooks', 'a.cjs', '--hooks', 'a.cjs'],
    ['--hooks'],
    ['--hooks', '']
  ]
  for (const args of cases) {
    const result = await runServerCli(root, args, { cwd: root })
    t.is(result.code, 2, args.join(' '))
    t.is(result.constructed, 0, `${args.join(' ')} never constructs`)
    t.ok(result.stderr.length > 0)
  }
})

test('CLI passes every rotation option combination to the server exactly', async (t) => {
  const root = await createTempDir(t)
  const none = await runServerCli(root, [])
  t.is(none.code, 0)
  t.is(none.options?.artifactPatterns, undefined)
  t.is(none.options?.maxCount, undefined)
  t.is(none.options?.maxVersions, undefined)
  t.is(none.options?.versionGranularity, undefined)
  t.is(none.options?.hooks, undefined)

  const patterns = ['--artifact-pattern', '{version}/{series}.tar.gz']
  const second = ['--artifact-pattern', '{series}-{version}.tar.gz']
  const cases: [string, string[], Partial<ServerOptions>][] = [
    ['one pattern', patterns, { artifactPatterns: ['{version}/{series}.tar.gz'] }],
    [
      'repeated patterns keep order',
      [...patterns, ...second],
      { artifactPatterns: ['{version}/{series}.tar.gz', '{series}-{version}.tar.gz'] }
    ],
    [
      'patterns and count',
      [...patterns, '--max-count', '20'],
      { artifactPatterns: ['{version}/{series}.tar.gz'], maxCount: 20 }
    ],
    [
      'patterns and versions',
      [...patterns, '--max-versions', '10', '--version-granularity', 'major'],
      {
        artifactPatterns: ['{version}/{series}.tar.gz'],
        maxVersions: 10,
        versionGranularity: 'major'
      }
    ],
    [
      'everything',
      [
        ...patterns,
        ...second,
        '--max-count',
        '20',
        '--max-versions',
        '10',
        '--version-granularity',
        'minor'
      ],
      {
        artifactPatterns: ['{version}/{series}.tar.gz', '{series}-{version}.tar.gz'],
        maxCount: 20,
        maxVersions: 10,
        versionGranularity: 'minor'
      }
    ],
    [
      'options in another order',
      ['--version-granularity', 'minor', '--max-versions', '3', ...second, '--max-count', '4'],
      {
        artifactPatterns: ['{series}-{version}.tar.gz'],
        maxCount: 4,
        maxVersions: 3,
        versionGranularity: 'minor'
      }
    ]
  ]
  for (const [label, args, expected] of cases) {
    const result = await runServerCli(root, args)
    t.is(result.code, 0, label)
    t.is(result.stderr, '', label)
    t.alike(result.options?.artifactPatterns, expected.artifactPatterns, `${label} patterns`)
    t.is(result.options?.maxCount, expected.maxCount, `${label} maxCount`)
    t.is(result.options?.maxVersions, expected.maxVersions, `${label} maxVersions`)
    t.is(
      result.options?.versionGranularity,
      expected.versionGranularity,
      `${label} versionGranularity`
    )
  }
})

test('CLI rejects invalid rotation option combinations before listening', async (t) => {
  const root = await createTempDir(t)
  const cases: [string, string[]][] = [
    ['max-count without patterns', ['--max-count', '2']],
    ['max-versions without patterns', ['--max-versions', '2', '--version-granularity', 'major']],
    [
      'max-versions without a version placeholder',
      [
        '--artifact-pattern',
        '{series}.bin',
        '--max-versions',
        '2',
        '--version-granularity',
        'major'
      ]
    ],
    [
      'max-versions without granularity',
      ['--artifact-pattern', '{series}-{version}.bin', '--max-versions', '2']
    ],
    [
      'granularity without max-versions',
      ['--artifact-pattern', '{series}-{version}.bin', '--version-granularity', 'major']
    ],
    ['granularity alone', ['--version-granularity', 'major']],
    [
      'unsupported granularity',
      [
        '--artifact-pattern',
        '{series}-{version}.bin',
        '--max-versions',
        '2',
        '--version-granularity',
        'patch'
      ]
    ],
    ['pattern with no placeholder', ['--artifact-pattern', 'plain.bin']],
    ['pattern with a repeated placeholder', ['--artifact-pattern', '{series}-{series}.bin']],
    ['pattern with adjacent placeholders', ['--artifact-pattern', '{series}{version}.bin']],
    ['pattern with an unbalanced brace', ['--artifact-pattern', '{series.bin']],
    ['pattern with an empty segment', ['--artifact-pattern', 'releases//{series}.bin']],
    [
      'duplicate pattern',
      ['--artifact-pattern', '{series}.bin', '--artifact-pattern', '{series}.bin']
    ],
    ['empty pattern', ['--artifact-pattern', '']],
    ...['0', '-1', '1.5', 'abc', '01', '9007199254740993'].flatMap(
      (value): [string, string[]][] => [
        [`max-count ${value}`, ['--artifact-pattern', '{series}.bin', '--max-count', value]],
        [
          `max-versions ${value}`,
          [
            '--artifact-pattern',
            '{series}-{version}.bin',
            '--max-versions',
            value,
            '--version-granularity',
            'major'
          ]
        ]
      ]
    ),
    [
      'duplicate max-count',
      ['--artifact-pattern', '{series}.bin', '--max-count', '1', '--max-count', '2']
    ],
    [
      'duplicate granularity',
      [
        '--artifact-pattern',
        '{series}-{version}.bin',
        '--max-versions',
        '1',
        '--version-granularity',
        'major',
        '--version-granularity',
        'minor'
      ]
    ]
  ]
  for (const [label, args] of cases) {
    // The real server validates the combination, so no fake is injected.
    const stderr = output()
    const proc = new EventEmitter()
    const code = await main(
      [
        'server',
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096',
        ...args
      ],
      { SWARM_DEPLOY_SERVER_SEED: b4a.toString(SERVER_SEED, 'hex') },
      { process: proc, stderr: stderr.stream }
    )
    t.is(code, 2, label)
    t.absent(stderr.text().includes('Unknown option'), `${label} is a recognized option`)
    t.is(proc.listenerCount('SIGINT'), 0, `${label} never started`)
    t.absent(stderr.text().includes(b4a.toString(SERVER_SEED, 'hex')), `${label} hides seed`)
  }
})

test('CLI loads hook modules from paths containing URL-significant characters', async (t) => {
  const root = await createTempDir(t)
  const directory = path.join(root, 'odd dir#1?x%41')
  await fs.promises.mkdir(directory)
  await fs.promises.writeFile(
    path.join(directory, 'hooks.cjs'),
    'module.exports = { afterCommit () {} }\n'
  )
  await fs.promises.writeFile(
    path.join(directory, 'hooks.mjs'),
    'export function onFailure () {}\n'
  )
  for (const [file, name] of [
    ['hooks.cjs', 'afterCommit'],
    ['hooks.mjs', 'onFailure']
  ]) {
    const result = await runServerCli(root, ['--hooks', path.join(directory, file)])
    t.is(result.code, 0, file)
    t.alike(Object.keys(result.options?.hooks || {}), [name], file)
  }
})

test('CLI ignores harmless non-hook exports and picks only known hook names', async (t) => {
  const root = await createTempDir(t)
  const record = (name: string) => `globalThis.${HOOK_LOG}.push('${name}')`
  const files: Record<string, string> = {
    'cjs-helpers.cjs': `const config = { retries: 3 }
module.exports = {
  config,
  helper () { return 1 },
  limit: 5,
  beforeComit () {},
  afterCommit () { ${record('cjs:after')} }
}\n`,
    'esm-helpers.mjs': `export const config = { retries: 3 }
export function helper () {}
export const limit = 5
export function beforeComit () {}
export function onFailure () { ${record('esm:failure')} }\n`,
    'esm-default-helpers.mjs': `export const limit = 1
export default { limit: 2, nested: { a: 1 }, typo () {}, beforeCommit () { ${record('default:before')} } }\n`,
    'mixed.mjs': `export const beforeCommit = undefined
export const afterCommit = () => { ${record('named:after')} }
export default {
  beforeCommit () { ${record('default:before')} },
  afterCommit () { ${record('default:after')} },
  helper: 1
}\n`
  }
  for (const [name, source] of Object.entries(files)) {
    await fs.promises.writeFile(path.join(root, name), source)
  }
  const cases: [string, string[], string[]][] = [
    ['cjs-helpers.cjs', ['afterCommit'], ['cjs:after']],
    ['esm-helpers.mjs', ['onFailure'], ['esm:failure']],
    ['esm-default-helpers.mjs', ['beforeCommit'], ['default:before']],
    ['mixed.mjs', ['afterCommit', 'beforeCommit'], ['default:before', 'named:after']]
  ]
  for (const [file, names, expected] of cases) {
    const log = hookLog()
    const result = await runServerCli(root, ['--hooks', file], { cwd: root })
    t.is(result.code, 0, file)
    t.is(result.stderr, '', file)
    const hooks = result.options?.hooks
    t.alike(Object.keys(hooks || {}).sort(), names, `${file} hook names`)
    await callAll(hooks)
    t.alike(log, expected, `${file} callbacks`)
  }
})

test('CLI hook selection ignores prototypes, symbols, and __proto__ and reads each hook once', async (t) => {
  const root = await createTempDir(t)
  await fs.promises.writeFile(
    path.join(root, 'proto.cjs'),
    `const inherited = { onFailure () { globalThis.${HOOK_LOG}.push('inherited') } }
const hooks = Object.create(inherited)
hooks.afterCommit = () => {}
hooks[Symbol('beforeCommit')] = () => {}
Object.defineProperty(hooks, '__proto__', { value: { beforeCommit () {} }, enumerable: true })
module.exports = hooks\n`
  )
  await fs.promises.writeFile(
    path.join(root, 'once.cjs'),
    `let reads = 0
const hooks = {}
Object.defineProperty(hooks, 'beforeCommit', {
  enumerable: true,
  get () {
    reads++
    if (reads > 1) throw new Error('read twice')
    return () => {}
  }
})
module.exports = hooks\n`
  )
  const log = hookLog()
  const proto = await runServerCli(root, ['--hooks', 'proto.cjs'], { cwd: root })
  t.is(proto.code, 0)
  t.alike(Object.keys(proto.options?.hooks || {}), ['afterCommit'])
  await callAll(proto.options?.hooks)
  t.alike(log, [])
  t.is(Object.getPrototypeOf(proto.options?.hooks), Object.prototype)

  const once = await runServerCli(root, ['--hooks', 'once.cjs'], { cwd: root })
  t.is(once.code, 0)
  t.alike(Object.keys(once.options?.hooks || {}), ['beforeCommit'])
})

test('CLI unwraps one explicit __esModule default level for compiled CommonJS hooks', async (t) => {
  const root = await createTempDir(t)
  await fs.promises.writeFile(
    path.join(root, 'compiled.cjs'),
    `Object.defineProperty(exports, '__esModule', { value: true })
exports.default = { afterCommit () {}, helper: 1 }\n`
  )
  await fs.promises.writeFile(
    path.join(root, 'twice.cjs'),
    `Object.defineProperty(exports, '__esModule', { value: true })
exports.default = { __esModule: true, default: { __esModule: true, default: { afterCommit () {} } } }\n`
  )
  const ok = await runServerCli(root, ['--hooks', 'compiled.cjs'], { cwd: root })
  t.is(ok.code, 0)
  t.alike(Object.keys(ok.options?.hooks || {}), ['afterCommit'])
  const nested = await runServerCli(root, ['--hooks', 'twice.cjs'], { cwd: root })
  t.is(nested.code, 2)
  t.is(nested.constructed, 0)
})

test('CLI loads hooks from a .js ES module inside a type=module package', async (t) => {
  const root = await createTempDir(t)
  await fs.promises.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
  await fs.promises.writeFile(
    path.join(root, 'hooks.js'),
    'export const config = { retries: 1 }\nexport async function afterCommit () {}\n'
  )
  const result = await runServerCli(root, ['--hooks', 'hooks.js'], { cwd: root })
  t.is(result.code, 0)
  t.alike(Object.keys(result.options?.hooks || {}), ['afterCommit'])
})
