'use strict'

const test = require('brittle')
const b4a = require('b4a')
const { EventEmitter } = require('#events')
const { Client, keyPairFromSeed } = require('../..')

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
