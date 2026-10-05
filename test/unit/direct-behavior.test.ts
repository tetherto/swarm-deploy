/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import path from '#path'
import {
  Client,
  ERRORS,
  keyPairFromSeed,
  Server,
  SwarmDeployError,
  type AfterCommitContext,
  type BeforeCommitContext,
  type HookFailureContext,
  type ServerHooks,
  type ServerScheduler
} from '../../dist/index.js'
import { fingerprint } from '../../dist/server.js'
import type {
  DirectDhtNode,
  DirectDhtServerHandle,
  DirectDhtSocket
} from '../../dist/direct-dht.js'
import {
  decodeAdmissionRecord,
  decodeFinalRecord,
  encodeAdmissionRecord,
  encodeControlFrame,
  encodeMetadataRecord
} from '../../dist/tar-protocol/controls.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import { acquireStorageLock, initLayout } from '../../dist/storage/layout.js'
import type { CommitStore } from '../../dist/storage/commit-store.js'
import type { SessionStore } from '../../dist/storage/session-store.js'
import { createTempDir } from '../helpers/files.js'
import { waitFor } from '../helpers/testnet.js'

const EventEmitter = events.EventEmitter
const sodium = require('sodium-native') as {
  sodium_memcmp(left: Uint8Array, right: Uint8Array): boolean
}
const SERVER_SEED = b4a.alloc(32, 0xb1)
const CLIENT_SEED = b4a.alloc(32, 0xb2)
const CLIENT_KEY = keyPairFromSeed(CLIENT_SEED).publicKey

class FakeSocket extends EventEmitter {
  readonly opened = Promise.resolve(true)
  readonly writes: Buffer[] = []
  readonly remotePublicKey: Buffer
  destroyed = false
  destroyError: unknown = null
  onWrite: ((bytes: Buffer, index: number) => boolean) | null = null
  onEnd: (() => void) | null = null

  constructor(remotePublicKey: Buffer) {
    super()
    this.remotePublicKey = b4a.from(remotePublicKey)
  }

  write(bytes: Uint8Array): boolean {
    if (this.destroyed) throw new Error('Socket is destroyed')
    const copy = b4a.from(bytes)
    this.writes.push(copy)
    return this.onWrite?.(copy, this.writes.length - 1) ?? true
  }

  pause(): void {}
  resume(): void {}

  end(): void {
    this.onEnd?.()
  }

  feed(bytes: Uint8Array): void {
    this.emit('data', b4a.from(bytes))
  }

  finishInput(): void {
    this.emit('end')
  }

  destroy(error?: unknown): void {
    if (this.destroyed) return
    this.destroyed = true
    this.destroyError = error ?? null
    if (error instanceof Error) this.emit('error', error)
    this.emit('close')
  }
}

class FakeServerNode implements DirectDhtNode {
  destroyed = false
  handleClosed = false
  private firewall: ((remotePublicKey: Buffer) => boolean) | null = null
  private connection: ((socket: DirectDhtSocket) => void) | null = null

  createServer(
    options: { firewall(remotePublicKey: Buffer): boolean },
    onConnection: (socket: DirectDhtSocket) => void
  ): DirectDhtServerHandle {
    this.firewall = options.firewall
    this.connection = onConnection
    const node = this
    return {
      publicKey: null,
      get closed() {
        return node.handleClosed
      },
      on() {
        return this
      },
      listen() {
        return Promise.resolve(this)
      },
      close() {
        node.handleClosed = true
        return Promise.resolve()
      }
    }
  }

  connect(): DirectDhtSocket {
    throw new Error('Unexpected client connection')
  }

  on(): this {
    return this
  }

  destroy(): Promise<void> {
    this.destroyed = true
    return Promise.resolve()
  }

  accept(socket: FakeSocket): void {
    if (!this.connection || !this.firewall) throw new Error('Server is not initialized')
    if (this.firewall(socket.remotePublicKey)) socket.destroy()
    else this.connection(socket as unknown as DirectDhtSocket)
  }
}

function fakeClientNode(socket: FakeSocket): DirectDhtNode {
  return {
    destroyed: false,
    createServer() {
      throw new Error('Unexpected server creation')
    },
    connect() {
      return socket as unknown as DirectDhtSocket
    },
    on() {
      return this
    },
    destroy() {
      this.destroyed = true
      return Promise.resolve()
    }
  }
}

function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null
}

function statuses(socket: FakeSocket): string[] {
  return socket.writes.map((frame) => {
    const body = frame.subarray(4)
    const value = JSON.parse(b4a.toString(body)) as { status: string }
    return value.status
  })
}

async function manifest(
  t: Assert,
  name: string,
  contents: string | Uint8Array = name
): Promise<{
  manifest: TarManifest
  tar: Buffer
}> {
  const root = await createTempDir(t)
  const file = path.join(root, name)
  await fs.promises.writeFile(file, contents)
  const built = await buildTarManifest(file, CLIENT_KEY)
  const chunks: Buffer[] = []
  await regenerateTarSuffix(built, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { manifest: built, tar: b4a.concat(chunks) }
}

function metadataFrame(value: TarManifest, reset = false): Buffer {
  return encodeControlFrame(encodeMetadataRecord(metadataFromManifest(value, reset)))
}

async function createServer(
  t: Assert,
  options: Partial<ConstructorParameters<typeof Server>[0]> = {}
): Promise<{ server: Server; node: FakeServerNode }> {
  const node = new FakeServerNode()
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: await createTempDir(t),
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 16 * 1024,
    maxStagingBytes: 64 * 1024,
    minFreeBytes: 0,
    dht: node,
    ...options
  })
  t.teardown(() => server.close())
  await server.listen()
  return { server, node }
}

function promptly<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 250)
    })
  ]).finally(() => clearTimeout(timer))
}

test('Server rejects excess authenticated sockets and releases connection capacity on close', async (t) => {
  const { server, node } = await createServer(t, {
    maxConnections: 1,
    maxActiveUploads: 1,
    idleTimeout: 1_000
  })
  const opened: number[] = []
  server.on('connection-open', (event) => opened.push(event.connections))

  const occupying = new FakeSocket(CLIENT_KEY)
  node.accept(occupying)
  const rejected = new FakeSocket(CLIENT_KEY)
  node.accept(rejected)

  t.is(rejected.destroyed, true)
  t.is(code(rejected.destroyError), ERRORS.FILE_BUSY)
  t.alike(opened, [1])

  occupying.destroy()
  const replacement = new FakeSocket(CLIENT_KEY)
  node.accept(replacement)
  t.is(replacement.destroyed, false)
  t.alike(opened, [1, 1])
})

test('Server authorization compares every allowlist entry before accepting', async (t) => {
  const original = sodium.sodium_memcmp
  let comparisons = 0
  sodium.sodium_memcmp = (left, right) => {
    comparisons++
    return original(left, right)
  }
  try {
    const { node } = await createServer(t, {
      allowedKeys: [CLIENT_KEY, b4a.alloc(32, 0xc1), b4a.alloc(32, 0xc2)]
    })
    comparisons = 0
    node.accept(new FakeSocket(CLIENT_KEY))
    t.is(comparisons, 9)
  } finally {
    sodium.sodium_memcmp = original
  }
})

