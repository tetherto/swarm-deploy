/// <reference path="../types/brittle.d.ts" />

import test, { type Assert } from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import {
  assertCommitRecord,
  commitRecordKind,
  compareCommitOrder,
  CorruptJournalError,
  DIRECTORY_COMMIT_VERSION,
  DIRECTORY_HISTORY_COMMIT_VERSION,
  DIRECTORY_JOURNAL_VERSION,
  DIRECTORY_PHASES,
  DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
  DIRECTORY_REPLACEMENT_PHASES,
  isDirectoryJournal,
  isDirectoryReplacementJournal,
  readCommitJournal,
  serializeJournal,
  type CommitRecord,
  type DirectoryCommitJournal,
  type DirectoryReplacementJournal
} from '../../dist/storage/commit-journal.js'
import { MAX_TREE_ENTRIES } from '../../dist/tar-protocol/tree.js'
import { createTempDir } from '../helpers/files.js'
import { initLayout } from '../helpers/layout.js'
import { createStorage } from '../helpers/storage.js'

const ID = 'a'.repeat(64)
const OTHER_ID = 'd'.repeat(64)
const DIGEST = 'b'.repeat(64)
const UPLOADER = 'c'.repeat(64)
const ATTEMPT = 'e'.repeat(64)
const IDENTITY = { dev: '66', ino: '1234' }

function directoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: DIRECTORY_COMMIT_VERSION,
    kind: 'directory',
    name: '0.18.1',
    size: 3,
    sha256: DIGEST,
    entryCount: 4,
    committedAt: 1_000,
    uploaderFingerprint: UPLOADER,
    transferId: ID,
    ...overrides
  }
}

function fileRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'payload.bin',
    size: 7,
    sha256: DIGEST,
    committedAt: 1_000,
    uploaderFingerprint: UPLOADER,
    transferId: ID,
    ...overrides
  }
}

function directoryJournal(
  overrides: Partial<Record<keyof DirectoryCommitJournal, unknown>> = {}
): Record<string, unknown> {
  return {
    version: DIRECTORY_JOURNAL_VERSION,
    intent: 'create-directory',
    state: 'committing',
    phase: 'journaled',
    transferId: ID,
    attemptId: ATTEMPT,
    name: '0.18.1',
    stagingTreeName: `${ID}.tree`,
    stagingTreeIdentity: IDENTITY,
    record: directoryRecord(),
    ...overrides
  }
}

/** Writes one journal file into a fresh storage root and returns that root. */
async function writeJournal(
  t: Assert,
  id: string,
  journal: Record<string, unknown>
): Promise<string> {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  await fs.promises.writeFile(path.join(layout.journals, `${id}.json`), JSON.stringify(journal))
  return root
}

test('a version 3 directory record validates and keeps its directory fields', (t) => {
  const record = assertCommitRecord(directoryRecord())
  t.is(record.version, 3)
  t.is(record.kind, 'directory')
  t.is(record.entryCount, 4)
  t.is(record.replaces, undefined)
  t.is(commitRecordKind(record), 'directory')
  t.is(commitRecordKind(assertCommitRecord(fileRecord()) as CommitRecord), 'file')
  t.alike([...DIRECTORY_PHASES], ['journaled', 'renamed', 'sidecar', 'cleanup'])
})

test('a malformed directory record is rejected field by field', (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wrong kind', directoryRecord({ kind: 'file' })],
    ['absent kind', directoryRecord({ kind: undefined })],
    ['absent entry count', directoryRecord({ entryCount: undefined })],
    ['fractional entry count', directoryRecord({ entryCount: 1.5 })],
    ['negative entry count', directoryRecord({ entryCount: -1 })],
    ['entry count above the ceiling', directoryRecord({ entryCount: MAX_TREE_ENTRIES + 1 })],
    [
      'replacement metadata',
      directoryRecord({
        replaces: { name: '0.18.0', transferId: OTHER_ID, historyName: `history-${OTHER_ID}` }
      })
    ],
    ['unknown version', directoryRecord({ version: 5 })],
    ['reserved name', directoryRecord({ name: `history-${OTHER_ID}` })],
    [
      'a version 4 record that is not a history copy',
      directoryRecord({ version: DIRECTORY_HISTORY_COMMIT_VERSION })
    ]
  ]
  for (const [label, candidate] of cases) {
    t.exception(() => assertCommitRecord(candidate), { code: ERRORS.PROTOCOL_INVALID }, label)
  }
})

