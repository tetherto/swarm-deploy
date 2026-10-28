/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import { ERRORS, Server, SwarmDeployError, keyPairFromSeed } from '../../dist/index.js'
import { createAbortController } from '../../dist/abort.js'
import {
  callbackError,
  hookError,
  hookResultOf,
  HookTurns,
  invokeHook,
  snapshotHooks
} from '../../dist/hooks.js'
import {
  copyHookResult,
  HookResultError,
  MAX_HOOK_RESULT_BYTES,
  MAX_HOOK_RESULT_DEPTH
} from '../../dist/hook-result.js'
import {
  encodeLinkResultRecord,
  MAX_CONTROL_RECORD_BYTES
} from '../../dist/tar-protocol/controls.js'

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

test('invokeHook hands back what a callback returns or resolves to, and still yields to an abort', async (t) => {
  const controller = createAbortController()
  t.alike(await invokeHook(() => ({ id: 1 }), null, controller.signal), {
    status: 'completed',
    value: { id: 1 }
  })
  t.alike(await invokeHook(async () => 'later', null, controller.signal), {
    status: 'completed',
    value: 'later'
  })
  t.alike(await invokeHook(() => {}, null, controller.signal), {
    status: 'completed',
    value: undefined
  })
  const raw = new Error('callback failure')
  await t.exception(
    invokeHook(
      () => {
        throw raw
      },
      null,
      controller.signal
    ),
    /callback failure/
  )

  const pending = invokeHook(() => new Promise(() => {}), null, controller.signal)
  controller.abort()
  t.alike(await pending, { status: 'aborted' })
})

/** An object `depth` containers deep, the outermost being depth 1. */
function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {}
  for (let level = 1; level < depth; level++) value = { child: value }
  return value
}

/** A result whose compact JSON is exactly `bytes` bytes long. */
function sizedResult(bytes: number, character = 'x'): Record<string, string> {
  const overhead = b4a.from('{"k":""}').byteLength
  return { k: character.repeat((bytes - overhead) / b4a.from(character).byteLength) }
}

test('copyHookResult returns a fresh, equal deep copy of a plain JSON object', (t) => {
  const original = {
    id: 'sub-42',
    attempts: 3,
    ratio: 0.5,
    accepted: true,
    note: null,
    evidence: ['https://example.test/review/42', 7, { deep: [[]] }],
    nested: { empty: {}, text: 'é€😀' }
  }
  const copy = copyHookResult(original)
  t.alike(copy, original)
  t.is(JSON.stringify(copy), JSON.stringify(original))
  t.not(copy, original)
  t.not(copy.nested, original.nested)
  original.evidence.push('late')
  original.nested.text = 'changed'
  t.is((copy.evidence as unknown[]).length, 3, 'a later mutation cannot change what is sent')
  t.is((copy.nested as { text: string }).text, 'é€😀')

  t.alike(copyHookResult({}), {})
  const bare = Object.create(null) as Record<string, unknown>
  bare.ok = 1
  t.alike(copyHookResult(bare), { ok: 1 })
})

test('copyHookResult refuses everything that is not a plain JSON object', (t) => {
  class Receipt {
    id = 'x'
  }
  const sparse: unknown[] = new Array(3)
  sparse[0] = 1
  sparse[2] = 3
  const withProperty: unknown[] = [1]
  Object.assign(withProperty, { extra: true })
  const cyclicObject: Record<string, unknown> = { id: 'x' }
  cyclicObject.self = cyclicObject
  const cyclicArray: unknown[] = []
  cyclicArray.push(cyclicArray)
  const hidden = Object.defineProperty({}, 'hidden', { value: 1, enumerable: false })
  const symbolKey = { [Symbol('key')]: 1 }
  const inherited = Object.create({ id: 'x' }) as object

  const refused: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'text'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', [1]],
    ['a function', () => ({})],
    ['a symbol', Symbol('s')],
    ['a BigInt', 1n],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a class instance', new Receipt()],
    ['an inherited object', inherited],
    ['a nested undefined', { a: undefined }],
    ['a nested function', { a: () => 1 }],
    ['a nested BigInt', { a: 1n }],
    ['a nested symbol', { a: Symbol('s') }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['a nested Date', { a: new Date(0) }],
    ['a nested class instance', { a: new Receipt() }],
    ['an undefined array item', { a: [undefined] }],
    ['a sparse array', { a: sparse }],
    ['an array property', { a: withProperty }],
    ['a toJSON method', { toJSON: () => ({ leaked: true }) }],
    ['a nested toJSON method', { a: { toJSON: () => 'x' } }],
    ['a symbol key', symbolKey],
    ['a hidden property', hidden],
    ['a cyclic object', cyclicObject],
    ['a cyclic array', { a: cyclicArray }],
    ['an own __proto__ key', JSON.parse('{"__proto__":{"admin":true}}')]
  ]
  for (const [label, value] of refused) {
    t.exception(() => copyHookResult(value), HookResultError, label)
  }

  let reads = 0
  const accessor = {
    get secret() {
      reads++
      return 'sk-secret'
    }
  }
  t.exception(() => copyHookResult(accessor), HookResultError, 'a getter')
  t.exception(() => copyHookResult({ a: accessor }), HookResultError, 'a nested getter')
  t.is(reads, 0, 'a getter is never called')

  const trap = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('trap detail')
      }
    }
  )
  t.exception(() => copyHookResult(trap), /trap detail/, 'a throwing proxy is refused, not hidden')
})

