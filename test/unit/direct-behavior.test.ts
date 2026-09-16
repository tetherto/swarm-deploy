/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import events from '#events'
import fs from '#fs'
import path from '#path'
import { Client, ERRORS, keyPairFromSeed, Server, type ServerScheduler } from '../../dist/index.js'
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
    const { server, node } = await createServer(t, {
      maxConnections: 1,
      maxActiveUploads: 1,
      idleTimeout: 5
    })
    const failures: string[] = []
    server.on('failure', (event) => failures.push(event.reason))
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    if (phase === 'tar') {
      const input = await manifest(t, `${phase}.txt`)
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
