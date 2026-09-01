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
    const existing = this._activeUploads.get(id)
    if (existing) {
      existing.references++
      return { id }
    }
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
    this._connections.delete(socket)
    const sockets = this._sockets.get(connection.owner)
    if (!sockets) return
    sockets.delete(socket)
    if (sockets.size === 0) this._sockets.delete(connection.owner)
  }

  _onSessionTerminal(session, connection) {
    connection.sessions.delete(session)
    this._sessions.delete(session)
  }

  _onPair(mux, socket, connection, id) {
    if (!this._isAllowed(connection.ownerKey)) {
      this._destroySocket(socket, new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked'))
      return
    }
    const channel = mux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    if (!channel) return
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
      idleTimeout: this.idleTimeout,
      scheduler: this.scheduler,
      destroy: (err) => this._destroySocket(socket, err),
      onTerminal: () => this._onSessionTerminal(session, connection)
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
    const connection = { owner, ownerKey: b4a.from(ownerKey), sessions: new Set() }
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
    const previous = this._allowlist
    const removed = []
    for (const key of previous) {
      if (!next.has(key)) removed.push(key)
    }
    this._allowlist = next

    for (const key of removed) {
      const sockets = this._sockets.get(key)
      if (sockets) {
        for (const socket of [...sockets]) {
          this._destroySocket(
            socket,
            new SwarmDeployError(ERRORS.REVOKED, 'Uploader access revoked')
          )
        }
      }
      if (this.sessionStore) await this.sessionStore.deleteByOwner(b4a.from(key, 'hex'))
      const details = { fingerprint: fingerprint(b4a.from(key, 'hex')) }
      this.logger.info('Uploader access revoked', details)
      this.emit('revoked', details)
    }
    return new Set(this._allowlist)
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
      this.commitStore = new CommitStore({ layout: this.layout, storage: this.storage })
      await recoverStorage({
        layout: this.layout,
        sessionStore: this.sessionStore,
        commitStore: this.commitStore,
        logger: this.logger
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
      if (this.allowlistPath) {
        this.allowlistWatcher = new AllowlistWatcher({
          filePath: this.allowlistPath,
          storage: this.storage,
          onReload: (keys) => this.reloadAllowlist(keys),
          scheduler: this.scheduler,
          logger: this.logger
        })
        this.allowlistWatcher.start()
      }
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
    if (this.allowlistWatcher) await this.allowlistWatcher.close().catch(() => {})
    this.allowlistWatcher = null
    if (this.retentionManager) await this.retentionManager.stop().catch(() => {})
    this.retentionManager = null

    await Promise.allSettled([...this._sessions].map((session) => session.close()))
    this._sessions.clear()
    for (const socket of this._connections.keys()) this._destroySocket(socket)
    this._connections.clear()
    this._sockets.clear()
    this._activeUploads.clear()

    if (this.swarm) await this.swarm.destroy().catch(() => {})
    this.swarm = null
    this.discovery = null
    if (this.sessionStore) await this.sessionStore.close().catch(() => {})
    this.sessionStore = null
    this.commitStore = null
    if (this.releaseStorageLock) await this.releaseStorageLock().catch(() => {})
    this.releaseStorageLock = null
    this.listening = false
  }

  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      if (this.listenPromise) await this.listenPromise.catch(() => {})
      await this._dispose()
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
