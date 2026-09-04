/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import path from '#path'
import { EventEmitter } from '#events'
import { Client, ERRORS, keyPairFromSeed, topicFromServerPublicKey } from '../../dist/index.js'
import type { Swarm } from '../../dist/types.js'
import {
  blockManifestAfterFirstRead,
  settledError,
  settlePromptly
} from '../helpers/cancellation.js'
import { CHUNK_SIZE, createTempDir, writeDeterministicFile } from '../helpers/files.js'

const SERVER_SEED = b4a.alloc(32, 71)
const CLIENT_SEED = b4a.alloc(32, 72)

/** A swarm whose discovery flush never settles, so close must abort it. */
interface StalledSwarm extends Swarm {
  destroyed: boolean
}

/**
 * The private client members these cancellation tests observe or replace. The
 * production surface keeps them private, so the harness names them explicitly.
 */
interface ClientInternals {
  _ensureStarted(): Promise<unknown>
  _delay(milliseconds: number): Promise<unknown>
  _uploadManifest(...args: unknown[]): Promise<unknown>
  swarm: unknown
  sessions: { size: number }
  sockets: { size: number }
}

interface FakeTimer {
  callback: () => void
}

function internals(client: Client): ClientInternals {
  return client as unknown as ClientInternals
}

function createStalledSwarm(): StalledSwarm {
  const swarm = new EventEmitter() as unknown as StalledSwarm
  swarm.destroyed = false
  swarm.join = () => ({ flushed: () => new Promise<never>(() => {}) })
  swarm.destroy = () => {
    swarm.destroyed = true
  }
  return swarm
}

test('Client close aborts a stalled discovery flush and destroys its swarm', async (t) => {
  const swarm = createStalledSwarm()
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(keyPairFromSeed(SERVER_SEED).publicKey),
    swarmFactory: () => swarm
  })
  const starting = internals(client)._ensureStarted()
  await new Promise((resolve) => setTimeout(resolve, 0))

  await client.close()
  await t.exception(() => starting, { name: 'SwarmDeployError', code: 'ABORTED' })
  t.ok(swarm.destroyed)
})

test('Client close rejects a pending reconnect delay and clears its timer', async (t) => {
  const timers = new Set<FakeTimer>()
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(keyPairFromSeed(SERVER_SEED).publicKey),
    scheduler: {
      setTimeout(callback) {
        const timer = { callback }
        timers.add(timer)
        return timer
      },
      clearTimeout(timer) {
        timers.delete(timer as FakeTimer)
      }
    }
  })
  const delayed = internals(client)._delay(30_000)
  await client.close()

  await t.exception(() => delayed, { name: 'SwarmDeployError', code: 'ABORTED' })
  t.is(timers.size, 0)
})

test('Client close stops directory processing during the first active hash', async (t) => {
  const source = await createTempDir(t)
  const firstPath = path.join(source, 'a-first.bin')
  const laterPath = path.join(source, 'b-later.bin')
  await writeDeterministicFile(firstPath, 4 * CHUNK_SIZE)
  await writeDeterministicFile(laterPath, CHUNK_SIZE)
  const blocked = blockManifestAfterFirstRead(t, firstPath)
  let uploadStarts = 0
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(keyPairFromSeed(SERVER_SEED).publicKey),
    swarmFactory() {
      throw new Error('networking must not start while the first hash is blocked')
    }
  })
  const client_ = internals(client)
  const originalUploadManifest = client_._uploadManifest.bind(client_)
  client_._uploadManifest = (...args: unknown[]) => {
    uploadStarts++
    return originalUploadManifest(...args)
  }
  const batch = client.upload(source)

  await blocked.started
  t.is(blocked.state.reads, 1)
  t.absent(blocked.state.openPaths.includes(laterPath))
  const closing = client.close()
  const [batchResult, closeResult] = await settlePromptly([batch, closing, blocked.streamClosed])

  t.is(batchResult.status, 'rejected')
  t.is(settledError(batchResult).name, 'SwarmDeployError')
  t.is(settledError(batchResult).code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.absent(blocked.state.openPaths.includes(laterPath))
  t.absent(blocked.state.readPaths.includes(laterPath))
  t.is(uploadStarts, 0)
  t.is(client_.sessions.size, 0)
  t.is(client_.sockets.size, 0)
  t.is(client_.swarm, null)
  t.ok(blocked.state.streamClosed)
  t.ok(blocked.state.descriptorCloseAttempted)
  await t.exception(() => blocked.state.descriptor!.stat!(), { code: 'EBADF' })
})

test('Client close rejects an active upload and its queued successor before startup', async (t) => {
  const source = await createTempDir(t)
  const firstPath = path.join(source, 'a-active.bin')
  const queuedPath = path.join(source, 'b-queued.bin')
  await writeDeterministicFile(firstPath, 4 * CHUNK_SIZE)
  await writeDeterministicFile(queuedPath, CHUNK_SIZE)
  const blocked = blockManifestAfterFirstRead(t, firstPath)
  let swarmStarts = 0
  let uploadStarts = 0
  const client = new Client({
    seed: CLIENT_SEED,
    topic: topicFromServerPublicKey(keyPairFromSeed(SERVER_SEED).publicKey),
    swarmFactory() {
      swarmStarts++
      return createStalledSwarm()
    }
  })
  const client_ = internals(client)
  const originalUploadManifest = client_._uploadManifest.bind(client_)
  client_._uploadManifest = (...args: unknown[]) => {
    uploadStarts++
    return originalUploadManifest(...args)
  }
  const active = client.upload(firstPath)
  const queued = client.upload(queuedPath)

  await blocked.started
  t.absent(blocked.state.lstatPaths.includes(queuedPath))
  const closing = client.close()
  const [activeResult, queuedResult, closeResult] = await settlePromptly([
    active,
    queued,
    closing,
    blocked.streamClosed
  ])

  for (const result of [activeResult, queuedResult]) {
    t.is(result.status, 'rejected')
    t.is(settledError(result).name, 'SwarmDeployError')
    t.is(settledError(result).code, ERRORS.ABORTED)
  }
  t.is(closeResult.status, 'fulfilled')
  t.absent(blocked.state.lstatPaths.includes(queuedPath))
  t.absent(blocked.state.openPaths.includes(queuedPath))
  t.absent(blocked.state.readPaths.includes(queuedPath))
  t.is(swarmStarts, 0)
  t.is(uploadStarts, 0)
  t.is(client_.sessions.size, 0)
  t.is(client_.sockets.size, 0)
  t.is(client_.swarm, null)
  t.ok(blocked.state.streamClosed)
  t.ok(blocked.state.descriptorCloseAttempted)
  await t.exception(() => blocked.state.descriptor!.stat!(), { code: 'EBADF' })
})
