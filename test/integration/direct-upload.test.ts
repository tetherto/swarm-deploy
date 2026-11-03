/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { Client, ERRORS, keyPairFromSeed, type ServerOptions } from '../../dist/index.js'
import { main } from '../../dist/cli.js'
import {
  buildTarManifest,
  deterministicTarSize,
  metadataFromManifest,
  regenerateTarSuffix
} from '../../dist/tar-protocol/manifest.js'
import type { SessionStore } from '../../dist/storage/session-store.js'
import type { StorageAdapter } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { Server } from '../helpers/server.js'
import { createStorage } from '../helpers/storage.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'

function restrictiveStorage(modeCapable = true): StorageAdapter {
  const storage = createStorage()
  return {
    ...storage,
    mkdir(target, options) {
      return storage.mkdir(target, { ...options, mode: 0o700 })
    },
    async open(target, flags, mode) {
      const creates =
        typeof flags === 'string'
          ? flags.includes('w') || flags.includes('x')
          : (flags & (fs.constants.O_CREAT ?? 0o100)) !== 0
      const handle = await storage.open(target, flags, creates ? 0o600 : mode)
      if (!modeCapable) {
        const { chmod: _chmod, ...withoutModeCapability } = handle
        return withoutModeCapability
      }
      return handle
    }
  }
}

function mode(stat: { mode: number }): number {
  return stat.mode & 0o777
}

test('direct server-key upload commits only after an explicit final result', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 91)
  const clientSeed = b4a.alloc(32, 92)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'direct TAR payload')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const serverEvents: string[] = []
  const clientEvents: string[] = []
  const clientProgress: Array<{ bytesSent: number; totalBytes: number }> = []
  server.on('offer', () => serverEvents.push('offer'))
  server.on('progress', () => {
    if (serverEvents.at(-1) !== 'progress') serverEvents.push('progress')
  })
  server.on('verification', (event) => serverEvents.push(`verification:${event.status}`))
  server.on('commit', (event) => serverEvents.push(`commit:${event.status}`))
  client.on('offer', () => clientEvents.push('offer'))
  client.on('progress', () => {
    if (clientEvents.at(-1) !== 'progress') clientEvents.push('progress')
  })
  client.on('progress', (event) => clientProgress.push(event))
  client.on('verification', (event) => clientEvents.push(`verification:${event.status}`))
  client.on('commit', (event) => clientEvents.push(`commit:${event.status}`))
  client.on('result', (event) => {
    if (event.final) clientEvents.push('result')
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.is(await fs.promises.readFile(path.join(storage, 'artifact.txt'), 'utf8'), 'direct TAR payload')
  t.alike(serverEvents, [
    'offer',
    'progress',
    'verification:started',
    'verification:succeeded',
    'commit:succeeded'
  ])
  t.alike(clientEvents, [
    'offer',
    'offer',
    'progress',
    'verification:started',
    'verification:succeeded',
    'commit:succeeded',
    'result'
  ])
  t.ok(clientProgress.length >= 2)
  t.ok(clientProgress[0].bytesSent < clientProgress.at(-1)!.bytesSent)
  t.is(clientProgress.at(-1)!.bytesSent, deterministicTarSize(result.size))
  t.ok(clientProgress.every((event) => event.totalBytes === deterministicTarSize(result.size)))
})

test('identical direct upload short-circuits before TAR transfer without history mutation', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 113)
  const clientSeed = b4a.alloc(32, 114)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'identical.txt')
  await fs.promises.writeFile(input, 'same artifact twice')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    replaceNames: ['identical.txt'],
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  let connections = 0
  let clientProgress = 0
  let serverProgress = 0
  server.on('connection', () => connections++)
  client.on('progress', () => clientProgress++)
  server.on('progress', () => serverProgress++)
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  t.is((await client.upload(input)).status, 'COMMITTED')
  const before = (await fs.promises.readdir(storage)).sort()
  clientProgress = 0
  serverProgress = 0

  t.is((await client.upload(input)).status, 'ALREADY_COMMITTED')
  t.is(connections, 2)
  t.is(clientProgress, 0)
  t.is(serverProgress, 0)
  t.alike((await fs.promises.readdir(storage)).sort(), before)
  t.absent(before.some((name) => name.startsWith('history-')))
})

