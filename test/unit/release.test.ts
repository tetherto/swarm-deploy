/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import {
  ReleaseMatcher,
  compareReleaseVersions,
  fixedSeriesKey,
  releaseVersionGroup
} from '../../dist/release.js'
import { validateBasename } from '../../dist/files.js'
import { assertCommitRelease } from '../../dist/storage/commit-journal.js'
// The internal SemVer helper's suite compiles and runs with this one.
import './semver.test.js'

test('release templates match basenames and immediate source parents in order', (t) => {
  const matcher = new ReleaseMatcher([
    'releases/{series}-{version}.tar.gz',
    '{version}/{series}.tar.gz',
    '{series}-{version}.tar.gz'
  ])
  t.alike(matcher.match('api.tar.gz', '2.4.1'), { series: 'api', version: '2.4.1' })
  t.alike(matcher.match('worker-1.3.0-rc.1.tar.gz', 'releases'), {
    series: 'worker',
    version: '1.3.0-rc.1'
  })
  t.alike(matcher.match('worker-1.3.0-rc.1.tar.gz'), {
    series: 'worker',
    version: '1.3.0-rc.1'
  })
  t.alike(matcher.match('web-3.0.0.tar.gz'), { series: 'web', version: '3.0.0' })
  t.is(matcher.match('notes.txt'), null)
})

test('release matcher splits hyphenated series before strict SemVer suffix', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.alike(matcher.match('my-app-1.0.0.tar.gz'), { series: 'my-app', version: '1.0.0' })
  t.alike(matcher.match('api-v2-1.0.0.tar.gz'), { series: 'api-v2', version: '1.0.0' })
  t.alike(matcher.match('app2-0.9.10-rc.1.tar.gz'), {
    series: 'app2',
    version: '0.9.10-rc.1'
  })
})

test('release matcher splits hyphenated series in parent segments', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}/bundle.tar.gz'])
  t.alike(matcher.match('bundle.tar.gz', 'my-app-1.0.0'), {
    series: 'my-app',
    version: '1.0.0'
  })
})

test('parent-version templates never match without source parent', (t) => {
  const matcher = new ReleaseMatcher(['{version}/{series}.tar.gz'])
  t.is(matcher.match('api.tar.gz'), null)
  t.is(matcher.match('payments.tar.gz'), null)
  t.alike(matcher.match('api.tar.gz', '2.4.1'), { series: 'api', version: '2.4.1' })
})

test('release matcher rejects literal parent folder mismatches', (t) => {
  const matcher = new ReleaseMatcher(['releases/{series}.tar.gz'])
  t.is(matcher.match('api.tar.gz', 'staging'), null)
  t.alike(matcher.match('api.tar.gz', 'releases'), { series: 'api' })

  const versioned = new ReleaseMatcher(['releases/{series}-{version}.tar.gz'])
  t.is(versioned.match('worker-1.0.0.tar.gz', 'staging'), null)
  t.alike(versioned.match('worker-1.0.0.tar.gz', 'releases'), {
    series: 'worker',
    version: '1.0.0'
  })
})

test('release matcher supports generic placeholder layouts', (t) => {
  const versionFirst = new ReleaseMatcher(['{version}-{series}.tar.gz'])
  t.alike(versionFirst.match('2.4.1-api.tar.gz'), { series: 'api', version: '2.4.1' })

  const underscore = new ReleaseMatcher(['{series}_{version}.tar.gz'])
  t.alike(underscore.match('my-app_1.0.0.tar.gz'), { series: 'my-app', version: '1.0.0' })

  const vPrefix = new ReleaseMatcher(['{series}-v{version}.tar.gz'])
  t.alike(vPrefix.match('api-v2-v1.0.0.tar.gz'), { series: 'api-v2', version: '1.0.0' })

  const parentLayout = new ReleaseMatcher(['{version}-{series}/bundle.tar.gz'])
  t.alike(parentLayout.match('bundle.tar.gz', '2.4.1-api-v2'), {
    series: 'api-v2',
    version: '2.4.1'
  })
})

test('source parent accepts SemVer build metadata folder names', (t) => {
  const matcher = new ReleaseMatcher(['{version}/{series}.tar.gz'])
  t.alike(matcher.match('api.tar.gz', '1.2.3+build.2'), { series: 'api', version: '1.2.3' })
  t.is(matcher.match('api.tar.gz', '1.2.3+build/extra'), null)
})

