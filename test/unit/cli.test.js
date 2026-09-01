'use strict'

const test = require('brittle')
const { EventEmitter } = require('#events')
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const { SwarmDeployError, ERRORS, parseSeed, publicKeyFromSeed } = require('../..')
const { createTempDir } = require('../helpers/files')
const { fingerprint } = require('../../lib/server')
const { topicFromServerPublicKey } = require('../../lib/topic')
const { main } = require('../../lib/cli')

const HEX64 = /^[0-9a-f]{64}$/
const SEED_A = 'ab'.repeat(32)
const SEED_B = 'cd'.repeat(32)
const PUBLIC_A = b4a.toString(publicKeyFromSeed(parseSeed(SEED_A)), 'hex')

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
  t.absent(text.includes(secret), 'output must not contain secret material')
}

function publicKeyHex(seedHex) {
  return b4a.toString(publicKeyFromSeed(parseSeed(seedHex)), 'hex')
}

async function writeSeedFile(filePath, seedHex, newline = true) {
  await fs.promises.writeFile(filePath, newline ? `${seedHex}\n` : seedHex, { mode: 0o600 })
}

async function writeAllowlist(filePath, keys) {
  await fs.promises.writeFile(filePath, keys.map((key) => `${key}\n`).join(''))
}

function topicFingerprint(seedHex) {
  return fingerprint(topicFromServerPublicKey(publicKeyFromSeed(parseSeed(seedHex))))
}

class FakeServer {
  constructor(options) {
    FakeServer.last = this
    this.options = options
    this.publicKey = publicKeyFromSeed(options.seed)
    this.topic = topicFromServerPublicKey(this.publicKey)
    this.closeCount = 0
    this.closed = false
    this.listening = false
    if (options.logger) {
      options.logger.info('fake-server-constructed')
      options.logger.warn('fake-server-warn')
      options.logger.error('fake-server-error')
    }
  }

  async listen() {
    if (this.closed) throw new Error('server already closed')
    this.listening = true
    return this
  }

  close() {
    this.closeCount++
    this.closed = true
    return Promise.resolve()
  }
}

class FakeClient {
  constructor(options) {
    FakeClient.last = this
    this.options = options
    this.closeCount = 0
    this.closed = false
  }

  async upload(inputPath) {
    if (typeof FakeClient.uploadImpl === 'function') return FakeClient.uploadImpl(inputPath, this)
    return { name: path.basename(inputPath), status: 'COMMITTED' }
  }

  close() {
    this.closeCount++
    this.closed = true
    return Promise.resolve()
  }
}