test('Server reserves active upload capacity atomically and releases failure and success paths', async (t) => {
  const { server, node } = await createServer(t, {
    maxConnections: 4,
    maxActiveUploads: 1,
    idleTimeout: 100
  })
  const first = await manifest(t, 'first.txt', 'first payload')
  const second = await manifest(t, 'second.txt', 'second payload')

  const failing = new FakeSocket(CLIENT_KEY)
  node.accept(failing)
  failing.feed(metadataFrame(first.manifest))
  await waitFor(() => statuses(failing).includes('ACCEPT'))

  const concurrent = new FakeSocket(CLIENT_KEY)
  node.accept(concurrent)
  concurrent.feed(metadataFrame(second.manifest))
  await waitFor(() => statuses(concurrent).includes('REJECTED'))
  const rejected = decodeAdmissionRecord(concurrent.writes[0].subarray(4))
  if (rejected.status !== 'REJECTED') throw new Error('Expected capacity rejection')
  t.is(rejected.code, ERRORS.ACTIVE_UPLOAD_LIMIT)
  concurrent.destroy()

  failing.feed(b4a.alloc(first.tar.byteLength, 0xff))
  failing.finishInput()
  await waitFor(() => statuses(failing).includes('FAILED'))
  const failed = decodeFinalRecord(failing.writes.at(-1)!.subarray(4))
  t.is(failed.status, 'FAILED')

  const succeeding = new FakeSocket(CLIENT_KEY)
  node.accept(succeeding)
  succeeding.feed(metadataFrame(first.manifest, true))
  await waitFor(() => statuses(succeeding).includes('ACCEPT'))
  succeeding.feed(first.tar)
  succeeding.finishInput()
  await waitFor(() => statuses(succeeding).includes('COMMITTED'))
  t.is(decodeFinalRecord(succeeding.writes.at(-1)!.subarray(4)).status, 'COMMITTED')
  succeeding.destroy()

  const afterSuccess = new FakeSocket(CLIENT_KEY)
  node.accept(afterSuccess)
  afterSuccess.feed(metadataFrame(second.manifest))
  await waitFor(() => statuses(afterSuccess).includes('ACCEPT'))
  t.is(decodeAdmissionRecord(afterSuccess.writes[0].subarray(4)).status, 'ACCEPT')
})

test('Server batches tiny TAR fragments into bounded durable appends', async (t) => {
  const batchBytes = 1024 * 1024
  const complete = await manifest(t, 'batched.bin', b4a.alloc(2 * batchBytes + 123, 0x5a))
  const resumed = await manifest(t, 'resumed.bin', b4a.alloc(2 * batchBytes + 321, 0x4c))
  const interrupted = await manifest(t, 'interrupted.bin', b4a.alloc(batchBytes, 0x6b))
  const { server, node } = await createServer(t, {
    maxFileBytes: 3 * batchBytes,
    maxStagingBytes: 8 * batchBytes,
    idleTimeout: 10_000
  })
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  const originalAppend = sessions.append.bind(sessions)
  const appends: Array<{ offset: number; bytes: Buffer }> = []
  sessions.append = (...args: Parameters<SessionStore['append']>) => {
    appends.push({ offset: args[2], bytes: b4a.from(args[3]) })
    return originalAppend(...args)
  }
  const progress: number[] = []
  server.on('progress', (event) => progress.push(event.bytesReceived))

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(complete.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  for (let offset = 0; offset < complete.tar.byteLength; offset += 257) {
    socket.feed(complete.tar.subarray(offset, offset + 257))
  }
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('COMMITTED'))

  const expectedCalls = Math.ceil(complete.tar.byteLength / batchBytes)
  t.is(appends.length, expectedCalls)
  t.alike(
    appends.map(({ offset }) => offset),
    Array.from({ length: expectedCalls }, (_value, index) => index * batchBytes)
  )
  t.alike(
    appends.map(({ bytes }) => bytes.byteLength),
    [
      ...Array(expectedCalls - 1).fill(batchBytes),
      complete.tar.byteLength - (expectedCalls - 1) * batchBytes
    ]
  )
  t.alike(
    progress,
    appends.map(({ offset, bytes }) => offset + bytes.byteLength)
  )
  t.is(progress.at(-1), complete.tar.byteLength)
  t.alike(b4a.concat(appends.map(({ bytes }) => bytes)), complete.tar)

  const resumeOffset = 12_345
  await sessions.admit(CLIENT_KEY, metadataFromManifest(resumed.manifest))
  await sessions.append(
    CLIENT_KEY,
    metadataFromManifest(resumed.manifest),
    0,
    resumed.tar.subarray(0, resumeOffset)
  )
  appends.length = 0
  progress.length = 0
  const resumedSocket = new FakeSocket(CLIENT_KEY)
  node.accept(resumedSocket)
  resumedSocket.feed(metadataFrame(resumed.manifest))
  await waitFor(() => statuses(resumedSocket).includes('RESUME'))
  const resumeAdmission = decodeAdmissionRecord(resumedSocket.writes[0].subarray(4))
  if (resumeAdmission.status !== 'RESUME') throw new Error('Expected resumed admission')
  t.is(resumeAdmission.offset, resumeOffset)
  for (let offset = resumeOffset; offset < resumed.tar.byteLength; offset += 263) {
    resumedSocket.feed(resumed.tar.subarray(offset, offset + 263))
  }
  resumedSocket.finishInput()
  await waitFor(() => statuses(resumedSocket).includes('COMMITTED'))

  const suffixBytes = resumed.tar.byteLength - resumeOffset
  const expectedResumeCalls = Math.ceil(suffixBytes / batchBytes)
  t.alike(
    appends.map(({ offset }) => offset),
    Array.from(
      { length: expectedResumeCalls },
      (_value, index) => resumeOffset + index * batchBytes
    )
  )
  t.alike(
    appends.map(({ bytes }) => bytes.byteLength),
    [
      ...Array(expectedResumeCalls - 1).fill(batchBytes),
      suffixBytes - (expectedResumeCalls - 1) * batchBytes
    ]
  )
  t.alike(b4a.concat(appends.map(({ bytes }) => bytes)), resumed.tar.subarray(resumeOffset))
  t.alike(
    progress,
    appends.map(({ offset, bytes }) => offset + bytes.byteLength)
  )
  t.is(progress.at(-1), resumed.tar.byteLength)

  appends.length = 0
  progress.length = 0
  const failures: string[] = []
  server.on('failure', (event) => failures.push(event.reason))
  const disconnected = new FakeSocket(CLIENT_KEY)
  node.accept(disconnected)
  disconnected.feed(metadataFrame(interrupted.manifest))
  await waitFor(() => statuses(disconnected).includes('ACCEPT'))
  disconnected.feed(interrupted.tar.subarray(0, batchBytes - 1))
  disconnected.destroy()
  await waitFor(() => failures.length === 1)

  t.alike(appends, [])
  t.alike(progress, [])
  t.alike(await sessions.admit(CLIENT_KEY, metadataFromManifest(interrupted.manifest)), {
    status: 'ACCEPT',
    offset: 0
  })
})

test('Server applies the inactivity timeout independently to metadata and TAR phases', async (t) => {
  for (const phase of ['metadata', 'tar'] as const) {
    const input = phase === 'tar' ? await manifest(t, `${phase}.txt`) : null
    const { server, node } = await createServer(t, {
      maxConnections: 1,
      maxActiveUploads: 1,
      idleTimeout: 50
    })
    const failures: string[] = []
    server.on('failure', (event) => failures.push(event.reason))
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    if (input) {
      socket.feed(metadataFrame(input.manifest))
      await waitFor(() => statuses(socket).includes('ACCEPT'))
    }

    await waitFor(() => failures.length === 1)
    t.is(failures[0], ERRORS.UPLOAD_IDLE_TIMEOUT, phase)
    t.is(socket.destroyed, true, phase)
    await server.close()
  }
})

test('Client rejects final-result inactivity and EOF without a terminal result', async (t) => {
  const inputRoot = await createTempDir(t)
  const input = path.join(inputRoot, 'terminal.txt')
  await fs.promises.writeFile(input, 'terminal behavior')

  for (const ending of ['timeout', 'eof'] as const) {
    const socket = new FakeSocket(keyPairFromSeed(SERVER_SEED).publicKey)
    socket.onWrite = (_bytes, index) => {
      if (index === 0) {
        queueMicrotask(() =>
          socket.feed(
            encodeControlFrame(encodeAdmissionRecord({ v: 1, status: 'ACCEPT', offset: 0 }))
          )
        )
      }
      return true
    }
    if (ending === 'eof') socket.onEnd = () => socket.finishInput()
    const client = new Client({
      seed: CLIENT_SEED,
      serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
      idleTimeout: 5,
      dht: fakeClientNode(socket)
    })
    t.teardown(() => client.close())

    await t.exception(client.upload(input), {
      code: ending === 'timeout' ? ERRORS.UPLOAD_IDLE_TIMEOUT : ERRORS.PROTOCOL_INVALID
    })
    t.is(socket.destroyed, true, ending)
    await client.close()
  }
})