test('artifact and source parent obey 100 UTF-8 byte limits', (t) => {
  const matcher = new ReleaseMatcher(['{series}.tar.gz'])
  const series93 = `a${'b'.repeat(92)}`
  const name100 = `${series93}.tar.gz`
  t.is(b4a.from(name100).byteLength, 100)
  t.alike(matcher.match(name100), { series: series93 })

  const series94 = `a${'b'.repeat(93)}`
  const name101 = `${series94}.tar.gz`
  t.is(b4a.from(name101).byteLength, 101)
  t.is(matcher.match(name101), null)

  const versioned = new ReleaseMatcher(['{version}/{series}.tar.gz'])
  const parent100 = `1.0.0+${'b'.repeat(94)}`
  t.is(b4a.from(parent100).byteLength, 100)
  t.alike(versioned.match('x.tar.gz', parent100), { series: 'x', version: '1.0.0' })

  const parent101 = `1.0.0+${'b'.repeat(95)}`
  t.is(b4a.from(parent101).byteLength, 101)
  t.is(versioned.match('x.tar.gz', parent101), null)
})

test('release versions use SemVer precedence and major/minor groups', (t) => {
  t.is(compareReleaseVersions('2.0.0-rc.1', '1.9.9') > 0, true)
  t.is(compareReleaseVersions('1.2.3+build.2', '1.2.3+build.1'), 0)
  t.is(compareReleaseVersions('1.0.0-alpha', '1.0.0-beta') < 0, true)
  t.is(releaseVersionGroup('1.2.3-rc.1', 'major'), '1')
  t.is(releaseVersionGroup('1.2.3-rc.1', 'minor'), '1.2')
})

test('release helpers reject invalid strict SemVer inputs', (t) => {
  t.exception(() => compareReleaseVersions('v1.0.0', '1.0.0'), /invalid/i)
  t.exception(() => compareReleaseVersions('1.0.0', 'not-semver'), /invalid/i)
  t.exception(() => releaseVersionGroup(' 1.0.0', 'major'), /invalid/i)
  t.exception(() => releaseVersionGroup('1.0.0', 'patch' as 'major'), /invalid/i)
  t.exception(() => compareReleaseVersions('9007199254740992.0.0', '1.0.0'), /invalid/i)
  t.exception(() => releaseVersionGroup('0.9007199254740992.0', 'minor'), /invalid/i)
  t.exception(() => compareReleaseVersions('1.0.0', `1.0.0-${'a'.repeat(95)}`), /invalid/i)
  t.exception(() => compareReleaseVersions('1.0.0/x', '1.0.0'), /invalid/i)
})

test('release versions at the safe-integer boundary compare and group exactly', (t) => {
  const max = '9007199254740991'
  t.is(compareReleaseVersions(`${max}.0.0`, '1.0.0') > 0, true)
  t.is(compareReleaseVersions(`0.${max}.0`, `0.${max}.0+build`), 0)
  t.is(compareReleaseVersions(`0.0.${max}`, `0.0.${max}-rc.1`) > 0, true)
  t.is(releaseVersionGroup(`${max}.${max}.${max}`, 'major'), max)
  t.is(releaseVersionGroup(`${max}.${max}.${max}-rc.1`, 'minor'), `${max}.${max}`)
})

