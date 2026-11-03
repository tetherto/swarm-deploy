/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import { ERRORS } from '../../dist/errors.js'
import { compileReplacePolicy, describeReplacePolicy } from '../../dist/replace-policy.js'

const MESSAGE = 'Invalid allowReplace'

function rejection(input: unknown): { code?: string; message?: string } | null {
  try {
    compileReplacePolicy(input)
    return null
  } catch (error: unknown) {
    return error as { code?: string; message?: string }
  }
}

test('replacement is off unless it is asked for', (t) => {
  for (const input of [undefined, false, []]) {
    const policy = compileReplacePolicy(input)
    t.is(policy.global, false)
    t.alike([...policy.selectors], [])
    t.is(policy.allows('app'), false)
    t.is(policy.allows('beta-1.0.0'), false)
    t.is(describeReplacePolicy(policy), false)
  }
})

test('true allows every name except the history namespace', (t) => {
  const policy = compileReplacePolicy(true)
  t.is(policy.global, true)
  t.is(policy.allows('app'), true)
  t.is(policy.allows('0.18.1'), true)
  t.is(policy.allows(`history-${'a'.repeat(64)}`), false, 'history is never replaceable')
  t.is(describeReplacePolicy(policy), true)
})

test('an exact name selects exactly that name', (t) => {
  const policy = compileReplacePolicy(['app.tar.gz', '0.18.1'])
  t.is(policy.allows('app.tar.gz'), true)
  t.is(policy.allows('0.18.1'), true)
  t.is(policy.allows('app.tar.gz.sig'), false)
  t.is(policy.allows('App.tar.gz'), false, 'names are compared exactly')
  t.alike([...(describeReplacePolicy(policy) as readonly string[])], ['app.tar.gz', '0.18.1'])
})

test('a template selects the names it matches, in the grammar of artifact patterns', (t) => {
  const policy = compileReplacePolicy(['beta-{version}'])
  t.is(policy.allows('beta-1.2.3'), true)
  t.is(policy.allows('beta-2.0.0-rc.1'), true)
  t.is(policy.allows('beta-12'), false, 'a version is strict SemVer')
  t.is(policy.allows('prod-1.2.3'), false)
  t.is(policy.allows('beta-1.2.3.tar'), false)

  const series = compileReplacePolicy(['{series}-nightly'])
  t.is(series.allows('app-nightly'), true)
  t.is(series.allows('app-weekly'), false)
})

test('a bare {version} template selects the SemVer-named artifacts and not every name', (t) => {
  const policy = compileReplacePolicy(['{version}'])
  t.is(policy.global, false)
  t.is(policy.allows('0.18.1'), true)
  t.is(policy.allows('2.0.0-rc.1'), true)
  t.is(policy.allows('app'), false)
  t.is(policy.allows('operator.txt'), false)
})

test('an explicit {series} template is accepted when the grammar accepts it', (t) => {
  const policy = compileReplacePolicy(['{series}'])
  t.is(policy.global, false, 'it is a template, not the global switch')
  t.is(policy.allows('app'), true)
  t.is(policy.allows(`history-${'b'.repeat(64)}`), false)
})

test('exact names and templates combine', (t) => {
  const policy = compileReplacePolicy(['latest.json', 'beta-{version}', '{version}'])
  t.is(policy.allows('latest.json'), true)
  t.is(policy.allows('beta-3.0.0'), true)
  t.is(policy.allows('3.0.0'), true)
  t.is(policy.allows('other.json'), false)
})

test('invalid policies are refused with one fixed message that echoes nothing', (t) => {
  const secret = 'SECRETMARKER'
  const invalid: unknown[] = [
    'beta-{version}',
    5,
    null,
    {},
    [5],
    [null],
    [''],
    [`${secret}/{version}`],
    [`${secret}\\{version}`],
    [`${secret}-{oops}`],
    [`${secret}-{version}-{version}`],
    [`${secret}-{series}{version}`],
    [`${secret}\u0000`],
    ['history-anything'],
    ['history-{version}'],
    [`-${secret}`],
    [`${secret}.`.repeat(40)],
    ['a', 'a'],
    ['beta-{version}', 'beta-{version}'],
    Array.from({ length: 65 }, (_unused, index) => `name-${index}`)
  ]
  for (const input of invalid) {
    const failure = rejection(input)
    t.is(failure?.code, ERRORS.PROTOCOL_INVALID, JSON.stringify(input)?.slice(0, 60))
    t.is(failure?.message, MESSAGE)
    t.absent(String(failure?.message).includes(secret), 'the value is never echoed')
  }
  t.is(rejection(Array.from({ length: 64 }, (_unused, index) => `name-${index}`)), null)
})

test('a compiled policy shares nothing with its input and exposes frozen selectors', (t) => {
  const input = ['beta-{version}']
  const policy = compileReplacePolicy(input)
  input.push('app')
  input[0] = 'other-{version}'
  t.is(policy.allows('beta-1.0.0'), true)
  t.is(policy.allows('app'), false)
  t.ok(Object.isFrozen(policy))
  t.ok(Object.isFrozen(policy.selectors))
  t.ok(Object.isFrozen(describeReplacePolicy(policy)))
})

test('a generator is read once and a throwing iterable is refused', async (t) => {
  function* names(): Generator<string> {
    yield 'one'
    yield 'two'
  }
  const policy = compileReplacePolicy(names())
  t.is(policy.allows('one'), true)
  t.is(policy.allows('two'), true)
  const hostile = {
    [Symbol.iterator]() {
      throw new Error('hostile iterator')
    }
  }
  await t.exception(() => compileReplacePolicy(hostile))
})