test('terminal delivery failure never contradicts durable lifecycle events', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 111)
  const clientSeed = b4a.alloc(32, 112)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'delivery.txt')
  await fs.promises.writeFile(input, 'durably committed before terminal delivery fails')
  const serverNode = testnet.createNode()
  const dht = {
    get destroyed() {
      return serverNode.destroyed
    },
    createServer(
      options: Parameters<typeof serverNode.createServer>[0],
      handler: Parameters<typeof serverNode.createServer>[1]
    ) {
      return serverNode.createServer(options, (socket) => {
        const stream = socket as unknown as { write(bytes: Buffer): boolean }
        const write = stream.write.bind(stream)
        stream.write = (bytes) =>
          b4a.toString(bytes).includes('"COMMITTED"') ? false : write(bytes)
        handler(socket)
      })
    },
    connect: serverNode.connect.bind(serverNode),
    on: serverNode.on.bind(serverNode),
    destroy: serverNode.destroy.bind(serverNode)
  }
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    idleTimeout: 20,
    dht
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 1_000,
    dht: testnet.createNode()
  })
  const phases: string[] = []
  server.on('verification', (event) => phases.push(`verification:${event.status}`))
  server.on('commit', (event) => phases.push(`commit:${event.status}`))
  server.on('failure', () => phases.push('failure'))
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  await t.exception(client.upload(input))
  t.is(
    await fs.promises.readFile(path.join(storage, 'delivery.txt'), 'utf8'),
    'durably committed before terminal delivery fails'
  )
  t.alike(phases, ['verification:started', 'verification:succeeded', 'commit:succeeded', 'failure'])
})

test('a divergent durable TAR prefix is reset once before direct commit', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 95)
  const clientSeed = b4a.alloc(32, 96)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'reset.txt')
  await fs.promises.writeFile(input, 'resume reset payload')
  const clientKey = keyPairFromSeed(clientSeed)
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [clientKey.publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const offers: string[] = []
  let connections = 0
  server.on('offer', (event) => offers.push(event.status))
  server.on('connection', () => {
    connections++
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const manifest = await buildTarManifest(input, clientKey.publicKey)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  if (!sessions) throw new Error('Server session store unavailable')
  await sessions.admit(clientKey.publicKey, metadataFromManifest(manifest))
  await sessions.append(clientKey.publicKey, metadataFromManifest(manifest), 0, b4a.alloc(16, 0xff))

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(offers, ['resumed', 'reset'])
  t.is(connections, 2)
  t.is(await fs.promises.readFile(path.join(storage, 'reset.txt'), 'utf8'), 'resume reset payload')
})

test('a matching durable TAR prefix resumes on one direct connection', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 97)
  const clientSeed = b4a.alloc(32, 98)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'resume.txt')
  await fs.promises.writeFile(input, 'matching direct TAR resume payload')
  const clientKey = keyPairFromSeed(clientSeed)
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [clientKey.publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const offers: string[] = []
  const progress: Array<{ bytesSent: number; totalBytes: number }> = []
  let connections = 0
  server.on('offer', (event) => offers.push(event.status))
  client.on('progress', (event) => progress.push(event))
  server.on('connection', () => {
    connections++
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  const manifest = await buildTarManifest(input, clientKey.publicKey)
  const chunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  const archive = b4a.concat(chunks)
  const metadata = metadataFromManifest(manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  if (!sessions) throw new Error('Server session store unavailable')
  await sessions.admit(clientKey.publicKey, metadata)
  await sessions.append(clientKey.publicKey, metadata, 0, archive.subarray(0, 512))

  const result = await client.upload(input)
  t.is(result.status, 'COMMITTED')
  t.alike(offers, ['resumed'])
  t.is(connections, 1)
  t.ok(progress.length >= 2)
  t.ok(progress.every((event) => event.totalBytes === manifest.tarSize))
  t.ok(
    progress.every((event, index) => index === 0 || event.bytesSent > progress[index - 1].bytesSent)
  )
  t.ok(progress[0].bytesSent > 512)
  t.is(progress.at(-1)!.bytesSent, manifest.tarSize)
  t.is(
    await fs.promises.readFile(path.join(storage, 'resume.txt'), 'utf8'),
    'matching direct TAR resume payload'
  )
})

test('a committed upload still reports success when session cleanup fails', async (t) => {
  // Retiring the session happens after the artifact is durably published.
  // Failing there must not turn a completed commit into a client-visible
  // failure; the residue is purged on the next start instead.
  const testnet = await createLocalTestnet(t)
  const storageDir = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'cleanup failure payload')

  let blockRetire = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (blockRetire && name === 'unlink' && target.endsWith('.tar.part')) {
        throw Object.assign(new Error('EIO: simulated cleanup failure'), { code: 'EIO' })
      }
    }
  })

  const serverSeed = b4a.alloc(32, 71)
  const clientSeed = b4a.alloc(32, 72)
  const server = new Server({
    seed: serverSeed,
    storageDir,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 8192,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    storage
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
  blockRetire = true
  const result = await client.upload(input)

  t.is(result.status, 'COMMITTED', 'the client is told the truth about its commit')
  t.is(
    await fs.promises.readFile(path.join(storageDir, 'artifact.txt'), 'utf8'),
    'cleanup failure payload',
    'the artifact is published'
  )
})

