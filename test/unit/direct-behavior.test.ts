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
import { fixedSeriesKey } from '../../dist/release.js'
import type {
  DirectDhtNode,
  DirectDhtServerHandle,
  DirectDhtSocket
} from '../../dist/direct-dht.js'
import {
  decodeAdmissionRecord,
  decodeFinalRecord,
  decodeLinkResultRecord,
  decodeMetadataRecord,
  decodeTreeMetadataRecord,
  encodeAdmissionRecord,
  encodeControlFrame,
  encodeFinalRecord,
  encodeLinkRequestRecord,
  encodeMetadataRecord,
  encodeTreeMetadataRecord
} from '../../dist/tar-protocol/controls.js'
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest,
  type TreeManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { writeTree } from '../helpers/trees.js'
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

test('Client link half-closes one control request and requires an explicit link result', async (t) => {
  const serverKey = keyPairFromSeed(SERVER_SEED).publicKey
  const linkResult = (status: 'LINKED' | 'UNCHANGED' | 'FAILED', code?: string): Buffer =>
    encodeControlFrame(
      b4a.from(JSON.stringify({ v: 1, status, ...(code === undefined ? {} : { code }) }))
    )

  const successSocket = new FakeSocket(serverKey)
  successSocket.onEnd = () => successSocket.feed(linkResult('LINKED'))
  const successClient = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: serverKey,
    idleTimeout: 1_000,
    dht: fakeClientNode(successSocket)
  })
  const successLink = successClient as unknown as {
    link(target: string, name: string): Promise<{ target: string; name: string; status: string }>
  }
  t.ok(typeof successLink.link === 'function')
  if (typeof successLink.link === 'function') {
    t.alike(await successLink.link('release-1.2.3', 'current'), {
      target: 'release-1.2.3',
      name: 'current',
      status: 'LINKED'
    })
    t.alike(JSON.parse(b4a.toString(successSocket.writes[0].subarray(4))), {
      v: 1,
      kind: 'link',
      target: 'release-1.2.3',
      name: 'current'
    })
    t.is(successSocket.writes.length, 1)
  }
  await successClient.close()
  t.is(successSocket.destroyed, true)

  const failedSocket = new FakeSocket(serverKey)
  failedSocket.onEnd = () => failedSocket.feed(linkResult('FAILED', 'LINK_TARGET_NOT_FOUND'))
  const failedClient = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: serverKey,
    idleTimeout: 1_000,
    dht: fakeClientNode(failedSocket)
  })
  const failedLink = failedClient as unknown as {
    link(target: string, name: string): Promise<unknown>
  }
  t.ok(typeof failedLink.link === 'function')
  if (typeof failedLink.link === 'function') {
    await t.exception(failedLink.link('release-1.2.3', 'current'), {
      code: (ERRORS as Record<string, string>).LINK_TARGET_NOT_FOUND
    })
  }
  await failedClient.close()
  t.is(failedSocket.destroyed, true)

  const eofSocket = new FakeSocket(serverKey)
  eofSocket.onEnd = () => eofSocket.finishInput()
  const eofClient = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: serverKey,
    idleTimeout: 1_000,
    dht: fakeClientNode(eofSocket)
  })
  const eofLink = eofClient as unknown as { link(target: string, name: string): Promise<unknown> }
  t.ok(typeof eofLink.link === 'function')
  if (typeof eofLink.link === 'function') {
    await t.exception(eofLink.link('release-1.2.3', 'current'), { code: ERRORS.PROTOCOL_INVALID })
  }
  await eofClient.close()
  t.is(eofSocket.destroyed, true)
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