test('Client close aborts pending work promptly and removes direct-wire listeners', async (t) => {
  const root = await createTempDir(t)
  const input = path.join(root, 'abort.txt')
  await fs.promises.writeFile(input, 'abort pending metadata response')
  const socket = new FakeSocket(keyPairFromSeed(SERVER_SEED).publicKey)
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 10_000,
    dht: fakeClientNode(socket)
  })
  const upload = client.upload(input)
  await waitFor(() => socket.writes.length === 1)

  await promptly(client.close(), 'client close')
  await t.exception(upload, { code: ERRORS.ABORTED })
  t.is(socket.destroyed, true)
  t.is(socket.listenerCount('data'), 0)
  t.is(socket.listenerCount('end'), 0)
})

test('Server close aborts pending reads, clears timers, and waits for listener cleanup', async (t) => {
  const intervals = new Set<unknown>()
  const scheduler: ServerScheduler = {
    setTimeout(callback, delay) {
      return setTimeout(callback, delay)
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
    setInterval(callback, delay) {
      const handle = setInterval(callback, delay)
      intervals.add(handle)
      return handle
    },
    clearInterval(handle) {
      intervals.delete(handle)
      clearInterval(handle as ReturnType<typeof setInterval>)
    }
  }
  const { server, node } = await createServer(t, {
    idleTimeout: 10_000,
    scheduler
  })
  const failures: string[] = []
  server.on('failure', (event) => failures.push(event.reason))
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  t.is(intervals.size, 1)

  await promptly(server.close(), 'server close')
  await waitFor(() => socket.listenerCount('data') === 0)
  t.is(socket.destroyed, true)
  t.alike(failures, [ERRORS.ABORTED])
  t.is(socket.listenerCount('end'), 0)
  t.is(intervals.size, 0)
  t.is(node.handleClosed, true)
})

test('Server close waits for blocked commit work before releasing its storage lock', async (t) => {
  const storageDir = await createTempDir(t)
  const { server, node } = await createServer(t, {
    storageDir,
    idleTimeout: 10_000
  })
  const input = await manifest(t, 'blocked-commit.txt', 'must not publish after close')
  const commits = (server as unknown as { commits: CommitStore }).commits
  const originalCommit = commits.commit.bind(commits)
  let releaseCommit: () => void = () => {}
  let commitStarted = false
  const gate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  commits.commit = async (...args: Parameters<CommitStore['commit']>) => {
    commitStarted = true
    await gate
    return originalCommit(...args)
  }

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  socket.feed(input.tar)
  socket.finishInput()
  await waitFor(() => commitStarted)

  let closed = false
  const closing = server.close().then(() => {
    closed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(closed, false, 'close remains pending while commit owns receive work')

  releaseCommit()
  await promptly(closing, 'blocked commit shutdown')
  await t.exception(() => fs.promises.lstat(path.join(storageDir, 'blocked-commit.txt')), {
    code: 'ENOENT'
  })

  const releaseLock = await acquireStorageLock(initLayout(storageDir))
  await releaseLock()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await t.exception(() => fs.promises.lstat(path.join(storageDir, 'blocked-commit.txt')), {
    code: 'ENOENT'
  })
})

test('Server recovery reports the number of purged corrupt TAR sessions', async (t) => {
  const storageDir = await createTempDir(t)
  const layout = initLayout(storageDir)
  await fs.promises.writeFile(path.join(layout.sessions, `${'cd'.repeat(32)}.json`), '{bad')
  await fs.promises.writeFile(
    path.join(layout.staging, `${'cd'.repeat(32)}.tar.part`),
    'discardable'
  )
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 16 * 1024,
    maxStagingBytes: 64 * 1024,
    minFreeBytes: 0,
    dht: new FakeServerNode()
  })
  t.teardown(() => server.close())
  const completed: number[] = []
  server.on('recovery', (event) => {
    if (event.status === 'completed') completed.push(event.purgedSessions ?? -1)
  })

  await server.listen()
  t.alike(completed, [1])
})

async function manifestIn(
  t: Assert,
  parent: string,
  name: string,
  contents: string = name
): Promise<{ manifest: TarManifest; tar: Buffer }> {
  const root = await createTempDir(t)
  const directory = path.join(root, parent)
  await fs.promises.mkdir(directory)
  const file = path.join(directory, name)
  await fs.promises.writeFile(file, contents)
  const built = await buildTarManifest(file, CLIENT_KEY)
  const chunks: Buffer[] = []
  await regenerateTarSuffix(built, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { manifest: built, tar: b4a.concat(chunks) }
}

type ReleaseSpy = {
  inspected: unknown[]
  committed: unknown[]
  admitted: number
}

function spyRelease(server: Server): ReleaseSpy {
  const spy: ReleaseSpy = { inspected: [], committed: [], admitted: 0 }
  const internals = server as unknown as { commits: CommitStore; sessions: SessionStore }
  const inspect = internals.commits.inspect.bind(internals.commits)
  internals.commits.inspect = (...args: Parameters<CommitStore['inspect']>) => {
    spy.inspected.push(args[1].release)
    return inspect(...args)
  }
  const commit = internals.commits.commit.bind(internals.commits)
  internals.commits.commit = (...args: Parameters<CommitStore['commit']>) => {
    spy.committed.push(args[1]?.release)
    return commit(...args)
  }
  const admit = internals.sessions.admit.bind(internals.sessions)
  internals.sessions.admit = (...args: Parameters<SessionStore['admit']>) => {
    spy.admitted++
    return admit(...args)
  }
  return spy
}

test('Server without artifact patterns accepts unmatched names and passes no release', async (t) => {
  const { server, node } = await createServer(t)
  const spy = spyRelease(server)
  const input = await manifest(t, 'unmatched.txt')

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  socket.feed(input.tar)
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('COMMITTED'))

  t.alike(spy.inspected, [null])
  t.alike(spy.committed, [null])
})

test('Server rejects unmatched offers before admission when artifact patterns are configured', async (t) => {
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin', 'releases/{series}.bin']
  })
  const spy = spyRelease(server)
  const offers: Array<{ status: string; reason?: string }> = []
  server.on('offer', (event) => offers.push({ status: event.status, reason: event.reason }))
  const unsafeParent = await manifestIn(t, 'bad parent', 'app.bin')
  t.is(unsafeParent.manifest.sourceParent, undefined)
  const inputs = [
    await manifest(t, 'plain.txt'),
    await manifestIn(t, 'staging', 'app.bin'),
    unsafeParent,
    await manifest(t, 'app.bin')
  ]

  for (const input of inputs) {
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    socket.feed(metadataFrame(input.manifest))
    await waitFor(() => statuses(socket).includes('REJECTED'))
    const rejected = decodeAdmissionRecord(socket.writes[0].subarray(4))
    if (rejected.status !== 'REJECTED') throw new Error('Expected rejection')
    t.is(rejected.code, ERRORS.INVALID_FILENAME)
    socket.destroy()
  }

  t.alike(
    offers,
    inputs.map(() => ({ status: 'rejected', reason: ERRORS.INVALID_FILENAME }))
  )
  t.is(spy.admitted, 0)
  t.alike(spy.inspected, [])
  t.alike(spy.committed, [])
})