test('re-uploading an unchanged directory is already committed and never replaced', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 71)
  const clientSeed = b4a.alloc(32, 72)
  const storage = await createTempDir(t)
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(source)
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'a')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
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
  t.is((await client.upload(source)).status, 'COMMITTED')
  t.is((await client.upload(source)).status, 'ALREADY_COMMITTED')
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'b')
  await t.exception(client.upload(source), { code: ERRORS.FILE_EXISTS })
  t.is(await fs.promises.readFile(path.join(storage, '0.18.1', 'a.bin'), 'utf8'), 'a')
})

test('a client promotes a committed directory through an authenticated manual link', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 121)
  const clientSeed = b4a.alloc(32, 122)
  const storage = await createTempDir(t)
  const source = path.join(await createTempDir(t), 'release-1')
  await fs.promises.mkdir(source)
  await fs.promises.writeFile(path.join(source, 'nested.bin'), 'directory payload')
  // A hand-made website link from before the root was managed: it points outside the
  // root, beside an unmanaged legacy directory that is not a managed artifact.
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'outside.txt'), 'outside payload')
  await fs.promises.mkdir(path.join(storage, 'legacy-site'))
  await fs.promises.writeFile(path.join(storage, 'legacy-site', 'legacy.bin'), 'legacy payload')
  await fs.promises.symlink(outside, path.join(storage, 'latest'))
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    symlinks: [{ selector: '/^release-\\d+$/' }]
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
  t.is((await client.upload(source)).kind, 'directory')
  t.alike(await client.link('release-1', 'current'), {
    target: 'release-1',
    name: 'current',
    status: 'LINKED'
  })
  t.is(await fs.promises.readlink(path.join(storage, 'current')), 'release-1')
  t.is((await client.link('release-1', 'current')).status, 'UNCHANGED')

  // The same authenticated request takes over the unrecorded symlink at `latest`.
  t.alike(await client.link('release-1', 'latest'), {
    target: 'release-1',
    name: 'latest',
    status: 'LINKED'
  })
  t.is(await fs.promises.readlink(path.join(storage, 'latest')), 'release-1')
  t.is((await client.link('release-1', 'latest')).status, 'UNCHANGED')
  t.alike(await fs.promises.readdir(outside), ['outside.txt'], 'the old target is untouched')
  t.is(await fs.promises.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'outside payload')
  t.is(
    await fs.promises.readFile(path.join(storage, 'legacy-site', 'legacy.bin'), 'utf8'),
    'legacy payload'
  )
})