test('Server commits and rotates a fixed-series {version}/payments.tar.gz pattern end to end', async (t) => {
  const template = '{version}/payments.tar.gz'
  const series = fixedSeriesKey(template)
  const storageDir = await createTempDir(t)
  const { server, node } = await createServer(t, {
    storageDir,
    artifactPatterns: [template],
    replaceNames: ['payments.tar.gz'],
    maxCount: 1
  })
  const spy = spyRelease(server)
  const commits = (server as unknown as { commits: CommitStore }).commits

  const first = await manifestIn(t, '1.0.0', 'payments.tar.gz', 'payments one')
  t.is(statuses(await uploadAll(node, first)).at(-1), 'COMMITTED')
  t.alike(spy.committed, [{ series, version: '1.0.0' }])
  const stored = (await commits.list()).find((record) => record.name === 'payments.tar.gz')!
  t.alike(stored.release, { series, version: '1.0.0' })
  const sidecar = JSON.parse(
    b4a.toString(
      await fs.promises.readFile(
        path.join(storageDir, '.swarm-deploy', 'commits', `${stored.transferId}.json`)
      )
    )
  ) as { release: { series: string; version: string } }
  t.alike(
    sidecar.release,
    { series, version: '1.0.0' },
    'the hashed fixed series is durable on disk'
  )

  const second = await manifestIn(t, '2.0.0', 'payments.tar.gz', 'payments two')
  t.is(statuses(await uploadAll(node, second)).at(-1), 'COMMITTED')
  t.alike(spy.committed.at(-1), { series, version: '2.0.0' })
  t.is(
    b4a.toString(await fs.promises.readFile(path.join(storageDir, 'payments.tar.gz'))),
    'payments two'
  )
  t.alike(
    (await commits.list()).map((record) => record.release),
    [{ series, version: '2.0.0' }],
    'count rotation keeps only the newest record of the fixed series'
  )
  t.alike(await historyFiles(storageDir), [], 'the rotated-out history artifact is gone')
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
    { maxVersions: 1, versionGranularity: 'major' },
    { maxVersions: 0, versionGranularity: 'major', artifactPatterns: ['{series}-{version}.bin'] },
    { artifactPatterns: ['{series}.bin', '{series}.bin'] },
    { artifactPatterns: ['no-placeholder.bin'] }
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
    kind: 'file',
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

function gate(): { wait: Promise<void>; open(): void } {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => {
    open = (): void => resolve()
  })
  return { wait, open }
}

function offerEvents(server: Server): string[] {
  const events: string[] = []
  server.on('offer', (event) => events.push(`${event.status}:${event.reason}`))
  return events
}

test('Server rejects a concurrent duplicate transfer with FILE_BUSY instead of running hooks twice', async (t) => {
  const calls: HookCall[] = []
  const held = gate()
  let entered = 0
  const { server, node } = await createServer(t, {
    hooks: recordingHooks(
      calls,
      { current: null },
      {
        beforeCommit: async () => {
          entered++
          await held.wait
        }
      }
    )
  })
  const offers = offerEvents(server)
  const input = await manifest(t, 'concurrent-hook.txt', 'concurrent hook payload')
  const metadata = metadataFromManifest(input.manifest)

  const first = new FakeSocket(CLIENT_KEY)
  node.accept(first)
  first.feed(metadataFrame(input.manifest))
  await waitFor(() => statuses(first).includes('ACCEPT'))
  first.feed(input.tar)
  first.finishInput()
  await waitFor(() => entered === 1)

  offers.length = 0
  const duplicate = new FakeSocket(CLIENT_KEY)
  node.accept(duplicate)
  duplicate.feed(metadataFrame(input.manifest))
  await waitFor(() => isTerminal(duplicate))
  await new Promise((resolve) => setTimeout(resolve, 20))

  t.alike(statuses(duplicate), ['REJECTED'])
  t.is(finalCode(duplicate), ERRORS.FILE_BUSY)
  t.alike(offers, [`rejected:${ERRORS.FILE_BUSY}`])
  t.is(entered, 1, 'the duplicate never enters beforeCommit')
  const reported = calls.filter((call) => call.hook === 'onFailure')
  t.is(reported.length, 1, 'the duplicate reports onFailure exactly once')
  const context = reported[0].context as HookFailureContext
  t.is(context.phase, 'offer')
  t.is(context.path, null)
  t.is((context.error as SwarmDeployError).code, ERRORS.FILE_BUSY)
  t.is(context.artifact.transferId, metadata.transferId)

  held.open()
  await waitFor(() => isTerminal(first))
  t.is(statuses(first).at(-1), 'COMMITTED')

  const released = reconnect(node, input)
  await waitFor(() => isTerminal(released))
  t.alike(statuses(released), ['ALREADY_COMMITTED'], 'the guard is released in finally')
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

function committingSocket(): FakeSocket {
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
  socket.onEnd = () =>
    socket.feed(encodeControlFrame(encodeFinalRecord({ v: 1, status: 'COMMITTED' })))
  return socket
}

test('Client uploads a directory as one directory offer and one canonical tree archive', async (t) => {
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true })
  await fs.promises.writeFile(path.join(source, 'b.txt'), 'b')
  await fs.promises.writeFile(path.join(source, 'nested', 'a.txt'), 'a')

  const socket = committingSocket()
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 5_000,
    dht: fakeClientNode(socket)
  })
  const events: Array<{ name: string; kind: string; status: string; final: boolean }> = []
  client.on('result', (event) => events.push(event))
  t.teardown(() => client.close())

  const result = await client.upload(source)
  t.is(result.status, 'COMMITTED')
  t.is(result.kind, 'directory')
  t.is(result.name, '0.18.1')
  t.is(result.entryCount, 3)
  t.is(result.size, 2)
  t.alike(events, [{ name: '0.18.1', kind: 'directory', status: 'COMMITTED', final: true }])

  // Exactly one offer frame, and it is a directory offer, not a batch of children.
  const offer = decodeTreeMetadataRecord(socket.writes[0].subarray(4))
  t.is(offer.kind, 'directory')
  t.is(offer.name, '0.18.1')
  t.is(offer.entryCount, 3)
  t.is(offer.payloadBytes, 2)
  t.is(offer.sourceParent, path.basename(path.dirname(source)))

  // The payload is byte-identical to the canonical archive the manifest describes.
  const manifest = await buildTreeManifest(source, keyPairFromSeed(CLIENT_SEED).publicKey)
  const expected: Buffer[] = []
  await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
    expected.push(b4a.from(chunk))
  })
  t.ok(b4a.equals(b4a.concat(socket.writes.slice(1)), b4a.concat(expected)))
  t.is(offer.tarSize, manifest.tarSize)
  t.is(b4a.toString(result.digest, 'hex'), offer.treeSha256)
  t.is(b4a.toString(result.transferId, 'hex'), offer.transferId)
})