test('prerelease numeric identifiers order numerically, including beyond 2^53', (t) => {
  t.is(compareReleaseVersions('1.0.0-2', '1.0.0-10') < 0, true, 'numeric, not lexical')
  t.is(compareReleaseVersions('1.0.0-10', '1.0.0-2') > 0, true)
  t.is(compareReleaseVersions('1.0.0-99', '1.0.0-100') < 0, true)
  t.is(compareReleaseVersions('1.0.0-1', '1.0.0-alpha') < 0, true, 'numeric below alphanumeric')

  const low = '1.0.0-9007199254740992'
  const high = '1.0.0-9007199254740993'
  t.is(compareReleaseVersions(low, high), -1, 'identifiers beyond 2^53 stay distinct')
  t.is(compareReleaseVersions(high, low), 1)
  t.is(compareReleaseVersions(high, high), 0)
  const wideLow = '1.0.0-12345678901234567890'
  const wideHigh = '1.0.0-12345678901234567891'
  t.is(compareReleaseVersions(wideLow, wideHigh), -1)
  t.is(compareReleaseVersions(wideHigh, wideLow), 1)
  t.is(compareReleaseVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'), -1)
})

test('release matcher canonicalizes captured versions and drops build metadata', (t) => {
  const max = '9007199254740991'
  const parent = new ReleaseMatcher(['{version}/{series}.tar.gz'])
  t.alike(parent.match('api.tar.gz', '1.2.3-rc.1+build.5'), {
    series: 'api',
    version: '1.2.3-rc.1'
  })
  t.alike(parent.match('api.tar.gz', `${max}.0.0+b`), { series: 'api', version: `${max}.0.0` })
  t.is(parent.match('api.tar.gz', '9007199254740992.0.0+b'), null)
  t.is(parent.match('api.tar.gz', '1.2.3+'), null)
  t.is(parent.match('api.tar.gz', 'v1.2.3+b'), null)
  t.is(parent.match('api.tar.gz', '01.2.3+b'), null)

  const basename = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.alike(basename.match(`app-${max}.${max}.${max}.tar.gz`), {
    series: 'app',
    version: `${max}.${max}.${max}`
  })
  t.is(basename.match('app-9007199254740992.0.0.tar.gz'), null)
  t.is(basename.match('app-0.0.9007199254740993.tar.gz'), null)
  t.is(basename.match('app-1.0.0-01.tar.gz'), null)
})

test('stored release versions stay canonical and reject build metadata', (t) => {
  const max = '9007199254740991'
  for (const version of ['1.2.3', `${max}.${max}.${max}`, '1.0.0-12345678901234567890']) {
    t.execution(() => assertCommitRelease({ series: 'app', version }), version)
  }
  for (const version of [
    '1.2.3+build.1',
    `${max}.0.0+b`,
    '9007199254740992.0.0',
    '0.0.9007199254740993',
    'v1.2.3',
    ' 1.2.3',
    '01.2.3',
    '1.0.0-01',
    '1.0.0/x',
    `1.0.0-${'a'.repeat(95)}`
  ]) {
    t.exception(
      () => assertCommitRelease({ series: 'app', version }),
      /Invalid commit release version/,
      version
    )
  }
})

test('release matcher rejects invalid templates at construction', (t) => {
  t.exception(
    () => new ReleaseMatcher(['{series}-{version}.tar.gz', '{series}-{version}.tar.gz']),
    /duplicate/i
  )
  t.exception(() => new ReleaseMatcher(['{series}-{series}.tar.gz']), /placeholder/i)
  t.exception(() => new ReleaseMatcher(['release.tar.gz']), /placeholder/i)
  t.exception(() => new ReleaseMatcher(['a/b/c/{series}.tar.gz']), /path/i)
  t.exception(() => new ReleaseMatcher(['{series}/nested/{version}.tar.gz']), /path/i)
  t.exception(() => new ReleaseMatcher(['/{series}.tar.gz']), /segment/i)
  t.exception(() => new ReleaseMatcher(['{series}/']), /segment/i)
  t.exception(() => new ReleaseMatcher(['{series}{version}.tar.gz']), /placeholder/i)
})

test('release matcher treats empty or unsafe captures as non-matches', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(matcher.match('-1.0.0.tar.gz'), null)
  t.is(matcher.match('worker-.tar.gz'), null)
  t.is(matcher.match('worker-not-semver.tar.gz'), null)
  t.is(matcher.match('api.tar.gz', 'not valid!'), null)
  t.is(matcher.match('api.tar.gz', ''), null)
})

test('release matcher exposes pattern metadata', (t) => {
  const countOnly = new ReleaseMatcher(['{series}.tar.gz'])
  t.is(countOnly.size, 1)
  t.is(countOnly.hasVersionPattern, false)

  const versioned = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(versioned.hasVersionPattern, true)
})

