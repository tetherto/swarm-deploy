/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import { ERRORS, Server, SwarmDeployError, keyPairFromSeed } from '../../dist/index.js'
import { createAbortController } from '../../dist/abort.js'
import { callbackError, hookError, HookTurns, snapshotHooks } from '../../dist/hooks.js'

const SEED = b4a.alloc(32, 0xb1)

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

function baseOptions() {
  return {
    seed: SEED,
    storageDir: '/unused',
    allowedKeys: [keyPairFromSeed(b4a.alloc(32, 0xb2)).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096
  }
}

test('ERRORS exposes a stable HOOK_FAILED code', (t) => {
  t.is(ERRORS.HOOK_FAILED, 'HOOK_FAILED')
})

test('snapshotHooks treats null and undefined as no hooks', (t) => {
  for (const value of [null, undefined]) {
    const snapshot = snapshotHooks(value)
    t.is(Object.isFrozen(snapshot), true)
    t.alike(Object.keys(snapshot), [])
  }
})

test('snapshotHooks rejects non-object hook containers', (t) => {
  for (const value of [7, 'hooks', true, () => {}]) {
    t.exception(() => snapshotHooks(value as never), { code: ERRORS.PROTOCOL_INVALID })
  }
})

test('snapshotHooks rejects non-function and unknown callbacks', (t) => {
  for (const name of ['beforeCommit', 'afterCommit', 'onFailure']) {
    for (const value of [1, 'run', {}, [], true, null]) {
      t.exception(() => snapshotHooks({ [name]: value } as never), {
        code: ERRORS.PROTOCOL_INVALID
      })
    }
  }
  t.exception(() => snapshotHooks({ afterComit() {} } as never), { code: ERRORS.PROTOCOL_INVALID })
})

test('snapshotHooks keeps function references, binds no receiver, and ignores later mutation', (t) => {
  const receivers: unknown[] = []
  const beforeCommit = function (this: unknown): void {
    receivers.push(this)
  }
  const afterCommit = (): void => {}
  const original = { beforeCommit, afterCommit }
  const snapshot = snapshotHooks(original)

  original.beforeCommit = () => {
    throw new Error('replacement must not run')
  }
  delete (original as { afterCommit?: unknown }).afterCommit
  ;(original as { onFailure?: unknown }).onFailure = () => {}

  t.is(snapshot.beforeCommit, beforeCommit)
  t.is(snapshot.afterCommit, afterCommit)
  t.is(snapshot.onFailure, undefined)
  t.is(Object.isFrozen(snapshot), true)
  t.is(snapshot === (original as unknown), false)
  t.is(
    Reflect.set(snapshot, 'beforeCommit', () => {}),
    false,
    'frozen snapshot rejects replacement'
  )
  t.is(snapshot.beforeCommit, beforeCommit)
})

test('snapshotHooks reads each accessor exactly once', (t) => {
  let reads = 0
  const hook = (): void => {}
  const snapshot = snapshotHooks({
    get beforeCommit() {
      reads++
      return hook
    }
  })
  t.is(reads, 1)
  t.is(snapshot.beforeCommit, hook)
})

test('snapshotHooks accepts afterLink as a validated, frozen callback', (t) => {
  const afterLink = (): void => {}
  const snapshot = snapshotHooks({ afterLink })
  t.is(snapshot.afterLink, afterLink)
  t.alike(Object.keys(snapshot), ['afterLink'])
  t.is(Object.isFrozen(snapshot), true)
  for (const value of [1, 'run', {}, [], true, null]) {
    t.exception(() => snapshotHooks({ afterLink: value } as never), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  t.exception(() => snapshotHooks({ afterLinks() {} } as never), { code: ERRORS.PROTOCOL_INVALID })
})

test('hookError names the afterLink phase without callback text', (t) => {
  const cause = new Error('publisher token sk-secret rejected')
  const error = hookError('afterLink', cause)
  t.is(error.code, ERRORS.HOOK_FAILED)
  t.is(error.message, 'Deployment hook failed during afterLink')
  t.is(callbackError(error), cause)
})

test('HookTurns runs one key first in, first out and never overlaps, while other keys proceed', async (t) => {
  const turns = new HookTurns()
  const { signal } = createAbortController()
  const first = turns.reserve('latest')
  const second = turns.reserve('latest')
  const third = turns.reserve('latest')
  const other = turns.reserve('stable')
  t.is(turns.size, 2)

  t.is(await first.ready(signal), 'ready')
  t.is(await other.ready(signal), 'ready', 'another key never waits')
  const order: string[] = []
  const secondReady = second.ready(signal).then(() => order.push('second'))
  const thirdReady = third.ready(signal).then(() => order.push('third'))
  await tick()
  t.alike(order, [], 'later turns wait for the earlier one')

  first.release()
  first.release()
  await secondReady
  await tick()
  t.alike(order, ['second'], 'the third turn still waits for the second')
  second.release()
  await thirdReady
  t.alike(order, ['second', 'third'])

  third.release()
  other.release()
  await tick()
  t.is(turns.size, 0, 'drained lines are dropped')
})

test('HookTurns wait settles as aborted, and a released or aborted turn cannot jump the line', async (t) => {
  const turns = new HookTurns()
  const controller = createAbortController()
  const first = turns.reserve('latest')
  const second = turns.reserve('latest')
  const third = turns.reserve('latest')
  await first.ready(controller.signal)

  const secondReady = second.ready(controller.signal)
  controller.abort()
  t.is(await secondReady, 'aborted')

  let thirdRan = false
  const live = createAbortController()
  const thirdReady = third.ready(live.signal).then(() => {
    thirdRan = true
  })
  second.release()
  await tick()
  t.is(thirdRan, false, 'releasing an earlier turn does not skip the running one')
  first.release()
  await thirdReady
  t.is(thirdRan, true)
  third.release()
  await tick()
  t.is(turns.size, 0)
})

test('hookError returns a stable HOOK_FAILED error that keeps the cause', (t) => {
  const cause = new Error('secret-bearing hook detail')
  const error = hookError('afterCommit', cause)
  t.ok(error instanceof SwarmDeployError)
  t.is(error.code, ERRORS.HOOK_FAILED)
  t.is(error.cause, cause)
  t.absent(error.message.includes('secret-bearing'))
  t.ok(error.message.includes('afterCommit'))
})

test('Server validates and snapshots hooks at construction', (t) => {
  t.exception(() => new Server({ ...baseOptions(), hooks: { afterCommit: 3 as never } }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => new Server({ ...baseOptions(), hooks: 'nope' as never }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.execution(() => new Server({ ...baseOptions(), hooks: null }))

  const hooks = { afterCommit: () => {} }
  const afterCommit = hooks.afterCommit
  const server = new Server({ ...baseOptions(), hooks })
  hooks.afterCommit = () => {
    throw new Error('replacement must not run')
  }
  t.is(server.hooks.afterCommit, afterCommit)
  t.is(Object.isFrozen(server.hooks), true)
})

test('callbackError unwraps only errors created by hookError', (t) => {
  const raw = new Error('callback failure')
  t.is(callbackError(hookError('beforeCommit', raw)), raw)
  t.is(callbackError(hookError('afterCommit', undefined)), undefined)

  const lookalike = new SwarmDeployError(ERRORS.HOOK_FAILED, 'forged', raw)
  t.is(callbackError(lookalike), lookalike)
  const ordinary = new SwarmDeployError(ERRORS.COMMIT_FAILED, 'plain', raw)
  t.is(callbackError(ordinary), ordinary)
  t.is(callbackError('text'), 'text')
})