test('Client rejects a directory containing a symlink before any connection write', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await fs.promises.mkdir(source)
  await fs.promises.writeFile(path.join(root, 'outside.txt'), 'outside')
  await fs.promises.symlink(path.join(root, 'outside.txt'), path.join(source, 'link.txt'))

  const socket = committingSocket()
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 5_000,
    dht: fakeClientNode(socket)
  })
  const failures: string[] = []
  client.on('failure', (event) => failures.push(event.reason))
  t.teardown(() => client.close())

  await t.exception(client.upload(source), { code: ERRORS.INVALID_FILENAME })
  t.is(socket.writes.length, 0)
  t.alike(failures, [ERRORS.INVALID_FILENAME])
})

test('Client reports a single-file upload as kind file with no entry count', async (t) => {
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'payload')
  const socket = committingSocket()
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 5_000,
    dht: fakeClientNode(socket)
  })
  t.teardown(() => client.close())

  const result = await client.upload(input)
  t.is(result.kind, 'file')
  t.is(result.name, 'artifact.txt')
  t.is(result.entryCount, undefined)
  t.is(decodeMetadataRecord(socket.writes[0].subarray(4)).name, 'artifact.txt')
})

async function treeManifest(
  t: Assert,
  name: string,
  spec: Record<string, string>
): Promise<{ manifest: TreeManifest; tar: Buffer }> {
  const source = path.join(await createTempDir(t), name)
  await writeTree(source, spec)
  const built = await buildTreeManifest(source, CLIENT_KEY)
  const chunks: Buffer[] = []
  await regenerateTreeTarSuffix(built, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { manifest: built, tar: b4a.concat(chunks) }
}

function treeMetadataFrame(value: TreeManifest, reset = false): Buffer {
  return encodeControlFrame(encodeTreeMetadataRecord(treeMetadataFromManifest(value, reset)))
}

test('a directory upload commits, reconciles its link, and reports kind to hooks', async (t) => {
  const contexts: Array<{ phase: string; kind: string; path: string; entryCount?: number }> = []
  const hooks: ServerHooks = {
    beforeCommit: (context) =>
      void contexts.push({
        phase: 'beforeCommit',
        kind: context.artifact.kind,
        path: context.path,
        entryCount: context.artifact.entryCount
      }),
    afterCommit: (context) =>
      void contexts.push({
        phase: 'afterCommit',
        kind: context.artifact.kind,
        path: context.path,
        entryCount: context.artifact.entryCount
      })
  }
  const { server, node } = await createServer(t, {
    hooks,
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const built = await treeManifest(t, '0.18.1', { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'z' })
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(treeMetadataFrame(built.manifest))
  socket.feed(built.tar)
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('COMMITTED'))

  const root = server.storageDir
  t.ok((await fs.promises.lstat(path.join(root, '0.18.1'))).isDirectory())
  t.alike((await fs.promises.readdir(path.join(root, '0.18.1'))).sort(), ['a', 'z.bin'])
  t.is(await fs.promises.readlink(path.join(root, 'latest')), '0.18.1')
  t.alike(
    contexts.map((context) => `${context.phase}:${context.kind}:${context.entryCount}`),
    ['beforeCommit:directory:4', 'afterCommit:directory:4']
  )
  t.ok(contexts[0].path.endsWith(`${built.manifest.transferId.toString('hex')}.tree`))
  t.is(contexts[1].path, path.join(root, '0.18.1'))
})

test('a configured link name cannot be uploaded as an artifact', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const built = await manifest(t, 'latest', 'payload')
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(built.manifest))
  await waitFor(() => statuses(socket).includes('REJECTED'))
  const rejection = JSON.parse(b4a.toString(socket.writes[0].subarray(4))) as { code: string }
  t.is(rejection.code, ERRORS.INVALID_FILENAME)
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, 'latest')))
})