async function waitForText(io, stream, snippet, timeout = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (io.text(stream).includes(snippet)) return io.text(stream)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${snippet}: ${io.text(stream)} ${io.text('stderr')}`)
}

async function runServerCommand(args, env = {}, extras = {}) {
  const proc = extras.process || new EventEmitter()
  const io = createIo({
    process: proc,
    Server: extras.Server || FakeServer,
    ...extras
  })
  const running = main(['server', ...args], env, io)
  await waitForText(io, 'stdout', 'ready')
  proc.emit(extras.signal || 'SIGINT')
  const code = await running
  return { code, io, server: FakeServer.last, process: proc }
}

test('main never calls process.exit and --help exits 0', async (t) => {
  const proc = new EventEmitter()
  proc.exit = () => {
    throw new Error('process.exit must not be called from main')
  }
  const io = createIo({ process: proc })
  const code = await main(['--help'], {}, io)
  t.is(code, 0)
  const help = io.text('stdout')
  t.ok(help.includes('keygen'))
  t.ok(help.includes('public-key'))
  t.ok(help.includes('server'))
  t.ok(help.includes('upload'))
  t.ok(help.includes('--seed-file'))
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
    ['upload', '--seed', SEED_A, '--server-key', PUBLIC_A, path.join(dir, 'file.bin')],
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

  t.is(await main(['server', ...required], {}, createIo({ Server: FakeServer })), 2)
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
      createIo({ Server: FakeServer })
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
      createIo({ Server: FakeServer })
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
      createIo({ Server: FakeServer })
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
  t.ok(fileOnly.server.options.allowedKeys.has(PUBLIC_A))
  t.is(fileOnly.io.text('stdout'), `${PUBLIC_A}\n${topicFingerprint(SEED_A)}\nready\n`)
  assertNoSecret(t, fileOnly.io.text('stdout') + fileOnly.io.text('stderr'), SEED_A)

  const envOnly = await runServerCommand(required, { SWARM_DEPLOY_SERVER_SEED: SEED_B })
  t.is(envOnly.code, 0)
  t.alike(envOnly.server.options.seed, parseSeed(SEED_B))
  assertNoSecret(t, envOnly.io.text('stdout') + envOnly.io.text('stderr'), SEED_B)

  const conflict = createIo({ Server: FakeServer })
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

  const invalid = [
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
    const io = createIo({ Server: FakeServer })
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

  const invalidAllowlist = createIo({ Server: FakeServer })
  t.is(await main(['server', ...args], {}, invalidAllowlist), 2)

  await writeAllowlist(allowlist, [PUBLIC_A])
  class CtorFail {
    constructor() {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid server options')
    }
  }
  const ctor = createIo({ Server: CtorFail })
  t.is(await main(['server', ...args], {}, ctor), 2)

  class ListenFail extends FakeServer {
    async listen() {
      throw new Error('swarm bind failed')
    }
  }
  const listen = createIo({ Server: ListenFail })
  t.is(await main(['server', ...args], {}, listen), 1)
  t.is(ListenFail.last.closeCount, 1)
  assertNoSecret(t, listen.text('stdout') + listen.text('stderr'), SEED_A)
  t.absent(listen.text('stdout').includes('ready'))
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
  const io = createIo({ process: proc, Server: FakeServer })
  const running = main(['server', ...args], {}, io)
  await waitForText(io, 'stdout', 'ready')
  proc.emit('SIGINT')
  proc.emit('SIGTERM')
  t.is(await running, 0)
  t.is(FakeServer.last.closeCount, 1)
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
  const io = createIo({ process: proc, Server: FakeServer })
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
  t.is(FakeServer.last.closeCount, 1)
})

test('upload requires options and accepts file or env seed but not both', async (t) => {
  const dir = await createTempDir(t)
  const seedPath = path.join(dir, 'client.seed')
  const artifact = path.join(dir, 'artifact.bin')
  await writeSeedFile(seedPath, SEED_A)
  await fs.promises.writeFile(artifact, 'bytes')

  t.is(
    await main(
      ['upload', '--server-key', PUBLIC_A, artifact],
      {},
      createIo({ Client: FakeClient })
    ),
    2
  )
  t.is(
    await main(['upload', '--seed-file', seedPath, artifact], {}, createIo({ Client: FakeClient })),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A],
      {},
      createIo({ Client: FakeClient })
    ),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', 'AA'.repeat(32), artifact],
      {},
      createIo({ Client: FakeClient })
    ),
    2
  )
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', 'ab', artifact],
      {},
      createIo({ Client: FakeClient })
    ),
    2
  )

  FakeClient.last = null
  const fileOnly = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      {},
      fileOnly
    ),
    0
  )
  t.alike(FakeClient.last.options.seed, parseSeed(SEED_A))
  t.alike(FakeClient.last.options.serverPublicKey, parseSeed(PUBLIC_A))
  t.is(fileOnly.text('stdout'), 'artifact.bin COMMITTED\n')
  t.is(FakeClient.last.closeCount, 1)
  assertNoSecret(t, fileOnly.text('stdout') + fileOnly.text('stderr'), SEED_A)
  t.absent(fileOnly.text('stdout').includes(PUBLIC_A))

  FakeClient.last = null
  const envOnly = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--server-key', PUBLIC_A, artifact],
      { SWARM_DEPLOY_CLIENT_SEED: SEED_B },
      envOnly
    ),
    0
  )
  t.alike(FakeClient.last.options.seed, parseSeed(SEED_B))
  assertNoSecret(t, envOnly.text('stdout') + envOnly.text('stderr'), SEED_B)

  const conflict = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      { SWARM_DEPLOY_CLIENT_SEED: SEED_B },
      conflict
    ),
    2
  )
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_A)
  assertNoSecret(t, conflict.text('stdout') + conflict.text('stderr'), SEED_B)
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
  const ok = createIo({ Client: FakeClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact], {}, ok),
    0
  )
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
  const partial = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      {},
      partial
    ),
    1
  )
  t.ok(partial.text('stdout').includes('ok.bin COMMITTED'))
  t.ok(partial.text('stdout').includes('bad.bin FILE_EXISTS'))
  t.ok(partial.text('stdout').includes('link skipped symlink'))
  assertNoSecret(t, partial.text('stdout') + partial.text('stderr'), SEED_A)

  FakeClient.uploadImpl = async () => {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }
  const discovery = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      {},
      discovery
    ),
    1
  )

  FakeClient.uploadImpl = null
  const mismatch = createIo()
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      {},
      mismatch
    ),
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
  const upload = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact],
      { SWARM_DEPLOY_SERVER_SEED: SEED_B },
      upload
    ),
    0
  )
  t.alike(FakeClient.last.options.seed, parseSeed(SEED_A))
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

  const server = createIo({ Server: FakeServer })
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

  const upload = createIo({ Client: FakeClient })
  t.is(
    await main(
      ['upload', '--server-key', PUBLIC_A, artifact],
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
  const originalOpen = fs.promises.open
  const originalUnlink = fs.promises.unlink
  let unlinked = false

  fs.promises.open = async function patchedOpen(filePath, flags, mode) {
    const handle = await originalOpen.call(this, filePath, flags, mode)
    if (filePath !== out) return handle
    return {
      fd: handle.fd,
      chmod: (...args) => handle.chmod(...args),
      stat: (...args) => handle.stat(...args),
      write: () => Promise.reject(new Error('injected write failure')),
      sync: (...args) => handle.sync(...args),
      close: async () => {
        await handle.close()
        await originalUnlink(out)
        await fs.promises.writeFile(out, `${replacement}\n`, { flag: 'wx', mode: 0o600 })
      }
    }
  }
  fs.promises.unlink = function patchedUnlink(filePath) {
    if (filePath === out) unlinked = true
    return originalUnlink(filePath)
  }
  t.teardown(() => {
    fs.promises.open = originalOpen
    fs.promises.unlink = originalUnlink
  })

  const io = createIo()
  t.is(await main(['keygen', '--out', out], {}, io), 2)
  t.absent(unlinked)
  let remaining = null
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
    close() {
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
    { Server: CloseFailServer }
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
    async listen() {
      await new Promise((resolve) => setTimeout(resolve, 40))
      throw new Error('swarm bind failed')
    }
  }

  const proc = new EventEmitter()
  const io = createIo({ process: proc, Server: DelayedListenFail })
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
  t.is(DelayedListenFail.last.closeCount, 1)
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
    close() {
      this.closeCount++
      this.closed = true
      return Promise.reject(new Error(`close leaked ${leaked}`))
    }
  }

  const io = createIo({ Client: CloseFailClient })
  t.is(
    await main(['upload', '--seed-file', seedPath, '--server-key', PUBLIC_A, artifact], {}, io),
    1
  )
  t.is(CloseFailClient.last.closeCount, 1)
  t.ok(io.text('stdout').includes('artifact.bin COMMITTED'))
  t.ok(io.text('stderr').includes('Cleanup failed'))
  t.absent(io.text('stderr').includes('close leaked'))
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), leaked)
  assertNoSecret(t, io.text('stdout') + io.text('stderr'), SEED_A)
})
