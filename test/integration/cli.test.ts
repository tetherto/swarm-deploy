/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import { EventEmitter } from '#events'
import fs from '#fs'
import path from '#path'
import b4a from 'b4a'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import { Server, parseSeed, publicKeyFromSeed, keyPairFromSeed } from '../../dist/index.js'
import { READY } from '../../dist/protocol/constants.js'
import {
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} from '../../dist/protocol/codecs.js'
import { createTempDir } from '../helpers/files.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { serverInternals } from '../helpers/internals.js'
import { topicFromServerPublicKey } from '../../dist/topic.js'
import { main } from '../../dist/cli.js'

const HEX64 = /^[0-9a-f]{64}$/

type CliIo = NonNullable<Parameters<typeof main>[2]>
type SpawnSync = typeof import('child_process').spawnSync

interface CapturedStream {
  write(chunk: unknown): boolean
}

/** The CLI seams these scenarios inject alongside the captured streams. */
interface IoOverrides {
  process?: EventEmitter
  Server?: NonNullable<CliIo['Server']>
  dht?: unknown
  connectTimeout?: number
  idleTimeout?: number
}

interface TestIo extends CliIo {
  stdout: CapturedStream
  stderr: CapturedStream
  process: EventEmitter
  captured: { stdout: string[]; stderr: string[] }
  text(stream: 'stdout' | 'stderr'): string
}

/** A Protomux message as the malformed-frame server drives it. */
interface HarnessMessage {
  send(value: unknown): boolean
}

interface SpawnedRuntime {
  name: string
  bin: string
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
  t.absent(text.includes(secret))
}

async function waitForText(
  io: TestIo,
  stream: 'stdout' | 'stderr',
  snippet: string,
  timeout = 15_000
): Promise<string> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (io.text(stream).includes(snippet)) return io.text(stream)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(`Timed out waiting for ${snippet}: ${io.text('stdout')} ${io.text('stderr')}`)
}

function trySpawnSync(): SpawnSync | null {
  try {
    return (require('child_process') as typeof import('child_process')).spawnSync
  } catch {
    return null
  }
}

function cliBin(): string {
  return path.join(__dirname, '../../dist/bin/swarm-deploy.js')
}

function bareBin(): string {
  return path.join(__dirname, '../../node_modules/bare-runtime/bin/bare')
}

function runtimeLabel(): string {
  return typeof Bare !== 'undefined' ? 'bare' : 'node'
}

test('keygen, public-key, and topic work through main without leaking the seed', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'ci.seed')
  const generated = createIo()
  t.is(await main(['keygen', '--out', seedPath], {}, generated), 0)
  const seed = (await fs.promises.readFile(seedPath, 'utf8')).trim()
  t.ok(HEX64.test(seed))
  t.is(generated.text('stdout').trim(), b4a.toString(publicKeyFromSeed(parseSeed(seed)), 'hex'))
  assertNoSecret(t, generated.text('stdout') + generated.text('stderr'), seed)

  const published = createIo()
  t.is(await main(['public-key', '--seed-file', seedPath], {}, published), 0)
  t.is(published.text('stdout'), generated.text('stdout'))
  assertNoSecret(t, published.text('stdout') + published.text('stderr'), seed)

  const topic = createIo()
  t.is(await main(['topic', '--seed-file', seedPath], {}, topic), 0)
  t.is(
    topic.text('stdout'),
    `${b4a.toString(topicFromServerPublicKey(publicKeyFromSeed(parseSeed(seed))), 'hex')}\n`
  )
  assertNoSecret(t, topic.text('stdout') + topic.text('stderr'), seed)
})

