'use strict'

const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const crypto = require('#crypto')
const fs = require('#fs')
const { EventEmitter } = require('#events')
const { SwarmDeployError, ERRORS } = require('./errors')
const { keyPairFromSeed } = require('./identity')
const { topicFromServerPublicKey } = require('./topic')
const { AllowlistWatcher } = require('./allowlist')
const {
  ServerSession,
  UPLOAD_PROTOCOL,
  DEFAULT_IDLE_TIMEOUT
} = require('./protocol/server-session')
const { initLayout, acquireStorageLock } = require('./storage/layout')
const { SessionStore } = require('./storage/session-store')
const { CommitStore } = require('./storage/commit-store')
const { recoverStorage } = require('./storage/recovery')
const {
  RetentionManager,
  DEFAULT_CLEANUP_INTERVAL,
  DEFAULT_RESUME_TTL,
  MAX_CLEANUP_INTERVAL
} = require('./storage/retention')

const DEFAULT_MAX_CONNECTIONS = 64
const DEFAULT_MAX_ACTIVE_UPLOADS = 8
const MAX_CONNECTIONS = 1024
const MAX_ACTIVE_UPLOADS = 1024
const FINGERPRINT_LENGTH = 12

function configurationError(message, cause = null) {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertPositiveSafeUint(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(`Invalid ${name}`)
  }
}

function assertOptionalSafeUint(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value !== undefined) assertPositiveSafeUint(value, name, maximum)
}

function assertSeed(seed) {
  if (!b4a.isBuffer(seed) || seed.byteLength !== 32) throw configurationError('Invalid seed')
}

function keyHex(key) {
  return b4a.toString(key, 'hex')
}

function assertPublicKey(key) {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw configurationError('Invalid allowed key')
}

function normalizeAllowlist(keys) {
  if (!keys || typeof keys[Symbol.iterator] !== 'function' || typeof keys === 'string') {
    throw configurationError('Invalid allowed keys')
  }
  const normalized = new Set()
  for (const key of keys) {
    if (typeof key === 'string') {
      if (!/^[0-9a-f]{64}$/.test(key)) throw configurationError('Invalid allowed key')
      normalized.add(key)
      continue
    }
    assertPublicKey(key)
    normalized.add(keyHex(key))
  }
  return normalized
}

function fingerprint(key) {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) return 'invalid'
  return keyHex(crypto.createHash('sha256').update(key).digest()).slice(0, FINGERPRINT_LENGTH)
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

class Server extends EventEmitter {
  constructor(options = {}) {
    super()
    if (!options || typeof options !== 'object') throw configurationError('Invalid server options')
    assertSeed(options.seed)
    if (typeof options.storageDir !== 'string' || options.storageDir.length === 0) {
      throw configurationError('Invalid storageDir')
    }
    const allowlist = normalizeAllowlist(options.allowedKeys)
    assertPositiveSafeUint(options.maxFileBytes, 'maxFileBytes')
    assertPositiveSafeUint(options.maxStagingBytes, 'maxStagingBytes')

    const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
    const maxActiveUploads = options.maxActiveUploads ?? DEFAULT_MAX_ACTIVE_UPLOADS
    const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    const cleanupInterval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL
    const resumeTtl = options.resumeTtl ?? DEFAULT_RESUME_TTL
    assertPositiveSafeUint(maxConnections, 'maxConnections', MAX_CONNECTIONS)
    assertPositiveSafeUint(maxActiveUploads, 'maxActiveUploads', MAX_ACTIVE_UPLOADS)
    assertPositiveSafeUint(idleTimeout, 'idleTimeout', MAX_CLEANUP_INTERVAL)
    assertPositiveSafeUint(cleanupInterval, 'cleanupInterval', MAX_CLEANUP_INTERVAL)
    assertPositiveSafeUint(resumeTtl, 'resumeTtl')
    assertOptionalSafeUint(options.maxAge, 'maxAge')
    assertOptionalSafeUint(options.maxStorageBytes, 'maxStorageBytes')
    if (maxActiveUploads > maxConnections) {
      throw configurationError('maxActiveUploads exceeds maxConnections')
    }
    if (
      options.scheduler &&
      (typeof options.scheduler.setTimeout !== 'function' ||
        typeof options.scheduler.clearTimeout !== 'function' ||
        typeof options.scheduler.setInterval !== 'function' ||
        typeof options.scheduler.clearInterval !== 'function')
    ) {
      throw configurationError('Invalid server scheduler')
    }
    if (
      options.storage &&
      (typeof options.storage.open !== 'function' ||
        typeof options.storage.lstat !== 'function' ||
        typeof options.storage.readdir !== 'function')
    ) {
      throw configurationError('Invalid storage adapter')
    }
    if (options.swarmFactory !== undefined && typeof options.swarmFactory !== 'function') {
      throw configurationError('Invalid swarm factory')
    }
    if (options.allowlistPath !== undefined && typeof options.allowlistPath !== 'string') {
      throw configurationError('Invalid allowlist path')
    }

    this._keyPair = keyPairFromSeed(b4a.from(options.seed))
    this.publicKey = b4a.from(this._keyPair.publicKey)
    this.topic = topicFromServerPublicKey(this.publicKey)
    this.storageDir = options.storageDir
    this.maxFileBytes = options.maxFileBytes
    this.maxStagingBytes = options.maxStagingBytes
    this.maxConnections = maxConnections
    this.maxActiveUploads = maxActiveUploads
    this.idleTimeout = idleTimeout
    this.cleanupInterval = cleanupInterval
    this.resumeTtl = resumeTtl
    this.maxAge = options.maxAge
    this.maxStorageBytes = options.maxStorageBytes
    this.dht = options.dht
    this.storage = options.storage || fs.promises
    this.scheduler = options.scheduler || { setTimeout, clearTimeout, setInterval, clearInterval }
    this.swarmFactory = options.swarmFactory || ((opts) => new Hyperswarm(opts))
    this.allowlistPath = options.allowlistPath
    this.logger = createSafeLogger(options.logger)
    this._allowlist = allowlist
    this._connections = new Map()
    this._sockets = new Map()
    this._sessions = new Set()
    this._activeUploads = new Map()
    this.layout = null
    this.sessionStore = null
    this.commitStore = null
    this.retentionManager = null
    this.allowlistWatcher = null
    this.swarm = null
    this.discovery = null
    this.releaseStorageLock = null
    this.listening = false
    this.closed = false
    this.listenPromise = null
    this.closePromise = null
    this.reloadPromise = Promise.resolve()
    this.pendingRevocations = new Map()
  }

