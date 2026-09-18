/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import path from '#path'
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
  t.is(
    await main(['public-key', '--seed', uppercaseSeed], {}, { stderr: malformedSeed.stream }),
    2
  )
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
