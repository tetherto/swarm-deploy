'use strict'

const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const { EventEmitter } = require('#events')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const { SwarmDeployError, ERRORS } = require('./errors')
const { abortError, throwIfAborted, onAbort, createAbortController } = require('./abort')
const { keyPairFromSeed } = require('./identity')
const { topicFromServerPublicKey } = require('./topic')
const { selectUploadPaths, buildFileManifest } = require('./files')
const { ClientSession, UPLOAD_PROTOCOL } = require('./protocol/client-session')

const DEFAULT_CONNECT_TIMEOUT = 30_000
const MAX_CONNECT_TIMEOUT = 30_000
const DEFAULT_IDLE_TIMEOUT = 60_000
const MAX_IDLE_TIMEOUT = 0x7fffffff
const INITIAL_RECONNECT_DELAY = 25
const MAX_RECONNECT_DELAY = 1_000
const FINGERPRINT_LENGTH = 12

function configurationError(code, message, cause = null) {
  return new SwarmDeployError(code, message, cause)
}

function assertSeed(seed) {
  if (!b4a.isBuffer(seed) || seed.byteLength !== 32) {
    throw configurationError(ERRORS.INVALID_SEED, 'Invalid client seed')
  }
}

function assertPublicKey(key) {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) {
    throw configurationError(ERRORS.INVALID_PUBLIC_KEY, 'Invalid server public key')
  }
}

function assertDuration(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(ERRORS.PROTOCOL_INVALID, `Invalid ${name}`)
  }
}

function fingerprint(key) {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) return 'invalid'
  return b4a.toString(crypto.createHash('sha256').update(key).digest()).slice(0, FINGERPRINT_LENGTH)
}

function createSafeLogger(logger) {
  return {
    info(message, details) {
      if (!logger || typeof logger.info !== 'function') return
      try {
        logger.info(message, details)
      } catch {}
    },
    warn(message, details) {
      if (!logger || typeof logger.warn !== 'function') return
      try {
        logger.warn(message, details)
      } catch {}
    },
    error(message, details) {
      if (!logger || typeof logger.error !== 'function') return
      try {
        logger.error(message, details)
      } catch {}
    }
  }
}

function isTransportError(error) {
  return error instanceof SwarmDeployError && error.transport === true
}

function clientClosedError() {
  return configurationError(ERRORS.PROTOCOL_INVALID, 'Client is closed')
}

function awaitAbortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const removeAbort = onAbort(signal, () => reject(abortError()))
    Promise.resolve(promise).then(
      (value) => {
        removeAbort()
        resolve(value)
      },
      (err) => {
        removeAbort()
        reject(err)
      }
    )
  })
}

class Client extends EventEmitter {
  constructor(options = {}) {
    super()
    if (!options || typeof options !== 'object') {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid client options')
    }
    assertSeed(options.seed)
    assertPublicKey(options.serverPublicKey)
    const connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    assertDuration(connectTimeout, 'connect timeout', MAX_CONNECT_TIMEOUT)
    assertDuration(idleTimeout, 'idle timeout', MAX_IDLE_TIMEOUT)
    if (options.swarmFactory !== undefined && typeof options.swarmFactory !== 'function') {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm factory')
    }
    if (
      options.scheduler &&
      (typeof options.scheduler.setTimeout !== 'function' ||
        typeof options.scheduler.clearTimeout !== 'function')
    ) {
      throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid client scheduler')
    }

    this._keyPair = keyPairFromSeed(b4a.from(options.seed))
    this.publicKey = b4a.from(this._keyPair.publicKey)
    this.serverPublicKey = b4a.from(options.serverPublicKey)
    if (crypto.timingSafeEqual(this.publicKey, this.serverPublicKey)) {
      throw configurationError(
        ERRORS.SERVER_KEY_MISMATCH,
        'Client and pinned server identities must be different'
      )
    }
    this.topic = topicFromServerPublicKey(this.serverPublicKey)
    this.connectTimeout = connectTimeout
    this.idleTimeout = idleTimeout
    this.dht = options.dht
    this.scheduler = options.scheduler || { setTimeout, clearTimeout }
    this.clock = options.clock || { now: () => Date.now() }
    this.swarmFactory = options.swarmFactory || ((opts) => new Hyperswarm(opts))
    this.logger = createSafeLogger(options.logger)
    this.swarm = null
    this.discovery = null
    this.socket = null
    this.sockets = new Set()
    this.sessions = new Set()
    this.socketWaiters = []
    this.delayWaiters = []
    this.closed = false
    this.closePromise = null
    this.disposePromise = null
    this.abortDisposals = []
    this.abortErrors = []
    this.startPromise = null
    this.uploadQueue = Promise.resolve()
    this.abortController = createAbortController()
    this.signal = this.abortController.signal
  }

