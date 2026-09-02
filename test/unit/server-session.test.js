'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const Protomux = require('protomux')
const { Duplex } = require('streamx')
const { SwarmDeployError, ERRORS } = require('../../dist/errors')
const { ServerSession, UPLOAD_PROTOCOL } = require('../../dist/protocol/server-session')
const { OFFER, CHUNK, FINISH, STATUS_CODE } = require('../../dist/protocol/constants')
const {
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} = require('../../dist/protocol/codecs')
const { transferId } = require('../../dist/protocol/transfer-id')

const OWNER = b4a.alloc(32, 7)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      if (predicate()) return resolve()
      if (++attempts === 100) return reject(new Error('Timed out waiting for protocol progress'))
      setTimeout(check, 1)
    }
    check()
  })
}

function createDuplexPair() {
  let left = null
  let right = null
  left = new Duplex({
    write(data, callback) {
      right.push(data)
      callback(null)
    }
  })
  right = new Duplex({
    write(data, callback) {
      left.push(data)
      callback(null)
    }
  })
  left.on('error', () => {})
  right.on('error', () => {})
  return { left, right }
}

function makeUpload({ name = 'artifact.bin', data = b4a.from('payload') } = {}) {
  const digest = sha256(data)
  const upload = {
    version: 1,
    name,
    size: data.byteLength,
    digest,
    chunkSize: 1024 * 1024,
    chunkCount: data.byteLength === 0 ? 0 : 1
  }
  upload.transferId = transferId({
    clientPublicKey: OWNER,
    name,
    size: upload.size,
    digest,
    chunkSize: upload.chunkSize
  })
  return {
    offer: upload,
    chunk: { transferId: upload.transferId, index: 0, digest, data }
  }
}

function createClientServer(sessionOptions) {
  const { left, right } = createDuplexPair()
  const clientMux = Protomux.from(left)
  const serverMux = Protomux.from(right)
  const received = { status: [], bitmapPage: [], ready: [], chunkAck: [], result: [] }
  let serverSession = null

  serverMux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => {
    const channel = serverMux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    serverSession = new ServerSession({
      channel,
      ownerKey: OWNER,
      destroy: () => right.destroy(),
      ...sessionOptions
    })
  })

  const channel = clientMux.createChannel({ protocol: UPLOAD_PROTOCOL, id: b4a.from('transfer') })
  const messages = [
    channel.addMessage({ encoding: offer }),
    channel.addMessage({ encoding: status, onmessage: (value) => received.status.push(value) }),
    channel.addMessage({
      encoding: bitmapPage,
      onmessage: (value) => received.bitmapPage.push(value)
    }),
    channel.addMessage({ encoding: ready, onmessage: (value) => received.ready.push(value) }),
    channel.addMessage({ encoding: chunk }),
    channel.addMessage({
      encoding: chunkAck,
      onmessage: (value) => received.chunkAck.push(value)
    }),
    channel.addMessage({ encoding: finish }),
    channel.addMessage({ encoding: result, onmessage: (value) => received.result.push(value) })
  ]
  channel.open()

  return {
    left,
    right,
    channel,
    messages,
    received,
    get serverSession() {
      return serverSession
    }
  }
}

function createSessionStore({ writeChunk = async () => {}, inspect = null } = {}) {
  const sessions = new Map()
  return {
    sessions,
    async offer(ownerKey, value) {
      const session = {
        id: b4a.toString(value.transferId, 'hex'),
        transferId: value.transferId,
        ownerKey,
        name: value.name,
        size: value.size,
        digest: value.digest,
        chunkSize: value.chunkSize,
        chunkCount: value.chunkCount,
        state: 'receiving'
      }
      sessions.set(session.id, session)
      return { verified: new Set(), state: 'receiving' }
    },
    async writeChunk(transferId, value) {
      await writeChunk(transferId, value)
      return { verified: new Set([value.index]) }
    },
    async finish(transferId) {
      const session = sessions.get(b4a.toString(transferId, 'hex'))
      session.state = 'verified'
      return { state: 'verified' }
    },
    async retireCommitted(transferId) {
      return sessions.delete(b4a.toString(transferId, 'hex'))
    },
    inspect
  }
}