test('publication normalizes restrictive staging modes for files and directory artifacts', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 131)
  const clientSeed = b4a.alloc(32, 132)
  const storage = await createTempDir(t)
  const sourceRoot = await createTempDir(t)
  const directory = path.join(sourceRoot, 'release')
  const file = path.join(sourceRoot, 'artifact.txt')
  await fs.promises.mkdir(path.join(directory, 'nested'), { recursive: true })
  await fs.promises.writeFile(path.join(directory, 'root.txt'), 'root payload')
  await fs.promises.writeFile(path.join(directory, 'nested', 'child.txt'), 'nested payload')
  await fs.promises.writeFile(file, 'single payload')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    storage: restrictiveStorage(),
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
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
  t.is((await client.upload(directory)).status, 'COMMITTED')
  t.is((await client.upload(file)).status, 'COMMITTED')

  for (const target of [path.join(storage, 'release'), path.join(storage, 'release', 'nested')]) {
    t.is(mode(await fs.promises.lstat(target)), 0o755, `${target} is publicly traversable`)
  }
  for (const target of [
    path.join(storage, 'release', 'root.txt'),
    path.join(storage, 'release', 'nested', 'child.txt'),
    path.join(storage, 'artifact.txt')
  ]) {
    t.is(mode(await fs.promises.lstat(target)), 0o644, `${target} is publicly readable`)
  }
})

test('a storage adapter without publication mode support fails closed only when publishing', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 141)
  const clientSeed = b4a.alloc(32, 142)
  const storage = await createTempDir(t)
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'payload')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    storage: restrictiveStorage(false),
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const commitFailures: string[] = []
  server.on('commit', (event) => {
    if (event.status === 'failed' && event.reason) commitFailures.push(event.reason)
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  await t.exception(client.upload(input))
  t.alike(commitFailures, [ERRORS.UNSUPPORTED_STORAGE])
  await t.exception(() => fs.promises.lstat(path.join(storage, 'artifact.txt')), { code: 'ENOENT' })
})

type Testnet = Awaited<ReturnType<typeof createLocalTestnet>>

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

type Failure = {
  code?: unknown
  message: string
  remote?: unknown
  transport?: unknown
  operation?: unknown
  phase?: unknown
}

async function rejectionOf(operation: Promise<unknown>): Promise<Failure> {
  const error = await operation.then(
    () => {
      throw new Error('The operation unexpectedly succeeded')
    },
    (failure: unknown) => failure
  )
  return error as Failure
}

/** A real server and client on the loopback testnet; `connections` follows the server's own count. */
async function failureRig(
  t: Assert,
  testnet: Testnet,
  id: number,
  options: Partial<ServerOptions> = {}
) {
  const clientSeed = b4a.alloc(32, id)
  const storage = await createTempDir(t)
  const server = new Server({
    seed: b4a.alloc(32, id + 100),
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    ...options
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    idleTimeout: 10_000,
    dht: testnet.createNode()
  })
  const rig = { testnet, server, client, storage, clientSeed, connections: 0 }
  server.on('connection-open', (event) => {
    rig.connections = event.connections
  })
  server.on('connection-close', (event) => {
    rig.connections = event.connections
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })
  await server.listen()
  return rig
}

