'use strict'

const test = require('brittle')
const b4a = require('b4a')
const path = require('#path')
const { EventEmitter } = require('#events')
const { Client, ERRORS, keyPairFromSeed } = require('../..')
const { blockManifestAfterFirstRead, settlePromptly } = require('../helpers/cancellation')
const { CHUNK_SIZE, createTempDir, writeDeterministicFile } = require('../helpers/files')

const SERVER_SEED = b4a.alloc(32, 71)
const CLIENT_SEED = b4a.alloc(32, 72)

function createStalledSwarm() {
  const swarm = new EventEmitter()
  swarm.destroyed = false
  swarm.join = () => ({ flushed: () => new Promise(() => {}) })
  swarm.destroy = async () => {
    swarm.destroyed = true
  }
  return swarm
}

test('Client close aborts a stalled discovery flush and destroys its swarm', async (t) => {
  const swarm = createStalledSwarm()
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    swarmFactory: () => swarm
  })
  const starting = client._ensureStarted()
  await new Promise((resolve) => setTimeout(resolve, 0))

  await client.close()
  await t.exception(() => starting, { name: 'SwarmDeployError', code: 'ABORTED' })
  t.ok(swarm.destroyed)
})

test('Client close rejects a pending reconnect delay and clears its timer', async (t) => {
  const timers = new Set()
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    scheduler: {
      setTimeout(callback) {
        const timer = { callback }
        timers.add(timer)
        return timer
      },
      clearTimeout(timer) {
        timers.delete(timer)
      }
    }
  })
  const delayed = client._delay(30_000)
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
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    swarmFactory() {
      throw new Error('networking must not start while the first hash is blocked')
    }
  })
  const originalUploadManifest = client._uploadManifest.bind(client)
  client._uploadManifest = async (...args) => {
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
  t.is(batchResult.reason.name, 'SwarmDeployError')
  t.is(batchResult.reason.code, ERRORS.ABORTED)
  t.is(closeResult.status, 'fulfilled')
  t.absent(blocked.state.openPaths.includes(laterPath))
  t.absent(blocked.state.readPaths.includes(laterPath))
  t.is(uploadStarts, 0)
  t.is(client.sessions.size, 0)
  t.is(client.sockets.size, 0)
  t.is(client.swarm, null)
  t.ok(blocked.state.streamClosed)
  t.ok(blocked.state.descriptorCloseAttempted)
  await t.exception(() => blocked.state.descriptor.stat(), { code: 'EBADF' })
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
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    swarmFactory() {
      swarmStarts++
      return createStalledSwarm()
    }
  })
  const originalUploadManifest = client._uploadManifest.bind(client)
  client._uploadManifest = async (...args) => {
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
    t.is(result.reason.name, 'SwarmDeployError')
    t.is(result.reason.code, ERRORS.ABORTED)
  }
  t.is(closeResult.status, 'fulfilled')
  t.absent(blocked.state.lstatPaths.includes(queuedPath))
  t.absent(blocked.state.openPaths.includes(queuedPath))
  t.absent(blocked.state.readPaths.includes(queuedPath))
  t.is(swarmStarts, 0)
  t.is(uploadStarts, 0)
  t.is(client.sessions.size, 0)
  t.is(client.sockets.size, 0)
  t.is(client.swarm, null)
  t.ok(blocked.state.streamClosed)
  t.ok(blocked.state.descriptorCloseAttempted)
  await t.exception(() => blocked.state.descriptor.stat(), { code: 'EBADF' })
})
