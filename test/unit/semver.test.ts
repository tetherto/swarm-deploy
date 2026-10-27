/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { Version } from 'bare-semver'
import { compareStrictVersions, parseStrictVersion } from '../../dist/semver.js'

const MAX_SAFE = '9007199254740991'

function parsed(raw: string): NonNullable<ReturnType<typeof parseStrictVersion>> {
  const version = parseStrictVersion(raw)
  if (!version) throw new Error(`Expected ${raw} to parse`)
  return version
}

function order(left: string, right: string): number {
  return compareStrictVersions(parsed(left), parsed(right))
}

test('strict versions parse to their canonical form without build metadata', (t) => {
  t.alike(parseStrictVersion('1.2.3-rc.1+build.5'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['rc', '1'],
    version: '1.2.3-rc.1',
    hasBuild: true
  })
  t.alike(parseStrictVersion('0.0.0'), {
    major: 0,
    minor: 0,
    patch: 0,
    prerelease: [],
    version: '0.0.0',
    hasBuild: false
  })
  t.is(parsed('10.20.30').version, '10.20.30')
  t.is(parsed('1.0.0+build').version, '1.0.0')
  t.is(parsed('1.0.0+build').hasBuild, true)
  t.is(parsed('1.0.0+001').version, '1.0.0', 'build identifiers may carry leading zeros')
  t.is(parsed('1.0.0-0').version, '1.0.0-0')
  t.is(parsed('1.0.0-01a').version, '1.0.0-01a', 'an alphanumeric identifier may start with zero')
  t.is(parsed('1.0.0-a-b.-.c--').version, '1.0.0-a-b.-.c--')
})

test('core components are accepted up to the largest safe integer and rejected beyond it', (t) => {
  const widest = `${MAX_SAFE}.${MAX_SAFE}.${MAX_SAFE}`
  t.is(parsed(widest).version, widest)
  t.is(parsed(`${MAX_SAFE}.0.0`).major, Number.MAX_SAFE_INTEGER)
  t.is(parsed(`0.${MAX_SAFE}.0`).minor, Number.MAX_SAFE_INTEGER)
  t.is(parsed(`0.0.${MAX_SAFE}`).patch, Number.MAX_SAFE_INTEGER)

  for (const unsafe of [
    '9007199254740992',
    '9007199254740993',
    '9007199254740994',
    '10000000000000000',
    '99999999999999999999',
    '9'.repeat(90)
  ]) {
    t.is(parseStrictVersion(`${unsafe}.0.0`), undefined, `major ${unsafe}`)
    t.is(parseStrictVersion(`0.${unsafe}.0`), undefined, `minor ${unsafe}`)
    t.is(parseStrictVersion(`0.0.${unsafe}`), undefined, `patch ${unsafe}`)
  }
  t.is(parsed(`1.0.0+${'9'.repeat(30)}`).version, '1.0.0', 'build metadata is never a number')
})

test('non-canonical and non-version inputs are rejected', (t) => {
  for (const raw of [
    '',
    ' ',
    ' 1.0.0',
    '1.0.0 ',
    '1.0.0\n',
    '\t1.0.0',
    'v1.0.0',
    'V1.0.0',
    '=1.0.0',
    '1',
    '1.0',
    '1.0.0.0',
    '01.0.0',
    '1.00.0',
    '1.0.00',
    '-1.0.0',
    '+1.0.0',
    '1.0.0-',
    '1.0.0-01',
    '1.0.0-1.00',
    '1.0.0-a..b',
    '1.0.0-.a',
    '1.0.0-a.',
    '1.0.0-a_b',
    '1.0.0+',
    '1.0.0+a..b',
    '1.0.0+a+b',
    '1.0.0+a_b',
    '1.0.0/x',
    '../1.0.0',
    '1.0.0\\x',
    '1.0.0-é',
    '1.0.0-١',
    '1.0.0-rc 1',
    '1.2.3 - 2.0.0',
    '^1.0.0',
    '~1.0.0',
    '>=1.0.0',
    '1.x',
    '1.0.x',
    '*',
    'latest'
  ]) {
    t.is(parseStrictVersion(raw), undefined, JSON.stringify(raw))
  }
  for (const raw of [undefined, null, 1, 1.5, {}, [], ['1.0.0'], true]) {
    t.is(parseStrictVersion(raw), undefined, `non-string ${JSON.stringify(raw)}`)
  }
})