test('Server links an authenticated request target after a clean close', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^release-\\d+$/' }]
  })
  const artifact = await manifest(t, 'release-1', 'release payload')
  await uploadAll(node, artifact)

  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(
    encodeControlFrame(
      encodeLinkRequestRecord({ v: 1, kind: 'link', target: 'release-1', name: 'current' })
    )
  )
  socket.finishInput()
  await waitFor(() => socket.writes.length === 1)

  t.alike(decodeLinkResultRecord(socket.writes[0].subarray(4)), { v: 1, status: 'LINKED' })
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'current')), 'release-1')
})

async function linkAll(
  node: FakeServerNode,
  target: string,
  name: string
): Promise<{ socket: FakeSocket; result: { v: number; status: string; code?: string } }> {
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(encodeControlFrame(encodeLinkRequestRecord({ v: 1, kind: 'link', target, name })))
  socket.finishInput()
  await waitFor(() => socket.writes.length === 1)
  return {
    socket,
    result: decodeLinkResultRecord(socket.writes[0].subarray(4)) as {
      v: number
      status: string
      code?: string
    }
  }
}

test('Server maps manual link outcomes, excludes hooks, and reserves durable names', async (t) => {
  const hooks: string[] = []
  const events: Array<{ status: string; reason?: string }> = []
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^release-\\d+$/' }, { selector: '/^release-\\d+$/', name: 'latest' }],
    hooks: {
      beforeCommit: () => void hooks.push('before'),
      afterCommit: () => void hooks.push('after'),
      onFailure: () => void hooks.push('failure')
    }
  })
  server.on('link', (event) => events.push({ status: event.status, reason: event.reason }))
  await uploadAll(node, await manifest(t, 'release-1', 'first'))
  await uploadAll(node, await manifest(t, 'release-2', 'second'))
  hooks.length = 0

  t.alike((await linkAll(node, 'release-1', 'current')).result, { v: 1, status: 'LINKED' })
  t.alike((await linkAll(node, 'release-1', 'current')).result, { v: 1, status: 'UNCHANGED' })
  t.alike((await linkAll(node, 'release-2', 'current')).result, { v: 1, status: 'LINKED' })
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'current')), 'release-2')
  t.alike((await linkAll(node, 'release-1', 'release-1')).result, {
    v: 1,
    status: 'FAILED',
    code: ERRORS.LINK_NOT_ALLOWED
  })
  t.alike((await linkAll(node, 'release-3', 'other')).result, {
    v: 1,
    status: 'FAILED',
    code: ERRORS.LINK_TARGET_NOT_FOUND
  })
  t.alike((await linkAll(node, 'release-1', 'latest')).result, {
    v: 1,
    status: 'FAILED',
    code: ERRORS.LINK_NOT_ALLOWED
  })
  t.alike((await linkAll(node, 'release-1', 'release-2')).result, {
    v: 1,
    status: 'FAILED',
    code: ERRORS.LINK_CONFLICT
  })
  await fs.promises.writeFile(path.join(server.storageDir, 'operator'), 'operator')
  t.alike((await linkAll(node, 'release-1', 'operator')).result, {
    v: 1,
    status: 'FAILED',
    code: ERRORS.LINK_CONFLICT
  })
  t.alike(hooks, [], 'link requests never run artifact hooks')
  const rejectedUpload = await uploadAll(node, await manifest(t, 'current', 'reserved'))
  t.is(finalCode(rejectedUpload), ERRORS.INVALID_FILENAME)
  t.alike(
    events.map((event) => event.status),
    ['linked', 'unchanged', 'linked', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']
  )
  t.alike(
    events.slice(3).map((event) => event.reason),
    [
      ERRORS.LINK_NOT_ALLOWED,
      ERRORS.LINK_TARGET_NOT_FOUND,
      ERRORS.LINK_NOT_ALLOWED,
      ERRORS.LINK_CONFLICT,
      ERRORS.LINK_CONFLICT
    ]
  )
})