test('Server passes normalized release coordinates from filename and parent templates', async (t) => {
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin', '{version}/{series}.tar.gz']
  })
  const spy = spyRelease(server)
  const uploads = [
    await manifest(t, 'payments-2.4.1.bin'),
    await manifestIn(t, '3.0.0-rc.1', 'web.tar.gz')
  ]
  const expected = [
    { series: 'payments', version: '2.4.1' },
    { series: 'web', version: '3.0.0-rc.1' }
  ]

  for (const input of uploads) {
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    socket.feed(metadataFrame(input.manifest))
    await waitFor(() => statuses(socket).includes('ACCEPT'))
    socket.feed(input.tar)
    socket.finishInput()
    await waitFor(() => statuses(socket).includes('COMMITTED'))
  }

  t.alike(spy.inspected, expected)
  t.alike(spy.committed, expected)
  const commits = (server as unknown as { commits: CommitStore }).commits
  t.alike(
    (await commits.list())
      .map((record) => record.release)
      .sort((a, b) => (a!.series < b!.series ? -1 : 1)),
    [expected[0], expected[1]].sort((a, b) => (a.series < b.series ? -1 : 1))
  )
})

test('Server passes the matched release when committing an already verified session', async (t) => {
  const { server, node } = await createServer(t, { artifactPatterns: ['{series}-{version}.bin'] })
  const spy = spyRelease(server)
  const input = await manifest(t, 'verified-1.2.3.bin')
  const metadata = metadataFromManifest(input.manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  await sessions.admit(CLIENT_KEY, metadata)
  await sessions.append(CLIENT_KEY, metadata, 0, input.tar)
  await sessions.verify(CLIENT_KEY, metadata)
  spy.admitted = 0

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('COMMITTED'))

  t.alike(spy.committed, [{ series: 'verified', version: '1.2.3' }])
})

test('Server rejects invalid retention and artifact pattern combinations', async (t) => {
  const base = {
    seed: SERVER_SEED,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0
  }
  const invalid: Array<Partial<ConstructorParameters<typeof Server>[0]>> = [
    { maxCount: 1 },
    { maxCount: 0, artifactPatterns: ['{series}.bin'] },
    { maxVersions: 1, versionGranularity: 'major' },
    { maxVersions: 1, versionGranularity: 'major', artifactPatterns: ['{series}.bin'] },
    { maxVersions: 1, artifactPatterns: ['{series}-{version}.bin'] },
    { maxVersions: 0, versionGranularity: 'major', artifactPatterns: ['{series}-{version}.bin'] },
    { versionGranularity: 'major', artifactPatterns: ['{series}-{version}.bin'] },
    {
      maxVersions: 1,
      versionGranularity: 'patch' as 'major',
      artifactPatterns: ['{series}-{version}.bin']
    },
    { artifactPatterns: ['{series}.bin', '{series}.bin'] },
    { artifactPatterns: ['no-placeholder.bin'] },
    { artifactPatterns: 7 as unknown as string[] }
  ]
  for (const options of invalid) {
    await t.exception(
      () => new Server({ ...base, storageDir: '/unused', ...options }),
      { code: ERRORS.PROTOCOL_INVALID },
      JSON.stringify(options)
    )
  }

  const patterns = ['{series}-{version}.bin']
  const server = new Server({
    ...base,
    storageDir: '/unused',
    artifactPatterns: patterns,
    maxCount: 2,
    maxVersions: 1,
    versionGranularity: 'minor'
  })
  patterns.push('{series}.tar.gz')
  t.alike([...server.artifactPatterns], ['{series}-{version}.bin'])
  t.is(server.maxCount, 2)
  t.is(server.maxVersions, 1)
  t.is(server.versionGranularity, 'minor')
})

type HookCall = {
  hook: 'beforeCommit' | 'afterCommit' | 'onFailure'
  context: BeforeCommitContext | AfterCommitContext | HookFailureContext
  seen: string[]
}

function isTerminal(socket: FakeSocket): boolean {
  return statuses(socket).some((status) =>
    ['COMMITTED', 'FAILED', 'REJECTED', 'ALREADY_COMMITTED'].includes(status)
  )
}

async function uploadAll(
  node: FakeServerNode,
  input: { manifest: TarManifest; tar: Buffer },
  reset = false
): Promise<FakeSocket> {
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest, reset))
  await waitFor(() => statuses(socket).includes('ACCEPT') || isTerminal(socket))
  if (!isTerminal(socket)) {
    socket.feed(input.tar)
    socket.finishInput()
  }
  await waitFor(() => isTerminal(socket))
  return socket
}

function reconnect(node: FakeServerNode, input: { manifest: TarManifest }): FakeSocket {
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  return socket
}

function finalCode(socket: FakeSocket): string | undefined {
  const frame = socket.writes.at(-1)!.subarray(4)
  const value = JSON.parse(b4a.toString(frame)) as { code?: string }
  return value.code
}

function recordingHooks(
  calls: HookCall[],
  socketRef: { current: FakeSocket | null },
  behavior: Partial<Record<HookCall['hook'], (call: HookCall) => void | Promise<void>>> = {}
): ServerHooks {
  const make =
    (hook: HookCall['hook']) =>
    async (context: HookCall['context']): Promise<void> => {
      const call: HookCall = {
        hook,
        context,
        seen: socketRef.current ? statuses(socketRef.current) : []
      }
      calls.push(call)
      await behavior[hook]?.(call)
    }
  return {
    beforeCommit: make('beforeCommit'),
    afterCommit: make('afterCommit'),
    onFailure: make('onFailure')
  }
}

function hookNames(calls: HookCall[]): string[] {
  return calls.map((call) => call.hook)
}

test('Server runs beforeCommit and afterCommit around a fresh durable commit', async (t) => {
  const calls: HookCall[] = []
  const ref: { current: FakeSocket | null } = { current: null }
  const storageDir = await createTempDir(t)
  const input = await manifest(t, 'fresh-hook.txt', 'fresh hook payload')
  const metadata = metadataFromManifest(input.manifest)
  const existence: Record<string, string> = {}
  const { server, node } = await createServer(t, {
    storageDir,
    hooks: recordingHooks(calls, ref, {
      beforeCommit: async (call) => {
        const context = call.context as BeforeCommitContext
        existence.before = b4a.toString(await fs.promises.readFile(context.path))
        await t.exception(
          () => fs.promises.lstat(path.join(storageDir, 'fresh-hook.txt')),
          { code: 'ENOENT' },
          'artifact is not visible before beforeCommit returns'
        )
      },
      afterCommit: async (call) => {
        const context = call.context as AfterCommitContext
        existence.after = b4a.toString(await fs.promises.readFile(context.path))
      }
    })
  })
  const commits: string[] = []
  server.on('commit', (event) => commits.push(event.status))
  const socket = new FakeSocket(CLIENT_KEY)
  ref.current = socket
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  socket.feed(input.tar)
  socket.finishInput()
  await waitFor(() => isTerminal(socket))

  t.alike(hookNames(calls), ['beforeCommit', 'afterCommit'])
  const [before, after] = calls.map((call) => call.context) as [
    BeforeCommitContext,
    AfterCommitContext
  ]
  t.alike(before.artifact, {
    name: 'fresh-hook.txt',
    size: metadata.fileSize,
    sha256: metadata.fileSha256,
    transferId: metadata.transferId,
    ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent })
  })
  t.is(before.resumed, false)
  t.is(before.alreadyCommitted, false)
  t.is(path.isAbsolute(before.path), true)
  t.is(
    before.path,
    path.join(path.resolve(storageDir), '.swarm-deploy', 'staging', `${metadata.transferId}.part`),
    'beforeCommit receives the extracted artifact, not the TAR'
  )
  t.is(existence.before, 'fresh hook payload')
  t.is(after.path, path.join(path.resolve(storageDir), 'fresh-hook.txt'))
  t.is(after.resumed, false)
  t.is(after.alreadyCommitted, false)
  t.is(existence.after, 'fresh hook payload')
  t.ok(Object.isFrozen(before) && Object.isFrozen(before.artifact))
  t.ok(Object.isFrozen(after) && Object.isFrozen(after.artifact))
  t.absent(calls[0].seen.includes('COMMITTED'))
  t.absent(calls[1].seen.includes('COMMITTED'), 'client is told COMMITTED only after afterCommit')
  t.is(statuses(socket).at(-1), 'COMMITTED')
  t.alike(commits, ['succeeded'])
  t.is(server.hooks.beforeCommit !== undefined, true)
})

