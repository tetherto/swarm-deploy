/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import { ERRORS, Server, SwarmDeployError, keyPairFromSeed } from '../../dist/index.js'
import { hookError, snapshotHooks } from '../../dist/hooks.js'

const SEED = b4a.alloc(32, 0xb1)

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
