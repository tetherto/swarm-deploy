/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { EventEmitter } from '#events'
import {
  ERRORS,
  SwarmDeployError,
  Client,
  Server,
  keyPairFromSeed,
  transferId,
  OFFER,
  STATUS,
  BITMAP_PAGE,
  FINISH
} from '../../dist/index.js'
import { ClientSession } from '../../dist/protocol/client-session.js'
import { ServerSession } from '../../dist/protocol/server-session.js'
import type { Offer } from '../../dist/protocol/types.js'
import type { SwarmDiscovery } from '../../dist/types.js'
import { initLayout } from '../../dist/storage/layout.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { recoverStorage } from '../../dist/storage/recovery.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type TestStorage } from '../helpers/storage.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { settledError } from '../helpers/cancellation.js'
import { clientInternals, destroyServerConnections, serverInternals } from '../helpers/internals.js'

const OWNER = b4a.alloc(32, 0x41)
const OTHER_OWNER = b4a.alloc(32, 0x42)
const CHUNK_SIZE = 1024 * 1024
const GIBIBYTE = 1024 * 1024 * 1024

type CommitSession = Parameters<CommitStore['commit']>[0]

/** A transport-loss failure carries the flag the reconnect window keys on. */
interface TransportError extends SwarmDeployError {
  transport?: boolean
}

/** An out-of-space failure keeps the errno the boundaries assert on. */
interface ErrnoError extends Error {
  code?: string
}

