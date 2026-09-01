'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { validateBasename } = require('../files')
const { transferId } = require('../protocol/transfer-id')
const { assertFixed32, assertSafeUint } = require('../protocol/validation')
const {
  assertSafeDirectory,
  assertSafeFile,
  openSafeRegularFile,
  withSafeDirectoryIdentity
} = require('./layout')
const { writeAtomic, readJson, MetadataFormatError } = require('./atomic-file')
const { withRootLease } = require('./root-coordinator')

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

function commitError(message, cause = null) {
  return new SwarmDeployError(ERRORS.COMMIT_FAILED, message, cause)
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new SwarmDeployError(ERRORS.REVOKED, 'Upload access was revoked')
}

function toHex(bytes) {
  return b4a.toString(bytes, 'hex')
}

function isHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isCommitRecordName(name) {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
}

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.cause?.code === 'ENOENT'
}

function attemptId() {
  return toHex(crypto.randomBytes(32))
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

function fingerprint(ownerKey) {
  return toHex(crypto.createHash('sha256').update(ownerKey).digest())
}

function recordsEqual(left, right) {
  return (
    left.version === right.version &&
    left.name === right.name &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.committedAt === right.committedAt &&
    left.uploaderFingerprint === right.uploaderFingerprint &&
    left.transferId === right.transferId
  )
}

function assertRecord(record) {
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

function assertSession(session) {
  if (!session || typeof session !== 'object') throw storageError('Invalid commit session')
  if (session.state !== 'verified') throw storageError('Session is not verified')
  if (!isHex(session.id)) throw storageError('Invalid session ID')
  assertFixed32(session.transferId, 'session transfer ID')
  assertFixed32(session.ownerKey, 'session owner key')
  validateBasename(session.name)
  assertSafeUint(session.size, 'session size')
  assertFixed32(session.digest, 'session digest')
  assertSafeUint(session.chunkSize, 'session chunk size')
  if (session.id !== toHex(session.transferId)) throw storageError('Session ID mismatch')

  const expectedId = transferId({
    clientPublicKey: session.ownerKey,
    name: session.name,
    size: session.size,
    digest: session.digest,
    chunkSize: session.chunkSize
  })
  if (!b4a.equals(expectedId, session.transferId)) throw storageError('Noncanonical session ID')
}

async function readExactly(handle, bytes, position) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
    const count = typeof read === 'number' ? read : read.bytesRead
    if (!Number.isSafeInteger(count) || count <= 0) return false
    offset += count
  }
  return true
}

async function writeAll(handle, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
    const count = typeof written === 'number' ? written : written.bytesWritten
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw storageError('Unable to write commit journal')
    }
    offset += count
  }
}