  get allowedKeys() {
    return new Set(this._allowlist)
  }

  _isAllowed(key) {
    return b4a.isBuffer(key) && key.byteLength === 32 && this._allowlist.has(keyHex(key))
  }

  _firewall(key) {
    const rejected = !this._isAllowed(key)
    if (rejected)
      this.logger.warn('Rejected unauthorised connection', { fingerprint: fingerprint(key) })
    return rejected
  }

  _reserveUpload(transferId) {
    const id = keyHex(transferId)
    if (this._activeUploads.has(id)) return null
    if (this._activeUploads.size >= this.maxActiveUploads) return null
    this._activeUploads.set(id, { references: 1 })
    return { id }
  }

  _releaseUpload(reservation) {
    if (!reservation || typeof reservation.id !== 'string') return
    const active = this._activeUploads.get(reservation.id)
    if (!active) return
    active.references--
    if (active.references <= 0) this._activeUploads.delete(reservation.id)
  }

  _isSessionActive(session) {
    return !!session && typeof session.id === 'string' && this._activeUploads.has(session.id)
  }

  _destroySocket(socket, error) {
    try {
      socket.destroy(error)
    } catch {}
  }

  _removeConnection(socket, connection) {
    if (connection.transportTimer) this.scheduler.clearTimeout(connection.transportTimer)
    if (connection.terminalTimer) this.scheduler.clearTimeout(connection.terminalTimer)
    this._connections.delete(socket)
    const sockets = this._sockets.get(connection.owner)
    if (!sockets) return
    sockets.delete(socket)
    if (sockets.size === 0) this._sockets.delete(connection.owner)
  }

  _onSessionTerminal(session, connection) {
    connection.sessions.delete(session)
    this._sessions.delete(session)
    connection.terminalTimer = this.scheduler.setTimeout(
      () => this._destroySocket(connection.socket),
      50
    )
  }

  _onPair(mux, socket, connection, id) {
    if (connection.channelOpened || !this._isAllowed(connection.ownerKey)) {
      this._destroySocket(socket, new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
      return
    }
    const channel = mux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    if (!channel) {
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid upload channel')
      )
      return
    }
    connection.channelOpened = true
    let session = null
    session = new ServerSession({
      channel,
      ownerKey: connection.ownerKey,
      sessionStore: this.sessionStore,
      commitStore: this.commitStore,
      retentionManager: this.retentionManager,
      maxFileBytes: this.maxFileBytes,
      reserveUpload: (transferId) => this._reserveUpload(transferId),
      releaseUpload: (reservation) => this._releaseUpload(reservation),
      isAuthorized: () => this._isAllowed(connection.ownerKey),
      idleTimeout: this.idleTimeout,
      scheduler: this.scheduler,
      destroy: (err) => this._destroySocket(socket, err),
      onTerminal: () => this._onSessionTerminal(session, connection),
      onProgress: () => connection.refreshTransport()
    })
    connection.sessions.add(session)
    this._sessions.add(session)
  }

