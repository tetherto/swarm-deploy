/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import { EventEmitter } from '#events'
import Hyperswarm from 'hyperswarm'
import { Server, keyPairFromSeed, transferId, ERRORS } from '../../dist/index.js'
import type { ServerOptions } from '../../dist/server.js'
import type { Offer } from '../../dist/protocol/types.js'
import type { ErrorCode } from '../../dist/errors.js'
import type { SwarmDiscovery } from '../../dist/types.js'
import { initLayout } from '../../dist/storage/layout.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'
import { createLocalTestnet } from '../helpers/testnet.js'
import { settledError, settlePromptly } from '../helpers/cancellation.js'
import {
  serverInternals,
  type ConnectableSocket,
  type TrackedConnection,
  type TrackedSocket
} from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 0x71)
const CLIENT_SEED = b4a.alloc(32, 0x72)
const CHUNK_SIZE = 1024 * 1024

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

interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
}

/**
 * A live Hyperswarm transport as the rejection branches observe it: the error
 * listener count is inspected around the destroy the server performs.
 */
interface RejectedSocket extends ConnectableSocket {
  listenerCount(event: string): number
  emit(event: string, ...args: unknown[]): boolean
  destroy(error?: unknown): void
}

interface RejectionRecord {
  socket: RejectedSocket
  error: { code?: ErrorCode }
  before: number
  atDestroy: number
}

/** The swarm seam replacement: an emitter plus the two methods used. */
interface StubSwarm extends EventEmitter {
  join(): SwarmDiscovery
  destroy(): Promise<void>
}

/** The cleanup payload this suite filters on. */
interface CleanupEvent {
  reason?: string
}

function sha256(bytes: Uint8Array): Buffer {
  return crypto.createHash('sha256').update(bytes).digest()
}

function hex(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'hex')
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function uploadFor(ownerKey: Uint8Array, name = 'offline-revocation.bin'): HarnessUpload {
  const data = b4a.from('persisted partial upload')
  const digest = sha256(data)
  const id = transferId({
    clientPublicKey: ownerKey,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE
  })
  const offer: Offer = {
    version: 1,
    transferId: id,
    name,
    size: data.byteLength,
    digest,
    chunkSize: CHUNK_SIZE,
    chunkCount: 1
  }
  return {
    offer,
    chunk: { transferId: id, index: 0, digest, data }
  }
}

function stubSwarm(events: string[] = []): StubSwarm {
  const swarm = new EventEmitter() as StubSwarm
  swarm.join = () => {
    events.push('join')
    return {
      async flushed() {
        events.push('flushed')
      },
      async destroy() {
        events.push('discovery-destroy')
      }
    }
  }
  swarm.destroy = async () => {
    events.push('swarm-destroy')
  }
  return swarm
}

