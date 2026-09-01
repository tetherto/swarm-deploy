'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const { SwarmDeployError, ERRORS } = require('../errors')
const { assertSafeDirectory, withSafeDirectoryIdentity } = require('./layout')
const { CorruptJournalError } = require('./commit-store')
const { RetentionManager } = require('./retention')

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function isJournalName(name) {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
}

function transferFingerprint(id) {
  return b4a
    .toString(crypto.createHash('sha256').update(b4a.from(id, 'hex')).digest(), 'hex')
    .slice(0, 12)
}

function report(logger, level, message, details) {
  if (!logger || typeof logger[level] !== 'function') return
  try {
    logger[level](message, details)
  } catch {}
}

function emit(onEvent, payload) {
  if (!onEvent) return
  try {
    onEvent(payload)
  } catch {}
}

function failureReason(err) {
  return typeof err?.code === 'string' && err.code.length > 0 ? err.code : ERRORS.PROTOCOL_INVALID
}

async function assertRecoveryLayout(layout, storage) {
  for (const directory of [
    layout.root,
    layout.internal,
    layout.staging,
    layout.sessions,
    layout.commits,
    layout.journals
  ]) {
    await assertSafeDirectory(directory, storage)
  }
}

async function prepareStorageRecovery({ layout, commitStore, logger = null, onEvent = null }) {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  if (!commitStore || typeof commitStore._readJournal !== 'function') {
    throw storageError('Invalid commit store')
  }
  if (typeof commitStore.retireCorruptAttempt !== 'function') {
    throw storageError('Commit store cannot retire corrupt attempts')
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw storageError('Invalid recovery event callback')
  }

  const storage = commitStore.storage || fs.promises
  let retired = 0
  let activeTransfer = null
  try {
    await assertRecoveryLayout(layout, storage)
    const names = await withSafeDirectoryIdentity(layout.journals, storage, () =>
      storage.readdir(layout.journals)
    )
    for (const name of names.sort()) {
      if (!isJournalName(name)) continue
      const id = name.slice(0, -'.json'.length)
      activeTransfer = transferFingerprint(id)
      try {
        await commitStore._readJournal(id)
      } catch (err) {
        if (!(err instanceof CorruptJournalError)) throw err
        const result = await commitStore.retireCorruptAttempt(id)
        retired++
        report(logger, 'warn', 'Retired corrupt commit attempt before session recovery', {
          transferId: id
        })
        emit(onEvent, {
          type: 'recovery',
          status: 'CORRUPT',
          phase: 'classification',
          transfer: activeTransfer
        })
        if (result.removedStaging) {
          emit(onEvent, {
            type: 'cleanup',
            transfer: activeTransfer,
            name: null,
            reason: 'corrupt-journal'
          })
        }
      }
      activeTransfer = null
    }
  } catch (err) {
    emit(onEvent, {
      type: 'recovery',
      status: 'failed',
      phase: 'classification',
      ...(activeTransfer ? { transfer: activeTransfer } : {}),
      reason: failureReason(err)
    })
    throw err
  }
  return retired
}

async function recoverStorage({
  layout,
  sessionStore,
  commitStore,
  logger = null,
  isAuthorized = null,
  onEvent = null
}) {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  if (!sessionStore || typeof sessionStore !== 'object') throw storageError('Invalid session store')
  if (!commitStore || typeof commitStore.recoverJournal !== 'function') {
    throw storageError('Invalid commit store')
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw storageError('Invalid recovery event callback')
  }

  const storage = commitStore.storage || fs.promises
  let names
  try {
    await assertRecoveryLayout(layout, storage)
    names = await withSafeDirectoryIdentity(layout.journals, storage, () =>
      storage.readdir(layout.journals)
    )
  } catch (err) {
    emit(onEvent, {
      type: 'recovery',
      status: 'failed',
      phase: 'journal',
      reason: failureReason(err)
    })
    throw err
  }
  const results = []
  for (const name of names.sort()) {
    if (!isJournalName(name)) {
      report(logger, 'warn', 'Ignoring unknown journal path', { name })
      continue
    }
    const id = name.slice(0, -'.json'.length)
    let result
    try {
      result = await commitStore.recoverJournal(id, sessionStore, { isAuthorized })
    } catch (err) {
      if (!(err instanceof CorruptJournalError)) {
        emit(onEvent, {
          type: 'recovery',
          status: 'failed',
          phase: 'journal',
          transfer: transferFingerprint(id),
          reason: failureReason(err)
        })
        throw err
      }
      if (typeof commitStore.retireCorruptAttempt !== 'function') {
        throw storageError('Commit store cannot retire corrupt attempts')
      }
      let retired
      try {
        retired = await commitStore.retireCorruptAttempt(id)
      } catch (retireError) {
        emit(onEvent, {
          type: 'recovery',
          status: 'failed',
          phase: 'journal',
          transfer: transferFingerprint(id),
          reason: failureReason(retireError)
        })
        throw retireError
      }
      result = { status: 'CORRUPT', reason: err.message }
      report(logger, 'warn', 'Skipping corrupt commit journal', {
        transferId: id,
        reason: err.message
      })
      if (retired.removedStaging) {
        emit(onEvent, {
          type: 'cleanup',
          transfer: transferFingerprint(id),
          name: null,
          reason: 'corrupt-journal'
        })
      }
    }
    results.push(result)
    report(logger, 'info', 'Recovered commit journal', { transferId: id, status: result.status })
    emit(onEvent, {
      type: 'recovery',
      status: result.status,
      transfer: transferFingerprint(id)
    })

    if (
      (result.status === 'COMMITTED' || result.status === 'ABORTED') &&
      sessionStore.initialized &&
      !sessionStore.closed &&
      typeof sessionStore.delete === 'function'
    ) {
      await sessionStore.delete(b4a.from(id, 'hex'))
    }
  }
  const retention = new RetentionManager({
    layout,
    sessionStore,
    commitStore,
    storage,
    isSessionActive: () => false,
    logger
  })
  emit(onEvent, { type: 'scrub', status: 'started' })
  try {
    const scrub = await retention.scrubCommitted()
    emit(onEvent, {
      type: 'scrub',
      status: 'completed',
      deleted: scrub.deleted,
      unknownCount: scrub.unknown.length
    })
  } catch (err) {
    emit(onEvent, {
      type: 'scrub',
      status: 'failed',
      reason: failureReason(err)
    })
    throw err
  }
  return results
}

module.exports = {
  prepareStorageRecovery,
  recoverStorage
}