test('a file or replacement record never carries directory fields', (t) => {
  t.exception(() => assertCommitRecord(fileRecord({ kind: 'directory' })), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => assertCommitRecord(fileRecord({ entryCount: 1 })), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () =>
      assertCommitRecord(
        fileRecord({
          version: 2,
          kind: 'directory',
          replaces: { name: 'current', transferId: OTHER_ID, historyName: `history-${OTHER_ID}` }
        })
      ),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.execution(() => assertCommitRecord(fileRecord()))
})

test('commit order is newest first and total across equal timestamps', (t) => {
  const at = (committedAt: number, transferId: string, name: string): CommitRecord =>
    assertCommitRecord({ ...fileRecord(), committedAt, transferId, name })
  const newest = at(30, ID, 'c.bin')
  const tieLow = at(20, '1'.repeat(64), 'b.bin')
  const tieHigh = at(20, '2'.repeat(64), 'a.bin')
  const sorted = [tieHigh, newest, tieLow].sort(compareCommitOrder)
  t.alike(
    sorted.map((record) => record.transferId),
    [newest.transferId, tieLow.transferId, tieHigh.transferId]
  )
  // A total order: reversing the input cannot change the result.
  t.alike(
    [tieLow, newest, tieHigh].sort(compareCommitOrder).map((record) => record.transferId),
    sorted.map((record) => record.transferId)
  )
  t.is(compareCommitOrder(newest, newest), 0)
  const sameId = at(20, ID, 'a.bin')
  const sameIdLater = at(20, ID, 'z.bin')
  t.ok(compareCommitOrder(sameId, sameIdLater) < 0)
})

test('a directory journal round-trips through serialize and read', async (t) => {
  const journal = directoryJournal()
  const serialized = serializeJournal(journal as unknown as DirectoryCommitJournal)
  t.alike(Object.keys(serialized).sort(), [
    'attemptId',
    'intent',
    'name',
    'phase',
    'record',
    'stagingTreeIdentity',
    'stagingTreeName',
    'state',
    'transferId',
    'version'
  ])
  const root = await writeJournal(t, ID, serialized)
  const read = await readCommitJournal(ID, initLayout(root), createStorage())
  t.ok(isDirectoryJournal(read))
  t.alike<unknown>(read, journal)
  t.absent(isDirectoryJournal(null))
})

test('every directory phase survives a durable phase transition', async (t) => {
  for (const phase of DIRECTORY_PHASES) {
    const journal = directoryJournal({ phase })
    const root = await writeJournal(
      t,
      ID,
      serializeJournal(journal as unknown as DirectoryCommitJournal)
    )
    const read = await readCommitJournal(ID, initLayout(root), createStorage())
    t.is(read && 'phase' in read ? read.phase : null, phase)
  }
})

test('a corrupt directory journal is rejected instead of silently repaired', async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wrong intent', directoryJournal({ intent: 'replace' })],
    ['unknown state', directoryJournal({ state: 'done' })],
    ['unknown phase', directoryJournal({ phase: 'renaming' })],
    ['staging name mismatch', directoryJournal({ stagingTreeName: `${OTHER_ID}.tree` })],
    ['staging name is a part file', directoryJournal({ stagingTreeName: `${ID}.part` })],
    ['non-hex attempt', directoryJournal({ attemptId: 'not-hex' })],
    ['identity missing', directoryJournal({ stagingTreeIdentity: { dev: '66' } })],
    ['reserved journal name', directoryJournal({ name: `history-${OTHER_ID}` })],
    ['record is not a directory record', directoryJournal({ record: fileRecord() })],
    [
      'record name disagrees with the journal name',
      directoryJournal({ record: directoryRecord({ name: '0.18.2' }) })
    ],
    [
      'record transfer disagrees with the journal ID',
      directoryJournal({ record: directoryRecord({ transferId: OTHER_ID }) })
    ]
  ]
  for (const [label, journal] of cases) {
    const root = await writeJournal(t, ID, journal)
    await t.exception(
      () => readCommitJournal(ID, initLayout(root), createStorage()),
      CorruptJournalError,
      label
    )
  }
})

test('a stored release version is validated as canonical SemVer without build metadata', (t) => {
  const max = '9007199254740991'
  for (const version of [
    '1.2.3',
    '1.0.0-rc.1',
    `${max}.${max}.${max}`,
    '1.0.0-12345678901234567890'
  ]) {
    const record = assertCommitRecord(fileRecord({ release: { series: 'app', version } }))
    t.is(record.release?.version, version, version)
  }
  t.is(assertCommitRecord(fileRecord({ release: { series: 'app' } })).release?.version, undefined)

  for (const version of [
    '1.2.3+build.1',
    `${max}.0.0+b`,
    '9007199254740992.0.0',
    '0.9007199254740992.0',
    '0.0.9007199254740992',
    'v1.2.3',
    ' 1.2.3 ',
    '1.2',
    '01.2.3',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3/x',
    '1.2.3\\x',
    `1.0.0-${'a'.repeat(95)}`,
    '',
    1,
    null
  ]) {
    t.exception(
      () => assertCommitRecord(fileRecord({ release: { series: 'app', version } })),
      { code: ERRORS.PROTOCOL_INVALID, message: 'Invalid commit release version' },
      JSON.stringify(version)
    )
  }
})

