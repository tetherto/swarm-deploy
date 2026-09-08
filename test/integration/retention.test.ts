/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import createTestnet from 'hyperdht/testnet'
import { Client, Server, keyPairFromSeed } from '../../dist/index.js'
import { ClientSession } from '../../dist/protocol/client-session.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { RetentionManager } from '../../dist/storage/retention.js'
import { createTempDir } from '../helpers/files.js'
import {
  clientInternals,
  serverInternals,
  watcherInternals,
  type WatcherInternals
} from '../helpers/internals.js'

const SERVER_SEED = b4a.alloc(32, 0x62)
const CLIENT_SEED = b4a.alloc(32, 0x63)
const CHUNK_SIZE = 1024 * 1024

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

test('Node and Bare lifecycle closes swarms, timers, descriptors, and testnet', async (t) => {
  const testnet = await createTestnet(3)
  t.teardown(() => testnet.destroy().catch(() => {}))
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
  t.teardown(() => {
    sessionPrototype._openSource = originalOpenSource
  })
  try {
    const ownerKey = keyPairFromSeed(CLIENT_SEED).publicKey
    const root = await createTempDir(t)
    const allowlist = path.join(await createTempDir(t), 'allowlist')
    await fs.promises.writeFile(allowlist, `${b4a.toString(ownerKey, 'hex')}\n`)
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
    t.teardown(() => server?.close())
    await server.listen()
    client = new Client({
      seed: CLIENT_SEED,
      topic: server.topic,
      connectTimeout: 5_000,
      idleTimeout: 5_000,
      dht: testnet.createNode()
    })
    t.teardown(() => client?.close())
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
    // `close()` clears the store, so the closed-state expectation is nullable.
    t.is<SessionStore | null>(serverInternal.sessionStore, null)
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
