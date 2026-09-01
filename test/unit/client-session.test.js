'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('#crypto')
const fs = require('#fs')
const path = require('#path')
const c = require('compact-encoding')
const Protomux = require('protomux')
const { Duplex } = require('streamx')
const {
  ClientSession,
  UPLOAD_PROTOCOL,
  MAX_IN_FLIGHT,
  boundedEncoding
} = require('../../lib/protocol/client-session')
const {
  OFFER,
  STATUS,
  BITMAP_PAGE,
  READY,
  CHUNK,
  CHUNK_ACK,
  FINISH,
  RESULT,
  STATUS_CODE,
  MAX_CONTROL_BYTES
} = require('../../lib/protocol/constants')
const {
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} = require('../../lib/protocol/codecs')
const { transferId } = require('../../lib/protocol/transfer-id')
const { buildFileManifest } = require('../../lib/files')
const { createTempDir } = require('../helpers/files')

const CLIENT_KEY = b4a.alloc(32, 9)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest()
}

function waitFor(predicate, timeout = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeout)
        return reject(new Error('Timed out waiting for protocol progress'))
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

function createManifest(count = 3) {
  const chunkSize = 8
  const chunks = Array.from({ length: count }, (_, index) => b4a.alloc(chunkSize, index))
  const data = b4a.concat(chunks)
  return {
    path: '/manifest-only.bin',
    name: 'manifest-only.bin',
    size: data.byteLength,
    digest: sha256(data),
    chunkSize,
    chunkCount: count,
    chunkDigests: chunks.map(sha256),
    chunks
  }
}

function createPair({
  manifest = createManifest(),
  scheduler = null,
  readChunk = null,
  useFileReader = false
} = {}) {
  const { left, right } = createDuplexPair()
  const clientMux = Protomux.from(left)
  const serverMux = Protomux.from(right)
  const received = { offer: [], chunk: [], finish: [] }
  let serverChannel = null
  let serverMessages = null

  serverMux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => {
    serverChannel = serverMux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    serverMessages = [
      serverChannel.addMessage({
        encoding: offer,
        onmessage: (value) => received.offer.push(value)
      }),
      serverChannel.addMessage({ encoding: status }),
      serverChannel.addMessage({ encoding: bitmapPage }),
      serverChannel.addMessage({ encoding: ready }),
      serverChannel.addMessage({
        encoding: chunk,
        onmessage: (value) => received.chunk.push(value)
      }),
      serverChannel.addMessage({ encoding: chunkAck }),
      serverChannel.addMessage({
        encoding: finish,
        onmessage: (value) => received.finish.push(value)
      }),
      serverChannel.addMessage({ encoding: result })
    ]
    serverChannel.open()
  })

  const channel = clientMux.createChannel({
    protocol: UPLOAD_PROTOCOL,
    id: b4a.from('client-session-test')
  })
  const session = new ClientSession({
    channel,
    clientPublicKey: CLIENT_KEY,
    readChunk: useFileReader ? null : readChunk || (async (_, index) => manifest.chunks[index]),
    ...(scheduler ? { scheduler } : {})
  })

  return {
    channel,
    clientMux,
    received,
    session,
    get serverChannel() {
      return serverChannel
    },
    get serverMessages() {
      return serverMessages
    },
    accept(verified = []) {
      const id = received.offer[0].transferId
      serverMessages[STATUS].send({ transferId: id, code: STATUS_CODE.ACCEPT })
      if (manifest.chunkCount > 0) {
        const bits = b4a.alloc(Math.ceil(manifest.chunkCount / 8))
        for (const index of verified) bits[Math.floor(index / 8)] |= 1 << (index % 8)
        serverMessages[BITMAP_PAGE].send({
          transferId: id,
          start: 0,
          count: manifest.chunkCount,
          bits
        })
      }
      serverMessages[READY].send({ transferId: id })
    }
  }
}

async function openAndOffer(pair, manifest) {
  const uploading = pair.session.upload(manifest)
  await new Promise((resolve) => setTimeout(resolve, 5))
  pair.channel.open()
  await waitFor(() => pair.received.offer.length === 1)
  return { uploading }
}

test('client session sends OFFER only after its channel fully opens', async (t) => {
  const manifest = createManifest(0)
  const pair = createPair({ manifest })
  const uploading = pair.session.upload(manifest)

  await new Promise((resolve) => setTimeout(resolve, 5))
  t.is(pair.received.offer.length, 0)

  pair.channel.open()
  await waitFor(() => pair.received.offer.length === 1)
  const id = transferId({
    clientPublicKey: CLIENT_KEY,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize
  })
  t.alike(pair.received.offer[0], {
    version: 1,
    transferId: id,
    name: manifest.name,
    size: manifest.size,
    digest: manifest.digest,
    chunkSize: manifest.chunkSize,
    chunkCount: manifest.chunkCount
  })

  pair.accept()
  await waitFor(() => pair.received.finish.length === 1)
  pair.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await uploading).status, 'COMMITTED')
})

test('client session uploads only indexes absent from verified bitmap pages', async (t) => {
  const manifest = createManifest(3)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.accept([1])
  await waitFor(() => pair.received.chunk.length >= 2)
  t.alike(
    pair.received.chunk.map((value) => value.index),
    [0, 2]
  )

  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })
  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 2 })
  await waitFor(() => pair.received.finish.length === 1)
  pair.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await uploading).status, 'COMMITTED')
})