test('CLI server becomes ready then uploads a file and a directory batch', async (t) => {
  const testnet = await createLocalTestnet(t)
  const dir = await createTempDir(t)
  const serverSeedPath = path.join(dir, 'server.seed')
  const clientSeedPath = path.join(dir, 'client.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  const artifact = path.join(dir, 'artifact.bin')
  const batch = path.join(dir, 'batch')
  await fs.promises.mkdir(storage)
  await fs.promises.mkdir(batch)

  t.is(await main(['keygen', '--out', serverSeedPath], {}, createIo()), 0)
  t.is(await main(['keygen', '--out', clientSeedPath], {}, createIo()), 0)
  const serverSeed = (await fs.promises.readFile(serverSeedPath, 'utf8')).trim()
  const clientSeed = (await fs.promises.readFile(clientSeedPath, 'utf8')).trim()
  const serverKey = b4a.toString(publicKeyFromSeed(parseSeed(serverSeed)), 'hex')
  const serverTopic = b4a.toString(topicFromServerPublicKey(parseSeed(serverKey)), 'hex')
  const clientKey = b4a.toString(publicKeyFromSeed(parseSeed(clientSeed)), 'hex')
  await fs.promises.writeFile(allowlist, `${clientKey}\n`)
  await fs.promises.writeFile(artifact, 'hello from cli')
  await fs.promises.writeFile(path.join(batch, 'keep.bin'), 'keep')
  await fs.promises.mkdir(path.join(batch, 'ignored'))

  const proc = new EventEmitter()
  const serverIo = createIo({
    process: proc,
    dht: testnet.createNode()
  })
  const serving = main(
    [
      'server',
      '--seed-file',
      serverSeedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1048576',
      '--max-staging-bytes',
      '2097152'
    ],
    {},
    serverIo
  )
  await waitForText(serverIo, 'stdout', 'ready')
  t.is(serverIo.text('stdout'), `${serverKey}\n${serverTopic}\nready\n`)
  assertNoSecret(t, serverIo.text('stdout') + serverIo.text('stderr'), serverSeed)

  const uploadIo = createIo({
    dht: testnet.createNode(),
    connectTimeout: 10_000
  })
  t.is(
    await main(
      ['upload', '--seed-file', clientSeedPath, '--topic', serverTopic, artifact],
      {},
      uploadIo
    ),
    0
  )
  t.ok(uploadIo.text('stdout').includes('artifact.bin COMMITTED'))
  t.alike(await fs.promises.readFile(path.join(storage, 'artifact.bin'), 'utf8'), 'hello from cli')
  assertNoSecret(t, uploadIo.text('stdout') + uploadIo.text('stderr'), clientSeed)
  t.absent(uploadIo.text('stdout').includes(clientKey))

  const batchIo = createIo({
    dht: testnet.createNode(),
    connectTimeout: 10_000
  })
  t.is(
    await main(
      ['upload', '--seed-file', clientSeedPath, '--topic', serverTopic, batch],
      {},
      batchIo
    ),
    0
  )
  t.ok(batchIo.text('stdout').includes('keep.bin COMMITTED'))
  t.ok(batchIo.text('stdout').includes('ignored skipped directory'))
  t.alike(await fs.promises.readFile(path.join(storage, 'keep.bin'), 'utf8'), 'keep')

  proc.emit('SIGTERM')
  t.is(await serving, 0)
})

test('CLI replaces an exact mutable name and keeps managed history idempotently', async (t) => {
  const testnet = await createLocalTestnet(t)
  const dir = await createTempDir(t)
  const serverSeedPath = path.join(dir, 'server.seed')
  const clientSeedPath = path.join(dir, 'client.seed')
  const allowlist = path.join(dir, 'allowlist')
  const storage = path.join(dir, 'storage')
  const source = path.join(dir, 'release.tar.gz')
  await fs.promises.mkdir(storage)
  t.is(await main(['keygen', '--out', serverSeedPath], {}, createIo()), 0)
  t.is(await main(['keygen', '--out', clientSeedPath], {}, createIo()), 0)
  const serverSeed = (await fs.promises.readFile(serverSeedPath, 'utf8')).trim()
  const clientSeed = (await fs.promises.readFile(clientSeedPath, 'utf8')).trim()
  const serverKey = b4a.toString(publicKeyFromSeed(parseSeed(serverSeed)), 'hex')
  const serverTopic = b4a.toString(topicFromServerPublicKey(parseSeed(serverKey)), 'hex')
  const clientKey = b4a.toString(publicKeyFromSeed(parseSeed(clientSeed)), 'hex')
  await fs.promises.writeFile(allowlist, `${clientKey}\n`)

  class CapturingServer extends Server {
    static last: CapturingServer | null = null

    constructor(options: ConstructorParameters<typeof Server>[0]) {
      super(options)
      CapturingServer.last = this
    }
  }

  const proc = new EventEmitter()
  const serverIo = createIo({
    process: proc,
    Server: CapturingServer,
    dht: testnet.createNode()
  })
  const serving = main(
    [
      'server',
      '--seed-file',
      serverSeedPath,
      '--storage',
      storage,
      '--allowlist',
      allowlist,
      '--max-file-bytes',
      '1048576',
      '--max-staging-bytes',
      '2097152',
      '--replace-name',
      'release.tar.gz'
    ],
    {},
    serverIo
  )
  await waitForText(serverIo, 'stdout', 'ready')

  const upload = async () => {
    const io = createIo({ dht: testnet.createNode(), connectTimeout: 10_000 })
    const code = await main(
      ['upload', '--seed-file', clientSeedPath, '--topic', serverTopic, source],
      {},
      io
    )
    return { code, output: io.text('stdout') }
  }

  await fs.promises.writeFile(source, 'release A')
  const first = await upload()
  t.is(first.code, 0)
  t.ok(first.output.includes('release.tar.gz COMMITTED'))

  await fs.promises.writeFile(source, 'release B')
  const second = await upload()
  t.is(second.code, 0)
  t.ok(second.output.includes('release.tar.gz COMMITTED'))

  const retry = await upload()
  t.is(retry.code, 0)
  t.ok(retry.output.includes('release.tar.gz ALREADY_COMMITTED'))

  const records = await serverInternals(CapturingServer.last!).commitStore.list()
  const current = records.find((record) => record.name === 'release.tar.gz')!
  const history = records.find((record) => record.name.startsWith('history-'))!
  t.is(records.length, 2)
  t.is(history.name, `history-${history.transferId}`)
  t.is(current.replaces?.transferId, history.transferId)
  t.is(current.replaces?.historyName, history.name)
  t.is(await fs.promises.readFile(path.join(storage, 'release.tar.gz'), 'utf8'), 'release B')
  t.is(await fs.promises.readFile(path.join(storage, history.name), 'utf8'), 'release A')

  proc.emit('SIGTERM')
  t.is(await serving, 0)
})

test('upload discovery errors exit 1 without leaking the client seed', async (t) => {
  const dir = await createTempDir(t)
  const clientSeedPath = path.join(dir, 'client.seed')
  t.is(await main(['keygen', '--out', clientSeedPath], {}, createIo()), 0)
  const clientSeed = (await fs.promises.readFile(clientSeedPath, 'utf8')).trim()
  const topic = b4a.toString(
    topicFromServerPublicKey(publicKeyFromSeed(parseSeed('11'.repeat(32)))),
    'hex'
  )
  const io = createIo()
  t.is(
    await main(
      ['upload', '--seed-file', clientSeedPath, '--topic', topic, path.join(dir, 'missing.bin')],
      {},
      io
    ),
    1
  )
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), clientSeed)
})

