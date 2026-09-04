/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { EventEmitter } from '#events'
import { Server, keyPairFromSeed, transferId, ERRORS } from '../../dist/index.js'
import { ServerSession } from '../../dist/protocol/server-session.js'
import { OFFER, CHUNK, FINISH, RESULT } from '../../dist/protocol/constants.js'
import type { Codec, Offer, ProtocolChannel } from '../../dist/protocol/types.js'
import type { SwarmDiscovery } from '../../dist/types.js'
import { initLayout } from '../../dist/storage/layout.js'
import { readJson } from '../../dist/storage/atomic-file.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import type { StorageAdapter, StorageLayout } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'
import { serverInternals, type TrackedConnection } from '../helpers/internals.js'

const OWNER = b4a.alloc(32, 0x51)
const OWNER_SEED = b4a.alloc(32, 0x52)
const CHUNK_SIZE = 1024 * 1024

/** A destroy reason captured from the transport seam. */
interface CaughtError {
  name?: string
  code?: string
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

interface HarnessChunk {
  transferId: Buffer
  index: number
  digest: Buffer
  data: Buffer
}

interface HarnessUpload {
  offer: Offer
  chunk: HarnessChunk
}

/**
 * A message recorded by the fake channel, retaining the inbound handler.
 * `ServerSession` installs handlers only for the messages it consumes, so the
 * harness drives the handler through a non-null assertion exactly where the
 * untyped original relied on it being present.
 */
interface RecordedMessage {
  onmessage?(value: unknown): unknown
  send(value: unknown): boolean
}

interface OutboundFrame {
  index: number
  value: unknown
}

/**
 * The fake channel implements only the members `ServerSession` exercises, so
 * the harness keeps the same observable surface as the untyped original.
 */
interface FakeChannel {
  drained: boolean
  closed: boolean
  _recv(): void
  addMessage<Input, Output>(options: {
    encoding: Codec<Input, Output>
    onmessage?: (value: Output) => unknown
  }): RecordedMessage
  open(): void
  close(): void
}

interface FakeTransport {
  channel: FakeChannel
  messages: RecordedMessage[]
  outbound: OutboundFrame[]
}

interface CreatedSession extends FakeTransport {
  layout: StorageLayout
  sessionStore: SessionStore
  commitStore: CommitStore
  session: ServerSession
  destroyed: CaughtError[]
}

/** A socket stand-in whose destruction the revocation path reports. */
interface FakeSocket extends EventEmitter {
  destroy(error?: unknown): void
}

interface AttachedSession extends FakeTransport {
  socket: FakeSocket
  connection: TrackedConnection
  session: ServerSession
}

interface LinearizedRun {
  server: Server
  storage: TestStorage
  storageDir: string
  upload: HarnessUpload
  id: string
  sessionPath: string
  stagingPath: string
  journalPath: string
  finalPath: string
  sidecarPath: string
  reloadError: CaughtError | null
}

/** The journal fields these assertions read back. */
interface JournalRecord {
  state?: unknown
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

function diagnosticTimeout<T>(promise: Promise<T>, label: string, timeout = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${label}`)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function makeUpload(ownerKey: Uint8Array = OWNER, name = 'revoked.bin'): HarnessUpload {
  const data = b4a.from('revocation barrier payload')
  const digest = sha256(data)
  const size = data.byteLength
  const id = transferId({
    clientPublicKey: ownerKey,
    name,
    size,
    digest,
    chunkSize: CHUNK_SIZE
  })
  const offer: Offer = {
    version: 1,
    transferId: id,
    name,
    size,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  return {
    offer,
    chunk: { transferId: id, index: 0, digest, data }
  }
}

function createChannel(): FakeTransport {
  const outbound: OutboundFrame[] = []
  const messages: RecordedMessage[] = []
  const channel: FakeChannel = {
    drained: true,
    closed: false,
    _recv() {},
    addMessage(options) {
      const index = messages.length
      const message = {
        ...options,
        send(value: unknown) {
          outbound.push({ index, value })
          return true
        }
      }
      messages.push(message)
      return message
    },
    open() {},
    close() {
      channel.closed = true
    }
  }
  return { channel, messages, outbound }
}

async function createSession(
  t: Assert,
  storage: StorageAdapter = fs.promises
): Promise<CreatedSession> {
  const layout = initLayout(await createTempDir(t))
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commitStore = new CommitStore({ layout, storage })
  const transport = createChannel()
  const destroyed: CaughtError[] = []
  const session = new ServerSession({
    channel: transport.channel as unknown as ProtocolChannel,
    ownerKey: OWNER,
    sessionStore,
    commitStore,
    maxFileBytes: CHUNK_SIZE,
    destroy(error) {
      destroyed.push(error as CaughtError)
    }
  })
  t.teardown(() => session.close())
  return { layout, sessionStore, commitStore, session, destroyed, ...transport }
}

async function offerReady(created: CreatedSession, upload: HarnessUpload): Promise<void> {
  await created.messages[OFFER].onmessage!(upload.offer)
  tIsReady(created)
}

function tIsReady(created: CreatedSession): void {
  if (created.session.state !== 'READY') {
    throw new Error(`Expected READY session, got ${created.session.state}`)
  }
}

test('revocation stops an active write and its queued successor without acknowledgements', async (t) => {
  const writeStarted = deferred()
  const releaseWrite = deferred()
  let blocked = false
  const storage = createStorage({
    async beforeOperation(name, filePath) {
      if (blocked || name !== 'write' || !filePath.endsWith('.part')) return
      blocked = true
      writeStarted.resolve()
      await releaseWrite.promise
    }
  })
  const created = await createSession(t, storage)
  const upload = makeUpload()
  await offerReady(created, upload)

  const active = created.messages[CHUNK].onmessage!(upload.chunk)
  await diagnosticTimeout(writeStarted.promise, 'active staging write barrier')
  const queued = created.messages[CHUNK].onmessage!(upload.chunk)
  created.session.revoke()
  releaseWrite.resolve()
  await Promise.all([active, queued])
  await created.session.settle()

  t.is(created.session.state, 'TERMINAL')
  t.is(created.channel.closed, true)
  t.is(created.outbound.filter((entry) => entry.index === 5).length, 0)
  t.is(created.destroyed[0].code, ERRORS.REVOKED)
  await created.sessionStore.deleteByOwner(OWNER)
  t.is(created.sessionStore.sessions.size, 0)
})

test('revocation at the publication link rolls back final and sidecar', async (t) => {
  const linkStarted = deferred()
  const releaseLink = deferred()
  let finalPath: string | null = null
  let blocked = false
  const storage = createStorage({
    async beforeOperation(name, source, destination) {
      if (blocked || name !== 'link' || destination !== finalPath) return
      blocked = true
      linkStarted.resolve()
      await releaseLink.promise
    }
  })
  const created = await createSession(t, storage)
  const upload = makeUpload(OWNER, 'committing.bin')
  finalPath = path.join(created.layout.root, upload.offer.name)
  await offerReady(created, upload)
  await created.messages[CHUNK].onmessage!(upload.chunk)

  const finishing = created.messages[FINISH].onmessage!({
    transferId: upload.offer.transferId
  })
  await diagnosticTimeout(linkStarted.promise, 'commit publication link barrier')
  created.session.revoke()
  releaseLink.resolve()
  await finishing
  await created.session.settle()

  t.is(
    created.outbound.some((entry) => entry.index === RESULT),
    false
  )
  await t.exception(() => fs.promises.lstat(finalPath!), { code: 'ENOENT' })
  await t.exception(
    () =>
      fs.promises.lstat(path.join(created.layout.commits, `${hex(upload.offer.transferId)}.json`)),
    { code: 'ENOENT' }
  )
  t.is(
    await created.commitStore.retryAbortedAttempt(upload.offer.transferId, created.sessionStore),
    false
  )
  await created.sessionStore.deleteByOwner(OWNER)
  t.is(created.sessionStore.sessions.size, 0)
})

/** The swarm seam replacement: an emitter plus the two methods used. */
interface StubSwarm extends EventEmitter {
  join(): SwarmDiscovery
  destroy(): Promise<void>
}

function createStubSwarm(): StubSwarm {
  const swarm = new EventEmitter() as StubSwarm
  swarm.join = () => ({ flushed: () => Promise.resolve() })
  swarm.destroy = () => Promise.resolve()
  return swarm
}

function attachServerSession(
  server: Server,
  ownerKey: Buffer,
  onDestroy: (error?: unknown) => void
): AttachedSession {
  const transport = createChannel()
  const socket = new EventEmitter() as FakeSocket
  socket.destroy = (error) => onDestroy(error)
  const owner = hex(ownerKey)
  const connection: TrackedConnection = {
    owner,
    ownerKey,
    sessions: new Set(),
    socket,
    refreshTransport() {}
  }
  const internal = serverInternals(server)
  internal._connections.set(socket, connection)
  internal._sockets.set(owner, new Set([socket]))
  internal._onPair(
    {
      createChannel() {
        return transport.channel
      }
    },
    socket,
    connection,
    b4a.from('late-revocation')
  )
  return {
    ...transport,
    socket,
    connection,
    session: [...connection.sessions][0] as ServerSession
  }
}

interface LinearizedOptions {
  deferRetry?: boolean
}

async function runLinearizedServerRevocation(
  t: Assert,
  name: string,
  { deferRetry = false }: LinearizedOptions = {}
): Promise<LinearizedRun> {
  const cleanupStarted = deferred()
  const releaseCleanup = deferred()
  const revocationStarted = deferred()
  let armed = false
  let sessionPath: string | null = null
  const storage = createStorage({
    async beforeOperation(operation, filePath) {
      if (!armed || operation !== 'unlink' || filePath !== sessionPath) return
      armed = false
      cleanupStarted.resolve()
      await releaseCleanup.promise
      throw new Error('Injected post-linearization cleanup failure')
    }
  })
  const storageDir = await createTempDir(t)
  const ownerKey = keyPairFromSeed(OWNER_SEED).publicKey
  const server = new Server({
    seed: b4a.alloc(32, name.length),
    storageDir,
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const internal = serverInternals(server)
  const attached = attachServerSession(server, ownerKey, () => revocationStarted.resolve())
  const upload = makeUpload(ownerKey, name)
  const id = hex(upload.offer.transferId)
  sessionPath = path.join(internal.layout.sessions, `${id}.json`)
  const stagingPath = path.join(internal.layout.staging, `${id}.part`)
  const journalPath = path.join(internal.layout.journals, `${id}.json`)
  const finalPath = path.join(internal.layout.root, name)
  const sidecarPath = path.join(internal.layout.commits, `${id}.json`)
  await attached.messages[OFFER].onmessage!(upload.offer)
  await attached.messages[CHUNK].onmessage!(upload.chunk)

  armed = true
  const finishing = attached.messages[FINISH].onmessage!({ transferId: upload.offer.transferId })
  await diagnosticTimeout(cleanupStarted.promise, `${name} cleanup barrier`)
  if (deferRetry) {
    internal.commitStore.retryAbortedAttempt = () => {
      throw new Error('Simulated restart before pending retry')
    }
  }
  const reloading = server.reloadAllowlist([])
  await diagnosticTimeout(revocationStarted.promise, `${name} revocation barrier`)
  releaseCleanup.resolve()
  await finishing
  await attached.session.settle()

  let reloadError: CaughtError | null = null
  try {
    await reloading
  } catch (err) {
    reloadError = err as CaughtError
  }
  return {
    server,
    storage,
    storageDir,
    upload,
    id,
    sessionPath,
    stagingPath,
    journalPath,
    finalPath,
    sidecarPath,
    reloadError
  }
}

test('late Server revocation preserves linearized commits online and after restart', async (t) => {
  const online = await runLinearizedServerRevocation(t, 'late-online.bin')
  const onlineInternal = serverInternals(online.server)
  const onlineRecord = await readJson(online.sidecarPath)
  const onlineFinal = await fs.promises.lstat(online.finalPath)
  t.is(online.reloadError, null)
  t.is(onlineInternal.sessionStore.sessions.size, 0)
  t.is(onlineInternal.sessionStore.reservedBytes, 0)
  t.is(onlineInternal._activeUploads.size, 0)
  t.is(onlineInternal.pendingRevocations.size, 0)
  t.alike(await fs.promises.readFile(online.finalPath), online.upload.chunk.data)
  await t.exception(() => fs.promises.lstat(online.sessionPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(online.stagingPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(online.journalPath), { code: 'ENOENT' })
  t.is(
    await onlineInternal.commitStore.retryAbortedAttempt(
      online.upload.offer.transferId,
      onlineInternal.sessionStore
    ),
    false
  )
  await online.server.reloadAllowlist([])
  const onlineAfter = await fs.promises.lstat(online.finalPath)
  t.is(onlineAfter.dev, onlineFinal.dev)
  t.is(onlineAfter.ino, onlineFinal.ino)
  t.alike(await readJson(online.sidecarPath), onlineRecord)

  const interrupted = await runLinearizedServerRevocation(t, 'late-restart.bin', {
    deferRetry: true
  })
  const interruptedInternal = serverInternals(interrupted.server)
  const interruptedRecord = await readJson(interrupted.sidecarPath)
  const interruptedFinal = await fs.promises.lstat(interrupted.finalPath)
  t.is(interrupted.reloadError!.name, 'AggregateError')
  t.is(interruptedInternal.sessionStore.sessions.size, 0)
  t.is(interruptedInternal.sessionStore.reservedBytes, 0)
  t.is(interruptedInternal._activeUploads.size, 0)
  t.is(interruptedInternal.pendingRevocations.size, 1)
  t.alike(await fs.promises.readFile(interrupted.finalPath), interrupted.upload.chunk.data)
  t.is(((await readJson(interrupted.journalPath)) as JournalRecord).state, 'committing')
  await interrupted.server.close()

  const restarted = new Server({
    seed: b4a.alloc(32, 0x59),
    storageDir: interrupted.storageDir,
    allowedKeys: [],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage: interrupted.storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => restarted.close())
  await restarted.listen()
  const restartedInternal = serverInternals(restarted)
  const restartedFinal = await fs.promises.lstat(interrupted.finalPath)
  t.is(restartedFinal.dev, interruptedFinal.dev)
  t.is(restartedFinal.ino, interruptedFinal.ino)
  t.alike(await fs.promises.readFile(interrupted.finalPath), interrupted.upload.chunk.data)
  t.alike(await readJson(interrupted.sidecarPath), interruptedRecord)
  await t.exception(() => fs.promises.lstat(interrupted.sessionPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(interrupted.stagingPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(interrupted.journalPath), { code: 'ENOENT' })
  t.is(restartedInternal.sessionStore.sessions.size, 0)
  t.is(restartedInternal.sessionStore.reservedBytes, 0)
})

test('an unchanged allowlist reload retries failed revocation cleanup', async (t) => {
  const ownerKey = keyPairFromSeed(OWNER_SEED).publicKey
  let armed = false
  let sessionPath: string | null = null
  let failures = 0
  const storage = createStorage({
    beforeOperation(name, filePath) {
      if (!armed || failures > 0 || name !== 'unlink' || filePath !== sessionPath) return
      failures++
      throw new Error('Injected revocation cleanup failure')
    }
  })
  const server = new Server({
    seed: b4a.alloc(32, 0x53),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const internal = serverInternals(server)
  const upload = makeUpload(ownerKey, 'retry-revocation.bin')
  await internal.sessionStore.offer(ownerKey, upload.offer)
  sessionPath = path.join(internal.layout.sessions, `${hex(upload.offer.transferId)}.json`)
  armed = true

  let firstFailure: CaughtError | null = null
  try {
    await server.reloadAllowlist([])
  } catch (err) {
    firstFailure = err as CaughtError
  }
  t.is(firstFailure!.name, 'AggregateError')
  t.alike(server.allowedKeys, new Set())
  t.is(internal.pendingRevocations.size, 1)
  t.is(internal.sessionStore.sessions.size, 1)

  await server.reloadAllowlist([])

  t.is(failures, 1)
  t.is(internal.pendingRevocations.size, 0)
  t.is(internal.sessionStore.sessions.size, 0)
  t.alike(await fs.promises.readdir(internal.layout.sessions), [])
  t.alike(await fs.promises.readdir(internal.layout.staging), [])
})
