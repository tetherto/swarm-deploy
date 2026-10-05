/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
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

test('release versions use SemVer precedence and major/minor groups', (t) => {
  t.is(compareReleaseVersions('2.0.0-rc.1', '1.9.9') > 0, true)
  t.is(compareReleaseVersions('1.2.3+build.2', '1.2.3+build.1'), 0)
  t.is(releaseVersionGroup('1.2.3-rc.1', 'major'), '1')
  t.is(releaseVersionGroup('1.2.3-rc.1', 'minor'), '1.2')
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
})

test('release matcher treats empty or unsafe captures as non-matches', (t) => {
  const matcher = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(matcher.match('-1.0.0.tar.gz'), null)
  t.is(matcher.match('worker-.tar.gz'), null)
  t.is(matcher.match('worker-not-semver.tar.gz'), null)
})

test('release matcher exposes pattern metadata', (t) => {
  const countOnly = new ReleaseMatcher(['{series}.tar.gz'])
  t.is(countOnly.size, 1)
  t.is(countOnly.hasVersionPattern, false)

  const versioned = new ReleaseMatcher(['{series}-{version}.tar.gz'])
  t.is(versioned.hasVersionPattern, true)
})

test('release matcher uses the template as fixed series without a series placeholder', (t) => {
  const matcher = new ReleaseMatcher(['{version}/payments.tar.gz'])
  t.alike(matcher.match('payments.tar.gz'), {
    series: '{version}/payments.tar.gz'
  })
  t.alike(matcher.match('payments.tar.gz', '2.4.1'), {
    series: '{version}/payments.tar.gz',
    version: '2.4.1'
  })
})