async function syncDirectory(directory, storage) {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function digestExactFile(filePath, size, storage, syncFirst = false) {
  return withSafeDirectoryIdentity(path.dirname(filePath), storage, async () => {
    const handle = await openSafeRegularFile(filePath, 'read', storage)
    try {
      if (syncFirst) await handle.sync()
      const before = await handle.stat()
      if (!before.isFile() || before.size !== size) return null

      const hash = crypto.createHash('sha256')
      let position = 0
      while (position < size) {
        const bytes = b4a.alloc(Math.min(64 * 1024, size - position))
        if (!(await readExactly(handle, bytes, position))) return null
        hash.update(bytes)
        position += bytes.byteLength
      }

      const after = await handle.stat()
      if (
        !after.isFile() ||
        after.size !== size ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return null
      }
      return {
        digest: hash.digest(),
        identity: fileIdentity(before)
      }
    } finally {
      await handle.close()
    }
  })
}

class CommitStore {
  constructor({ layout, clock = Date, storage = fs.promises }) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')

    this.layout = layout
    this.clock = clock
    this.storage = storage
  }

  _stagingPath(id) {
    return path.join(this.layout.staging, `${id}.part`)
  }

  _sessionPath(id) {
    return path.join(this.layout.sessions, `${id}.json`)
  }

  _journalPath(id) {
    return path.join(this.layout.journals, `${id}.json`)
  }

  _recordPath(id) {
    return path.join(this.layout.commits, `${id}.json`)
  }

  _finalPath(name) {
    return path.join(this.layout.root, name)
  }

  async _assertLayout() {
    for (const directory of [
      this.layout.root,
      this.layout.internal,
      this.layout.staging,
      this.layout.sessions,
      this.layout.commits,
      this.layout.journals
    ]) {
      await assertSafeDirectory(directory, this.storage)
    }
  }

  async _safeFileOrAbsent(filePath, directory) {
    try {
      return await withSafeDirectoryIdentity(directory, this.storage, () =>
        assertSafeFile(filePath, this.storage)
      )
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  async _readRecordOrAbsent(recordPath) {
    const stat = await this._safeFileOrAbsent(recordPath, this.layout.commits)
    if (!stat) return null
    return assertRecord(await readJson(recordPath, this.storage, MAX_COMMIT_METADATA_BYTES))
  }

  async _writeRecord(record) {
    const recordPath = this._recordPath(record.transferId)
    const existing = await this._readRecordOrAbsent(recordPath)
    if (existing) {
      if (!recordsEqual(existing, record)) throw storageError('Conflicting commit record')
      return false
    }
    await writeAtomic(recordPath, b4a.from(JSON.stringify(record)), this.storage)
    return true
  }

  async _removeFile(filePath, directory) {
    let removed = false
    await withSafeDirectoryIdentity(directory, this.storage, async () => {
      try {
        await assertSafeFile(filePath, this.storage)
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      await this.storage.unlink(filePath)
      removed = true
    })
    if (removed) {
      await withSafeDirectoryIdentity(directory, this.storage, () =>
        syncDirectory(directory, this.storage)
      )
    }
    return removed
  }

  async _removeManagedFinalOrAbsent(record) {
    let removed = false
    let preservedPath = false
    const finalPath = this._finalPath(record.name)
    await withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      let stat
      try {
        stat = await this.storage.lstat(finalPath)
      } catch (err) {
        if (isMissing(err)) return
        throw err
      }
      if (stat.isDirectory()) {
        try {
          await this.storage.rmdir(finalPath)
          removed = true
        } catch (err) {
          if (err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST') {
            preservedPath = true
            return
          }
          throw err
        }
        return
      }
      await this.storage.unlink(finalPath)
      removed = true
    })
    if (removed) {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
    }
    return { removed, preservedPath }
  }

  async _writeJournal(record, sourceStagingIdentity) {
    const id = attemptId()
    const journalPath = this._journalPath(record.transferId)
    if (await this._safeFileOrAbsent(journalPath, this.layout.journals)) {
      throw storageError('Commit journal already exists')
    }
    const journal = {
      version: JOURNAL_VERSION,
      state: 'committing',
      transferId: record.transferId,
      attemptId: id,
      sourceStagingIdentity,
      record
    }
    const temporary = path.join(this.layout.journals, `.${record.transferId}.${id}.tmp`)
    const bytes = b4a.from(JSON.stringify(journal))
    try {
      await withSafeDirectoryIdentity(this.layout.journals, this.storage, async () => {
        const handle = await openSafeRegularFile(temporary, 'create', this.storage)
        try {
          await writeAll(handle, bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.storage.link(temporary, journalPath)
        await syncDirectory(this.layout.journals, this.storage)
      })
    } finally {
      await this._removeFile(temporary, this.layout.journals).catch(() => {})
    }
    return id
  }

  async _discardJournal(id, expectedAttemptId) {
    const journal = await this._readJournal(id)
    if (!journal || journal.attemptId !== expectedAttemptId) return false
    return this._removeFile(this._journalPath(id), this.layout.journals)
  }

  async _linkStaging(stagingPath, finalPath, expectedIdentity, signal) {
    return withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.staging, this.storage, async () => {
        const staging = await assertSafeFile(stagingPath, this.storage)
        if (!identitiesEqual(fileIdentity(staging), expectedIdentity)) {
          throw storageError('Staging file changed before commit')
        }
        assertNotAborted(signal)
        await this.storage.link(stagingPath, finalPath)
        assertNotAborted(signal)
      })
    )
  }

  async _removeAbortedPublication(record, expectedIdentity) {
    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (final && identitiesEqual(fileIdentity(final), expectedIdentity)) {
      await this._removeFile(finalPath, this.layout.root)
    }
    const recordPath = this._recordPath(record.transferId)
    const sidecar = await this._readRecordOrAbsent(recordPath)
    if (sidecar && recordsEqual(sidecar, record)) {
      await this._removeFile(recordPath, this.layout.commits)
    }
  }

  async _matchesRecord(filePath, directory, record, syncFirst = false) {
    const stat = await this._safeFileOrAbsent(filePath, directory)
    if (!stat) return false
    const result = await digestExactFile(filePath, record.size, this.storage, syncFirst)
    return result !== null && b4a.equals(result.digest, b4a.from(record.sha256, 'hex'))
  }

  _recordFromSession(session) {
    assertSession(session)
    const record = {
      version: COMMIT_VERSION,
      name: session.name,
      size: session.size,
      sha256: toHex(session.digest),
      committedAt: this.clock.now(),
      uploaderFingerprint: fingerprint(session.ownerKey),
      transferId: session.id
    }
    return assertRecord(record)
  }

  async inspect(name, offer) {
    await this._assertLayout()
    validateBasename(name)
    if (!offer || typeof offer !== 'object') throw storageError('Invalid commit offer')
    if (offer.name !== name) throw storageError('Commit offer name mismatch')
    assertSafeUint(offer.size, 'commit offer size')
    assertFixed32(offer.digest, 'commit offer digest')
    assertFixed32(offer.transferId, 'commit offer transfer ID')

    const finalPath = this._finalPath(name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (!final) return { status: 'AVAILABLE' }

    const id = toHex(offer.transferId)
    const record = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      record &&
      record.name === name &&
      record.size === offer.size &&
      record.sha256 === toHex(offer.digest) &&
      record.transferId === id &&
      (await this._matchesRecord(finalPath, this.layout.root, record))
    ) {
      return { status: 'ALREADY_COMMITTED', record }
    }
    return { status: 'FILE_EXISTS' }
  }

  async commit(session, { retentionManager = null, signal = null } = {}) {
    assertSession(session)
    if (
      retentionManager !== null &&
      (typeof retentionManager.run !== 'function' ||
        typeof retentionManager.afterCommit !== 'function' ||
        typeof retentionManager._runUnlocked !== 'function' ||
        typeof retentionManager._afterCommitUnlocked !== 'function')
    ) {
      throw storageError('Invalid retention manager')
    }
    if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
      throw storageError('Invalid commit abort signal')
    }
    return withRootLease(this.layout.root, () => this._commit(session, retentionManager, signal))
  }

  async _commit(session, retentionManager, signal) {
    assertNotAborted(signal)
    await this._assertLayout()
    const record = this._recordFromSession(session)
    const stagingPath = this._stagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)

    const stagingDigest = await digestExactFile(stagingPath, record.size, this.storage, true)
    if (
      stagingDigest === null ||
      !b4a.equals(stagingDigest.digest, b4a.from(record.sha256, 'hex'))
    ) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging file checksum mismatch')
    }

    if (retentionManager) await retentionManager._runUnlocked({ incomingBytes: record.size })
    assertNotAborted(signal)

    const journalAttemptId = await this._writeJournal(record, stagingDigest.identity)
    let linked = false
    try {
      assertNotAborted(signal)
      await this._linkStaging(stagingPath, finalPath, stagingDigest.identity, signal)
      linked = true
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
      assertNotAborted(signal)
      await this._writeRecord(record)
      assertNotAborted(signal)
      await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
      assertNotAborted(signal)
      await this._removeFile(stagingPath, this.layout.staging)
      assertNotAborted(signal)
      await this._discardJournal(record.transferId, journalAttemptId)
      if (retentionManager) await retentionManager._afterCommitUnlocked()
      return record
    } catch (err) {
      if (err?.code === ERRORS.REVOKED) {
        try {
          await this._removeAbortedPublication(record, stagingDigest.identity)
        } catch (cleanupCause) {
          err.cleanupCause = cleanupCause
        }
        throw err
      }
      if (!linked && err?.code !== 'EEXIST') {
        const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
        linked =
          !!final &&
          identitiesEqual(fileIdentity(final), stagingDigest.identity) &&
          (await this._matchesRecord(finalPath, this.layout.root, record))
      }
      if (linked) throw err

      try {
        await this._discardJournal(record.transferId, journalAttemptId)
      } catch (cleanupCause) {
        const failure = commitError('Unable to create final artifact', err)
        failure.cleanupCause = cleanupCause
        throw failure
      }
      if (err?.code === 'EEXIST') {
        throw new SwarmDeployError(ERRORS.FILE_EXISTS, 'Destination already exists', err)
      }
      throw commitError('Unable to create final artifact', err)
    }
  }

  async _readJournal(id) {
    if (!isHex(id)) throw storageError('Invalid journal ID')
    const journalPath = this._journalPath(id)
    let journal
    try {
      const stat = await this._safeFileOrAbsent(journalPath, this.layout.journals)
      if (!stat) return null
      journal = await readJson(journalPath, this.storage, MAX_COMMIT_METADATA_BYTES)
      if (
        journal.version !== JOURNAL_VERSION ||
        journal.state !== 'committing' ||
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
        record = assertRecord(journal.record)
      } catch (err) {
        throw new CorruptJournalError('Invalid commit journal record', err)
      }
      if (record.transferId !== id) throw new CorruptJournalError('Commit journal ID mismatch')
      return {
        record,
        attemptId: journal.attemptId,
        sourceStagingIdentity: journal.sourceStagingIdentity
      }
    } catch (err) {
      if (err instanceof CorruptJournalError) throw err
      if (err instanceof MetadataFormatError) {
        throw new CorruptJournalError('Malformed commit journal', err)
      }
      throw err
    }
  }

  async recoverJournal(id, sessionStore) {
    await this._assertLayout()
    const journal = await this._readJournal(id)
    if (!journal) return { status: 'MISSING' }
    const { record, attemptId: journalAttemptId, sourceStagingIdentity } = journal

    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    const sidecar = await this._readRecordOrAbsent(this._recordPath(id))

    if (final) {
      const staging = await this._safeFileOrAbsent(this._stagingPath(id), this.layout.staging)
      const provenanced =
        identitiesEqual(fileIdentity(final), sourceStagingIdentity) ||
        (staging && identitiesEqual(fileIdentity(final), fileIdentity(staging)))
      if (!provenanced) {
        await this._discardJournal(id, journalAttemptId)
        return { status: 'FILE_EXISTS', record }
      }
      if (!(await this._matchesRecord(finalPath, this.layout.root, record))) {
        throw storageError('Final file does not match commit journal')
      }
      if (!sidecar) {
        const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
        if (
          session.name !== record.name ||
          session.size !== record.size ||
          toHex(session.digest) !== record.sha256 ||
          fingerprint(session.ownerKey) !== record.uploaderFingerprint
        ) {
          throw new CorruptJournalError('Commit journal does not match verified session')
        }
        await this._writeRecord(record)
      }
      if (sidecar && !recordsEqual(sidecar, record)) {
        throw storageError('Commit sidecar does not match journal')
      }
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
      await this._removeFile(this._stagingPath(id), this.layout.staging)
      await this._discardJournal(id, journalAttemptId)
      return { status: 'COMMITTED', record }
    }

    if (sidecar && !recordsEqual(sidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }
    if (sidecar) await this._removeFile(this._recordPath(id), this.layout.commits)

    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Session store cannot validate recovery state')
    }
    const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
    if (
      session.name !== record.name ||
      session.size !== record.size ||
      toHex(session.digest) !== record.sha256
    ) {
      throw storageError('Verified session does not match commit journal')
    }
    if (!(await this._matchesRecord(this._stagingPath(id), this.layout.staging, record))) {
      throw storageError('Verified staging does not match commit journal')
    }
    await this._discardJournal(id, journalAttemptId)
    return { status: 'RESUMABLE', record }
  }

  async list() {
    await this._assertLayout()
    const names = await withSafeDirectoryIdentity(this.layout.commits, this.storage, () =>
      this.storage.readdir(this.layout.commits)
    )
    const records = []
    const namesSeen = new Set()
    for (const filename of names.filter(isCommitRecordName).sort()) {
      const id = filename.slice(0, -'.json'.length)
      const record = await this._readRecordOrAbsent(this._recordPath(id))
      if (!record) throw storageError('Commit record disappeared during enumeration')
      if (record.transferId !== id) throw storageError('Commit record ID does not match path')
      if (namesSeen.has(record.name)) throw storageError('Duplicate managed commit filename')
      namesSeen.add(record.name)
      records.push(record)
    }
    return records
  }

  async delete(record) {
    await this._assertLayout()
    assertRecord(record)
    const stored = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (!stored) return false
    if (!recordsEqual(stored, record)) throw storageError('Commit record changed before deletion')

    const finalPath = this._finalPath(record.name)
    const final = await this._safeFileOrAbsent(finalPath, this.layout.root)
    if (final) await this._removeFile(finalPath, this.layout.root)
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return true
  }

  async purge(record) {
    await this._assertLayout()
    assertRecord(record)
    const stored = await this._readRecordOrAbsent(this._recordPath(record.transferId))
    if (!stored) return false
    if (!recordsEqual(stored, record)) throw storageError('Commit record changed before deletion')

    const final = await this._removeManagedFinalOrAbsent(record)
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    return { purged: true, preservedPath: final.preservedPath }
  }
}

module.exports = {
  CommitStore,
  CorruptJournalError,
  COMMIT_VERSION,
  MAX_COMMIT_METADATA_BYTES
}
