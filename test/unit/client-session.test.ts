/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import c from 'compact-encoding'
import Protomux, { type ProtomuxChannel } from 'protomux'
import { Duplex } from 'streamx'
import {
  ClientSession,
  type ClientSessionResult,
  UPLOAD_PROTOCOL,
  MAX_IN_FLIGHT,
  boundedEncoding
} from '../../dist/protocol/client-session.js'
import {
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
} from '../../dist/protocol/constants.js'
import {
  offer,
  status,
  bitmapPage,
  ready,
  chunk,
  chunkAck,
  finish,
  result
} from '../../dist/protocol/codecs.js'
import { transferId } from '../../dist/protocol/transfer-id.js'
import { ERRORS } from '../../dist/errors.js'
import type {
  Chunk,
  Digest,
  FileManifest,
  FileSnapshot,
  Offer,
  ProtocolChannel,
  SessionScheduler,
  TransferMessage
} from '../../dist/protocol/types.js'
import { buildFileManifest } from '../../dist/files.js'
import { createTempDir } from '../helpers/files.js'

const CLIENT_KEY = b4a.alloc(32, 9)

/**
 * The harness manifest. `stat` and `chunks` are optional so both the in-memory
 * fixtures and a real `buildFileManifest` result share one shape.
 */
interface HarnessManifest extends Omit<FileManifest, 'stat'> {
  stat?: FileSnapshot
  chunks?: Buffer[]
}

/** A Protomux message as the harness drives it: any encoded payload. */
interface HarnessMessage {
  send(value: unknown): boolean
}

interface ReceivedMessages {
  offer: Offer[]
  chunk: Chunk[]
  finish: TransferMessage[]
}

interface FakeTimer {
  callback: () => void
}

interface CreatePairOptions {
  manifest?: HarnessManifest
  scheduler?: SessionScheduler | null
  readChunk?: ((manifest: FileManifest, index: number) => Promise<Uint8Array>) | null
  openSource?: NonNullable<ConstructorParameters<typeof ClientSession>[0]['openSource']>
  useFileReader?: boolean
}

interface ProtocolPair {
  channel: ProtomuxChannel
  clientMux: Protomux
  received: ReceivedMessages
  session: ClientSession
  readonly serverChannel: ProtomuxChannel
  readonly serverMessages: HarnessMessage[]
  accept(verified?: number[]): void
}

function asManifest(manifest: HarnessManifest): FileManifest {
  return manifest as FileManifest
}

function sha256(bytes: Uint8Array): Digest {
  return crypto.createHash('sha256').update(bytes).digest()
}

function waitFor(predicate: () => boolean, timeout = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const check = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started >= timeout) {
        return reject(new Error('Timed out waiting for protocol progress'))
      }
      setTimeout(check, 1)
    }
    check()
  })
}

