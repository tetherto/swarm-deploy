/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { ERRORS } from '../../dist/errors.js'
import {
  compileSymlinkRules,
  isManualSymlinkTargetAllowed,
  selectDesiredLinks,
  symlinkRuleNames,
  type SymlinkRule
} from '../../dist/symlinks.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'

function fileRecord(
  name: string,
  committedAt: number,
  transferId = name
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0')
): CommitRecord {
  return {
    version: 1,
    name,
    size: 1,
    sha256: 'a'.repeat(64),
    committedAt,
    uploaderFingerprint: 'b'.repeat(64),
    transferId
  }
}

function directoryRecord(name: string, committedAt: number, transferId: string): CommitRecord {
  return {
    version: 3,
    kind: 'directory',
    name,
    size: 1,
    sha256: 'c'.repeat(64),
    entryCount: 1,
    committedAt,
    uploaderFingerprint: 'd'.repeat(64),
    transferId
  }
}

test('rules accept exact and unflagged regex selectors and are repeatable', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz', name: 'current.tar.gz' },
    { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/', name: 'app-latest.tar.gz' },
    { selector: 'a'.repeat(64), name: 'pinned.bin' }
  ])
  t.is(rules.length, 4)
  t.is(rules[0].exact, null)
  t.is(rules[1].exact, 'release.tar.gz')
  t.is(rules[0].matches('0.18.1'), true)
  t.is(rules[0].matches('0.18.1-rc.1'), false)
  t.is(rules[2].matches('app-1.2.3.tar.gz'), true)
  t.alike([...symlinkRuleNames(rules)].sort(), [
    'app-latest.tar.gz',
    'current.tar.gz',
    'latest',
    'pinned.bin'
  ])
})

test('one-argument rules authorize exact and regex-selected targets', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz' },
    { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/' },
    { selector: '/^history-/' }
  ])
  t.is(isManualSymlinkTargetAllowed(rules, 'release.tar.gz'), true)
  t.is(isManualSymlinkTargetAllowed(rules, 'app-1.2.3.tar.gz'), true)
  t.is(isManualSymlinkTargetAllowed(rules, '0.18.1'), false)
  t.is(isManualSymlinkTargetAllowed(rules, 'unrelated.bin'), false)
  t.is(isManualSymlinkTargetAllowed(rules, 'history-aa'), false)
  t.is(isManualSymlinkTargetAllowed(rules, '../release.tar.gz'), false)
  t.alike([...symlinkRuleNames(rules)], ['latest'])
})

test('manual authorization rules never produce desired automatic links', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz' },
    { selector: '/^app-/' }
  ])
  const records = [
    directoryRecord('0.18.1', 100, '1'.repeat(64)),
    fileRecord('release.tar.gz', 200, '2'.repeat(64)),
    fileRecord('app-1.2.3.tar.gz', 300, '3'.repeat(64))
  ]
  t.alike(selectDesiredLinks(rules, records), [
    { name: 'latest', target: '0.18.1', transferId: '1'.repeat(64), targetKind: 'directory' }
  ])
})

test('rule compilation rejects every malformed configuration', (t) => {
  for (const rules of [
    [{ selector: '/[unclosed/', name: 'latest' }],
    [{ selector: '//', name: 'latest' }],
    [{ selector: '/^a$/i', name: 'latest' }],
    [{ selector: '', name: 'latest' }],
    [{ selector: 'a'.repeat(201), name: 'latest' }],
    [{ selector: '../escape', name: 'latest' }],
    [{ selector: 'history-aa', name: 'latest' }],
    [{ selector: 'latest', name: 'latest' }],
    [{ selector: 'release.tar.gz', name: 'history-latest' }],
    [{ selector: 'release.tar.gz', name: '.swarm-deploy' }],
    [{ selector: 'release.tar.gz', name: 'a/b' }],
    [{ selector: 'release.tar.gz', name: 'a'.repeat(101) }],
    [
      { selector: 'one.bin', name: 'latest' },
      { selector: 'two.bin', name: 'latest' }
    ],
    [{ selector: 'release.tar.gz' }, { selector: 'release.tar.gz' }],
    [{ selector: 'history-aa' }],
    [{ selector: 'release.tar.gz', name: undefined } as unknown as SymlinkRule],
    [{ selector: 'release.tar.gz', extra: 1 } as unknown as SymlinkRule],
    [{ selector: 'release.tar.gz', name: 'latest', extra: 1 } as unknown as SymlinkRule],
    'release.tar.gz' as unknown as Iterable<SymlinkRule>
  ]) {
    t.exception(() => compileSymlinkRules(rules as Iterable<SymlinkRule>), {
      code: /PROTOCOL_INVALID|INVALID_FILENAME/
    })
  }
  t.alike(compileSymlinkRules(undefined), [])
  t.alike(compileSymlinkRules(null), [])
})

test('selection picks the newest matching record deterministically', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz', name: 'current.tar.gz' }
  ])
  const records = [
    directoryRecord('0.18.0', 100, '1'.repeat(64)),
    directoryRecord('0.18.1', 200, '2'.repeat(64)),
    directoryRecord('0.18.2', 200, '0'.repeat(64)),
    fileRecord('history-aaaa', 300, '3'.repeat(64)),
    fileRecord('unrelated.bin', 400, '4'.repeat(64))
  ]
  t.alike(selectDesiredLinks(rules, records), [
    { name: 'latest', target: '0.18.2', transferId: '0'.repeat(64), targetKind: 'directory' }
  ])

  const withFile = [...records, fileRecord('release.tar.gz', 50, '5'.repeat(64))]
  t.alike(selectDesiredLinks(rules, withFile), [
    { name: 'latest', target: '0.18.2', transferId: '0'.repeat(64), targetKind: 'directory' },
    {
      name: 'current.tar.gz',
      target: 'release.tar.gz',
      transferId: '5'.repeat(64),
      targetKind: 'file'
    }
  ])
})

test('a rule is dormant until a managed target exists and never targets itself', (t) => {
  const rules = compileSymlinkRules([
    { selector: 'release.tar.gz', name: 'current.tar.gz' },
    { selector: '/^latest$/', name: 'latest' }
  ])
  t.alike(selectDesiredLinks(rules, []), [])
  t.alike(selectDesiredLinks(rules, [fileRecord('latest', 10, '6'.repeat(64))]), [])
  t.is(ERRORS.LINK_CONFLICT, 'LINK_CONFLICT')
})