test('Server passes release coordinates and source parent to hook artifacts', async (t) => {
  const calls: HookCall[] = []
  const { node } = await createServer(t, {
    artifactPatterns: ['{version}/{series}.tar.gz'],
    hooks: recordingHooks(calls, { current: null })
  })
  const input = await manifestIn(t, '3.0.0-rc.1', 'web.tar.gz')
  await uploadAll(node, input)

  const artifact = (calls[0].context as BeforeCommitContext).artifact
  t.is(artifact.sourceParent, '3.0.0-rc.1')
  t.alike(artifact.release, { series: 'web', version: '3.0.0-rc.1' })
  t.ok(Object.isFrozen(artifact.release))
  t.alike((calls[1].context as AfterCommitContext).artifact, artifact)
})

test('Server marks both hooks resumed after a partial resume', async (t) => {
  const calls: HookCall[] = []
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(calls, { current: null })
  })
  const input = await manifest(t, 'partial-hook.bin', b4a.alloc(4096, 0x33))
  const metadata = metadataFromManifest(input.manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  await sessions.admit(CLIENT_KEY, metadata)
  await sessions.append(CLIENT_KEY, metadata, 0, input.tar.subarray(0, 700))

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('RESUME'))
  socket.feed(input.tar.subarray(700))
  socket.finishInput()
  await waitFor(() => isTerminal(socket))

  t.alike(hookNames(calls), ['beforeCommit', 'afterCommit'])
  t.is((calls[0].context as BeforeCommitContext).resumed, true)
  t.is((calls[1].context as AfterCommitContext).resumed, true)
  t.is((calls[1].context as AfterCommitContext).alreadyCommitted, false)
})

test('Server reruns beforeCommit for a verified reconnect and keeps the session after a beforeCommit failure', async (t) => {
  const calls: HookCall[] = []
  let failBefore = true
  const ref: { current: FakeSocket | null } = { current: null }
  const injected = new Error('deploy gate said no')
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(calls, ref, {
      beforeCommit: () => {
        if (failBefore) throw injected
      }
    })
  })
  const failures: string[] = []
  server.on('failure', (event) => failures.push(event.reason))
  const input = await manifest(t, 'verified-hook.txt', 'verified hook payload')
  const metadata = metadataFromManifest(input.manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  await sessions.admit(CLIENT_KEY, metadata)
  await sessions.append(CLIENT_KEY, metadata, 0, input.tar)
  await sessions.verify(CLIENT_KEY, metadata)

  const first = reconnect(node, input)
  ref.current = first
  await waitFor(() => isTerminal(first))
  await waitFor(() => calls.length === 2)
  t.alike(hookNames(calls), ['beforeCommit', 'onFailure'])
  t.is(finalCode(first), ERRORS.HOOK_FAILED)
  t.alike(failures, [ERRORS.HOOK_FAILED])
  const failure = calls[1].context as HookFailureContext
  t.is(failure.phase, 'beforeCommit')
  t.is(failure.resumed, true)
  t.is(failure.alreadyCommitted, false)
  t.is(failure.path, (calls[0].context as BeforeCommitContext).path)
  t.is(failure.error, injected, 'onFailure receives the raw callback exception')
  t.absent(
    b4a.toString(first.writes.at(-1)!).includes('deploy gate said no'),
    'callback text never reaches the wire'
  )
  t.ok(calls[1].seen.includes('FAILED'), 'client is answered before onFailure runs')
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, 'verified-hook.txt')), {
    code: 'ENOENT'
  })
  t.alike(await sessions.admit(CLIENT_KEY, metadata), { status: 'VERIFIED' })

  failBefore = false
  calls.length = 0
  const second = reconnect(node, input)
  await waitFor(() => isTerminal(second))
  t.alike(hookNames(calls), ['beforeCommit', 'afterCommit'])
  t.is((calls[0].context as BeforeCommitContext).resumed, true)
  t.is((calls[1].context as AfterCommitContext).resumed, true)
  t.is(statuses(second).at(-1), 'COMMITTED')
})

test('Server runs only afterCommit before answering ALREADY_COMMITTED', async (t) => {
  const calls: HookCall[] = []
  const ref: { current: FakeSocket | null } = { current: null }
  const { node } = await createServer(t, { hooks: recordingHooks(calls, ref) })
  const input = await manifest(t, 'already-hook.txt', 'already hook payload')
  await uploadAll(node, input)
  calls.length = 0

  const socket = new FakeSocket(CLIENT_KEY)
  ref.current = socket
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => isTerminal(socket))

  t.alike(hookNames(calls), ['afterCommit'])
  const context = calls[0].context as AfterCommitContext
  t.is(context.alreadyCommitted, true)
  t.is(context.resumed, false)
  t.is(path.basename(context.path), 'already-hook.txt')
  t.alike(calls[0].seen, [], 'ALREADY_COMMITTED is written after afterCommit returns')
  t.alike(statuses(socket), ['ALREADY_COMMITTED'])
})

test('Server keeps a committed artifact when afterCommit fails and retries afterCommit on reconnect', async (t) => {
  const calls: HookCall[] = []
  let failures = 2
  const injected = new Error('post-deploy restart failed')
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(
      calls,
      { current: null },
      {
        afterCommit: () => {
          if (failures-- > 0) throw injected
        }
      }
    )
  })
  const input = await manifest(t, 'after-fail.txt', 'after failure payload')

  const first = await uploadAll(node, input)
  t.is(statuses(first).at(-1), 'FAILED')
  t.is(finalCode(first), ERRORS.HOOK_FAILED)
  t.is(
    b4a.toString(await fs.promises.readFile(path.join(server.storageDir, 'after-fail.txt'))),
    'after failure payload'
  )
  await waitFor(() => calls.length === 3)
  t.alike(hookNames(calls), ['beforeCommit', 'afterCommit', 'onFailure'])
  const failure = calls[2].context as HookFailureContext
  t.is(failure.phase, 'afterCommit')
  t.is(failure.path, path.join(path.resolve(server.storageDir), 'after-fail.txt'))
  t.is(failure.alreadyCommitted, false)
  t.is(failure.error, injected)

  calls.length = 0
  const second = reconnect(node, input)
  await waitFor(() => isTerminal(second))
  t.alike(hookNames(calls), ['afterCommit', 'onFailure'])
  t.alike(statuses(second), ['REJECTED'])
  t.is(finalCode(second), ERRORS.HOOK_FAILED)
  const retryFailure = calls[1].context as HookFailureContext
  t.is(retryFailure.phase, 'afterCommit')
  t.is(retryFailure.alreadyCommitted, true)
  t.is(retryFailure.error, injected)

  calls.length = 0
  const third = reconnect(node, input)
  await waitFor(() => isTerminal(third))
  t.alike(hookNames(calls), ['afterCommit'])
  t.alike(statuses(third), ['ALREADY_COMMITTED'])
})