test('client session limits unacknowledged chunks and defers FINISH', async (t) => {
  const manifest = createManifest(MAX_IN_FLIGHT + 1)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.accept()
  await waitFor(() => pair.received.chunk.length === MAX_IN_FLIGHT)
  t.alike(
    pair.received.chunk.map((value) => value.index),
    [0, 1, 2, 3]
  )
  t.is(pair.received.finish.length, 0)

  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })
  await waitFor(() => pair.received.chunk.length === MAX_IN_FLIGHT + 1)
  t.is(pair.received.chunk[4].index, 4)
  t.is(pair.received.finish.length, 0)

  for (let index = 1; index <= 4; index++) {
    pair.serverMessages[CHUNK_ACK].send({ transferId: id, index })
  }
  await waitFor(() => pair.received.finish.length === 1)
  pair.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await uploading).status, 'COMMITTED')
})

test('client session pauses chunk production until Protomux drains', async (t) => {
  const manifest = createManifest(2)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId
  const send = pair.session.messages[CHUNK].send
  let paused = false
  pair.session.messages[CHUNK].send = (value) => {
    const sent = send(value)
    if (paused) return sent
    paused = true
    pair.clientMux.drained = false
    return false
  }

  pair.accept()
  await waitFor(() => pair.received.chunk.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  t.is(pair.received.chunk.length, 1)

  pair.clientMux.drained = true
  pair.channel.ondrain()
  await waitFor(() => pair.received.chunk.length === 2)
  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })
  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 1 })
  await waitFor(() => pair.received.finish.length === 1)
  pair.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await uploading).status, 'COMMITTED')
})

test('client session fails closed on invalid server transfer IDs and states', async (t) => {
  const manifest = createManifest(1)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.serverMessages[READY].send({ transferId: id })
  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })

  const second = createPair({ manifest })
  const { uploading: retry } = await openAndOffer(second, manifest)
  second.serverMessages[STATUS].send({ transferId: b4a.alloc(32), code: STATUS_CODE.ACCEPT })
  await t.exception(() => retry, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })
})

test('client session rejects duplicate, out-of-range, and mismatched acknowledgements', async (t) => {
  const manifest = createManifest(1)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.accept()
  await waitFor(() => pair.received.chunk.length === 1)
  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 1 })
  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })
})

test('client session resolves committed and already committed results', async (t) => {
  const manifest = createManifest(0)
  const committed = createPair({ manifest })
  const { uploading: committedUpload } = await openAndOffer(committed, manifest)
  const id = committed.received.offer[0].transferId
  committed.accept()
  await waitFor(() => committed.received.finish.length === 1)
  committed.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await committedUpload).status, 'COMMITTED')

  const already = createPair({ manifest })
  const { uploading: alreadyUpload } = await openAndOffer(already, manifest)
  const alreadyId = already.received.offer[0].transferId
  already.serverMessages[STATUS].send({
    transferId: alreadyId,
    code: STATUS_CODE.ALREADY_COMMITTED
  })
  t.is((await alreadyUpload).status, 'ALREADY_COMMITTED')
})

test('client session turns terminal statuses, local checksums, timeouts, and bad frames into typed errors', async (t) => {
  const manifest = createManifest(1)
  const unavailable = createPair({ manifest })
  const { uploading: unavailableUpload } = await openAndOffer(unavailable, manifest)
  unavailable.serverMessages[STATUS].send({
    transferId: unavailable.received.offer[0].transferId,
    code: STATUS_CODE.FILE_EXISTS
  })
  await t.exception(() => unavailableUpload, { name: 'SwarmDeployError', code: 'FILE_EXISTS' })

  const checksum = createPair({
    manifest,
    readChunk: async () => b4a.alloc(manifest.chunkSize, 99)
  })
  const { uploading: checksumUpload } = await openAndOffer(checksum, manifest)
  checksum.accept()
  await t.exception(() => checksumUpload, { name: 'SwarmDeployError', code: 'CHECKSUM_MISMATCH' })

  const timers = new Set()
  const scheduler = {
    setTimeout(callback) {
      const timer = { callback }
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) {
      timers.delete(timer)
    }
  }
  const timedOut = createPair({ manifest, scheduler })
  const { uploading: timeoutUpload } = await openAndOffer(timedOut, manifest)
  for (const timer of timers) timer.callback()
  await t.exception(() => timeoutUpload, { name: 'SwarmDeployError', code: 'UPLOAD_IDLE_TIMEOUT' })

  const frame = b4a.concat([
    c.encode(status, { transferId: b4a.alloc(32), code: STATUS_CODE.ACCEPT }),
    b4a.from([0])
  ])
  t.exception(
    () =>
      boundedEncoding(status, MAX_CONTROL_BYTES).decode({
        buffer: frame,
        start: 0,
        end: frame.byteLength
      }),
    { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' }
  )
})

test('client session reports a source removed after pre-hash as FILE_BUSY', async (t) => {
  const source = path.join(await createTempDir(t), 'removed.bin')
  await fs.promises.writeFile(source, b4a.from('remove after pre-hash'))
  const manifest = await buildFileManifest(source)
  const pair = createPair({ manifest, useFileReader: true })
  const { uploading } = await openAndOffer(pair, manifest)
  await fs.promises.rm(source)

  pair.accept()
  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'FILE_BUSY' })
})

test('client session closes its channel when source descriptor cleanup fails', async (t) => {
  const manifest = createManifest(0)
  const pair = createPair({ manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.accept()
  await waitFor(() => pair.received.finish.length === 1)
  pair.session.file = {
    async close() {
      throw new Error('injected close failure')
    }
  }
  pair.serverMessages[RESULT].send({ transferId: id, code: 0 })

  await t.exception(() => uploading)
  t.ok(pair.channel.closed)
})