test('recovery treats a journal record with a non-canonical release version as corrupt', async (t) => {
  const journal = (version: string): Record<string, unknown> => ({
    version: 1,
    state: 'committing',
    transferId: ID,
    attemptId: ATTEMPT,
    sourceStagingIdentity: IDENTITY,
    record: fileRecord({ release: { series: 'app', version } })
  })
  const good = await writeJournal(t, ID, journal('1.2.3-rc.1'))
  const read = await readCommitJournal(ID, initLayout(good), createStorage())
  t.is(read?.version, 1)
  for (const version of ['1.2.3+build.1', '9007199254740992.0.0', 'v1.2.3']) {
    const root = await writeJournal(t, ID, journal(version))
    await t.exception(
      () => readCommitJournal(ID, initLayout(root), createStorage()),
      CorruptJournalError,
      version
    )
  }
})

test('file and replacement journals read back unchanged', async (t) => {
  const file = {
    version: 1,
    state: 'committing',
    transferId: ID,
    attemptId: ATTEMPT,
    sourceStagingIdentity: IDENTITY,
    record: fileRecord()
  }
  const root = await writeJournal(t, ID, file)
  const read = await readCommitJournal(ID, initLayout(root), createStorage())
  t.absent(isDirectoryJournal(read))
  t.is(read?.version, 1)
})

const OLD_ID = 'f'.repeat(64)

function historyRecordShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return directoryRecord({
    version: DIRECTORY_HISTORY_COMMIT_VERSION,
    transferId: OLD_ID,
    name: `history-${OLD_ID}`,
    ...overrides
  })
}

function replacementJournal(
  overrides: Partial<Record<keyof DirectoryReplacementJournal, unknown>> = {}
): Record<string, unknown> {
  return {
    version: DIRECTORY_REPLACEMENT_JOURNAL_VERSION,
    intent: 'replace-directory',
    state: 'committing',
    phase: 'journaled',
    transferId: ID,
    attemptId: ATTEMPT,
    name: '0.18.1',
    historyName: `history-${OLD_ID}`,
    publicationName: `${ATTEMPT}.tree`,
    dedupName: null,
    stagingTreeIdentity: IDENTITY,
    oldTreeIdentity: { dev: '66', ino: '5678' },
    dedupTreeIdentity: null,
    dedupRecord: null,
    oldRecord: directoryRecord({ transferId: OLD_ID, committedAt: 500 }),
    record: directoryRecord(),
    ...overrides
  }
}

test('a version 4 directory history record is the only directory record with a history name', (t) => {
  const record = assertCommitRecord(historyRecordShape())
  t.is(record.version, 4)
  t.is(record.kind, 'directory')
  t.is(record.name, `history-${OLD_ID}`)
  t.is(commitRecordKind(record), 'directory')

  const cases: Array<[string, Record<string, unknown>]> = [
    ['a current name', historyRecordShape({ name: '0.18.1' })],
    ['another transfer’s history name', historyRecordShape({ name: `history-${ID}` })],
    ['no entry count', historyRecordShape({ entryCount: undefined })],
    ['not a directory', historyRecordShape({ kind: 'file' })],
    [
      'replacement metadata',
      historyRecordShape({
        replaces: { name: '0.18.0', transferId: ID, historyName: `history-${ID}` }
      })
    ]
  ]
  for (const [label, candidate] of cases) {
    t.exception(() => assertCommitRecord(candidate), { code: ERRORS.PROTOCOL_INVALID }, label)
  }
})