test('Server reports onFailure once with phase, path and the original error for ordinary failures', async (t) => {
  const calls: HookCall[] = []
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(calls, { current: null })
  })
  const commits = (server as unknown as { commits: CommitStore }).commits
  const stagingDir = path.join(path.resolve(server.storageDir), '.swarm-deploy', 'staging')

  const offerInput = await manifest(t, 'offer-fail.txt', 'offer failure payload')
  await fs.promises.writeFile(path.join(server.storageDir, 'offer-fail.txt'), 'something else')
  const offer = await uploadAll(node, offerInput)
  t.is(finalCode(offer), ERRORS.FILE_EXISTS)
  await waitFor(() => calls.length === 1)
  t.is(calls[0].hook, 'onFailure')
  let context = calls[0].context as HookFailureContext
  t.is(context.phase, 'offer')
  t.is(context.path, null)
  t.is((context.error as SwarmDeployError).code, ERRORS.FILE_EXISTS)
  t.is(context.artifact.name, 'offer-fail.txt')

  calls.length = 0
  const transferInput = await manifest(t, 'transfer-fail.txt', 'x'.repeat(2000))
  const truncated = new FakeSocket(CLIENT_KEY)
  node.accept(truncated)
  truncated.feed(metadataFrame(transferInput.manifest))
  await waitFor(() => statuses(truncated).includes('ACCEPT'))
  truncated.feed(transferInput.tar.subarray(0, 600))
  truncated.destroy()
  await waitFor(() => calls.length === 1)
  context = calls[0].context as HookFailureContext
  t.is(context.phase, 'transfer')
  t.is(path.dirname(context.path!), stagingDir)
  t.is(context.resumed, false)
  t.is((context.error as SwarmDeployError).code, ERRORS.PROTOCOL_INVALID)

  calls.length = 0
  const verifyInput = await manifest(t, 'verify-fail.txt', 'verify failure payload')
  const garbage = {
    manifest: verifyInput.manifest,
    tar: b4a.alloc(verifyInput.tar.byteLength, 0xff)
  }
  const verification = await uploadAll(node, garbage)
  t.is(statuses(verification).at(-1), 'FAILED')
  await waitFor(() => calls.length === 1)
  context = calls[0].context as HookFailureContext
  t.is(context.phase, 'verification')
  t.is(path.dirname(context.path!), stagingDir)
  t.is((context.error as SwarmDeployError).code, finalCode(verification) as string)

  calls.length = 0
  const injected = new SwarmDeployError(ERRORS.COMMIT_FAILED, 'disk exploded')
  const originalCommit = commits.commit.bind(commits)
  commits.commit = () => Promise.reject(injected)
  const commitInput = await manifest(t, 'commit-fail.txt', 'commit failure payload')
  const commit = await uploadAll(node, commitInput)
  commits.commit = originalCommit
  t.is(finalCode(commit), ERRORS.COMMIT_FAILED)
  await waitFor(() => calls.length === 2)
  t.alike(hookNames(calls), ['beforeCommit', 'onFailure'])
  context = calls[1].context as HookFailureContext
  t.is(context.phase, 'commit')
  t.is(context.error, injected)
  t.is(context.path, (calls[0].context as BeforeCommitContext).path)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(calls.length, 2, 'onFailure runs at most once')
})

test('Server logs a failing onFailure hook without replacing the original error', async (t) => {
  for (const mode of ['reject', 'throw'] as const) {
    const warnings: Array<{ message: string; details?: Record<string, unknown> }> = []
    const attempts: string[] = []
    const { node } = await createServer(t, {
      logger: {
        warn(message, details) {
          warnings.push({ message, details })
          throw new Error('logger is hostile')
        },
        error() {
          throw new Error('logger is hostile')
        }
      },
      hooks: {
        onFailure:
          mode === 'reject'
            ? () => {
                attempts.push(mode)
                return Promise.reject(new Error('secondary hook failure token=hunter2'))
              }
            : () => {
                attempts.push(mode)
                throw new Error('secondary hook failure token=hunter2')
              }
      }
    })
    const input = await manifest(t, `secondary-${mode}.txt`, 'secondary failure payload')
    const garbage = { manifest: input.manifest, tar: b4a.alloc(input.tar.byteLength, 0xff) }
    const socket = await uploadAll(node, garbage)
    await waitFor(() => warnings.some((entry) => entry.message === 'Failure hook failed'))

    t.is(statuses(socket).at(-1), 'FAILED', mode)
    t.not(finalCode(socket), ERRORS.HOOK_FAILED, mode)
    t.alike(attempts, [mode])
    const entry = warnings.find((value) => value.message === 'Failure hook failed')!
    t.is(entry.details?.phase, 'verification')
    t.is(
      entry.details?.transfer,
      fingerprint(b4a.from(metadataFromManifest(input.manifest).transferId, 'hex'))
    )
    t.absent(JSON.stringify(entry.details).includes('hunter2'))
  }
})

test('Server close does not wait for a hung beforeCommit hook', async (t) => {
  const calls: HookCall[] = []
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(
      calls,
      { current: null },
      { beforeCommit: () => new Promise<void>(() => {}) }
    )
  })
  const input = await manifest(t, 'hung-hook.txt', 'hung hook payload')
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  socket.feed(input.tar)
  socket.finishInput()
  await waitFor(() => calls.some((call) => call.hook === 'beforeCommit'))

  await promptly(server.close(), 'server close with hung hook')
  const failure = calls.find((call) => call.hook === 'onFailure')?.context as HookFailureContext
  t.is(failure.phase, 'beforeCommit')
  t.is((failure.error as SwarmDeployError).code, ERRORS.ABORTED)
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, 'hung-hook.txt')), {
    code: 'ENOENT'
  })
})

type EarlyRejection = {
  name: string
  reason: string
  options: Partial<ConstructorParameters<typeof Server>[0]>
  contents?: string
  release: boolean
  arrange?: (server: Server, node: FakeServerNode) => Promise<() => void> | (() => void)
}

test('Server reports every early offer rejection to onFailure exactly once after the rejection', async (t) => {
  const cases: EarlyRejection[] = [
    {
      name: 'plain.txt',
      reason: ERRORS.INVALID_FILENAME,
      options: { artifactPatterns: ['{series}-{version}.bin'] },
      release: false
    },
    {
      name: 'too-large-1.0.0.bin',
      reason: ERRORS.FILE_TOO_LARGE,
      options: { artifactPatterns: ['{series}-{version}.bin'] },
      contents: 'x'.repeat(16 * 1024 + 1),
      release: true
    },
    {
      name: 'busy-first.txt',
      reason: ERRORS.ACTIVE_UPLOAD_LIMIT,
      options: { maxConnections: 4, maxActiveUploads: 1 },
      release: false,
      arrange: (server) => {
        const active = (server as unknown as { activeUploads: Set<unknown> }).activeUploads
        const placeholder = {}
        active.add(placeholder)
        return () => active.delete(placeholder)
      }
    },
    {
      name: 'busy-second.txt',
      reason: ERRORS.ACTIVE_UPLOAD_LIMIT,
      options: { maxConnections: 4, maxActiveUploads: 1 },
      release: false,
      arrange: (server) => {
        const internals = server as unknown as {
          activeUploads: Set<unknown>
          commits: CommitStore
        }
        const placeholder = {}
        const inspect = internals.commits.inspect.bind(internals.commits)
        internals.commits.inspect = async (...args: Parameters<CommitStore['inspect']>) => {
          const result = await inspect(...args)
          internals.activeUploads.add(placeholder)
          return result
        }
        return () => {
          internals.commits.inspect = inspect
          internals.activeUploads.delete(placeholder)
        }
      }
    }
  ]

  for (const entry of cases) {
    const calls: HookCall[] = []
    const ref: { current: FakeSocket | null } = { current: null }
    const { server, node } = await createServer(t, {
      ...entry.options,
      maxFileBytes: 16 * 1024,
      hooks: recordingHooks(calls, ref)
    })
    const offers: string[] = []
    server.on('offer', (event) => offers.push(`${event.status}:${event.reason}`))
    const input = await manifest(t, entry.name, entry.contents ?? entry.name)
    const metadata = metadataFromManifest(input.manifest)
    const restore = await entry.arrange?.(server, node)

    const socket = new FakeSocket(CLIENT_KEY)
    ref.current = socket
    node.accept(socket)
    socket.feed(metadataFrame(input.manifest))
    await waitFor(() => isTerminal(socket) && calls.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    restore?.()

    t.alike(statuses(socket), ['REJECTED'], entry.name)
    t.is(finalCode(socket), entry.reason, entry.name)
    t.alike(offers, [`rejected:${entry.reason}`], entry.name)
    t.alike(hookNames(calls), ['onFailure'], `${entry.name} reports exactly once`)
    t.alike(calls[0].seen, ['REJECTED'], `${entry.name} reports after the rejection is sent`)
    const context = calls[0].context as HookFailureContext
    t.is(context.phase, 'offer', entry.name)
    t.is(context.path, null, entry.name)
    t.is(context.resumed, false, entry.name)
    t.is(context.alreadyCommitted, false, entry.name)
    t.is((context.error as SwarmDeployError).code, entry.reason, entry.name)
    t.is(context.artifact.name, entry.name, entry.name)
    t.is(context.artifact.size, metadata.fileSize, entry.name)
    t.is(context.artifact.transferId, metadata.transferId, entry.name)
    t.is(context.artifact.release !== undefined, entry.release, entry.name)
    t.ok(Object.isFrozen(context) && Object.isFrozen(context.artifact), entry.name)
    await server.close()
  }
})

test('Server reports a noncanonical transfer ID to onFailure once and keeps PROTOCOL_INVALID on the wire', async (t) => {
  const calls: HookCall[] = []
  const ref: { current: FakeSocket | null } = { current: null }
  const { server, node } = await createServer(t, { hooks: recordingHooks(calls, ref) })
  const rejections: string[] = []
  server.on('failure', (event) => rejections.push(event.reason))
  const input = await manifest(t, 'forged-id.txt', 'forged transfer id payload')
  const genuine = metadataFromManifest(input.manifest)
  const forged = { ...genuine, transferId: 'ab'.repeat(32) }

  const socket = new FakeSocket(CLIENT_KEY)
  ref.current = socket
  node.accept(socket)
  socket.feed(encodeControlFrame(encodeMetadataRecord(forged)))
  await waitFor(() => isTerminal(socket) && calls.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 20))

  t.alike(statuses(socket), ['REJECTED'])
  t.is(finalCode(socket), ERRORS.PROTOCOL_INVALID)
  t.alike(rejections, [ERRORS.PROTOCOL_INVALID])
  t.alike(hookNames(calls), ['onFailure'])
  t.alike(calls[0].seen, ['REJECTED'])
  const context = calls[0].context as HookFailureContext
  t.is(context.phase, 'offer')
  t.is(context.path, null)
  t.is((context.error as SwarmDeployError).code, ERRORS.PROTOCOL_INVALID)
  t.is(context.artifact.transferId, forged.transferId)
  for (const key of Object.keys(context.artifact)) {
    t.ok(['name', 'size', 'sha256', 'transferId', 'sourceParent', 'release'].includes(key), key)
  }
})