  _onConnection(socket, peerInfo = null) {
    const ownerKey = socket?.remotePublicKey || peerInfo?.publicKey
    if (this.closed || !this._isAllowed(ownerKey)) {
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.AUTH_REJECTED, 'Unauthorised uploader')
      )
      return
    }
    if (this._connections.size >= this.maxConnections) {
      this._destroySocket(
        socket,
        new SwarmDeployError(ERRORS.FILE_BUSY, 'Connection capacity exceeded')
      )
      return
    }

    const owner = keyHex(ownerKey)
    const connection = {
      owner,
      ownerKey: b4a.from(ownerKey),
      sessions: new Set(),
      channelOpened: false,
      socket,
      transportTimer: null,
      terminalTimer: null,
      refreshTransport: null
    }
    connection.refreshTransport = () => {
      if (connection.transportTimer) this.scheduler.clearTimeout(connection.transportTimer)
      connection.transportTimer = this.scheduler.setTimeout(() => {
        this._destroySocket(
          socket,
          new SwarmDeployError(ERRORS.UPLOAD_IDLE_TIMEOUT, 'Transport idle timeout')
        )
      }, this.idleTimeout)
      if (typeof connection.transportTimer.unref === 'function') connection.transportTimer.unref()
    }
    connection.refreshTransport()
    this._connections.set(socket, connection)
    let sockets = this._sockets.get(owner)
    if (!sockets) this._sockets.set(owner, (sockets = new Set()))
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => {
      this._removeConnection(socket, connection)
      for (const session of [...connection.sessions]) {
        session.close().catch(() => {})
      }
    })

    const mux = Protomux.from(socket)
    mux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => this._onPair(mux, socket, connection, id))
    const details = { fingerprint: fingerprint(ownerKey), connections: this._connections.size }
    this.logger.info('Authenticated uploader connected', details)
    this.emit('connection', details)
  }

  async reloadAllowlist(keys) {
    const next = normalizeAllowlist(keys)
    const run = this.reloadPromise.then(
      () => this._applyAllowlist(next),
      () => this._applyAllowlist(next)
    )
    this.reloadPromise = run.catch(() => {})
    return run
  }

  async _applyAllowlist(next) {
    let swapped = false
    try {
      for (const key of this.pendingRevocations.keys()) {
        await this._revokeOwner(key)
      }
      const previous = this._allowlist
      const removed = []
      for (const key of previous) {
        if (!next.has(key)) removed.push(key)
      }
      this._allowlist = next
      swapped = true
      for (const key of removed) await this._revokeOwner(key)
    } catch (err) {
      err.allowlistApplied = swapped
      throw err
    }
    return new Set(this._allowlist)
  }

  async _revokeOwner(key) {
    let pending = this.pendingRevocations.get(key)
    if (!pending) {
      pending = { transferIds: new Set() }
      this.pendingRevocations.set(key, pending)
    }
    const sockets = this._sockets.get(key)
    const sessions = new Set()
    const errors = []
    if (sockets) {
      for (const socket of [...sockets]) {
        const connection = this._connections.get(socket)
        if (connection) {
          for (const session of connection.sessions) {
            if (session.transferId) pending.transferIds.add(keyHex(session.transferId))
            try {
              session.revoke()
            } catch (err) {
              errors.push(err)
            }
            sessions.add(session)
          }
        }
        try {
          socket.destroy(new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
        } catch (err) {
          errors.push(err)
        }
      }
    }
    const settled = await Promise.allSettled([...sessions].map((session) => session.settle()))
    for (const result of settled) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    for (const id of pending.transferIds) {
      try {
        await this.commitStore.retryAbortedAttempt(b4a.from(id, 'hex'), this.sessionStore)
      } catch (err) {
        errors.push(err)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    try {
      if (this.sessionStore) await this.sessionStore.deleteByOwner(b4a.from(key, 'hex'))
    } catch (err) {
      errors.push(err)
    }
    if (errors.length) throw new AggregateError(errors, 'Uploader revocation cleanup failed')
    this.pendingRevocations.delete(key)
    const details = { fingerprint: fingerprint(b4a.from(key, 'hex')) }
    this.logger.info('Uploader access revoked', details)
    this.emit('revoked', details)
  }

  async _start() {
    try {
      this.layout = initLayout(this.storageDir)
      this.releaseStorageLock = await acquireStorageLock(this.layout, { storage: this.storage })
      this.sessionStore = new SessionStore({
        layout: this.layout,
        maxStagingBytes: this.maxStagingBytes,
        storage: this.storage
      })
      await this.sessionStore.init()
      if (this.allowlistPath) {
        this.allowlistWatcher = new AllowlistWatcher({
          filePath: this.allowlistPath,
          storage: this.storage,
          onReload: (keys) => this.reloadAllowlist(keys),
          scheduler: this.scheduler,
          logger: this.logger
        })
        await this.allowlistWatcher.start()
      }
      this.commitStore = new CommitStore({ layout: this.layout, storage: this.storage })
      await recoverStorage({
        layout: this.layout,
        sessionStore: this.sessionStore,
        commitStore: this.commitStore,
        logger: this.logger,
        isAuthorized: (key) => this._isAllowed(key)
      })
      this.retentionManager = new RetentionManager({
        layout: this.layout,
        sessionStore: this.sessionStore,
        commitStore: this.commitStore,
        maxAge: this.maxAge,
        maxStorageBytes: this.maxStorageBytes,
        resumeTtl: this.resumeTtl,
        cleanupInterval: this.cleanupInterval,
        storage: this.storage,
        isSessionActive: (session) => this._isSessionActive(session),
        logger: this.logger,
        scheduler: this.scheduler
      })
      await this.retentionManager.start()

      this.swarm = this.swarmFactory({
        keyPair: this._keyPair,
        dht: this.dht,
        maxPeers: this.maxConnections,
        maxServerConnections: this.maxConnections,
        maxClientConnections: 0,
        firewall: (key) => this._firewall(key)
      })
      if (
        !this.swarm ||
        typeof this.swarm.on !== 'function' ||
        typeof this.swarm.join !== 'function' ||
        typeof this.swarm.destroy !== 'function'
      ) {
        throw configurationError('Invalid swarm')
      }
      this.swarm.on('connection', (socket, peerInfo) => this._onConnection(socket, peerInfo))
      this.discovery = this.swarm.join(this.topic, { server: true, client: false })
      if (!this.discovery || typeof this.discovery.flushed !== 'function') {
        throw configurationError('Invalid swarm discovery')
      }
      await this.discovery.flushed()
      this.listening = true
      this.logger.info('Server listening', { publicKey: fingerprint(this.publicKey) })
      this.emit('listening', { publicKey: fingerprint(this.publicKey) })
      return this
    } catch (err) {
      await this._dispose()
      throw err
    }
  }

  listen() {
    if (this.closed) return Promise.reject(configurationError('Server is closed'))
    if (this.listenPromise) return this.listenPromise
    this.listenPromise = this._start()
    return this.listenPromise
  }

  async _dispose() {
    const errors = []
    const attempt = async (operation) => {
      try {
        await operation()
      } catch (err) {
        errors.push(err)
      }
    }

    if (this.allowlistWatcher) await attempt(() => this.allowlistWatcher.close())
    this.allowlistWatcher = null
    if (this.retentionManager) await attempt(() => this.retentionManager.stop())
    this.retentionManager = null

    for (const session of [...this._sessions]) await attempt(() => session.close())
    this._sessions.clear()
    for (const socket of this._connections.keys()) {
      try {
        socket.destroy()
      } catch (err) {
        errors.push(err)
      }
    }
    this._connections.clear()
    this._sockets.clear()
    this._activeUploads.clear()

    if (this.swarm) await attempt(() => this.swarm.destroy())
    this.swarm = null
    this.discovery = null
    if (this.sessionStore) await attempt(() => this.sessionStore.close())
    this.sessionStore = null
    this.commitStore = null
    if (this.releaseStorageLock) await attempt(() => this.releaseStorageLock())
    this.releaseStorageLock = null
    this.listening = false
    if (errors.length > 0) throw new AggregateError(errors, 'Server cleanup failed')
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      const errors = []
      if (this.listenPromise) {
        try {
          await this.listenPromise
        } catch (err) {
          errors.push(err)
        }
      }
      try {
        await this._dispose()
      } catch (err) {
        errors.push(...(err.errors || [err]))
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Server close failed')
    })()
    return this.closePromise
  }
}

module.exports = {
  Server,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_ACTIVE_UPLOADS,
  MAX_CONNECTIONS,
  MAX_ACTIVE_UPLOADS,
  FINGERPRINT_LENGTH,
  fingerprint,
  normalizeAllowlist
}
