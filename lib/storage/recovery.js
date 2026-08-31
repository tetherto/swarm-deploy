'use strict'

const b4a = require('b4a')
const fs = require('#fs')
const { SwarmDeployError, ERRORS } = require('../errors')
const { assertSafeDirectory, withSafeDirectoryIdentity } = require('./layout')

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function isJournalName(name) {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
}

function report(logger, level, message, details) {
  if (!logger || typeof logger[level] !== 'function') return
  logger[level](message, details)
}

async function recoverStorage({ layout, sessionStore, commitStore, logger = null }) {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  if (!sessionStore || typeof sessionStore !== 'object') throw storageError('Invalid session store')
  if (!commitStore || typeof commitStore.recoverJournal !== 'function') {
    throw storageError('Invalid commit store')
  }

  const storage = commitStore.storage || fs.promises
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

  const names = await withSafeDirectoryIdentity(layout.journals, storage, () =>
    storage.readdir(layout.journals)
  )
  const results = []
  for (const name of names.sort()) {
    if (!isJournalName(name)) {
      report(logger, 'warn', 'Ignoring unknown journal path', { name })
      continue
    }
    const id = name.slice(0, -'.json'.length)
    const result = await commitStore.recoverJournal(id)
    results.push(result)
    report(logger, 'info', 'Recovered commit journal', { transferId: id, status: result.status })

    if (
      result.status === 'COMMITTED' &&
      sessionStore.initialized &&
      !sessionStore.closed &&
      typeof sessionStore.delete === 'function'
    ) {
      await sessionStore.delete(b4a.from(id, 'hex'))
    }
  }
  return results
}

module.exports = {
  recoverStorage
}
