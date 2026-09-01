'use strict'

const { EventEmitter } = require('#events')
const fs = require('#fs')
const { parsePublicKey } = require('./identity')

const DEFAULT_POLL_INTERVAL = 5_000
const MAX_POLL_INTERVAL = 0x7fffffff

function assertPollInterval(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_POLL_INTERVAL) {
    throw new RangeError('Invalid allowlist poll interval')
  }
}

function parseAllowlist(text) {
  if (typeof text !== 'string') throw new TypeError('Allowlist must be text')

  const keys = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    parsePublicKey(line)
    keys.add(line)
  }
  return keys
}

class AllowlistWatcher extends EventEmitter {
  constructor({
    filePath,
    storage = fs.promises,
    onReload,
    pollInterval = DEFAULT_POLL_INTERVAL,
    scheduler = { setInterval, clearInterval },
    logger = null
  }) {
    super()
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('Invalid allowlist path')
    }
    if (!storage || typeof storage.readFile !== 'function') {
      throw new TypeError('Invalid allowlist storage')
    }
    if (typeof onReload !== 'function') throw new TypeError('Invalid allowlist reload handler')
    assertPollInterval(pollInterval)
    if (
      !scheduler ||
      typeof scheduler.setInterval !== 'function' ||
      typeof scheduler.clearInterval !== 'function'
    ) {
      throw new TypeError('Invalid allowlist scheduler')
    }

    this.filePath = filePath
    this.storage = storage
    this.onReload = onReload
    this.pollInterval = pollInterval
    this.scheduler = scheduler
    this.logger = logger
    this.keys = new Set()
    this.timer = null
    this.closed = false
    this.pending = Promise.resolve()
  }

  _report(level, message, details) {
    if (!this.logger || typeof this.logger[level] !== 'function') return
    try {
      this.logger[level](message, details)
    } catch {}
  }

  poll() {
    const run = this.pending.then(
      () => this._poll(),
      () => this._poll()
    )
    this.pending = run.catch(() => {})
    return run
  }

  async _poll() {
    if (this.closed) return false
    const text = await this.storage.readFile(this.filePath, 'utf8')
    const next = parseAllowlist(typeof text === 'string' ? text : text.toString())
    try {
      await this.onReload(new Set(next))
    } catch (err) {
      if (!err?.allowlistApplied) throw err
      this._applySnapshot(next)
      throw err
    }
    this._applySnapshot(next)
    return true
  }

  _applySnapshot(next) {
    const previous = this.keys
    this.keys = next
    let removed = 0
    for (const key of previous) if (!next.has(key)) removed++
    if (removed > 0) this.emit('removed', { removed })
    this.emit('reloaded', { count: next.size })
  }

  async load() {
    if (this.closed) return false
    return this.poll()
  }

  startPolling() {
    if (this.closed || this.timer) return
    this.timer = this.scheduler.setInterval(() => {
      this.poll().catch((err) => {
        this._report('warn', 'Allowlist reload failed', { message: err.message })
      })
    }, this.pollInterval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async start() {
    if (this.closed || this.timer) return
    await this.load()
    if (this.closed || this.timer) return
    this.startPolling()
  }

  async close() {
    this.closed = true
    if (this.timer) this.scheduler.clearInterval(this.timer)
    this.timer = null
    await this.pending
  }
}

module.exports = {
  parseAllowlist,
  AllowlistWatcher,
  DEFAULT_POLL_INTERVAL,
  MAX_POLL_INTERVAL
}