test('copyHookResult enforces the depth limit', (t) => {
  t.execution(() => copyHookResult(nested(MAX_HOOK_RESULT_DEPTH)))
  t.exception(() => copyHookResult(nested(MAX_HOOK_RESULT_DEPTH + 1)), HookResultError)
  const arrays = { a: [[[[[[[1]]]]]]] } // object, then seven arrays: depth 8
  t.execution(() => copyHookResult(arrays))
  t.exception(() => copyHookResult({ a: [[[[[[[[1]]]]]]]] }), HookResultError)
})

test('copyHookResult enforces the byte limit on UTF-8 bytes of the compact JSON', (t) => {
  t.is(MAX_HOOK_RESULT_BYTES, 3 * 1024)
  t.execution(() => copyHookResult(sizedResult(MAX_HOOK_RESULT_BYTES)))
  t.exception(() => copyHookResult(sizedResult(MAX_HOOK_RESULT_BYTES + 1)), HookResultError)
  // 'é' is two bytes, so this is far fewer characters than the limit yet over it.
  const wide = sizedResult(MAX_HOOK_RESULT_BYTES, 'é')
  t.execution(() => copyHookResult(wide))
  t.exception(() => copyHookResult({ k: `${wide.k}é` }), HookResultError)
  // Escaped characters take more bytes than they have characters.
  t.exception(() => copyHookResult({ k: '"'.repeat(MAX_HOOK_RESULT_BYTES / 2) }), HookResultError)
  t.exception(
    () => copyHookResult({ list: new Array(MAX_HOOK_RESULT_BYTES).fill(1) }),
    HookResultError
  )
  // The whole record, with its fixed fields, still fits one control frame.
  const record = encodeLinkResultRecord({
    v: 1,
    status: 'UNCHANGED',
    hookResult: sizedResult(MAX_HOOK_RESULT_BYTES)
  })
  t.ok(record.byteLength <= MAX_CONTROL_RECORD_BYTES)
})

test('a refused result names a reason and a path, never a value', (t) => {
  const error = (() => {
    try {
      copyHookResult({ token: 'sk-secret-value', nested: { list: [1, 2n] } })
    } catch (caught) {
      return caught as HookResultError
    }
    throw new Error('expected a refusal')
  })()
  t.ok(error instanceof HookResultError)
  t.ok(error.message.includes('$.nested.list[1]'))
  t.absent(error.message.includes('sk-secret-value'))
})

test('hookResultOf passes undefined through and fails everything else invalid like a throw', (t) => {
  t.is(hookResultOf(undefined), undefined)
  t.alike(hookResultOf({ id: 'sub-1' }), { id: 'sub-1' })
  t.alike(hookResultOf({}), {})
  for (const returned of [null, 'ok', 7, false, [1], () => ({}), { fn: () => 1 }, nested(9)]) {
    let failure: unknown = null
    try {
      hookResultOf(returned)
    } catch (error) {
      failure = error
    }
    t.ok(failure instanceof SwarmDeployError)
    const failed = failure as SwarmDeployError
    t.is(failed.code, ERRORS.HOOK_FAILED)
    t.is(failed.message, 'Deployment hook failed during afterLink')
    t.ok(callbackError(failure) instanceof HookResultError, 'onFailure sees the reason')
  }
})