test('Server reports a VERIFIED reconnect read failure with the extracted .part path', async (t) => {
  const calls: HookCall[] = []
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(calls, { current: null })
  })
  const input = await manifest(t, 'verified-read.txt', 'verified read payload')
  const metadata = metadataFromManifest(input.manifest)
  const sessions = (server as unknown as { sessions: SessionStore }).sessions
  await sessions.admit(CLIENT_KEY, metadata)
  await sessions.append(CLIENT_KEY, metadata, 0, input.tar)
  await sessions.verify(CLIENT_KEY, metadata)
  const injected = new SwarmDeployError(ERRORS.COMMIT_FAILED, 'staging file vanished')
  sessions.readVerified = () => Promise.reject(injected)

  const socket = reconnect(node, input)
  await waitFor(() => calls.length > 0)

  t.alike(hookNames(calls), ['onFailure'])
  const context = calls[0].context as HookFailureContext
  t.is(context.phase, 'verification')
  t.is(context.resumed, true)
  t.is(context.error, injected)
  t.is(
    context.path,
    path.join(
      path.resolve(server.storageDir),
      '.swarm-deploy',
      'staging',
      `${metadata.transferId}.part`
    )
  )
  t.is(finalCode(socket), ERRORS.COMMIT_FAILED)
})

test('Server close aborts a hung onFailure hook without losing the original failure', async (t) => {
  const calls: HookCall[] = []
  const ref: { current: FakeSocket | null } = { current: null }
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(calls, ref, { onFailure: () => new Promise<void>(() => {}) })
  })
  const input = await manifest(t, 'hung-failure.txt', 'hung failure payload')
  const garbage = { manifest: input.manifest, tar: b4a.alloc(input.tar.byteLength, 0xff) }
  const socket = new FakeSocket(CLIENT_KEY)
  ref.current = socket
  node.accept(socket)
  socket.feed(metadataFrame(garbage.manifest))
  await waitFor(() => statuses(socket).includes('ACCEPT'))
  socket.feed(garbage.tar)
  socket.finishInput()
  await waitFor(() => calls.some((call) => call.hook === 'onFailure'))

  t.is(statuses(socket).at(-1), 'FAILED', 'the client already has the original failure')
  t.ok(calls[0].seen.includes('FAILED'))
  const code = finalCode(socket)
  t.not(code, ERRORS.HOOK_FAILED)
  t.is((calls[0].context as HookFailureContext).phase, 'verification')

  await promptly(server.close(), 'server close with hung onFailure')
  t.is(finalCode(socket), code, 'client response is unchanged by close')
  t.is(calls.length, 1, 'onFailure ran once')
})

async function readableNow(file: string): Promise<string> {
  try {
    return b4a.toString(await fs.promises.readFile(file))
  } catch (error) {
    return `unreadable:${code(error)}`
  }
}

async function historyFiles(directory: string): Promise<string[]> {
  return (await fs.promises.readdir(directory)).filter((name) => name.startsWith('history-'))
}

type RotationFixture = {
  server: Server
  node: FakeServerNode
  log: string[]
  commitOptions: Array<{ deferPostCommitRetention?: boolean } | undefined>
}

async function rotationFixture(
  t: Assert,
  hooks: ServerHooks,
  extra: Partial<ConstructorParameters<typeof Server>[0]> = {}
): Promise<RotationFixture> {
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    hooks,
    ...extra
  })
  const log: string[] = []
  server.on('retention', (event) => {
    if (event.trigger === 'post-commit') log.push(`retention:${event.status}`)
  })
  const commits = (server as unknown as { commits: CommitStore }).commits
  const commitOptions: RotationFixture['commitOptions'] = []
  const commit = commits.commit.bind(commits)
  commits.commit = (...args: Parameters<CommitStore['commit']>) => {
    commitOptions.push(args[1])
    return commit(...args)
  }
  return { server, node, log, commitOptions }
}

test('Server keeps a rotated-out create path readable in afterCommit and rotates only after it succeeds', async (t) => {
  const inside: string[] = []
  const fixture = await rotationFixture(t, {
    async afterCommit({ path: finalPath }) {
      inside.push(await readableNow(finalPath))
    }
  })
  const newer = await manifest(t, 'app-2.0.0.bin', 'newer release')
  const older = await manifest(t, 'app-1.0.0.bin', 'older release')

  await uploadAll(fixture.node, newer)
  inside.length = 0
  fixture.log.length = 0
  const socket = await uploadAll(fixture.node, older)

  t.is(statuses(socket).at(-1), 'COMMITTED')
  t.alike(inside, ['older release'], 'the out-of-window final path exists inside afterCommit')
  t.alike(
    fixture.commitOptions.map((options) => options?.deferPostCommitRetention),
    [true, true]
  )
  await t.exception(
    () => fs.promises.lstat(path.join(fixture.server.storageDir, 'app-1.0.0.bin')),
    { code: 'ENOENT' },
    'rotation removes it only after the callback succeeded'
  )
  t.ok(
    (await fs.promises.lstat(path.join(fixture.server.storageDir, 'app-2.0.0.bin'))).isFile(),
    'the retained window is intact'
  )
  t.alike(fixture.log, ['retention:completed'])
})

test('Server orders afterCommit before post-commit retention', async (t) => {
  const order: string[] = []
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    hooks: {
      afterCommit({ artifact }) {
        order.push(`afterCommit:${artifact.name}`)
      }
    }
  })
  server.on('retention', (event) => {
    if (event.trigger === 'post-commit') order.push('retention')
  })
  await uploadAll(node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
  order.length = 0
  await uploadAll(node, await manifest(t, 'app-1.0.0.bin', 'older release'))
  t.alike(order, ['afterCommit:app-1.0.0.bin', 'retention'])
})

