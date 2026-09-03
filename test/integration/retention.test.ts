/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import createTestnet from 'hyperdht/testnet'
import { Client, Server, keyPairFromSeed, transferId } from '../../dist/index.js'
import { ClientSession } from '../../dist/protocol/client-session.js'
import { initLayout } from '../../dist/storage/layout.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { RetentionManager, DEFAULT_RESUME_TTL } from '../../dist/storage/retention.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import type { Offer } from '../../dist/protocol/types.js'
import { createClock, type TestClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import {
  clientInternals,
  serverInternals,
  watcherInternals,
  type WatcherInternals
} from '../helpers/internals.js'

const OWNER = b4a.alloc(32, 0x61)
const SERVER_SEED = b4a.alloc(32, 0x62)
const CLIENT_SEED = b4a.alloc(32, 0x63)
const CHUNK_SIZE = 1024 * 1024

/** Errno-bearing failure surfaced by the `lstat` existence probe. */
interface ErrnoError extends Error {
  code?: string
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

type RetentionSession = Parameters<
  ConstructorParameters<typeof RetentionManager>[0]['isSessionActive']
>[0]

/** Retention only sees session state; the harness keys activity off the id. */
interface ActivitySession extends RetentionSession {
  id: string
}

/** Only the retention knobs these scenarios override. */
interface RetentionOverrides {
  maxAge?: number
  maxStorageBytes?: number
  resumeTtl?: number
}

interface Stores {
  layout: StorageLayout
  clock: TestClock
  sessionStore: SessionStore
  commitStore: CommitStore
  manager: RetentionManager
  setActive(id: string | null): void
}

interface CommittedArtifact {
  upload: HarnessUpload
  record: CommitRecord
  finalPath: string
}

/** The source descriptor the lifecycle assertions probe after close. */
interface SourceHandle {
  stat(): Promise<unknown>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown>
}

/** The private `_openSource` hook wrapped to capture the opened descriptor. */
interface OpenSourceHost {
  file: SourceHandle | null
}

interface OpenSourcePrototype {
  _openSource(this: OpenSourceHost): Promise<void>
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function makeUpload(name: string, data: Buffer): HarnessUpload {
  const digest = sha256(data)
  const size = data.byteLength
  const id = transferId({
    clientPublicKey: OWNER,
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
    chunk: { transferId: id, index: 0, digest, data }
  }
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

async function createStores(t: Assert, options: RetentionOverrides = {}): Promise<Stores> {
  const layout = initLayout(await createTempDir(t))
  const clock = createClock()
  const sessionStore = new SessionStore({
    layout,
    maxStagingBytes: 4 * CHUNK_SIZE,
    checkpointChunks: 1,
    clock
  })
  await sessionStore.init()
  t.teardown(() => sessionStore.close())
  const commitStore = new CommitStore({ layout, clock })
  let activeId: string | null = null
  const manager = new RetentionManager({
    layout,
    sessionStore,
    commitStore,
    clock,
    isSessionActive: (session) => (session as ActivitySession).id === activeId,
    ...options
  })
  return {
    layout,
    clock,
    sessionStore,
    commitStore,
    manager,
    setActive(id) {
      activeId = id
    }
  }
}

async function commit(stores: Stores, name: string, data: Buffer): Promise<CommittedArtifact> {
  const upload = makeUpload(name, data)
  await stores.sessionStore.offer(OWNER, upload.offer)
  if (upload.offer.chunkCount > 0) {
    await stores.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  }
  await stores.sessionStore.finish(upload.offer.transferId)
  const record = await stores.commitStore.commit(
    stores.sessionStore.sessions.get(hex(upload.offer.transferId))!
  )
  await stores.sessionStore.retireCommitted(upload.offer.transferId)
  return { upload, record, finalPath: path.join(stores.layout.root, name) }
}

test('retention honors exact age and quota boundaries', async (t) => {
  const age = await createStores(t, { maxAge: 10 })
  const artifact = await commit(age, 'age.bin', b4a.from('abc'))
  age.clock.advance(9)
  t.is((await age.manager.run()).ageDeleted, 0)
  t.is(await pathExists(artifact.finalPath), true)
  age.clock.advance(1)
  t.is((await age.manager.run()).ageDeleted, 1)
  t.is(await pathExists(artifact.finalPath), false)

  const quota = await createStores(t, { maxStorageBytes: 6 })
  const alpha = await commit(quota, 'alpha.bin', b4a.from('aaa'))
  quota.clock.advance(1)
  const bravo = await commit(quota, 'bravo.bin', b4a.from('bbb'))
  t.is((await quota.manager.run()).storageDeleted, 0)
  t.is(await pathExists(alpha.finalPath), true)
  t.is(await pathExists(bravo.finalPath), true)

  const reservation = await quota.manager.run({ incomingBytes: 1 })
  t.is(reservation.storageDeleted, 1)
  t.is(await pathExists(alpha.finalPath), false)
  t.is(await pathExists(bravo.finalPath), true)
})

test('retention rotates commits but never expires an active upload', async (t) => {
  const stores = await createStores(t, {
    maxStorageBytes: 3,
    resumeTtl: DEFAULT_RESUME_TTL
  })
  const committed = await commit(stores, 'committed.bin', b4a.from('old'))
  const active = makeUpload('active.bin', b4a.from('new'))
  await stores.sessionStore.offer(OWNER, active.offer)
  const activeId = hex(active.offer.transferId)
  stores.setActive(activeId)
  stores.clock.advance(DEFAULT_RESUME_TTL + 1)

  const result = await stores.manager.run({ incomingBytes: 1 })

  t.is(result.storageDeleted, 1)
  t.is(await pathExists(committed.finalPath), false)
  t.is(stores.sessionStore.sessions.has(activeId), true)
  t.is(await pathExists(path.join(stores.layout.staging, `${activeId}.part`)), true)

  stores.setActive(null)
  t.is(await stores.manager.expireSessions(), 1)
  t.is(stores.sessionStore.sessions.has(activeId), false)
})

test('Node and Bare lifecycle closes swarms, timers, descriptors, and testnet', async (t) => {
  const testnet = await createTestnet(3)
  let server: Server | null = null
  let client: Client | null = null
  let watcher: WatcherInternals | null = null
  let retention: RetentionManager | null = null
  let serverSwarm: { destroyed: boolean } | null = null
  let clientSwarm: { destroyed: boolean } | null = null
  const opened: { sourceHandle: SourceHandle | null } = { sourceHandle: null }
  const sessionPrototype = ClientSession.prototype as unknown as OpenSourcePrototype
  const originalOpenSource = sessionPrototype._openSource
  sessionPrototype._openSource = async function (this: OpenSourceHost) {
    await originalOpenSource.call(this)
    if (this.file) opened.sourceHandle = this.file
  }
  try {
    const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
    const root = await createTempDir(t)
    const allowlist = path.join(await createTempDir(t), 'allowlist')
    await fs.promises.writeFile(allowlist, `${hex(ownerKey)}\n`)
    server = new Server({
      seed: SERVER_SEED,
      storageDir: root,
      allowedKeys: [ownerKey],
      allowlistPath: allowlist,
      maxFileBytes: CHUNK_SIZE,
      maxStagingBytes: CHUNK_SIZE,
      minFreeBytes: 0,
      cleanupInterval: 60_000,
      dht: testnet.createNode()
    })
    await server.listen()
    client = new Client({
      seed: CLIENT_SEED,
      serverPublicKey: server.publicKey,
      connectTimeout: 5_000,
      idleTimeout: 5_000,
      dht: testnet.createNode()
    })
    const source = path.join(await createTempDir(t), 'lifecycle.bin')
    await fs.promises.writeFile(source, b4a.from('close every resource'))

    const uploaded = await client.upload(source)
    t.is(uploaded.status, 'COMMITTED')
    const serverInternal = serverInternals(server)
    const clientInternal = clientInternals(client)
    watcher = watcherInternals(serverInternal.allowlistWatcher)
    retention = serverInternal.retentionManager
    serverSwarm = serverInternal.swarm
    clientSwarm = clientInternal.swarm

    await client.close()
    await server.close()

    t.is(clientInternal.swarm, null)
    t.is(clientInternal.discovery, null)
    t.is(clientInternal.sessions.size, 0)
    t.is(clientInternal.sockets.size, 0)
    t.is(clientInternal.socketWaiters.length, 0)
    t.is(clientInternal.delayWaiters.length, 0)
    t.is(serverInternal.swarm, null)
    t.is(serverInternal.sessionStore, null)
    t.is(serverInternal._connections.size, 0)
    t.is(serverInternal._sessions.size, 0)
    t.is(watcher.timer, null)
    t.is(retention.timer, null)
    t.ok(serverSwarm!.destroyed)
    t.ok(clientSwarm!.destroyed)
    await t.exception(() => opened.sourceHandle!.stat(), { code: 'EBADF' })
    await t.exception(() => opened.sourceHandle!.read(b4a.alloc(1), 0, 1, 0), { code: 'EBADF' })

    await testnet.destroy()
  } finally {
    sessionPrototype._openSource = originalOpenSource
    await Promise.allSettled([client?.close(), server?.close()])
    await testnet.destroy().catch(() => {})
  }
})