test('Server keeps durable manual names managed after rules are removed on restart', async (t) => {
  const storageDir = await createTempDir(t)
  const first = await createServer(t, {
    storageDir,
    symlinks: [{ selector: '/^release-\\d+$/' }]
  })
  await uploadAll(first.node, await manifest(t, 'release-1', 'release'))
  t.alike((await linkAll(first.node, 'release-1', 'current')).result, { v: 1, status: 'LINKED' })
  await first.server.close()

  const node = new FakeServerNode()
  const restarted = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 16 * 1024,
    maxStagingBytes: 64 * 1024,
    minFreeBytes: 0,
    dht: node
  })
  t.teardown(() => restarted.close())
  await restarted.listen()
  const rejected = await uploadAll(node, await manifest(t, 'current', 'must stay reserved'))
  t.is(finalCode(rejected), ERRORS.INVALID_FILENAME)
  t.is(await fs.promises.readlink(path.join(storageDir, 'current')), 'release-1')
})

test('a link is repointed to the newest match before the old target is rotated', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }],
    artifactPatterns: ['{version}'],
    maxCount: 1
  })
  for (const name of ['0.18.0', '0.18.1']) {
    const built = await treeManifest(t, name, { 'a.bin': name })
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    socket.feed(treeMetadataFrame(built.manifest))
    socket.feed(built.tar)
    socket.finishInput()
    await waitFor(() => statuses(socket).includes('COMMITTED'))
  }
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'latest')), '0.18.1')
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, '0.18.0')))
})