test('CLI classifies a malformed server frame as runtime exit 1', async (t) => {
  const testnet = await createLocalTestnet(t)
  const dir = await createTempDir(t)
  const clientSeedPath = path.join(dir, 'client.seed')
  const artifact = path.join(dir, 'malformed.bin')
  await fs.promises.writeFile(clientSeedPath, `${'91'.repeat(32)}\n`, { mode: 0o600 })
  await fs.promises.writeFile(artifact, 'runtime protocol failure')
  const clientSeed = (await fs.promises.readFile(clientSeedPath, 'utf8')).trim()
  const serverSeed = b4a.alloc(32, 0x92)
  const serverKey = publicKeyFromSeed(serverSeed)
  const swarm = new Hyperswarm({
    dht: testnet.createNode(),
    keyPair: keyPairFromSeed(serverSeed)
  })
  t.teardown(() => swarm.destroy())
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    const mux = Protomux.from(socket)
    mux.pair({ protocol: 'swarm-deploy/upload/1' }, (id) => {
      const channel = mux.createChannel({ protocol: 'swarm-deploy/upload/1', id })
      const messages: HarnessMessage[] = [
        channel.addMessage({
          encoding: offer,
          onmessage(value) {
            messages[READY].send({ transferId: value.transferId })
          }
        }),
        channel.addMessage({ encoding: status }),
        channel.addMessage({ encoding: bitmapPage }),
        channel.addMessage({ encoding: ready }),
        channel.addMessage({ encoding: chunk }),
        channel.addMessage({ encoding: chunkAck }),
        channel.addMessage({ encoding: finish }),
        channel.addMessage({ encoding: result })
      ]
      channel.open()
    })
  })
  const discovery = swarm.join(topicFromServerPublicKey(serverKey), {
    server: true,
    client: false
  })
  await discovery.flushed()

  const io = createIo({ dht: testnet.createNode(), connectTimeout: 5_000, idleTimeout: 5_000 })
  t.is(
    await main(
      [
        'upload',
        '--seed-file',
        clientSeedPath,
        '--topic',
        b4a.toString(topicFromServerPublicKey(serverKey), 'hex'),
        artifact
      ],
      {},
      io
    ),
    1
  )
  t.ok(io.text('stderr').includes('Unexpected'))
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), clientSeed)
})

