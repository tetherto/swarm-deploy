/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import {
  ReleaseMatcher,
  compareReleaseVersions,
  releaseVersionGroup
} from '../../dist/release.js'

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
})

test('release matcher rejects invalid templates at construction', (t) => {
  t.exception(
    () =>
      new ReleaseMatcher([
        '{series}-{version}.tar.gz',
        '{series}-{version}.tar.gz'
      ]),
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
    series: '{version}/payments.tar.gz',
    version: '2.4.1'
  })
})

test('release matcher rejects non-canonical semver version captures', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(matcher.match('app-01.2.3.tar.gz'), null)
  t.is(matcher.match('app-v1.0.0.tar.gz'), null)
})