test('real Hyperswarm rejection branches install socket errors before destroy', async (t) => {
  const testnet = await createLocalTestnet(t)
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const modes: Array<[string, ErrorCode]> = [
    ['closed', ERRORS.AUTH_REJECTED],
    ['newly-revoked', ERRORS.AUTH_REJECTED],
    ['capacity', ERRORS.FILE_BUSY]
  ]

  for (let index = 0; index < modes.length; index++) {
    const [mode, expectedCode] = modes[index]
    const reached = deferred<RejectionRecord>()
    let firewallAttempts = 0
    const server = new Server({
      seed: b4a.alloc(32, 0x73 + index),
      storageDir: await createTempDir(t),
      allowedKeys: [ownerKey],
      maxFileBytes: CHUNK_SIZE,
      maxStagingBytes: CHUNK_SIZE,
      maxConnections: 1,
      maxActiveUploads: 1,
      minFreeBytes: 0,
      dht: testnet.createNode()
    })
    const internal = serverInternals(server)
    const originalFirewall = internal._firewall.bind(server)
    internal._firewall = (key) => {
      if (b4a.equals(key as Uint8Array, ownerKey)) firewallAttempts++
      return originalFirewall(key)
    }
    const originalConnection = internal._onConnection.bind(server)
    internal._onConnection = (candidate, peerInfo) => {
      const socket = candidate as RejectedSocket
      const before = socket.listenerCount('error')
      const destroy = socket.destroy.bind(socket)
      socket.destroy = (error) => {
        const atDestroy = socket.listenerCount('error')
        destroy()
        reached.resolve({ socket, error: error as { code?: ErrorCode }, before, atDestroy })
      }
      if (mode === 'closed') server.closed = true
      if (mode === 'newly-revoked') internal._allowlist.delete(hex(ownerKey))
      // The capacity branch only reads `_connections.size`, so the occupying
      // entries stay the same opaque placeholders as in the untyped harness.
      if (mode === 'capacity') {
        internal._connections.set(
          { occupied: true } as unknown as TrackedSocket,
          {} as TrackedConnection
        )
      }
      originalConnection(socket, peerInfo)
      if (mode === 'closed') server.closed = false
      if (mode === 'capacity') internal._connections.clear()
    }
    await server.listen()

    const client = new Hyperswarm({
      dht: testnet.createNode(),
      keyPair: keyPairFromSeed(CLIENT_SEED)
    })
    const discovery = client.join(server.topic, { server: false, client: true })
    await discovery.flushed()
    const rejected = await reached.promise

    t.is(rejected.error.code, expectedCode, `${mode} rejection code`)
    t.ok(firewallAttempts > 0, `${mode} passed through the real firewall`)
    t.ok(rejected.atDestroy > rejected.before, `${mode} installed a safe error listener`)
    t.is(internal._sessions.size, 0, `${mode} opened no protocol session`)
    rejected.socket.emit('error', new Error(`${mode} late socket error`))
    t.pass(`${mode} process remained alive after socket error`)

    await client.destroy()
    await server.close()
  }
})

test('restart purges offline-revoked resumable state before networking', async (t) => {
  const storageDir = await createTempDir(t)
  const configDir = await createTempDir(t)
  const allowlistPath = path.join(configDir, 'allowlist')
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const upload = uploadFor(ownerKey)
  await fs.promises.writeFile(allowlistPath, `${hex(ownerKey)}\n`)

  const options = {
    seed: SERVER_SEED,
    storageDir,
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    allowlistPath,
    swarmFactory: () => stubSwarm()
  }
  const first = new Server({ ...options, allowedKeys: [ownerKey] })
  const firstInternal = serverInternals(first)
  await first.listen()
  await firstInternal.sessionStore.offer(ownerKey, upload.offer)
  await firstInternal.sessionStore.writeChunk(upload.offer.transferId, upload.chunk)
  await first.close()

  await fs.promises.writeFile(allowlistPath, '')
  const restarted = new Server({ ...options, allowedKeys: [] })
  const restartedInternal = serverInternals(restarted)
  await restarted.listen()
  t.is(restartedInternal.sessionStore.sessions.size, 0)
  t.is(restartedInternal.sessionStore.reservedBytes, 0)
  t.alike(await fs.promises.readdir(restartedInternal.layout.sessions), [])
  t.alike(await fs.promises.readdir(restartedInternal.layout.staging), [])
  await restarted.close()

  await fs.promises.writeFile(allowlistPath, `${hex(ownerKey)}\n`)
  const reallowed = new Server({ ...options, allowedKeys: [ownerKey] })
  await reallowed.listen()
  const offered = await serverInternals(reallowed).sessionStore.offer(ownerKey, upload.offer)
  t.is(offered.resumed, false)
  await reallowed.close()
})