  async _start() {
    try {
      this.swarm = this.swarmFactory({
        keyPair: this._keyPair,
        dht: this.dht,
        maxPeers: 4,
        maxClientConnections: 4,
        maxServerConnections: 0
      })
      if (
        !this.swarm ||
        typeof this.swarm.on !== 'function' ||
        typeof this.swarm.join !== 'function' ||
        typeof this.swarm.destroy !== 'function'
      ) {
        throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm')
      }
      this.swarm.on('connection', (socket, peerInfo) => this._onConnection(socket, peerInfo))
      this.discovery = this.swarm.join(this.topic, { server: false, client: true })
      if (!this.discovery || typeof this.discovery.flushed !== 'function') {
        throw configurationError(ERRORS.PROTOCOL_INVALID, 'Invalid swarm discovery')
      }
      await awaitAbortable(this.discovery.flushed(), this.signal)
      throwIfAborted(this.signal)
      return this
    } catch (err) {
      await this._dispose()
      throw err
    }
  }

  _ensureStarted() {
    if (this.closed) return Promise.reject(clientClosedError())
    if (!this.startPromise) this.startPromise = this._start()
    return this.startPromise
  }

  _resolveSocketWaiters(socket) {
    const waiters = this.socketWaiters
    this.socketWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.resolve(socket)
    }
  }

  _rejectSocketWaiters(error) {
    const waiters = this.socketWaiters
    this.socketWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  _onConnection(socket, peerInfo = null) {
    const peerKey = peerInfo?.publicKey || socket?.remotePublicKey
    if (
      this.closed ||
      !b4a.isBuffer(peerKey) ||
      peerKey.byteLength !== 32 ||
      !crypto.timingSafeEqual(peerKey, this.serverPublicKey)
    ) {
      socket.on('error', () => {})
      try {
        socket.destroy(
          configurationError(ERRORS.SERVER_KEY_MISMATCH, 'Peer did not match pinned server key')
        )
      } catch {}
      this.logger.warn('Rejected unpinned server connection', { fingerprint: fingerprint(peerKey) })
      this.emit('rejected-peer', { fingerprint: fingerprint(peerKey) })
      return
    }

    if (this.socket && this.socket !== socket && !this.socket.destroyed) {
      try {
        this.socket.destroy()
      } catch {}
    }
    this.socket = socket
    this.sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => {
      this.sockets.delete(socket)
      if (this.socket === socket) this.socket = null
    })
    const details = { fingerprint: fingerprint(peerKey) }
    this.logger.info('Pinned server connected', details)
    this.emit('connection', details)
    this._resolveSocketWaiters(socket)
  }

  _waitForSocket(deadline) {
    if (this.closed || this.signal.aborted) return Promise.reject(abortError())
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    const remaining = deadline - this.clock.now()
    if (remaining <= 0) {
      return Promise.reject(
        new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Timed out waiting for pinned server')
      )
    }
    return new Promise((resolve, reject) => {
      let removeAbort = () => {}
      const finish = (callback, value) => {
        removeAbort()
        this.scheduler.clearTimeout(waiter.timer)
        const index = this.socketWaiters.indexOf(waiter)
        if (index !== -1) this.socketWaiters.splice(index, 1)
        callback(value)
      }
      const waiter = {
        resolve: (socket) => finish(resolve, socket),
        reject: (error) => finish(reject, error),
        timer: this.scheduler.setTimeout(() => {
          finish(
            reject,
            new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Timed out waiting for pinned server')
          )
        }, remaining)
      }
      this.socketWaiters.push(waiter)
      removeAbort = onAbort(this.signal, () => waiter.reject(abortError()))
    })
  }

  _delay(timeout, signal = this.signal) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let removeAbort = () => {}
      const settle = (callback, value) => {
        removeAbort()
        this.scheduler.clearTimeout(waiter.timer)
        const index = this.delayWaiters.indexOf(waiter)
        if (index !== -1) this.delayWaiters.splice(index, 1)
        callback(value)
      }
      const waiter = {
        resolve: () => settle(resolve, true),
        reject: (error) => settle(reject, error),
        timer: this.scheduler.setTimeout(() => {
          waiter.resolve()
        }, timeout)
      }
      this.delayWaiters.push(waiter)
      removeAbort = onAbort(signal, () => waiter.reject(abortError()))
    })
  }

  _rejectDelays(error) {
    const waiters = this.delayWaiters
    this.delayWaiters = []
    for (const waiter of waiters) {
      this.scheduler.clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  async _startSession(socket, manifest) {
    if (this.closed || socket !== this.socket || socket.destroyed) throw transportError()
    const mux = Protomux.from(socket)
    const channel = mux.createChannel({
      protocol: UPLOAD_PROTOCOL,
      id: crypto.randomBytes(16)
    })
    if (!channel) throw transportError()
    const session = new ClientSession({
      channel,
      clientPublicKey: this.publicKey,
      idleTimeout: this.idleTimeout,
      scheduler: this.scheduler,
      signal: this.signal,
      destroy: (error) => {
        try {
          socket.destroy(error)
        } catch {}
      }
    })
    this.sessions.add(session)
    try {
      channel.open()
      return await session.upload(manifest)
    } finally {
      this.sessions.delete(session)
    }
  }

  async _uploadManifest(manifest) {
    await this._ensureStarted()
    let deadline = this.clock.now() + this.connectTimeout
    let delay = INITIAL_RECONNECT_DELAY
    let lastTransportError = null

    while (!this.closed && !this.signal.aborted && this.clock.now() < deadline) {
      let socket = null
      try {
        socket = await this._waitForSocket(deadline)
        return await this._startSession(socket, manifest)
      } catch (err) {
        if (!isTransportError(err)) throw err
        lastTransportError = err
        if (socket && this.socket === socket) this.socket = null
        try {
          socket?.destroy()
        } catch {}
        deadline = this.clock.now() + this.connectTimeout
        const remaining = deadline - this.clock.now()
        if (remaining <= 0) break
        if (!(await this._delay(Math.min(delay, remaining)))) break
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY)
      }
    }

    if (this.closed || this.signal.aborted) throw abortError()
    throw (
      lastTransportError ||
      new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Reconnect window expired')
    )
  }

  _reportResult(result) {
    const details = { name: result.name, status: result.status }
    this.logger.info('Upload completed', details)
    this.emit('result', details)
    return result
  }

  async _upload(inputPath) {
    throwIfAborted(this.signal)
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      throw configurationError(ERRORS.INVALID_FILENAME, 'Invalid upload path')
    }
    const rootStat = await fs.promises.lstat(inputPath)
    const selection = await selectUploadPaths(inputPath, { signal: this.signal })
    if (!rootStat.isDirectory()) {
      const manifest = await buildFileManifest(selection.paths[0], { signal: this.signal })
      return this._reportResult(await this._uploadManifest(manifest))
    }

    const results = []
    for (const skipped of selection.skipped) {
      const details = { name: skipped.name, reason: skipped.reason }
      this.logger.info('Skipped input entry', details)
      this.emit('skipped', details)
    }
    for (const entry of selection.entries) {
      if (entry.kind === 'skipped') continue
      throwIfAborted(this.signal)
      const name = entry.name
      if (entry.kind === 'failed') {
        const failed = { name, status: ERRORS.PROTOCOL_INVALID, reason: entry.reason }
        results.push(failed)
        this.logger.warn('Input entry failed', failed)
        this.emit('result', failed)
        continue
      }
      try {
        const manifest = await buildFileManifest(entry.path, { signal: this.signal })
        results.push(this._reportResult(await this._uploadManifest(manifest)))
      } catch (err) {
        if (this.signal.aborted || err?.code === ERRORS.ABORTED) throw err
        const status = err instanceof SwarmDeployError ? err.code : ERRORS.PROTOCOL_INVALID
        const failed = { name, status }
        results.push(failed)
        this.logger.warn('Upload failed', failed)
        this.emit('result', failed)
      }
    }
    const failed = results.some(
      (entry) => entry.status !== 'COMMITTED' && entry.status !== 'ALREADY_COMMITTED'
    )
    return { status: failed ? 'FAILED' : 'COMMITTED', results, skipped: selection.skipped }
  }

  upload(inputPath) {
    if (this.closed || this.signal.aborted) return Promise.reject(abortError())
    const pending = this.uploadQueue.then(
      () => this._upload(inputPath),
      () => this._upload(inputPath)
    )
    this.uploadQueue = pending.catch(() => {})
    return pending
  }

  _abortResources() {
    const error = abortError()
    this._rejectSocketWaiters(error)
    this._rejectDelays(error)
    for (const session of [...this.sessions]) {
      this.abortDisposals.push(Promise.resolve(session.close()).catch(() => {}))
    }
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
    const discovery = this.discovery
    const swarm = this.swarm
    this.discovery = null
    this.swarm = null
    if (discovery && typeof discovery.destroy === 'function') {
      try {
        this.abortDisposals.push(Promise.resolve(discovery.destroy()))
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
    if (swarm) {
      try {
        this.abortDisposals.push(Promise.resolve(swarm.destroy()))
      } catch (err) {
        this.abortErrors.push(err)
      }
    }
  }

  _dispose() {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this._disposeResources()
    return this.disposePromise
  }

  async _disposeResources() {
    const errors = [...this.abortErrors]
    this._rejectSocketWaiters(clientClosedError())
    this._rejectDelays(clientClosedError())
    const disposalResults = await Promise.allSettled(this.abortDisposals)
    for (const disposal of disposalResults) {
      if (disposal.status === 'rejected') errors.push(disposal.reason)
    }
    for (const session of [...this.sessions]) {
      try {
        await session.close()
      } catch {}
    }
    this.sessions.clear()
    for (const socket of [...this.sockets]) {
      try {
        socket.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this.sockets.clear()
    this.socket = null
    if (this.swarm) {
      try {
        await this.swarm.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this.swarm = null
    this.discovery = null
    if (errors.length) throw new AggregateError(errors, 'Client cleanup failed')
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.abortController.abort()
    this._abortResources()
    this.closePromise = (async () => {
      await this.uploadQueue
      await this._dispose()
    })()
    return this.closePromise
  }
}

function transportError() {
  const error = new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Upload transport closed')
  error.transport = true
  return error
}

module.exports = {
  Client,
  DEFAULT_CONNECT_TIMEOUT,
  MAX_CONNECT_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  MAX_IDLE_TIMEOUT,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY,
  FINGERPRINT_LENGTH,
  fingerprint,
  createSafeLogger
}