function createDuplexPair(): { left: Duplex; right: Duplex } {
  let left!: Duplex
  let right!: Duplex
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

function createManifest(count = 3): HarnessManifest {
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

function createPair(
  t: Assert,
  {
    manifest = createManifest(),
    scheduler = null,
    readChunk = null,
    openSource,
    useFileReader = false
  }: CreatePairOptions = {}
): ProtocolPair {
  const { left, right } = createDuplexPair()
  const clientMux = Protomux.from(left)
  const serverMux = Protomux.from(right)
  const received: ReceivedMessages = { offer: [], chunk: [], finish: [] }
  let serverChannel: ProtomuxChannel | null = null
  let serverMessages: HarnessMessage[] | null = null

  serverMux.pair({ protocol: UPLOAD_PROTOCOL }, (id) => {
    const channel = serverMux.createChannel({ protocol: UPLOAD_PROTOCOL, id })
    serverChannel = channel
    serverMessages = [
      channel.addMessage({
        encoding: offer,
        onmessage: (value) => received.offer.push(value)
      }),
      channel.addMessage({ encoding: status }),
      channel.addMessage({ encoding: bitmapPage }),
      channel.addMessage({ encoding: ready }),
      channel.addMessage({
        encoding: chunk,
        onmessage: (value) => received.chunk.push(value)
      }),
      channel.addMessage({ encoding: chunkAck }),
      channel.addMessage({
        encoding: finish,
        onmessage: (value) => received.finish.push(value)
      }),
      channel.addMessage({ encoding: result })
    ]
    channel.open()
  })

  const channel = clientMux.createChannel({
    protocol: UPLOAD_PROTOCOL,
    id: b4a.from('client-session-test')
  })
  const session = new ClientSession({
    channel: channel as unknown as ProtocolChannel,
    clientPublicKey: CLIENT_KEY,
    readChunk: useFileReader ? null : readChunk || ((_manifest, index) => manifest.chunks![index]),
    ...(openSource ? { openSource } : {}),
    ...(scheduler ? { scheduler } : {})
  })
  t.teardown(async () => {
    await session.close().catch(() => {})
    left.destroy()
    right.destroy()
  })

  return {
    channel,
    clientMux,
    received,
    session,
    get serverChannel() {
      return serverChannel!
    },
    get serverMessages() {
      return serverMessages!
    },
    accept(verified: number[] = []) {
      const id = received.offer[0].transferId
      serverMessages![STATUS].send({ transferId: id, code: STATUS_CODE.ACCEPT })
      if (manifest.chunkCount > 0) {
        const bits = b4a.alloc(Math.ceil(manifest.chunkCount / 8))
        for (const index of verified) bits[Math.floor(index / 8)] |= 1 << (index % 8)
        serverMessages![BITMAP_PAGE].send({
          transferId: id,
          start: 0,
          count: manifest.chunkCount,
          bits
        })
      }
      serverMessages![READY].send({ transferId: id })
    }
  }
}

async function openAndOffer(
  pair: ProtocolPair,
  manifest: HarnessManifest
): Promise<{ uploading: Promise<ClientSessionResult> }> {
  const uploading = pair.session.upload(asManifest(manifest))
  await new Promise((resolve) => setTimeout(resolve, 5))
  pair.channel.open()
  await waitFor(() => pair.received.offer.length === 1)
  return { uploading }
}

test('client session sends OFFER only after its channel fully opens', async (t) => {
  const manifest = createManifest(0)
  const pair = createPair(t, { manifest })
  const uploading = pair.session.upload(asManifest(manifest))

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
  const pair = createPair(t, { manifest })
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
  const pair = createPair(t, { manifest })
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
  const pair = createPair(t, { manifest })
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
  const pair = createPair(t, { manifest })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.serverMessages[READY].send({ transferId: id })
  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })

  const second = createPair(t, { manifest })
  const { uploading: retry } = await openAndOffer(second, manifest)
  second.serverMessages[STATUS].send({ transferId: b4a.alloc(32), code: STATUS_CODE.ACCEPT })
  await t.exception(() => retry, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })
})

test('client session fails closed on every forbidden server message direction', async (t) => {
  const manifest = createManifest(1)
  for (const type of [OFFER, CHUNK, FINISH]) {
    const pair = createPair(t, { manifest })
    const { uploading } = await openAndOffer(pair, manifest)
    const id = pair.received.offer[0].transferId
    if (type === OFFER) pair.serverMessages[type].send(pair.received.offer[0])
    if (type === CHUNK) {
      pair.serverMessages[type].send({
        transferId: id,
        index: 0,
        digest: manifest.chunkDigests[0],
        data: manifest.chunks![0]
      })
    }
    if (type === FINISH) pair.serverMessages[type].send({ transferId: id })
    await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' })
    t.ok(pair.channel._mux.stream.destroyed)
  }
})

test('client session rejects invalid acknowledgements', async (t) => {
  for (const invalid of ['duplicate', 'mismatched-transfer', 'out-of-range'] as const) {
    const manifest = createManifest(1)
    const pair = createPair(t, { manifest })
    const { uploading } = await openAndOffer(pair, manifest)
    const id = pair.received.offer[0].transferId

    pair.accept()
    await waitFor(() => pair.received.chunk.length === 1)
    if (invalid === 'duplicate') {
      pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })
      pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })
    } else {
      pair.serverMessages[CHUNK_ACK].send({
        transferId: invalid === 'mismatched-transfer' ? b4a.alloc(32) : id,
        index: invalid === 'out-of-range' ? 1 : 0
      })
    }
    await t.exception(
      () => uploading,
      { name: 'SwarmDeployError', code: 'PROTOCOL_INVALID' },
      invalid
    )
  }
})