function createCommitStore({
  inspect = async () => ({ status: 'AVAILABLE' }),
  commit = async () => {}
} = {}) {
  return { inspect, commit }
}

function createTimeoutScheduler() {
  const timers = new Map()
  return {
    timers,
    setTimeout(callback, timeout) {
      const timer = { callback, timeout }
      timers.set(timer, timer)
      return timer
    },
    clearTimeout(timer) {
      timers.delete(timer)
    }
  }
}

test('server session writes sequential chunks before acknowledging and retires committed sessions', async (t) => {
  const wrote = deferred()
  const releaseWrite = deferred()
  const sessionStore = createSessionStore({
    writeChunk: async () => {
      wrote.resolve()
      await releaseWrite.promise
    }
  })
  const committed = []
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore({
      async commit(session, options) {
        committed.push({ session, options })
        return { name: session.name }
      }
    }),
    retentionManager: { marker: 'retention' },
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()

  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.ready.length === 1)
  t.is(pair.received.status[0].code, STATUS_CODE.ACCEPT)
  t.is(pair.received.bitmapPage.length, 1)

  pair.messages[CHUNK].send(upload.chunk)
  await wrote.promise
  t.is(pair.received.chunkAck.length, 0)
  releaseWrite.resolve()
  await waitFor(() => pair.received.chunkAck.length === 1)
  t.alike(pair.received.chunkAck[0], { transferId: upload.offer.transferId, index: 0 })

  pair.messages[FINISH].send({ transferId: upload.offer.transferId })
  await waitFor(() => pair.received.result.length === 1)
  t.is(pair.received.result[0].code, 0)
  t.is(committed.length, 1)
  t.is(committed[0].options.retentionManager.marker, 'retention')
  t.is(sessionStore.sessions.size, 0)
})

test('server session rejects chunks before READY by destroying the connection', async (t) => {
  const sessionStore = createSessionStore()
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore(),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()

  pair.messages[CHUNK].send(upload.chunk)
  await waitFor(() => pair.right.destroyed)

  t.is(sessionStore.sessions.size, 0)
})

test('server session returns terminal statuses for unavailable or capacity-rejected offers', async (t) => {
  const cases = [
    ['ALREADY_COMMITTED', STATUS_CODE.ALREADY_COMMITTED],
    ['FILE_EXISTS', STATUS_CODE.FILE_EXISTS],
    ['FILE_BUSY', STATUS_CODE.FILE_BUSY]
  ]

  for (const [inspectStatus, expected] of cases) {
    const pair = createClientServer({
      sessionStore: createSessionStore(),
      commitStore: createCommitStore({ inspect: async () => ({ status: inspectStatus }) }),
      maxFileBytes: 1024 * 1024
    })
    const upload = makeUpload({ name: `${inspectStatus}.bin` })
    pair.messages[OFFER].send(upload.offer)
    await waitFor(() => pair.received.status.length === 1)
    t.is(pair.received.status[0].code, expected)
  }

  const pair = createClientServer({
    sessionStore: createSessionStore(),
    commitStore: createCommitStore(),
    maxFileBytes: 1
  })
  const upload = makeUpload()
  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.status.length === 1)
  t.is(pair.received.status[0].code, STATUS_CODE.REJECTED)
})

test('server session runs non-destructive retention admission before staging offer', async (t) => {
  for (const code of [ERRORS.FILE_TOO_LARGE, ERRORS.CLEANUP_FAILED]) {
    let offered = 0
    const sessionStore = createSessionStore()
    const originalOffer = sessionStore.offer
    sessionStore.offer = async (...args) => {
      offered++
      return originalOffer(...args)
    }
    const pair = createClientServer({
      sessionStore,
      commitStore: createCommitStore(),
      retentionManager: {
        async admit() {
          throw new SwarmDeployError(code, 'Rejected before receiving bytes')
        }
      },
      maxFileBytes: 1024 * 1024
    })
    const upload = makeUpload({ name: `${code}.bin` })

    pair.messages[OFFER].send(upload.offer)
    await waitFor(() => pair.received.status.length === 1)

    t.is(pair.received.status[0].code, STATUS_CODE.REJECTED, code)
    t.is(pair.received.status[0].reason, code, code)
    t.is(offered, 0, `${code} allocated no staging session`)
    t.is(pair.received.chunkAck.length, 0, `${code} received zero bytes`)
  }
})