test('a directory replacement journal round-trips through serialize and read', async (t) => {
  for (const phase of DIRECTORY_REPLACEMENT_PHASES) {
    const journal = replacementJournal({ phase })
    const serialized = serializeJournal(journal as unknown as DirectoryReplacementJournal)
    t.alike(Object.keys(serialized).sort(), [
      'attemptId',
      'dedupName',
      'dedupRecord',
      'dedupTreeIdentity',
      'historyName',
      'intent',
      'name',
      'oldRecord',
      'oldTreeIdentity',
      'phase',
      'publicationName',
      'record',
      'stagingTreeIdentity',
      'state',
      'transferId',
      'version'
    ])
    const root = await writeJournal(t, ID, serialized)
    const read = await readCommitJournal(ID, initLayout(root), createStorage())
    t.ok(isDirectoryReplacementJournal(read), phase)
    t.absent(isDirectoryJournal(read), 'a replacement is not a create')
    t.alike<unknown>(read, journal, phase)
  }
  t.absent(isDirectoryReplacementJournal(null))
})

test('a journal that parks a returning history copy carries all of it or none of it', async (t) => {
  const parked = replacementJournal({
    dedupName: `${ATTEMPT}.dedup`,
    dedupTreeIdentity: { dev: '66', ino: '9999' },
    dedupRecord: historyRecordShape({ transferId: ID, name: `history-${ID}` })
  })
  const root = await writeJournal(
    t,
    ID,
    serializeJournal(parked as unknown as DirectoryReplacementJournal)
  )
  const read = await readCommitJournal(ID, initLayout(root), createStorage())
  t.alike<unknown>(read, parked)

  const partial: Array<[string, Record<string, unknown>]> = [
    ['a name only', replacementJournal({ dedupName: `${ATTEMPT}.dedup` })],
    ['an identity only', replacementJournal({ dedupTreeIdentity: IDENTITY })],
    [
      'a record only',
      replacementJournal({
        dedupRecord: historyRecordShape({ transferId: ID, name: `history-${ID}` })
      })
    ]
  ]
  for (const [label, journal] of partial) {
    const dir = await writeJournal(t, ID, journal)
    await t.exception(
      () => readCommitJournal(ID, initLayout(dir), createStorage()),
      CorruptJournalError,
      label
    )
  }
})

test('a corrupt directory replacement journal is rejected instead of silently repaired', async (t) => {
  const dedup = {
    dedupName: `${ATTEMPT}.dedup`,
    dedupTreeIdentity: IDENTITY
  }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wrong intent', replacementJournal({ intent: 'create-directory' })],
    ['unknown state', replacementJournal({ state: 'done' })],
    ['unknown phase', replacementJournal({ phase: 'exchanged' })],
    ['non-hex attempt', replacementJournal({ attemptId: 'not-hex' })],
    ['publication name mismatch', replacementJournal({ publicationName: `${OTHER_ID}.tree` })],
    ['publication is a part file', replacementJournal({ publicationName: `${ATTEMPT}.part` })],
    ['history name mismatch', replacementJournal({ historyName: `history-${OTHER_ID}` })],
    ['reserved name', replacementJournal({ name: `history-${OLD_ID}` })],
    ['identity missing', replacementJournal({ oldTreeIdentity: { dev: '66' } })],
    ['current record is a file record', replacementJournal({ record: fileRecord() })],
    [
      'old record is a history record',
      replacementJournal({ oldRecord: historyRecordShape({ name: `history-${OLD_ID}` }) })
    ],
    [
      'record name disagrees with the journal name',
      replacementJournal({ record: directoryRecord({ name: '0.18.2' }) })
    ],
    [
      'record transfer disagrees with the journal ID',
      replacementJournal({ record: directoryRecord({ transferId: OTHER_ID }) })
    ],
    [
      'the journal replaces its own transfer',
      replacementJournal({ oldRecord: directoryRecord({ transferId: ID }) })
    ],
    [
      'dedup record is not a history copy of this transfer',
      replacementJournal({
        ...dedup,
        dedupRecord: historyRecordShape({ transferId: OTHER_ID, name: `history-${OTHER_ID}` })
      })
    ],
    [
      'dedup record is a current record',
      replacementJournal({ ...dedup, dedupRecord: directoryRecord() })
    ],
    [
      'dedup name is not this attempt’s',
      replacementJournal({
        dedupName: `${OTHER_ID}.dedup`,
        dedupTreeIdentity: IDENTITY,
        dedupRecord: historyRecordShape({ transferId: ID, name: `history-${ID}` })
      })
    ]
  ]
  for (const [label, journal] of cases) {
    const root = await writeJournal(t, ID, journal)
    await t.exception(
      () => readCommitJournal(ID, initLayout(root), createStorage()),
      CorruptJournalError,
      label
    )
  }
})

test('an unknown journal version is corrupt, never guessed at', async (t) => {
  const root = await writeJournal(t, ID, { ...replacementJournal(), version: 5 })
  await t.exception(
    () => readCommitJournal(ID, initLayout(root), createStorage()),
    CorruptJournalError
  )
})
