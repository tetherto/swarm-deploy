'use strict'

const test = require('brittle')
const { EventEmitter } = require('#events')
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const {
  parseSeed,
  publicKeyFromSeed,
  keyPairFromSeed,
  READY,
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} = require('../..')
const { createTempDir } = require('../helpers/files')
const { createLocalTestnet } = require('../helpers/testnet')
const { fingerprint } = require('../../lib/server')
const { topicFromServerPublicKey } = require('../../lib/topic')
const { main } = require('../../lib/cli')

const HEX64 = /^[0-9a-f]{64}$/

function createIo(overrides = {}) {
  const stdout = []
  const stderr = []
  const io = {
    stdout: {
      write(chunk) {
        stdout.push(String(chunk))
        return true
      }
    },
    stderr: {
      write(chunk) {
        stderr.push(String(chunk))
        return true
      }
    },
    process: overrides.process || new EventEmitter(),
    ...overrides
  }
  io.captured = { stdout, stderr }
  io.text = (stream) => (stream === 'stderr' ? stderr : stdout).join('')
  return io
}

function assertNoSecret(t, text, secret) {
  t.ok(typeof secret === 'string' && secret.length > 0)
  t.absent(text.includes(secret))
}

async function waitForText(io, stream, snippet, timeout = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (io.text(stream).includes(snippet)) return io.text(stream)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${snippet}: ${io.text('stdout')} ${io.text('stderr')}`)
}

function trySpawnSync() {
  try {
    return require('child_process').spawnSync
  } catch {
    return null
  }
}

function cliBin() {
  return path.join(__dirname, '../../bin/swarm-deploy.js')
}

function bareBin() {
  return path.join(__dirname, '../../node_modules/bare-runtime/bin/bare')
}

function runtimeLabel() {
  return typeof Bare !== 'undefined' ? 'bare' : 'node'
}

test('keygen and public-key work through main without leaking the seed', async (t) => {
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
  t.is(
    serverIo.text('stdout'),
    `${serverKey}\n${fingerprint(topicFromServerPublicKey(parseSeed(serverKey)))}\nready\n`
  )
  assertNoSecret(t, serverIo.text('stdout') + serverIo.text('stderr'), serverSeed)

  const uploadIo = createIo({
    dht: testnet.createNode(),
    connectTimeout: 10_000
  })
  t.is(
    await main(
      ['upload', '--seed-file', clientSeedPath, '--server-key', serverKey, artifact],
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
      ['upload', '--seed-file', clientSeedPath, '--server-key', serverKey, batch],
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

test('upload discovery errors exit 1 without leaking the client seed', async (t) => {
  const dir = await createTempDir(t)
  const clientSeedPath = path.join(dir, 'client.seed')
  t.is(await main(['keygen', '--out', clientSeedPath], {}, createIo()), 0)
  const clientSeed = (await fs.promises.readFile(clientSeedPath, 'utf8')).trim()
  const serverKey = b4a.toString(publicKeyFromSeed(parseSeed('11'.repeat(32))), 'hex')
  const io = createIo()
  t.is(
    await main(
      [
        'upload',
        '--seed-file',
        clientSeedPath,
        '--server-key',
        serverKey,
        path.join(dir, 'missing.bin')
      ],
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
      const messages = [
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
        '--server-key',
        b4a.toString(serverKey, 'hex'),
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
    const runtimes = [{ name: 'node', bin: process.execPath }]
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