test('an unrecorded directory and an operator file leave a rule dormant at startup', async (t) => {
  const storageDir = await createTempDir(t)
  await fs.promises.mkdir(path.join(storageDir, '0.18.1'))
  await fs.promises.writeFile(path.join(storageDir, 'latest'), 'operator file')
  const node = new FakeServerNode()
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 16 * 1024,
    maxStagingBytes: 64 * 1024,
    minFreeBytes: 0,
    dht: node,
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  t.teardown(() => server.close())
  await server.listen()
  t.is(await fs.promises.readFile(path.join(storageDir, 'latest'), 'utf8'), 'operator file')
  t.ok((await fs.promises.lstat(path.join(storageDir, '0.18.1'))).isDirectory())
})

test('an unmanaged path at a configured link name fails the link closed', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  await fs.promises.writeFile(path.join(server.storageDir, 'latest'), 'operator file')
  const built = await treeManifest(t, '0.18.1', { 'a.bin': 'a' })
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(treeMetadataFrame(built.manifest))
  socket.feed(built.tar)
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('FAILED'))
  const failure = JSON.parse(b4a.toString(socket.writes[socket.writes.length - 1].subarray(4))) as {
    code: string
  }
  t.is(failure.code, ERRORS.LINK_CONFLICT)
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())
  t.is(await fs.promises.readFile(path.join(server.storageDir, 'latest'), 'utf8'), 'operator file')
})

test('configuring symlinks requires a symlink-capable storage adapter', (t) => {
  const { createStorage } =
    require('../helpers/storage.js') as typeof import('../helpers/storage.js')
  const incapable = { ...createStorage(), symlink: undefined, readlink: undefined }
  t.exception(
    () =>
      new Server({
        seed: SERVER_SEED,
        storageDir: '/srv/swarm-deploy',
        allowedKeys: [CLIENT_KEY],
        maxFileBytes: 1024,
        maxStagingBytes: 4096,
        storage: incapable,
        symlinks: [{ selector: 'release.tar.gz', name: 'current.tar.gz' }]
      }),
    { code: ERRORS.UNSUPPORTED_STORAGE }
  )
  t.execution(
    () =>
      new Server({
        seed: SERVER_SEED,
        storageDir: '/srv/swarm-deploy',
        allowedKeys: [CLIENT_KEY],
        maxFileBytes: 1024,
        maxStagingBytes: 4096,
        storage: createStorage()
      })
  )
})

test('a link reconciliation failure after a durable commit is retried as already committed', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const links = (server as unknown as { links: { reconcile: unknown } }).links
  const original = links.reconcile
  let reconcilesWithTargets = 0
  ;(links as { reconcile: unknown }).reconcile = async (...args: unknown[]) => {
    const desired = args[0] as unknown[]
    if (desired.length > 0 && ++reconcilesWithTargets === 2) {
      throw new Error('injected link failure')
    }
    return await (original as (...rest: unknown[]) => Promise<unknown>).apply(links, args)
  }
  const built = await treeManifest(t, '0.18.1', { 'a.bin': 'a' })
  const first = new FakeSocket(CLIENT_KEY)
  node.accept(first)
  first.feed(treeMetadataFrame(built.manifest))
  first.feed(built.tar)
  first.finishInput()
  await waitFor(() => statuses(first).includes('FAILED'))
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())

  const retry = new FakeSocket(CLIENT_KEY)
  node.accept(retry)
  retry.feed(treeMetadataFrame(built.manifest))
  retry.finishInput()
  await waitFor(() => statuses(retry).includes('ALREADY_COMMITTED'))
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'latest')), '0.18.1')
})