const spawnSync = trySpawnSync()

if (spawnSync) {
  test(`spawned ${runtimeLabel()} CLI --help exits 0`, (t) => {
    const result = spawnSync(process.execPath, [cliBin(), '--help'], { encoding: 'utf8' })
    t.is(result.status, 0)
    t.ok(result.stdout.includes('keygen'))
    t.ok(result.stdout.includes('upload'))
    t.absent(result.stdout.includes('SWARM_DEPLOY_SERVER_SEED'))
    t.absent(result.stdout.includes('SWARM_DEPLOY_CLIENT_SEED'))
    t.absent(/(^|\s)--seed(\s|=|$)/.test(result.stdout))
  })

  test('spawned Node and Bare CLI keygen refuse overwrite and hide the seed', async (t) => {
    const dir = await createTempDir(t)
    const runtimes: SpawnedRuntime[] = [{ name: 'node', bin: process.execPath }]
    try {
      const bare = bareBin()
      await fs.promises.access(bare)
      runtimes.push({ name: 'bare', bin: bare })
    } catch {}

    t.ok(runtimes.length >= 1)
    for (const runtime of runtimes) {
      const out = path.join(dir, `${runtime.name}.seed`)
      const first = spawnSync(runtime.bin, [cliBin(), 'keygen', '--out', out], { encoding: 'utf8' })
      t.is(first.status, 0, `${runtime.name} keygen`)
      const seed = (await fs.promises.readFile(out, 'utf8')).trim()
      t.ok(HEX64.test(seed), `${runtime.name} canonical seed`)
      t.is((await fs.promises.lstat(out)).mode & 0o777, 0o600)
      t.ok(HEX64.test(first.stdout.trim()))
      t.absent(first.stdout.includes(seed))
      t.absent(first.stderr.includes(seed))

      const topic = spawnSync(runtime.bin, [cliBin(), 'topic', '--seed-file', out], {
        encoding: 'utf8'
      })
      const expectedTopic = b4a.toString(
        topicFromServerPublicKey(publicKeyFromSeed(parseSeed(seed))),
        'hex'
      )
      t.is(topic.status, 0, `${runtime.name} topic`)
      t.is(topic.stdout, `${expectedTopic}\n`)
      t.absent(topic.stdout.includes(seed))
      t.absent(topic.stderr.includes(seed))

      const second = spawnSync(runtime.bin, [cliBin(), 'keygen', '--out', out], {
        encoding: 'utf8'
      })
      t.is(second.status, 2, `${runtime.name} overwrite`)
      t.absent(second.stdout.includes(seed))
      t.absent(second.stderr.includes(seed))
      t.is((await fs.promises.readFile(out, 'utf8')).trim(), seed)
    }
  })
}
