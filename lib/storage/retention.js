'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { SwarmDeployError, ERRORS } = require('../errors')
const { assertSafeDirectory, openSafeRegularFile, withSafeDirectoryIdentity } = require('./layout')
const { assertSafeUint } = require('../protocol/validation')
const { withRootLease } = require('./root-coordinator')

const DEFAULT_RESUME_TTL = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL = 15 * 60 * 1000
const MAX_CLEANUP_INTERVAL = 0x7fffffff

function storageError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function cleanupError(message, cause = null) {
  return new SwarmDeployError(ERRORS.CLEANUP_FAILED, message, cause)
}

function isMissing(err) {
  return err?.code === 'ENOENT' || err?.cause?.code === 'ENOENT'
}

function assertPositiveSafeUint(value, name) {
  assertSafeUint(value, name)
  if (value === 0) throw storageError(`Invalid ${name}`)
}

function report(logger, level, message, details) {
  if (!logger || typeof logger[level] !== 'function') return
  try {
    logger[level](message, details)
  } catch {}
}

function compareRecords(left, right) {
  if (left.committedAt !== right.committedAt) return left.committedAt - right.committedAt
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function identityMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino
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

async function inspectManagedFinal(record, { layout, storage, hash }) {
  const finalPath = path.join(layout.root, record.name)
  return withSafeDirectoryIdentity(layout.root, storage, async () => {
    let initial
    try {
      initial = await storage.lstat(finalPath)
    } catch (err) {
      if (isMissing(err)) return 'MISSING'
      throw err
    }
    if (initial.isSymbolicLink()) return 'SYMLINK'
    if (!initial.isFile()) return 'NON_REGULAR'
    if (initial.size !== record.size) return 'WRONG_SIZE'
    if (!hash) return 'VALID'

    const digest = crypto.createHash('sha256')
    let handle = null
    try {
      handle = await openSafeRegularFile(finalPath, 'read', storage)
      const before = await handle.stat()
      if (!before.isFile() || before.size !== record.size || !identityMatches(initial, before)) {
        return 'CHANGED'
      }
      let position = 0
      while (position < record.size) {
        const bytes = b4a.alloc(Math.min(64 * 1024, record.size - position))
        if (!(await readExactly(handle, bytes, position))) return 'TRUNCATED'
        digest.update(bytes)
        position += bytes.byteLength
      }
      const after = await handle.stat()
      if (
        !after.isFile() ||
        after.size !== record.size ||
        !identityMatches(before, after) ||
        !b4a.equals(digest.digest(), b4a.from(record.sha256, 'hex'))
      ) {
        return 'DIGEST_INVALID'
      }
      return 'VALID'
    } finally {
      if (handle) await handle.close()
    }
  })
}

class RetentionManager {
  constructor({
    layout,
    sessionStore,
    commitStore,
    maxAge,
    maxStorageBytes,
    resumeTtl = DEFAULT_RESUME_TTL,
    cleanupInterval = DEFAULT_CLEANUP_INTERVAL,
    clock = Date,
    storage = commitStore?.storage || fs.promises,
    isSessionActive,
    logger = null,
    scheduler = { setInterval, clearInterval }
  }) {
    if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
    if (!sessionStore || typeof sessionStore.expire !== 'function') {
      throw storageError('Invalid session store')
    }
    if (
      !commitStore ||
      typeof commitStore.list !== 'function' ||
      typeof commitStore.delete !== 'function' ||
      typeof commitStore.purge !== 'function'
    ) {
      throw storageError('Invalid commit store')
    }
    if (!clock || typeof clock.now !== 'function') throw storageError('Invalid clock')
    if (!storage || typeof storage !== 'object') throw storageError('Invalid storage adapter')
    if (
      !scheduler ||
      typeof scheduler.setInterval !== 'function' ||
      typeof scheduler.clearInterval !== 'function'
    )
      throw storageError('Invalid retention scheduler')
    if (typeof isSessionActive !== 'function')
      throw storageError('Invalid session activity predicate')
    if (maxAge !== undefined) assertSafeUint(maxAge, 'maxAge')
    if (maxStorageBytes !== undefined) assertSafeUint(maxStorageBytes, 'maxStorageBytes')
    assertPositiveSafeUint(resumeTtl, 'resumeTtl')
    assertPositiveSafeUint(cleanupInterval, 'cleanupInterval')
    if (cleanupInterval > MAX_CLEANUP_INTERVAL) throw storageError('Invalid cleanupInterval')

    this.layout = layout
    this.sessionStore = sessionStore
    this.commitStore = commitStore
    this.maxAge = maxAge
    this.maxStorageBytes = maxStorageBytes
    this.resumeTtl = resumeTtl
    this.cleanupInterval = cleanupInterval
    this.clock = clock
    this.storage = storage
    this.isSessionActive = isSessionActive
    this.logger = logger
    this.timer = null
    this.cleanupFailure = null
    this.scheduler = scheduler
    this.startPromise = null
    this.tickPromise = null
    this.tickQueued = false
    this.lifecycle = 0
  }

  async expireSessions() {
    return this.sessionStore.expire(this.resumeTtl, (session) => !this.isSessionActive(session))
  }

  async scrubCommitted({ hash = true } = {}) {
    if (typeof hash !== 'boolean') throw storageError('Invalid scrub hash option')
    for (const directory of [this.layout.root, this.layout.internal, this.layout.commits]) {
      await assertSafeDirectory(directory, this.storage)
    }
    const records = await this.commitStore.list()
    const knownNames = new Set(records.map((record) => record.name))
    const rootNames = await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.readdir(this.layout.root)
    )
    const unknown = rootNames
      .filter((name) => name !== '.swarm-deploy' && !knownNames.has(name))
      .sort()
    for (const name of unknown)
      report(this.logger, 'warn', 'Ignoring unknown committed path', { name })

    const valid = []
    let deleted = 0
    for (const record of records) {
      const status = await inspectManagedFinal(record, {
        layout: this.layout,
        storage: this.storage,
        hash
      })
      if (status === 'VALID') {
        valid.push(record)
        continue
      }
      let purged
      try {
        purged = await this.commitStore.purge(record)
        if (!purged) {
          throw storageError('Managed commit record disappeared during scrub')
        }
      } catch (err) {
        throw cleanupError('Unable to remove invalid managed commit', err)
      }
      deleted++
      if (purged.preservedPath) {
        unknown.push(record.name)
        report(this.logger, 'warn', 'Preserving non-empty managed directory', {
          name: record.name
        })
      }
      report(this.logger, 'warn', 'Removed invalid managed commit', {
        name: record.name,
        reason: status
      })
    }
    return { records: valid, deleted, unknown: unknown.sort() }
  }

  async _deleteRecord(record, reason) {
    try {
      if (!(await this.commitStore.delete(record))) {
        throw storageError('Managed commit record disappeared during retention')
      }
    } catch (err) {
      throw cleanupError('Unable to remove managed commit', err)
    }
    report(this.logger, 'info', 'Removed managed commit', { name: record.name, reason })
  }

  _totalSize(records) {
    let total = 0
    for (const record of records) {
      if (total > Number.MAX_SAFE_INTEGER - record.size) {
        throw storageError('Managed commit size exceeds safe integer range')
      }
      total += record.size
    }
    return total
  }

  run(options = {}) {
    return withRootLease(this.layout.root, () => this._runUnlocked(options))
  }

  async _runUnlocked(options = {}) {
    const result = await this._run(options)
    this.cleanupFailure = null
    return result
  }

  async _run({ incomingBytes = 0 } = {}) {
    assertSafeUint(incomingBytes, 'incomingBytes')
    if (this.maxStorageBytes !== undefined && incomingBytes > this.maxStorageBytes) {
      throw new SwarmDeployError(
        ERRORS.FILE_TOO_LARGE,
        'Incoming artifact exceeds committed storage limit'
      )
    }

    const expiredSessions = await this.expireSessions()
    const scrub = await this.scrubCommitted({ hash: false })
    const current = scrub.records.slice()
    let ageDeleted = 0
    if (this.maxAge !== undefined) {
      const now = this.clock.now()
      assertSafeUint(now, 'current timestamp')
      for (const record of current.slice().sort(compareRecords)) {
        if (now < record.committedAt || now - record.committedAt < this.maxAge) continue
        await this._deleteRecord(record, 'MAX_AGE')
        current.splice(current.indexOf(record), 1)
        ageDeleted++
      }
    }

    let storageDeleted = 0
    if (this.maxStorageBytes !== undefined) {
      const permitted = this.maxStorageBytes - incomingBytes
      let total = this._totalSize(current)
      for (const record of current.slice().sort(compareRecords)) {
        if (total <= permitted) break
        await this._deleteRecord(record, 'MAX_STORAGE')
        total -= record.size
        storageDeleted++
      }
      if (total > permitted) throw storageError('Unable to reserve committed storage capacity')
    }
    return { expiredSessions, scrubbed: scrub.deleted, ageDeleted, storageDeleted }
  }

  async afterCommit() {
    return withRootLease(this.layout.root, () => this._afterCommitUnlocked())
  }

  async _afterCommitUnlocked() {
    try {
      await this._runUnlocked()
      return true
    } catch (err) {
      this.cleanupFailure = err
      report(this.logger, 'error', 'Post-commit retention failed', { message: err.message })
      return false
    }
  }

  start() {
    if (this.timer) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    const lifecycle = ++this.lifecycle
    const start = (async () => {
      await this.run()
      if (lifecycle !== this.lifecycle || this.timer) return
      this.timer = this.scheduler.setInterval(
        () => this._scheduleTick(lifecycle),
        this.cleanupInterval
      )
      if (typeof this.timer.unref === 'function') this.timer.unref()
    })()
    this.startPromise = start
    start.then(
      () => {
        if (this.startPromise === start) this.startPromise = null
      },
      () => {
        if (this.startPromise === start) this.startPromise = null
      }
    )
    return start
  }

  _scheduleTick(lifecycle) {
    if (lifecycle !== this.lifecycle || !this.timer) return
    if (this.tickPromise) {
      this.tickQueued = true
      return
    }
    const tick = this._drainTicks(lifecycle)
    this.tickPromise = tick
    tick.then(
      () => {
        if (this.tickPromise === tick) this.tickPromise = null
      },
      () => {
        if (this.tickPromise === tick) this.tickPromise = null
      }
    )
  }

  async _drainTicks(lifecycle) {
    do {
      this.tickQueued = false
      try {
        await this.run()
      } catch (err) {
        report(this.logger, 'error', 'Scheduled retention failed', { message: err.message })
      }
    } while (this.tickQueued && lifecycle === this.lifecycle && this.timer)
  }

  async stop() {
    this.lifecycle++
    if (this.timer) this.scheduler.clearInterval(this.timer)
    this.timer = null
    this.tickQueued = false
    await Promise.allSettled([this.startPromise, this.tickPromise].filter(Boolean))
  }

  close() {
    return this.stop()
  }
}

module.exports = {
  RetentionManager,
  DEFAULT_RESUME_TTL,
  DEFAULT_CLEANUP_INTERVAL,
  MAX_CLEANUP_INTERVAL
}