test('server session fails closed when an OFFER transfer ID is noncanonical', async (t) => {
  const pair = createClientServer({
    sessionStore: createSessionStore(),
    commitStore: createCommitStore(),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()

  pair.messages[OFFER].send({ ...upload.offer, transferId: b4a.alloc(32) })
  await waitFor(() => pair.right.destroyed)

  t.absent(pair.serverSession?.transferId)
})

test('server session limits queued chunks before storage work', async (t) => {
  const writing = deferred()
  const sessionStore = createSessionStore({ writeChunk: async () => writing.promise })
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore(),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()
  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.ready.length === 1)

  for (let index = 0; index < 5; index++) pair.messages[CHUNK].send(upload.chunk)
  await waitFor(() => pair.right.destroyed)
  writing.resolve()

  t.is(sessionStore.sessions.size, 1)
})

test('server session closes an idle connection after the default timeout', async (t) => {
  const scheduler = createTimeoutScheduler()
  const pair = createClientServer({
    sessionStore: createSessionStore(),
    commitStore: createCommitStore(),
    maxFileBytes: 1024 * 1024,
    scheduler
  })
  await waitFor(() => pair.serverSession !== null)

  const [timer] = scheduler.timers.values()
  t.is(timer.timeout, 60_000)
  timer.callback()
  await waitFor(() => pair.right.destroyed)
})

test('server session revocation prevents queued chunk writes', async (t) => {
  const started = deferred()
  const release = deferred()
  let writes = 0
  const sessionStore = createSessionStore({
    writeChunk: async () => {
      writes++
      started.resolve()
      await release.promise
    }
  })
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore(),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()
  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.ready.length === 1)
  pair.messages[CHUNK].send(upload.chunk)
  await started.promise
  pair.messages[CHUNK].send(upload.chunk)

  pair.serverSession.revoke()
  release.resolve()
  await pair.serverSession.settle()

  t.is(writes, 1)
})

test('server session revocation prevents queued finish commit', async (t) => {
  const started = deferred()
  const release = deferred()
  let finished = 0
  let committed = 0
  const sessionStore = createSessionStore({
    writeChunk: async () => {
      started.resolve()
      await release.promise
    }
  })
  sessionStore.finish = async (transferId) => {
    finished++
    const session = sessionStore.sessions.get(b4a.toString(transferId, 'hex'))
    session.state = 'verified'
  }
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore({ commit: async () => committed++ }),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()
  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.ready.length === 1)
  pair.messages[CHUNK].send(upload.chunk)
  await started.promise
  pair.messages[FINISH].send({ transferId: upload.offer.transferId })

  pair.serverSession.revoke()
  release.resolve()
  await pair.serverSession.settle()

  t.is(finished, 0)
  t.is(committed, 0)
})

test('server session settlement retains cleanup errors raised after revocation', async (t) => {
  const started = deferred()
  const commit = deferred()
  const sessionStore = createSessionStore()
  sessionStore.finish = async (transferId) => {
    sessionStore.sessions.get(b4a.toString(transferId, 'hex')).state = 'verified'
  }
  const pair = createClientServer({
    sessionStore,
    commitStore: createCommitStore({
      commit: async () => {
        started.resolve()
        return commit.promise
      }
    }),
    maxFileBytes: 1024 * 1024
  })
  const upload = makeUpload()
  pair.messages[OFFER].send(upload.offer)
  await waitFor(() => pair.received.ready.length === 1)
  pair.messages[FINISH].send({ transferId: upload.offer.transferId })
  await started.promise

  pair.serverSession.revoke()
  commit.reject(new AggregateError([new Error('rollback failed')], 'cleanup failed'))

  await t.exception(() => pair.serverSession.settle(), { name: 'AggregateError' })
})