test('fixed-series parent-version templates require source parent', (t) => {
  const matcher = new ReleaseMatcher(['{version}/payments.tar.gz'])
  t.is(matcher.match('payments.tar.gz'), null)
  t.alike(matcher.match('payments.tar.gz', '2.4.1'), {
    series: fixedSeriesKey('{version}/payments.tar.gz'),
    version: '2.4.1'
  })
})

test('fixed-series keys are persistable, deterministic, and collision resistant', (t) => {
  const template = '{version}/payments.tar.gz'
  const key = fixedSeriesKey(template)
  t.ok(/^fixed-[0-9a-f]{64}$/.test(key), 'key is a lowercase hashed basename')
  t.is(key.length, 70)
  t.is(b4a.from(key).byteLength, 70)
  t.is(validateBasename(key), key, 'key survives commit-record basename validation')
  t.execution(() => assertCommitRelease({ series: key, version: '2.4.1' }))

  t.is(fixedSeriesKey(template), key, 'the same template always derives the same key')
  t.not(fixedSeriesKey('{version}/billing.tar.gz'), key)
  t.not(fixedSeriesKey('{version}-payments.tar.gz'), key)

  const matcher = new ReleaseMatcher([template])
  t.is(matcher.match('payments.tar.gz', '2.4.1')!.series, key)
  t.is(
    new ReleaseMatcher([template]).match('payments.tar.gz', '9.9.9')!.series,
    key,
    'a restarted matcher derives the identical persisted key'
  )
})

test('every documented version-only template yields a valid persistable series', (t) => {
  const templates = [
    '{version}/payments.tar.gz',
    'payments-{version}.tar.gz',
    'releases/payments-{version}.zip',
    '{version}.bin'
  ]
  for (const template of templates) {
    const matcher = new ReleaseMatcher([template])
    const matched =
      matcher.match('payments.tar.gz', '2.4.1') ??
      matcher.match('payments-2.4.1.tar.gz') ??
      matcher.match('payments-2.4.1.zip', 'releases') ??
      matcher.match('2.4.1.bin')
    t.ok(matched, template)
    t.is(matched!.series, fixedSeriesKey(template), template)
    t.is(matched!.version, '2.4.1', template)
    t.execution(() => assertCommitRelease({ ...matched }), template)
  }
})

test('a captured series cannot impersonate a derived fixed-series key', (t) => {
  const derived = fixedSeriesKey('{version}/payments.tar.gz')
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])

  t.is(matcher.match(`${derived}-2.4.1.tar.gz`), null, 'a versioned capture is rejected')
  t.is(
    new ReleaseMatcher(['{series}.tar.gz']).match(`${derived}.tar.gz`),
    null,
    'a series-only capture is rejected'
  )
  t.is(
    new ReleaseMatcher(['{version}/{series}.tar.gz']).match(`${derived}.tar.gz`, '2.4.1'),
    null,
    'a parent-versioned capture is rejected'
  )

  // Only the exact reserved shape is withheld; look-alikes stay matchable.
  for (const series of [
    'fixed-',
    `fixed-${'a'.repeat(63)}`,
    `fixed-${'a'.repeat(65)}`,
    `fixed-${'A'.repeat(64)}`,
    `fixed-${'g'.repeat(64)}`,
    `prefixed-${'a'.repeat(64)}`
  ]) {
    t.alike(matcher.match(`${series}-2.4.1.tar.gz`), { series, version: '2.4.1' }, series)
  }

  t.is(
    new ReleaseMatcher(['{version}/payments.tar.gz']).match('payments.tar.gz', '2.4.1')!.series,
    derived,
    'the derived key itself is still assigned by the matcher that owns it'
  )
})

test('release matcher rejects residual braces outside exact placeholders', (t) => {
  for (const template of [
    '{serie}-{version}.tar.gz',
    '{series}-{version}}.tar.gz',
    '{{series}.tar.gz',
    '{series}-{Version}.tar.gz',
    'a{b}-{series}.tar.gz',
    '{ series }-{version}.tar.gz',
    '{version}/payments{.tar.gz'
  ]) {
    t.exception(() => new ReleaseMatcher([template]), /brace/i, template)
  }
})

test('release matcher rejects non-canonical semver version captures', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(matcher.match('app-01.2.3.tar.gz'), null)
  t.is(matcher.match('app-v1.0.0.tar.gz'), null)
})