test('versions are limited to 100 UTF-8 bytes', (t) => {
  t.is(parseStrictVersion(`1.0.0-${'a'.repeat(94)}`)?.version, `1.0.0-${'a'.repeat(94)}`)
  t.is(parseStrictVersion(`1.0.0-${'a'.repeat(95)}`), undefined)
  t.is(parseStrictVersion(`1.0.0+${'b'.repeat(94)}`)?.version, '1.0.0')
  t.is(parseStrictVersion(`1.0.0+${'b'.repeat(95)}`), undefined)
})

test('prerelease precedence follows the SemVer 2.0.0 ordering chain', (t) => {
  const chain = [
    '1.0.0-0',
    '1.0.0-1',
    '1.0.0-2',
    '1.0.0-10',
    '1.0.0-11',
    '1.0.0-99',
    '1.0.0-100',
    '1.0.0-1a',
    '1.0.0-A',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1-0',
    '1.0.1',
    '1.0.9',
    '1.0.10',
    '1.9.0',
    '1.10.0',
    '2.0.0-rc.1',
    '2.0.0',
    '10.0.0'
  ]
  for (let i = 0; i < chain.length; i++) {
    t.is(order(chain[i]!, chain[i]!), 0, `${chain[i]} equals itself`)
    for (let j = i + 1; j < chain.length; j++) {
      t.is(order(chain[i]!, chain[j]!), -1, `${chain[i]} < ${chain[j]}`)
      t.is(order(chain[j]!, chain[i]!), 1, `${chain[j]} > ${chain[i]}`)
    }
  }
})

test('build metadata never takes part in precedence', (t) => {
  t.is(order('1.2.3+build.2', '1.2.3+build.1'), 0)
  t.is(order('1.2.3+a', '1.2.3'), 0)
  t.is(order('1.2.3-rc.1+z', '1.2.3-rc.1+a'), 0)
  t.is(order('1.2.3-rc.1+a', '1.2.3'), -1)
  t.is(order('1.2.4+a', '1.2.3+z'), 1)
})

test('long numeric prerelease identifiers keep an exact total order', (t) => {
  // `Version.compare` coerces numeric identifiers to Number, so beyond 2^53
  // two distinct identifiers can round to one value and compare as lower than
  // each other. Retention sorts versions, so the order has to stay exact.
  const ascending = [
    '1.0.0-9007199254740990',
    `1.0.0-${MAX_SAFE}`,
    '1.0.0-9007199254740992',
    '1.0.0-9007199254740993',
    '1.0.0-9007199254740994',
    '1.0.0-12345678901234567890',
    '1.0.0-12345678901234567891',
    '1.0.0-99999999999999999999',
    '1.0.0-100000000000000000000',
    `1.0.0-${'1'.repeat(29)}1`,
    `1.0.0-${'1'.repeat(29)}2`,
    `1.0.0-${'1'.repeat(30)}1`,
    '1.0.0-0a',
    `1.0.0-${'9'.repeat(40)}a`,
    '1.0.0-a'
  ]
  for (let i = 0; i < ascending.length; i++) {
    for (let j = i + 1; j < ascending.length; j++) {
      t.is(order(ascending[i]!, ascending[j]!), -1, `${ascending[i]} < ${ascending[j]}`)
      t.is(order(ascending[j]!, ascending[i]!), 1, `${ascending[j]} > ${ascending[i]}`)
    }
  }
  t.is(order('1.0.0-9007199254740993.1', '1.0.0-9007199254740993.2'), -1)
  t.is(order('1.0.0-9007199254740993.2', '1.0.0-9007199254740992.9'), 1)
  t.is(order('1.0.0-9007199254740993', '1.0.0-9007199254740993.0'), -1, 'a shorter prefix is lower')
})

test('precedence matches bare-semver wherever its numeric coercion is exact', (t) => {
  const identifiers = ['0', '1', '9', '10', '100', MAX_SAFE, 'a', 'A', 'alpha', '1a', '01a', 'a-b']
  const prerelease = ['', ...identifiers.map((id) => `-${id}`)]
  for (const first of identifiers) {
    for (const second of identifiers) prerelease.push(`-${first}.${second}`)
  }
  const versions = []
  for (const core of ['1.0.0', '1.0.10', '1.2.0']) {
    for (const suffix of prerelease) {
      const raw = `${core}${suffix}`
      versions.push({ raw, ours: parsed(raw), theirs: Version.parse(raw) })
    }
  }

  let compared = 0
  for (const left of versions) {
    for (const right of versions) {
      const expected = Math.sign(Version.compare(left.theirs, right.theirs))
      const actual = compareStrictVersions(left.ours, right.ours)
      if (actual !== expected) {
        t.fail(`${left.raw} vs ${right.raw}: expected ${expected}, got ${actual}`)
      }
      compared++
    }
  }
  t.ok(compared > 100_000, `compared ${compared} pairs`)
})