test('Server retires corrupt journal orphan staging before networking', async (t) => {
  const storageDir = await createTempDir(t)
  const layout = initLayout(storageDir)
  const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
  const corrupt = uploadFor(ownerKey, 'corrupt-orphan-startup.bin')
  const valid = uploadFor(ownerKey, 'valid-resume-startup.bin')
  let crashAfterSessionUnlink = false
  const storage = createStorage({
    afterOperation(name, filePath) {
      if (
        crashAfterSessionUnlink &&
        name === 'unlink' &&
        path.basename(filePath) === `${hex(corrupt.offer.transferId)}.json`
      ) {
        crashAfterSessionUnlink = false
        throw new Error('Injected crash after session unlink')
      }
    }
  })
  const sessions = new SessionStore({
    layout,
    maxStagingBytes: 2 * CHUNK_SIZE,
    checkpointChunks: 1,
    storage
  })
  await sessions.init()
  await sessions.offer(ownerKey, corrupt.offer)
  await sessions.writeChunk(corrupt.offer.transferId, corrupt.chunk)
  await sessions.finish(corrupt.offer.transferId)
  await sessions.offer(ownerKey, valid.offer)
  const commits = new CommitStore({ layout, storage })
  crashAfterSessionUnlink = true
  await commits.commit(sessions.sessions.get(hex(corrupt.offer.transferId))!)
  await fs.promises.writeFile(
    path.join(layout.journals, `${hex(corrupt.offer.transferId)}.json`),
    '{corrupt'
  )
  await sessions.close()

  const lifecycle: string[] = []
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [ownerKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: 2 * CHUNK_SIZE,
    minFreeBytes: 0,
    swarmFactory() {
      lifecycle.push('network')
      return stubSwarm()
    }
  })
  server.on('cleanup', (event: CleanupEvent) => {
    if (event.reason === 'corrupt-journal') lifecycle.push('cleanup')
  })
  await server.listen()

  t.alike(lifecycle, ['cleanup', 'network'])
  t.is(serverInternals(server).sessionStore.sessions.has(hex(valid.offer.transferId)), true)
  const journalNames = await fs.promises.readdir(layout.journals)
  t.is(journalNames.length, 1)
  t.ok(journalNames[0].startsWith(`.${hex(corrupt.offer.transferId)}.corrupt-`))
  t.is(
    (await fs.promises.readdir(layout.staging)).includes(`${hex(corrupt.offer.transferId)}.part`),
    false
  )
  t.is(
    (await fs.promises.readdir(layout.staging)).includes(`${hex(valid.offer.transferId)}.part`),
    true
  )
  await server.close()
})

test('Server close aborts a never-resolving discovery flush and releases resources', async (t) => {
  const storageDir = await createTempDir(t)
  const joined = deferred()
  const events: string[] = []
  const swarm = new EventEmitter() as StubSwarm
  const discovery: SwarmDiscovery = {
    flushed() {
      joined.resolve()
      return new Promise(() => {})
    },
    async destroy() {
      events.push('discovery-destroy')
    }
  }
  swarm.join = () => discovery
  swarm.destroy = async () => {
    events.push('swarm-destroy')
  }
  const options: ServerOptions = {
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0
  }
  const server = new Server({ ...options, swarmFactory: () => swarm })
  const internal = serverInternals(server)
  const starting = server.listen()
  await joined.promise
  const retention = internal.retentionManager
  const closing = server.close()

  t.ok(events.includes('discovery-destroy'), 'close synchronously starts discovery cancellation')
  t.ok(events.includes('swarm-destroy'), 'close synchronously starts swarm cancellation')
  const [startResult, closeResult] = await settlePromptly([starting, closing])
  t.is(startResult.status, 'rejected')
  t.is(settledError(startResult).code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.is(server.listening, false)
  t.is(internal.swarm, null)
  t.is(internal.discovery, null)
  // `close()` clears the store, so the closed-state expectation is nullable.
  t.is<SessionStore | null>(internal.sessionStore, null)
  t.is(internal._connections.size, 0)
  t.is(internal._sessions.size, 0)
  t.is(retention.timer, null)

  const recovered = new Server({ ...options, swarmFactory: () => stubSwarm() })
  await recovered.listen()
  await recovered.close()
})

test('Server close during storage startup prevents later swarm announcement', async (t) => {
  const entered = deferred()
  const release = deferred()
  let blocked = false
  let swarmCreations = 0
  const storage = createStorage({
    async beforeOperation(operation, filePath) {
      if (blocked || operation !== 'readdir' || !filePath.endsWith('/sessions')) return
      blocked = true
      entered.resolve()
      await release.promise
    }
  })
  const storageDir = await createTempDir(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: CHUNK_SIZE,
    maxStagingBytes: CHUNK_SIZE,
    minFreeBytes: 0,
    storage,
    swarmFactory() {
      swarmCreations++
      return stubSwarm()
    }
  })
  const starting = server.listen()
  await entered.promise
  const closing = server.close()
  release.resolve()
  const [startResult, closeResult] = await settlePromptly([starting, closing])

  t.is(startResult.status, 'rejected')
  t.is(settledError(startResult).code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.is(swarmCreations, 0)
  t.is(server.listening, false)
})