test('client session resolves committed and already committed results', async (t) => {
  const manifest = createManifest(0)
  const committed = createPair(t, { manifest })
  const { uploading: committedUpload } = await openAndOffer(committed, manifest)
  const id = committed.received.offer[0].transferId
  committed.accept()
  await waitFor(() => committed.received.finish.length === 1)
  committed.serverMessages[RESULT].send({ transferId: id, code: 0 })
  t.is((await committedUpload).status, 'COMMITTED')

  const already = createPair(t, { manifest })
  const { uploading: alreadyUpload } = await openAndOffer(already, manifest)
  const alreadyId = already.received.offer[0].transferId
  already.serverMessages[STATUS].send({
    transferId: alreadyId,
    code: STATUS_CODE.ALREADY_COMMITTED
  })
  t.is((await alreadyUpload).status, 'ALREADY_COMMITTED')
})

test('client session preserves the stable active-upload limit reason', async (t) => {
  const manifest = createManifest(1)
  const pair = createPair(t, { manifest })
  const events: Array<Record<string, unknown>> = []
  pair.session.onEvent = (event) => events.push(event)
  const { uploading } = await openAndOffer(pair, manifest)
  pair.serverMessages[STATUS].send({
    transferId: pair.received.offer[0].transferId,
    code: STATUS_CODE.REJECTED,
    reason: ERRORS.ACTIVE_UPLOAD_LIMIT
  })

  await t.exception(() => uploading, {
    name: 'SwarmDeployError',
    code: ERRORS.ACTIVE_UPLOAD_LIMIT
  })
  t.is(
    events.find((event) => event.type === 'offer' && event.status === 'rejected')?.reason,
    ERRORS.ACTIVE_UPLOAD_LIMIT
  )
})

test('client session turns terminal statuses, local checksums, timeouts, and bad frames into typed errors', async (t) => {
  const manifest = createManifest(1)
  const unavailable = createPair(t, { manifest })
  const { uploading: unavailableUpload } = await openAndOffer(unavailable, manifest)
  unavailable.serverMessages[STATUS].send({
    transferId: unavailable.received.offer[0].transferId,
    code: STATUS_CODE.FILE_EXISTS
  })
  await t.exception(() => unavailableUpload, { name: 'SwarmDeployError', code: 'FILE_EXISTS' })

  const checksum = createPair(t, {
    manifest,
    readChunk: () => Promise.resolve(b4a.alloc(manifest.chunkSize, 99))
  })
  const { uploading: checksumUpload } = await openAndOffer(checksum, manifest)
  checksum.accept()
  await t.exception(() => checksumUpload, { name: 'SwarmDeployError', code: 'CHECKSUM_MISMATCH' })

  const timers = new Set<FakeTimer>()
  const scheduler: SessionScheduler = {
    setTimeout(callback) {
      const timer = { callback }
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) {
      timers.delete(timer as FakeTimer)
    }
  }
  const timedOut = createPair(t, { manifest, scheduler })
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
  const pair = createPair(t, { manifest, useFileReader: true })
  const { uploading } = await openAndOffer(pair, manifest)
  await fs.promises.rm(source)

  pair.accept()
  await t.exception(() => uploading, { name: 'SwarmDeployError', code: 'FILE_BUSY' })
})

test('client session closes its channel when source descriptor cleanup fails', async (t) => {
  const source = path.join(await createTempDir(t), 'close-failure.bin')
  await fs.promises.writeFile(source, b4a.from('close me'))
  const manifest = await buildFileManifest(source)
  let opened: Awaited<ReturnType<typeof fs.promises.open>> | null = null
  const pair = createPair(t, {
    manifest,
    useFileReader: true,
    async openSource(filePath, flags) {
      const handle = await fs.promises.open(filePath, flags)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        throw new Error('injected close failure')
      }
      opened = handle
      return handle
    }
  })
  const { uploading } = await openAndOffer(pair, manifest)
  const id = pair.received.offer[0].transferId

  pair.accept()
  await waitFor(() => pair.received.chunk.length === 1)
  pair.serverMessages[CHUNK_ACK].send({ transferId: id, index: 0 })

  await t.exception(() => uploading, { message: 'injected close failure' })
  await t.exception(() => opened!.stat(), { code: 'EBADF' })
  t.ok(pair.channel.closed)
})