/** `swarm-deploy upload` through the real CLI against a rig, with its output captured. */
async function runUpload(
  rig: Awaited<ReturnType<typeof failureRig>>,
  file: string,
  flags: string[]
) {
  const stdout = output()
  const stderr = output()
  const exit = await main(
    ['upload', ...flags, '--server-key', b4a.toString(rig.server.publicKey, 'hex'), file],
    { SWARM_DEPLOY_CLIENT_SEED: b4a.toString(rig.clientSeed, 'hex') },
    {
      dht: rig.testnet.createNode(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      connectTimeout: 5_000,
      idleTimeout: 10_000
    }
  )
  return { exit, stdout: stdout.text(), stderr: stderr.text() }
}

test('ordinary refusals and a disk-reserve refusal reach a real client and the CLI as the server’s own code', async (t) => {
  const testnet = await createLocalTestnet(t)
  const directory = await createTempDir(t)
  const small = path.join(directory, 'artifact.txt')
  const large = path.join(directory, 'large.bin')
  await fs.promises.writeFile(small, 'first content')
  await fs.promises.writeFile(large, b4a.alloc(2048, 0x61))

  // A size limit: refused before any payload is sent.
  const limited = await failureRig(t, testnet, 21)
  const tooLarge = await rejectionOf(limited.client.upload(large))
  t.is(tooLarge.code, ERRORS.FILE_TOO_LARGE)
  t.is(tooLarge.remote, true)
  t.is(tooLarge.operation, 'upload')
  t.is(tooLarge.phase, 'admission')
  t.absent(tooLarge.transport)
  t.ok(
    tooLarge.message.includes('FILE_TOO_LARGE'),
    'the message names the code, not just "rejected"'
  )
  await waitFor(() => limited.connections === 0)

  // An explicit link request the server refuses.
  const link = await rejectionOf(limited.client.link('missing', 'current'))
  t.is(link.code, ERRORS.LINK_NOT_ALLOWED)
  t.is(link.remote, true)
  t.is(link.operation, 'link')
  t.is(link.phase, 'final')
  await waitFor(() => limited.connections === 0)

  // The same refusal through the CLI, plain and as JSON, with nothing secret in either.
  const plain = await runUpload(limited, large, [])
  t.is(plain.exit, 1)
  t.is(plain.stdout, '')
  t.is(
    plain.stderr,
    'Server rejected upload (FILE_TOO_LARGE): the artifact exceeds the size the server accepts\n'
  )
  const json = await runUpload(limited, large, ['--json'])
  t.is(json.exit, 1)
  t.alike(JSON.parse(json.stdout), { code: 'FILE_TOO_LARGE', origin: 'server', phase: 'admission' })
  t.is(json.stdout.trimEnd().includes('\n'), false, 'one object on one line')
  t.is(json.stderr, plain.stderr, 'the diagnostic is the same with --json')
  const seed = b4a.toString(limited.clientSeed, 'hex')
  t.absent((plain.stdout + plain.stderr + json.stdout + json.stderr).includes(seed))
  await waitFor(() => limited.connections === 0)

  // A name that already holds other content.
  const conflicting = await failureRig(t, testnet, 22)
  t.is((await conflicting.client.upload(small)).status, 'COMMITTED')
  await fs.promises.writeFile(small, 'other content!')
  const exists = await rejectionOf(conflicting.client.upload(small))
  t.is(exists.code, ERRORS.FILE_EXISTS)
  t.is(exists.remote, true)
  t.is(exists.phase, 'admission')
  await waitFor(() => conflicting.connections === 0)

  // The reserve check that production hit: the code arrives, not a connection reset.
  const reserved = await failureRig(t, testnet, 23, { minFreeBytes: Number.MAX_SAFE_INTEGER })
  const noSpace = await rejectionOf(reserved.client.upload(small))
  t.is(noSpace.code, ERRORS.DISK_RESERVE)
  t.is(noSpace.remote, true)
  t.is(noSpace.phase, 'admission')
  t.absent(noSpace.transport)
  t.absent(noSpace.message.includes('reset'))
  const reserveJson = await runUpload(reserved, small, ['--json'])
  t.is(reserveJson.exit, 1)
  t.alike(JSON.parse(reserveJson.stdout), {
    code: 'DISK_RESERVE',
    origin: 'server',
    phase: 'admission'
  })
  t.ok(reserveJson.stderr.includes('DISK_RESERVE'))
  await waitFor(() => reserved.connections === 0)
  t.alike(await fs.promises.readdir(reserved.storage), [], 'nothing was published')
})

test('a failure while the payload is still streaming reaches the client as the server’s own code', async (t) => {
  const testnet = await createLocalTestnet(t)
  const file = path.join(await createTempDir(t), 'payload.bin')
  await fs.promises.writeFile(file, b4a.alloc(6 * 1024 * 1024, 0x61))
  const logs: Array<Record<string, unknown>> = []
  const rig = await failureRig(t, testnet, 24, {
    maxFileBytes: 8 * 1024 * 1024,
    maxStagingBytes: 32 * 1024 * 1024,
    logger: { warn: (message, details) => void logs.push({ message, ...details }) }
  })
  // A disk that fills while receiving: the first durable append (after one MiB) fails with a
  // raw write error, while the client is still sending under backpressure. The reserve check
  // itself runs at admission, so this is the same condition arriving later, and it is reported
  // as the same code.
  const sessions = (rig.server as unknown as { sessions: SessionStore }).sessions
  sessions.append = () =>
    Promise.reject(
      Object.assign(new Error('ENOSPC: no space left on device, write /srv/private/part'), {
        code: 'ENOSPC'
      })
    )
  const failures: string[] = []
  rig.server.on('failure', (event) => failures.push(event.reason))

  const error = await rejectionOf(rig.client.upload(file))
  t.is(error.code, ERRORS.DISK_RESERVE, 'the server reason, not a reset and not a bad request')
  t.is(error.remote, true)
  t.is(error.operation, 'upload')
  t.ok(['streaming', 'final'].includes(String(error.phase)), `phase ${String(error.phase)}`)
  t.absent(error.transport)
  t.ok(error.message.includes('free disk space'))
  t.absent(error.message.includes('/srv/private'), 'server text never reaches the message')
  t.absent(error.message.includes('ENOSPC'))
  t.alike(failures, [ERRORS.DISK_RESERVE], 'the server counted one failure')
  const [logged] = logs.filter((entry) => entry.message === 'Direct upload failed')
  t.is(logged.reason, ERRORS.DISK_RESERVE)
  t.is(logged.phase, 'transfer', 'the log says where the server was')
  t.is(logged.systemCode, 'ENOSPC', 'and which known errno it was')
  t.absent(JSON.stringify(logs).includes('/srv/private'), 'with no error text or path')

  // The connection and every slot are released, and nothing was published.
  await waitFor(() => rig.connections === 0)
  const state = rig.server as unknown as {
    activeUploads: Set<unknown>
    activeTransfers: Set<string>
  }
  t.is(state.activeUploads.size, 0)
  t.is(state.activeTransfers.size, 0)
  t.alike(await fs.promises.readdir(rig.storage), [])
})

test('a server that drops the connection without answering is reported with its phase and no invented reason', async (t) => {
  const testnet = await createLocalTestnet(t)
  const file = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(file, 'payload that is never answered')
  const serverNode = testnet.createNode()
  const dht = {
    get destroyed() {
      return serverNode.destroyed
    },
    createServer(
      options: Parameters<typeof serverNode.createServer>[0],
      handler: Parameters<typeof serverNode.createServer>[1]
    ) {
      return serverNode.createServer(options, (socket) => {
        // A server that cannot answer: whatever it would write drops the connection instead.
        const stream = socket as unknown as { write(bytes: Buffer): boolean; destroy(): void }
        stream.write = () => {
          stream.destroy()
          return false
        }
        handler(socket)
      })
    },
    connect: serverNode.connect.bind(serverNode),
    on: serverNode.on.bind(serverNode),
    destroy: serverNode.destroy.bind(serverNode)
  }
  const rig = await failureRig(t, testnet, 25, { dht })

  const error = await rejectionOf(rig.client.upload(file))
  t.is(error.transport, true, 'marked as a connection failure')
  t.is(error.operation, 'upload')
  t.ok(['request', 'admission'].includes(String(error.phase)), `phase ${String(error.phase)}`)
  t.absent(error.remote, 'no server answer exists to claim')
  t.absent(String(error.code).startsWith('FILE_'), 'no server code is invented')

  const plain = await runUpload(rig, file, [])
  t.is(plain.exit, 1)
  t.is(plain.stdout, '')
  t.ok(plain.stderr.startsWith('Upload failed while '), plain.stderr)
  t.ok(
    plain.stderr.includes('No server reason was received, so the outcome on the server is unknown.')
  )
  t.absent(plain.stderr.includes('reset by peer'), 'the stream text is not repeated as a reason')
  const json = await runUpload(rig, file, ['--json'])
  t.is(json.exit, 1)
  const fields = JSON.parse(json.stdout) as Record<string, unknown>
  t.is(fields.origin, 'transport')
  t.ok(['request', 'admission'].includes(String(fields.phase)))
  t.absent('hookResult' in fields)
})