/** A caught failure, including the cause chain the commit boundary preserves. */
interface CaughtError {
  code?: string
  cause?: { code?: string }
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

interface UploadOptions {
  name?: string
  data?: Buffer
  size?: number
  digest?: Buffer
}

/** The swarm seam replacement: an emitter plus the two methods used. */
interface StubSwarm extends EventEmitter {
  join(): SwarmDiscovery
  destroy(): Promise<void>
}

interface CreateStoreOptions {
  root?: string
  maxStagingBytes?: number
  storage?: TestStorage
  minFreeBytes?: number
}

interface CreatedStore {
  layout: StorageLayout
  store: SessionStore
}

interface SessionUnlinkFailure extends CreatedStore {
  upload: HarnessUpload
  id: string
  storage: TestStorage
  stagingPath: string
  journalPath: string
  foreignTarget?: string
}

/**
 * The `ClientSession` internals the disconnect boundaries read and drive.
 * Naming them keeps the production members private while the hooks stay typed.
 */
interface ClientSessionInternals {
  state: string
  nextMissing: number
  missing: unknown[]
  inFlight: Set<unknown>
  destroy(error?: unknown): void
}

interface ClientSessionPrototype {
  _send(this: ClientSessionInternals, index: number, value: unknown): Promise<unknown>
  _pump(this: ClientSessionInternals): Promise<unknown>
}

/** `ServerSession` is only observed by the index it just sent. */
interface ServerSessionInternals {
  state: string
}

interface ServerSessionPrototype {
  _send(
    this: ServerSessionInternals,
    index: number,
    value: unknown,
    options?: unknown
  ): Promise<unknown>
}

type ClientSendHook = (index: number, session: ClientSessionInternals) => Promise<void>
type ClientPumpHook = (session: ClientSessionInternals) => Promise<boolean | void>
type ServerSendHook = (index: number, session: ServerSessionInternals) => Promise<void>

/** Cleanup handles a boundary may return once installed. */
interface BoundaryHooks {
  beforeResume?: Promise<void>
  cleanup?(): void
}

type BoundaryControl = void | (() => void) | BoundaryHooks

interface DisconnectCase {
  name: string
  visible?: boolean
  install(trigger: () => void, releaseBoundary: Deferred): BoundaryControl
}

interface IntegrityCase {
  name: string
  upload: HarnessUpload
  mutate(upload: HarnessUpload): void
  operation: 'write' | 'finish'
  code: string
}

interface OrphanCase {
  name: string
  mutate(created: SessionUnlinkFailure): Promise<unknown>
}

/** The journal fields the orphan corpus rewrites. */
interface JournalDocument {
  transferId?: string
  sourceStagingIdentity: { ino: string }
  record: { transferId?: string }
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

function diagnosticTimeout<T>(promise: Promise<T>, label: string, timeout = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out at ${label}`)), timeout)
    })
  ]).finally(() => clearTimeout(timer))
}

function transportFailure(): TransportError {
  const error: TransportError = new SwarmDeployError(
    ERRORS.PROTOCOL_INVALID,
    'Injected transport boundary'
  )
  error.transport = true
  return error
}

function noSpace(message: string): ErrnoError {
  const error: ErrnoError = new Error(message)
  error.code = 'ENOSPC'
  return error
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(ownerKey: Uint8Array = OWNER, options: UploadOptions = {}): HarnessUpload {
  const data = options.data || b4a.from('adversarial payload')
  const name = options.name || 'adversarial.bin'
  const size = options.size ?? data.byteLength
  const digest = options.digest || sha256(data)
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
    chunkCount: size === 0 ? 0 : 1
  }
  return {
    offer,
    chunk: {
      transferId: id,
      index: 0,
      digest: sha256(data),
      data
    }
  }
}

function createStubSwarm(): StubSwarm {
  const swarm = new EventEmitter() as StubSwarm
  swarm.join = () => ({ flushed: async () => {} })
  swarm.destroy = async () => {}
  return swarm
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (err) {
    if ((err as ErrnoError).code === 'ENOENT') return false
    throw err
  }
}

async function createStore(t: Assert, options: CreateStoreOptions = {}): Promise<CreatedStore> {
  const layout = initLayout(options.root || (await createTempDir(t)))
  const store = new SessionStore({
    layout,
    maxStagingBytes: options.maxStagingBytes ?? 8 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage: options.storage,
    minFreeBytes: options.minFreeBytes
  })
  await store.init()
  t.teardown(() => store.close())
  return { layout, store }
}

async function verify(
  store: SessionStore,
  ownerKey: Uint8Array,
  upload: HarnessUpload
): Promise<CommitSession> {
  await store.offer(ownerKey, upload.offer)
  if (upload.offer.chunkCount > 0) {
    await store.writeChunk(upload.offer.transferId, upload.chunk)
  }
  await store.finish(upload.offer.transferId)
  return store.sessions.get(hex(upload.offer.transferId))!
}

async function createSessionUnlinkFailure(t: Assert, name: string): Promise<SessionUnlinkFailure> {
  let armed = false
  let sessionPath: string | null = null
  const storage = createStorage({
    async afterOperation(operation, filePath) {
      if (!armed || operation !== 'unlink' || filePath !== sessionPath) return
      armed = false
      throw new Error('Injected cleanup failure after session unlink')
    }
  })
  const root = await createTempDir(t)
  const created = await createStore(t, { root, storage })
  const upload = makeUpload(OWNER, { name })
  const session = await verify(created.store, OWNER, upload)
  const id = hex(upload.offer.transferId)
  sessionPath = path.join(created.layout.sessions, `${id}.json`)
  armed = true
  await new CommitStore({ layout: created.layout, storage }).commit(session)
  await created.store.close()
  return {
    ...created,
    upload,
    id,
    storage,
    stagingPath: path.join(created.layout.staging, `${id}.part`),
    journalPath: path.join(created.layout.journals, `${id}.json`)
  }
}

/** Splits an install result into its optional resume and cleanup handles. */
function boundaryHooks(control: BoundaryControl): BoundaryHooks | null {
  return control && typeof control !== 'function' ? control : null
}

test('path and inode attack corpus never escapes or mutates foreign targets', async (t) => {
  const created = await createStore(t)
  const attacks = [
    '/absolute.bin',
    '../escape.bin',
    'dir/file.bin',
    'dir\\file.bin',
    'nul\u0000.bin',
    'control\u0001.bin',
    'résumé.bin',
    '.hidden',
    '..',
    'a/../b'
  ]

  for (const name of attacks) {
    const upload = makeUpload(OWNER, { name })
    await t.exception(() => created.store.offer(OWNER, upload.offer), {
      name: 'SwarmDeployError',
      code: ERRORS.INVALID_FILENAME
    })
  }

  const outside = await createTempDir(t)
  const target = path.join(outside, 'target.bin')
  await fs.promises.writeFile(target, b4a.from('foreign target'))

  const symlinkUpload = makeUpload(OWNER, { name: 'symlink.bin' })
  const stagingLink = path.join(
    created.layout.staging,
    `${hex(symlinkUpload.offer.transferId)}.part`
  )
  await fs.promises.symlink(target, stagingLink)
  await t.exception(() => created.store.offer(OWNER, symlinkUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readFile(target), b4a.from('foreign target'))

  const hardlinkUpload = makeUpload(OWNER, { name: 'hardlink.bin' })
  const hardlink = path.join(created.layout.root, hardlinkUpload.offer.name)
  await fs.promises.link(target, hardlink)
  await t.exception(() => created.store.offer(OWNER, hardlinkUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(target), b4a.from('foreign target'))

  const internalRoot = await createTempDir(t)
  const internalTarget = await createTempDir(t)
  const internal = path.join(internalRoot, '.swarm-deploy')
  await fs.promises.mkdir(internal)
  await fs.promises.symlink(internalTarget, path.join(internal, 'sessions'))
  t.exception(() => initLayout(internalRoot), {
    name: 'SwarmDeployError',
    code: ERRORS.PROTOCOL_INVALID
  })
  t.alike(await fs.promises.readdir(internalTarget), [])
})

test('length, chunk hash, whole hash, and excess-byte failures publish nothing', async (t) => {
  const cases: IntegrityCase[] = [
    {
      name: 'short',
      upload: makeUpload(OWNER, { name: 'short.bin', data: b4a.from('abc'), size: 4 }),
      mutate(upload) {
        upload.chunk.data = b4a.from('abc')
      },
      operation: 'write',
      code: ERRORS.PROTOCOL_INVALID
    },
    {
      name: 'excess',
      upload: makeUpload(OWNER, { name: 'excess.bin', data: b4a.from('abcd'), size: 3 }),
      mutate(upload) {
        upload.chunk.data = b4a.from('abcd')
      },
      operation: 'write',
      code: ERRORS.PROTOCOL_INVALID
    },
    {
      name: 'chunk digest',
      upload: makeUpload(OWNER, { name: 'chunk-hash.bin' }),
      mutate(upload) {
        upload.chunk.digest = b4a.alloc(32)
      },
      operation: 'write',
      code: ERRORS.CHECKSUM_MISMATCH
    },
    {
      name: 'whole digest',
      upload: makeUpload(OWNER, {
        name: 'whole-hash.bin',
        digest: b4a.alloc(32)
      }),
      mutate() {},
      operation: 'finish',
      code: ERRORS.CHECKSUM_MISMATCH
    }
  ]

  for (const entry of cases) {
    const created = await createStore(t)
    await created.store.offer(OWNER, entry.upload.offer)
    entry.mutate(entry.upload)
    if (entry.operation === 'write') {
      await t.exception(
        () => created.store.writeChunk(entry.upload.offer.transferId, entry.upload.chunk),
        { name: 'SwarmDeployError', code: entry.code },
        entry.name
      )
    } else {
      await created.store.writeChunk(entry.upload.offer.transferId, entry.upload.chunk)
      await t.exception(() => created.store.finish(entry.upload.offer.transferId), {
        name: 'SwarmDeployError',
        code: entry.code
      })
    }
    t.is(
      await pathExists(path.join(created.layout.root, entry.upload.offer.name)),
      false,
      `${entry.name} final absent`
    )
  }
})

test('same-ID offers are idempotent while same-name races admit one transfer', async (t) => {
  const duplicateStore = await createStore(t)
  const duplicate = makeUpload()
  const duplicates = await Promise.all([
    duplicateStore.store.offer(OWNER, duplicate.offer),
    duplicateStore.store.offer(OWNER, duplicate.offer)
  ])
  t.is(duplicates.filter((snapshot) => snapshot.resumed).length, 1)
  t.is(duplicateStore.store.sessions.size, 1)

  const racingStore = await createStore(t)
  const first = makeUpload(OWNER, { name: 'race.bin', data: b4a.from('first') })
  const second = makeUpload(OTHER_OWNER, { name: 'race.bin', data: b4a.from('second') })
  const raced = await Promise.allSettled([
    racingStore.store.offer(OWNER, first.offer),
    racingStore.store.offer(OTHER_OWNER, second.offer)
  ])
  t.is(raced.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const rejected = raced.find((outcome) => outcome.status === 'rejected')!
  t.is(settledError(rejected).code, ERRORS.FILE_BUSY)
  t.is(racingStore.store.sessions.size, 1)
})

test('disconnect boundaries resume without exposing partial uploads', async (t) => {
  const testnet = await createLocalTestnet(t)
  const clientSeed = b4a.alloc(32, 0x45)
  const ownerKey = keyPairFromSeed(clientSeed).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x46),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: 16 * CHUNK_SIZE,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()
  const internal = serverInternals(server)

  const clientPrototype = ClientSession.prototype as unknown as ClientSessionPrototype
  const serverPrototype = ServerSession.prototype as unknown as ServerSessionPrototype
  const originalClientSend = clientPrototype._send
  const originalClientPump = clientPrototype._pump
  const originalServerSend = serverPrototype._send
  let clientSendHook: ClientSendHook | null = null
  let clientPumpHook: ClientPumpHook | null = null
  let serverSendHook: ServerSendHook | null = null
  clientPrototype._send = async function (index, value) {
    if (clientSendHook) await clientSendHook(index, this)
    return originalClientSend.call(this, index, value)
  }
  clientPrototype._pump = async function () {
    if (clientPumpHook && (await clientPumpHook(this)) === false) return
    return originalClientPump.call(this)
  }
  serverPrototype._send = async function (index, value, options) {
    const sent = await originalServerSend.call(this, index, value, options)
    if (serverSendHook) await serverSendHook(index, this)
    return sent
  }
  t.teardown(() => {
    clientPrototype._send = originalClientSend
    clientPrototype._pump = originalClientPump
    serverPrototype._send = originalServerSend
  })

  const cases: DisconnectCase[] = [
    {
      name: 'before-offer',
      install(trigger) {
        clientSendHook = async (index, session) => {
          if (index !== OFFER) return
          clientSendHook = null
          trigger()
          const error = transportFailure()
          session.destroy(error)
          throw error
        }
      }
    },
    {
      name: 'after-accept',
      install(trigger) {
        serverSendHook = async (index) => {
          if (index !== STATUS) return
          serverSendHook = null
          trigger()
          destroyServerConnections(server)
        }
      }
    },
    {
      name: 'after-bitmap',
      install(trigger) {
        serverSendHook = async (index) => {
          if (index !== BITMAP_PAGE) return
          serverSendHook = null
          trigger()
          destroyServerConnections(server)
        }
      }
    },
    {
      name: 'after-ready',
      install(trigger) {
        clientPumpHook = async (session) => {
          if (session.state !== 'READY' || session.nextMissing !== 0) return
          clientPumpHook = null
          trigger()
          session.destroy(transportFailure())
          return false
        }
      }
    },
    {
      name: 'after-chunk-before-ack',
      install(trigger) {
        const original = internal.sessionStore.writeChunk
        internal.sessionStore.writeChunk = async (...args) => {
          const snapshot = await original.apply(internal.sessionStore, args)
          internal.sessionStore.writeChunk = original
          trigger()
          destroyServerConnections(server)
          return snapshot
        }
        return () => {
          internal.sessionStore.writeChunk = original
        }
      }
    },
    {
      name: 'after-ack',
      install(trigger) {
        clientPumpHook = async (session) => {
          if (
            session.state !== 'READY' ||
            session.inFlight.size !== 0 ||
            session.nextMissing !== session.missing.length
          ) {
            return
          }
          clientPumpHook = null
          trigger()
          session.destroy(transportFailure())
          return false
        }
      }
    },
    {
      name: 'before-finish',
      install(trigger) {
        clientSendHook = async (index, session) => {
          if (index !== FINISH) return
          clientSendHook = null
          trigger()
          const error = transportFailure()
          session.destroy(error)
          throw error
        }
      }
    },
    {
      name: 'during-verification',
      install(trigger, releaseBoundary) {
        const originalStorage = internal.sessionStore.storage
        const originalFinish = internal.sessionStore.finish
        const verificationSettled = deferred()
        internal.sessionStore.finish = async (...args) => {
          try {
            return await originalFinish.apply(internal.sessionStore, args)
          } finally {
            internal.sessionStore.finish = originalFinish
            verificationSettled.resolve()
          }
        }
        internal.sessionStore.storage = createStorage({
          async beforeOperation(operation, filePath) {
            if (operation !== 'read' || !filePath.endsWith('.part')) return
            internal.sessionStore.storage = originalStorage
            trigger()
            destroyServerConnections(server)
            await releaseBoundary.promise
          }
        })
        return {
          beforeResume: verificationSettled.promise,
          cleanup() {
            internal.sessionStore.finish = originalFinish
            internal.sessionStore.storage = originalStorage
          }
        }
      }
    },
    {
      name: 'after-commit-before-result',
      visible: true,
      install(trigger) {
        const original = internal.commitStore.commit
        internal.commitStore.commit = async (...args) => {
          const record = await original.apply(internal.commitStore, args)
          internal.commitStore.commit = original
          trigger()
          destroyServerConnections(server)
          return record
        }
        return () => {
          internal.commitStore.commit = original
        }
      }
    }
  ]

  for (const entry of cases) {
    const client = new Client({
      seed: clientSeed,
      topic: server.topic,
      connectTimeout: 5_000,
      idleTimeout: 5_000,
      dht: testnet.createNode()
    })
    const internalClient = clientInternals(client)
    const source = path.join(await createTempDir(t), `${entry.name}.bin`)
    const data = b4a.from(`disconnect at ${entry.name}`)
    await fs.promises.writeFile(source, data)
    const finalPath = path.join(internal.layout.root, path.basename(source))
    const triggered = deferred()
    const retryEntered = deferred()
    const releaseRetry = deferred()
    const releaseBoundary = deferred()
    const originalDelay = internalClient._delay
    let fired = false
    const control = entry.install(() => {
      if (fired) return
      fired = true
      triggered.resolve()
    }, releaseBoundary)
    const hooks = boundaryHooks(control)
    internalClient._delay = async (...args) => {
      retryEntered.resolve()
      await releaseRetry.promise
      return originalDelay.apply(internalClient, args)
    }
    const uploading = client.upload(source)
    try {
      await diagnosticTimeout(
        Promise.all([triggered.promise, retryEntered.promise]),
        entry.name,
        5_000
      )
      t.is(await pathExists(finalPath), entry.visible === true, `${entry.name} visibility`)
      if (entry.visible) t.alike(await fs.promises.readFile(finalPath), data)
      releaseBoundary.resolve()
      if (hooks?.beforeResume) {
        await diagnosticTimeout(hooks.beforeResume, `${entry.name} settle`, 5_000)
      }
      releaseRetry.resolve()
      const result = await diagnosticTimeout(uploading, `${entry.name} resume`, 10_000)
      t.ok(
        result.status === 'COMMITTED' || result.status === 'ALREADY_COMMITTED',
        `${entry.name} resumed`
      )
      t.alike(await fs.promises.readFile(finalPath), data, `${entry.name} final`)
    } finally {
      releaseBoundary.resolve()
      releaseRetry.resolve()
      internalClient._delay = originalDelay
      clientSendHook = null
      clientPumpHook = null
      serverSendHook = null
      if (typeof control === 'function') control()
      else if (hooks?.cleanup) hooks.cleanup()
      await uploading.catch(() => {})
      await client.close()
    }
  }
})

test('staging and minimum free-disk reservations reject before creating state', async (t) => {
  const staging = await createStore(t, { maxStagingBytes: 3 })
  const exact = makeUpload(OWNER, { name: 'exact.bin', data: b4a.from('abc') })
  await staging.store.offer(OWNER, exact.offer)
  const over = makeUpload(OWNER, { name: 'over.bin', data: b4a.from('x') })
  await t.exception(() => staging.store.offer(OWNER, over.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.STAGING_LIMIT
  })

  const diskStorage = createStorage()
  diskStorage.statfs = async () => ({ bavail: 10, bsize: 1 })
  const disk = await createStore(t, {
    storage: diskStorage,
    minFreeBytes: 8,
    maxStagingBytes: 100
  })
  const upload = makeUpload(OWNER, { name: 'disk.bin', data: b4a.from('abc') })
  await t.exception(() => disk.store.offer(OWNER, upload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
  t.is(disk.store.sessions.size, 0)
  t.alike(await fs.promises.readdir(disk.layout.staging), [])

  const serverOwner = keyPairFromSeed(OWNER).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x43),
    storageDir: await createTempDir(t),
    allowedKeys: [serverOwner],
    maxFileBytes: 100,
    maxStagingBytes: 100,
    minFreeBytes: 8,
    storage: diskStorage,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  const serverUpload = makeUpload(serverOwner, {
    name: 'server-disk.bin',
    data: b4a.from('abc')
  })
  await t.exception(
    () => serverInternals(server).sessionStore.offer(serverOwner, serverUpload.offer),
    {
      name: 'SwarmDeployError',
      code: ERRORS.DISK_RESERVE
    }
  )

  const unsupported = await createStore(t, {
    storage: createStorage(),
    minFreeBytes: 1,
    maxStagingBytes: 100
  })
  const unsupportedUpload = makeUpload(OWNER, {
    name: 'unsupported-disk.bin',
    data: b4a.from('x')
  })
  await t.exception(() => unsupported.store.offer(OWNER, unsupportedUpload.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
})

test('Server defaults to 1 GiB reserve and real statfs enforces both edges', async (t) => {
  const ownerKey = keyPairFromSeed(OWNER).publicKey
  const server = new Server({
    seed: b4a.alloc(32, 0x44),
    storageDir: await createTempDir(t),
    allowedKeys: [ownerKey],
    maxFileBytes: 100,
    maxStagingBytes: 100,
    swarmFactory: createStubSwarm
  })
  t.teardown(() => server.close())
  await server.listen()
  t.is(server.minFreeBytes, GIBIBYTE)
  t.is(serverInternals(server).sessionStore.minFreeBytes, GIBIBYTE)

  const admitted = await createStore(t, {
    minFreeBytes: 1,
    maxStagingBytes: 100
  })
  const accepted = makeUpload(OWNER, { name: 'real-statfs-ok.bin', data: b4a.from('x') })
  await admitted.store.offer(OWNER, accepted.offer)
  t.is(admitted.store.sessions.size, 1)

  const rejected = await createStore(t, {
    minFreeBytes: Number.MAX_SAFE_INTEGER,
    maxStagingBytes: 100
  })
  const available = await fs.promises.statfs(rejected.layout.staging)
  t.ok(BigInt(available.bavail) * BigInt(available.bsize) < BigInt(Number.MAX_SAFE_INTEGER))
  const refused = makeUpload(OWNER, { name: 'real-statfs-low.bin', data: b4a.from('x') })
  await t.exception(() => rejected.store.offer(OWNER, refused.offer), {
    name: 'SwarmDeployError',
    code: ERRORS.DISK_RESERVE
  })
  t.is(rejected.store.sessions.size, 0)
})

test('pre-publication write, sync, and link failures preserve resumable state and foreign finals', async (t) => {
  for (const failure of ['write', 'sync', 'link']) {
    let armed = false
    let layout!: StorageLayout
    let finalPath: string | null = null
    const storage = createStorage({
      async beforeOperation(name, source, destination) {
        if (!armed) return
        if (failure === 'write' && name === 'write' && source.startsWith(layout.journals)) {
          throw new Error('Injected journal write failure')
        }
        if (failure === 'sync' && name === 'sync' && source.startsWith(layout.journals)) {
          throw new Error('Injected journal sync failure')
        }
        if (failure === 'link' && name === 'link' && destination === finalPath) {
          throw new Error('Injected final link failure')
        }
      }
    })
    const created = await createStore(t, { storage })
    layout = created.layout
    const upload = makeUpload(OWNER, { name: `${failure}.bin` })
    const session = await verify(created.store, OWNER, upload)
    finalPath = path.join(layout.root, upload.offer.name)
    armed = true
    await t.exception(() => new CommitStore({ layout, storage }).commit(session))
    armed = false

    t.is(await pathExists(finalPath), false, `${failure} final absent`)
    t.is(created.store.sessions.has(hex(upload.offer.transferId)), true)
    t.is(await pathExists(path.join(layout.staging, `${hex(upload.offer.transferId)}.part`)), true)
  }

  const foreign = await createStore(t)
  const upload = makeUpload(OWNER, { name: 'foreign.bin' })
  const session = await verify(foreign.store, OWNER, upload)
  const destination = path.join(foreign.layout.root, upload.offer.name)
  await fs.promises.writeFile(destination, b4a.from('operator-owned'))
  await t.exception(() => new CommitStore({ layout: foreign.layout }).commit(session), {
    name: 'SwarmDeployError',
    code: ERRORS.FILE_EXISTS
  })
  t.alike(await fs.promises.readFile(destination), b4a.from('operator-owned'))
})

test('coded ENOSPC at staging and publication boundaries preserves safe state', async (t) => {
  for (const operation of ['write', 'sync']) {
    let armed = false
    const storage = createStorage({
      async beforeOperation(name, filePath) {
        if (!armed || name !== operation || !filePath.endsWith('.part')) return
        armed = false
        throw noSpace(`No space during staging ${operation}`)
      }
    })
    const created = await createStore(t, { storage })
    const upload = makeUpload(OWNER, { name: `staging-${operation}-enospc.bin` })
    await created.store.offer(OWNER, upload.offer)
    armed = true
    await t.exception(
      () => created.store.writeChunk(upload.offer.transferId, upload.chunk),
      { code: 'ENOSPC' },
      `staging ${operation}`
    )
    const session = created.store.sessions.get(hex(upload.offer.transferId))!
    t.is(session.state, 'receiving')
    t.is(session.verified.size, 0)
    t.is(await pathExists(path.join(created.layout.root, upload.offer.name)), false)
    t.is(await pathExists(path.join(created.layout.staging, `${session.id}.part`)), true)
  }

  for (const boundary of ['link', 'root-sync']) {
    let armed = false
    let finalPath: string | null = null
    let root: string | null = null
    const storage = createStorage({
      async beforeOperation(name, source, destination) {
        if (!armed) return
        if (boundary === 'link' && name === 'link' && destination === finalPath) {
          armed = false
          throw noSpace('No space linking final')
        }
        if (boundary === 'root-sync' && name === 'sync' && source === root) {
          armed = false
          throw noSpace('No space syncing publication directory')
        }
      }
    })
    const created = await createStore(t, { storage })
    root = created.layout.root
    const upload = makeUpload(OWNER, { name: `${boundary}-enospc.bin` })
    const session = await verify(created.store, OWNER, upload)
    finalPath = path.join(root, upload.offer.name)
    armed = true
    let failure: CaughtError | null = null
    try {
      await new CommitStore({ layout: created.layout, storage }).commit(session)
    } catch (err) {
      failure = err as CaughtError
    }
    if (boundary === 'link') {
      t.is(failure!.code, ERRORS.COMMIT_FAILED, `${boundary} typed commit failure`)
      t.is(failure!.cause!.code, 'ENOSPC', `${boundary} preserves ENOSPC cause`)
    } else {
      t.is(failure!.code, 'ENOSPC', `${boundary} preserves coded failure`)
    }
    t.is(await pathExists(finalPath), false, `${boundary} final absent`)
    t.is(created.store.sessions.has(session.id), true, `${boundary} remains resumable`)
    t.is(
      await pathExists(path.join(created.layout.staging, `${session.id}.part`)),
      true,
      `${boundary} staging retained`
    )
  }
})

test('restart converges after session unlink without exposing partial content', async (t) => {
  const created = await createSessionUnlinkFailure(t, 'restart.bin')

  const restarted = new SessionStore({
    layout: created.layout,
    maxStagingBytes: 8 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage: created.storage
  })
  t.teardown(() => restarted.close())
  await restarted.init()
  t.is(restarted.reservedBytes, created.upload.offer.size)
  const commitStore = new CommitStore({ layout: created.layout, storage: created.storage })
  const recovered = await recoverStorage({
    layout: created.layout,
    sessionStore: restarted,
    commitStore,
    logger: { warn() {} }
  })

  t.is(recovered[0].status, 'COMMITTED')
  t.alike(
    await fs.promises.readFile(path.join(created.layout.root, created.upload.offer.name)),
    created.upload.chunk.data
  )
  t.is(restarted.reservedBytes, 0)
  t.alike(await fs.promises.readdir(created.layout.staging), [])
  t.alike(await fs.promises.readdir(created.layout.sessions), [])
  t.alike(await fs.promises.readdir(created.layout.journals), [])
})

test('orphan staging requires a bounded canonical same-inode journal', async (t) => {
  const readJournal = async (filePath: string): Promise<JournalDocument> =>
    JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as JournalDocument

  const cases: OrphanCase[] = [
    {
      name: 'malformed',
      mutate: async (created) => fs.promises.writeFile(created.journalPath, '{')
    },
    {
      name: 'oversized',
      mutate: async (created) =>
        fs.promises.writeFile(created.journalPath, b4a.alloc(16 * 1024 + 1))
    },
    {
      name: 'journal symlink',
      mutate: async (created) => {
        created.foreignTarget = path.join(created.layout.root, 'foreign-journal-target')
        await fs.promises.writeFile(created.foreignTarget, 'foreign journal target')
        await fs.promises.unlink(created.journalPath)
        await fs.promises.symlink(created.foreignTarget, created.journalPath)
      }
    },
    {
      name: 'wrong top-level ID',
      mutate: async (created) => {
        const journal = await readJournal(created.journalPath)
        journal.transferId = 'f'.repeat(64)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    },
    {
      name: 'wrong staging inode',
      mutate: async (created) => {
        const journal = await readJournal(created.journalPath)
        journal.sourceStagingIdentity.ino = String(BigInt(journal.sourceStagingIdentity.ino) + 1n)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    },
    {
      name: 'foreign record',
      mutate: async (created) => {
        const journal = await readJournal(created.journalPath)
        journal.record.transferId = 'e'.repeat(64)
        await fs.promises.writeFile(created.journalPath, JSON.stringify(journal))
      }
    }
  ]

  for (const entry of cases) {
    const created = await createSessionUnlinkFailure(t, `${entry.name.replaceAll(' ', '-')}.bin`)
    await entry.mutate(created)
    const restarted = new SessionStore({
      layout: created.layout,
      maxStagingBytes: 8 * CHUNK_SIZE,
      storage: created.storage
    })
    await t.exception(
      () => restarted.init(),
      { name: 'SwarmDeployError', code: ERRORS.PROTOCOL_INVALID },
      entry.name
    )
    t.is(restarted.initialized, false, `${entry.name} not initialized`)
    t.is(restarted.reservedBytes, 0, `${entry.name} not silently admitted`)
    if (created.foreignTarget) {
      t.is(await fs.promises.readFile(created.foreignTarget, 'utf8'), 'foreign journal target')
    }
    await restarted.close()
  }
})