test('Server keeps a failed-afterCommit create artifact so a retry reaches ALREADY_COMMITTED before rotating', async (t) => {
  let failures = 1
  const inside: string[] = []
  const order: string[] = []
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    hooks: {
      async afterCommit({ path: finalPath, alreadyCommitted }) {
        order.push(`afterCommit:${alreadyCommitted}`)
        inside.push(await readableNow(finalPath))
        if (failures-- > 0) throw new Error('deploy step failed')
      }
    }
  })
  server.on('retention', (event) => {
    if (event.trigger === 'post-commit') order.push('retention')
  })
  const commits = (server as unknown as { commits: CommitStore }).commits
  await uploadAll(node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
  order.length = 0
  inside.length = 0
  failures = 1
  const older = await manifest(t, 'app-1.0.0.bin', 'older release')
  const target = path.join(server.storageDir, 'app-1.0.0.bin')

  const first = await uploadAll(node, older)
  t.is(finalCode(first), ERRORS.HOOK_FAILED)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.alike(order, ['afterCommit:false'], 'no retention after a failed callback')
  t.is(await readableNow(target), 'older release', 'the artifact stays')
  t.ok(
    (await commits.list()).some((record) => record.name === 'app-1.0.0.bin'),
    'the record stays'
  )

  const retry = reconnect(node, older)
  await waitFor(() => isTerminal(retry))
  t.alike(statuses(retry), ['ALREADY_COMMITTED'])
  t.alike(inside, ['older release', 'older release'], 'the retry sees the existing path')
  t.alike(order, ['afterCommit:false', 'afterCommit:true', 'retention'])
  await t.exception(() => fs.promises.lstat(target), { code: 'ENOENT' })
})

test('Server does not rotate after a failing already-committed afterCommit retry', async (t) => {
  let failures = 2
  const order: string[] = []
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    hooks: {
      afterCommit({ alreadyCommitted }) {
        order.push(`afterCommit:${alreadyCommitted}`)
        if (failures-- > 0) throw new Error('still failing')
      }
    }
  })
  server.on('retention', (event) => {
    if (event.trigger === 'post-commit') order.push('retention')
  })
  failures = 0
  await uploadAll(node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
  order.length = 0
  failures = 2
  const older = await manifest(t, 'app-1.0.0.bin', 'older release')
  const target = path.join(server.storageDir, 'app-1.0.0.bin')

  await uploadAll(node, older)
  const retry = reconnect(node, older)
  await waitFor(() => isTerminal(retry))
  t.alike(statuses(retry), ['REJECTED'])
  t.is(finalCode(retry), ERRORS.HOOK_FAILED)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.alike(order, ['afterCommit:false', 'afterCommit:true'], 'no retention after either failure')
  t.is(await readableNow(target), 'older release')

  const last = reconnect(node, older)
  await waitFor(() => isTerminal(last))
  t.alike(statuses(last), ['ALREADY_COMMITTED'])
  t.alike(order.slice(2), ['afterCommit:true', 'retention'])
  await t.exception(() => fs.promises.lstat(target), { code: 'ENOENT' })
})

test('Server defers replacement retention until afterCommit succeeds and keeps it after a failure', async (t) => {
  let failures = 0
  const inside: string[][] = []
  const order: string[] = []
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    replaceNames: ['app-1.0.0.bin'],
    hooks: {
      async afterCommit({ alreadyCommitted }) {
        order.push(`afterCommit:${alreadyCommitted}`)
        inside.push(await historyFiles(server.storageDir))
        if (failures-- > 0) throw new Error('deploy step failed')
      }
    }
  })
  const spy: Array<boolean | undefined> = []
  const commits = (server as unknown as { commits: CommitStore }).commits
  const commit = commits.commit.bind(commits)
  commits.commit = (...args: Parameters<CommitStore['commit']>) => {
    spy.push(args[1]?.deferPostCommitRetention)
    return commit(...args)
  }
  server.on('retention', (event) => {
    if (event.trigger === 'post-commit') order.push('retention')
  })
  await uploadAll(node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
  await uploadAll(node, await manifest(t, 'app-1.0.0.bin', 'first content'))
  order.length = 0
  inside.length = 0
  spy.length = 0

  failures = 1
  const replacement = await manifest(t, 'app-1.0.0.bin', 'second content')
  const failed = await uploadAll(node, replacement)
  t.is(finalCode(failed), ERRORS.HOOK_FAILED)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.alike(spy, [true], 'replacement commits defer post-commit retention')
  t.alike(order, ['afterCommit:false'], 'no retention after a failed callback')
  t.is(inside[0].length, 1, 'replacement history exists inside afterCommit')
  t.is(await readableNow(path.join(server.storageDir, 'app-1.0.0.bin')), 'second content')
  t.is((await historyFiles(server.storageDir)).length, 1, 'history survives the failure')

  const retry = reconnect(node, replacement)
  await waitFor(() => isTerminal(retry))
  t.alike(statuses(retry), ['ALREADY_COMMITTED'])
  t.alike(order, ['afterCommit:false', 'afterCommit:true', 'retention'])
  t.is(inside[1].length, 1, 'history still exists for the retried callback')
  t.is(await readableNow(path.join(server.storageDir, 'app-1.0.0.bin')), 'second content')
  t.is((await historyFiles(server.storageDir)).length, 0, 'rotation removes it afterwards')

  failures = 0
  order.length = 0
  const again = await manifest(t, 'app-1.0.0.bin', 'third content')
  await uploadAll(node, again)
  t.alike(order, ['afterCommit:false', 'retention'])
  t.is(inside.at(-1)!.length, 1, 'a successful replacement keeps history inside afterCommit')
  t.is((await historyFiles(server.storageDir)).length, 0)
})

test('Server keeps immediate post-commit retention without an afterCommit hook', async (t) => {
  const configurations: Array<{ name: string; hooks: ServerHooks }> = [
    { name: 'no hooks', hooks: {} },
    { name: 'beforeCommit only', hooks: { beforeCommit() {} } },
    { name: 'onFailure only', hooks: { onFailure() {} } }
  ]
  for (const configuration of configurations) {
    const order: string[] = []
    const fixture = await rotationFixture(t, configuration.hooks)
    fixture.server.on('retention', (event) => {
      if (event.trigger === 'post-commit') order.push('retention')
    })
    await uploadAll(fixture.node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
    order.length = 0
    fixture.commitOptions.length = 0
    const socket = await uploadAll(fixture.node, await manifest(t, 'app-1.0.0.bin', 'older'))

    t.is(statuses(socket).at(-1), 'COMMITTED', configuration.name)
    t.alike(
      fixture.commitOptions.map((options) => options?.deferPostCommitRetention ?? false),
      [false],
      `${configuration.name} does not defer`
    )
    t.alike(order, ['retention'], `${configuration.name} rotates once after commit`)
    await t.exception(
      () => fs.promises.lstat(path.join(fixture.server.storageDir, 'app-1.0.0.bin')),
      { code: 'ENOENT' },
      configuration.name
    )
    await fixture.server.close()
  }
})

test('Server leaves a failed-afterCommit out-of-window artifact to later scheduled retention', async (t) => {
  const { server, node } = await createServer(t, {
    artifactPatterns: ['{series}-{version}.bin'],
    maxVersions: 1,
    versionGranularity: 'major',
    hooks: {
      afterCommit() {
        throw new Error('deploy step failed')
      }
    }
  })
  await uploadAll(node, await manifest(t, 'app-2.0.0.bin', 'newer release'))
  const failed = await uploadAll(node, await manifest(t, 'app-1.0.0.bin', 'older release'))
  const target = path.join(server.storageDir, 'app-1.0.0.bin')
  t.is(finalCode(failed), ERRORS.HOOK_FAILED)
  t.is(await readableNow(target), 'older release')

  // No persistent hook-pending marker exists, so an ordinary pass removes it.
  const retention = (server as unknown as { retention: { run(): Promise<unknown> } }).retention
  await retention.run()
  await t.exception(() => fs.promises.lstat(target), { code: 'ENOENT' })
})
