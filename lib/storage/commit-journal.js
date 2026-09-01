'use strict'

const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { validateBasename } = require('../files')
const { assertSafeUint } = require('../protocol/validation')
const { assertSafeFile } = require('./layout')
const { readJson, MetadataFormatError } = require('./atomic-file')

const COMMIT_VERSION = 1
const JOURNAL_VERSION = 1
const MAX_COMMIT_METADATA_BYTES = 16 * 1024

class CorruptJournalError extends Error {
  constructor(message, cause = null) {
    super(message)
    this.name = 'CorruptJournalError'
    this.cause = cause
  }
}

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function isHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.cause?.code === 'ENOENT'
}

function identityValue(value) {
  if (
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) &&
    (typeof value !== 'bigint' || value < 0n)
  ) {
    throw storageError('Storage file identity is unavailable')
  }
  return String(value)
}

function fileIdentity(stat) {
  return { dev: identityValue(stat.dev), ino: identityValue(stat.ino) }
}

function identitiesEqual(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function assertCommitRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw storageError('Invalid commit record')
  }
  if (record.version !== COMMIT_VERSION) throw storageError('Invalid commit record version')
  validateBasename(record.name)
  assertSafeUint(record.size, 'commit size')
  if (!isHex(record.sha256)) throw storageError('Invalid commit digest')
  assertSafeUint(record.committedAt, 'commit timestamp')
  if (!isHex(record.uploaderFingerprint)) throw storageError('Invalid uploader fingerprint')
  if (!isHex(record.transferId)) throw storageError('Invalid commit transfer ID')
  return record
}

async function readCommitJournal(id, layout, storage) {
  if (!isHex(id)) throw storageError('Invalid journal ID')
  const journalPath = path.join(layout.journals, `${id}.json`)
  let journal
  try {
    try {
      await assertSafeFile(journalPath, storage)
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
    journal = await readJson(journalPath, storage, MAX_COMMIT_METADATA_BYTES)
    if (
      journal.version !== JOURNAL_VERSION ||
      (journal.state !== 'committing' && journal.state !== 'aborting') ||
      journal.transferId !== id ||
      !isHex(journal.attemptId) ||
      !journal.sourceStagingIdentity ||
      !/^(0|[1-9][0-9]*)$/.test(journal.sourceStagingIdentity.dev) ||
      !/^(0|[1-9][0-9]*)$/.test(journal.sourceStagingIdentity.ino)
    ) {
      throw new CorruptJournalError('Invalid commit journal')
    }
    let record
    try {
      record = assertCommitRecord(journal.record)
    } catch (err) {
      throw new CorruptJournalError('Invalid commit journal record', err)
    }
    if (record.transferId !== id) throw new CorruptJournalError('Commit journal ID mismatch')
    return {
      record,
      attemptId: journal.attemptId,
      sourceStagingIdentity: journal.sourceStagingIdentity,
      state: journal.state
    }
  } catch (err) {
    if (err instanceof CorruptJournalError) throw err
    if (err instanceof MetadataFormatError) {
      throw new CorruptJournalError('Malformed commit journal', err)
    }
    throw err
  }
}

module.exports = {
  CorruptJournalError,
  COMMIT_VERSION,
  JOURNAL_VERSION,
  MAX_COMMIT_METADATA_BYTES,
  assertCommitRecord,
  readCommitJournal,
  isHex,
  fileIdentity,
  identitiesEqual
}
