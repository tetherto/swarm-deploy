/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { pack, type Header } from 'tar-stream'
import { createAbortController } from '../../dist/abort.js'
import { ERRORS } from '../../dist/errors.js'
import {
  assertMetadataTransferId,
  buildTarManifest,
  deterministicTarSize,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import {
  CONTROL_VERSION,
  MAX_CONTROL_RECORD_BYTES,
  ControlFrameDecoder,
  decodeAdmissionRecord,
  decodeFinalRecord,
  decodeMetadataRecord,
  encodeAdmissionRecord,
  encodeControlFrame,
  encodeFinalRecord,
  encodeMetadataRecord,
  type MetadataRecord
} from '../../dist/tar-protocol/controls.js'
import { TarProtocolLifecycle, writeProtocolBytes } from '../../dist/tar-protocol/lifecycle.js'
import { DirectWireReader } from '../../dist/tar-protocol/direct-wire.js'
import {
  validateAndExtractTar,
  type TarExtractionStaging
} from '../../dist/tar-protocol/extract.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir } from '../helpers/files.js'

const CLIENT_KEY = b4a.alloc(32, 23)

function readableSocket() {
  const listeners = new Map<string, Set<(value?: Buffer) => void>>()
  return {
    on(event: string, listener: (value?: Buffer) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return this
    },
    removeListener(event: string, listener: (value?: Buffer) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    pause() {},
    resume() {},
    emit(event: string, value?: Buffer) {
      for (const listener of listeners.get(event) || []) listener(value)
    }
  }
}

function sha256(bytes: Uint8Array): Buffer {
  return sodiumSha256(bytes)
}

async function collectTar(manifest: TarManifest, offset = 0): Promise<Buffer> {
  const chunks: Buffer[] = []
  const result = await regenerateTarSuffix(manifest, offset, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  if (result.status !== 'MATCH') throw new Error('Unexpected reset')
  return b4a.concat(chunks)
}

async function archive(
  header: Partial<Header> & Pick<Header, 'name'>,
  body = b4a.alloc(0)
): Promise<Buffer> {
  const output = pack()
  output.entry(header, body)
  output.finalize()
  const chunks: Buffer[] = []
  for await (const value of output) chunks.push(b4a.from(value as Uint8Array))
  return b4a.concat(chunks)
}

function metadataForTar(tar: Uint8Array, overrides: Partial<MetadataRecord> = {}): MetadataRecord {
  const body = b4a.from('payload')
  return {
    v: CONTROL_VERSION,
    name: 'artifact.bin',
    fileSize: body.byteLength,
    fileSha256: b4a.toString(sha256(body), 'hex'),
    tarSize: tar.byteLength,
    tarSha256: b4a.toString(sha256(tar), 'hex'),
    transferId: '11'.repeat(32),
    reset: false,
    ...overrides
  }
}

function memoryStaging(): TarExtractionStaging & {
  tar: Buffer[]
  file: Buffer[]
  completed: number
  aborted: number
} {
  return {
    tar: [],
    file: [],
    completed: 0,
    aborted: 0,
    writeTar(chunk) {
      this.tar.push(b4a.from(chunk))
    },
    writeFile(chunk) {
      this.file.push(b4a.from(chunk))
    },
    complete() {
      this.completed++
    },
    abort() {
      this.aborted++
    }
  }
}

test('canonical TAR is deterministic and bound into its manifest', async (t) => {
  const dir = await createTempDir(t)
  const file = path.join(dir, 'artifact.bin')
  await fs.promises.writeFile(file, b4a.from('payload'))

  const first = await buildTarManifest(file, CLIENT_KEY)
  const second = await buildTarManifest(file, CLIENT_KEY)
  const firstTar = await collectTar(first)
  const secondTar = await collectTar(second)

  t.alike(firstTar, secondTar)
  t.is(first.fileSize, 7)
  t.is(first.tarSize, deterministicTarSize(7))
  t.alike(first.fileSha256, sha256(b4a.from('payload')))
  t.alike(first.tarSha256, sha256(firstTar))
  t.alike(first.transferId, second.transferId)
  t.is(
    b4a.toString(first.tarSha256, 'hex'),
    '00e2b1271cceb3d62531532827f9487ed0253365ad311822ce3b2e1ec734f3d6'
  )
  t.is(
    b4a.toString(first.transferId, 'hex'),
    '1c1e719f9bb199367352c667f1e9edbf7cc8f2b73630c832cd9ab6d558615e7c'
  )
  t.is(firstTar.readUInt8(156), 48)
  t.is(
    firstTar.subarray(512 + 7).every((byte) => byte === 0),
    true
  )
})

test('canonical TAR resume works at every archive region', async (t) => {
  const dir = await createTempDir(t)
  const file = path.join(dir, 'artifact.bin')
  await fs.promises.writeFile(file, b4a.from('payload'))
  const manifest = await buildTarManifest(file, CLIENT_KEY)
  const whole = await collectTar(manifest)
  const offsets = [0, 13, 512, 515, 519, 1023, 1024, manifest.tarSize - 1, manifest.tarSize]

  for (const offset of offsets) {
    const chunks: Buffer[] = []
    const result = await regenerateTarSuffix(manifest, offset, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    if (result.status !== 'MATCH') throw new Error('Unexpected reset')
    t.alike(result.prefixSha256, sha256(whole.subarray(0, offset)))
    t.alike(b4a.concat(chunks), whole.subarray(offset))
  }
})

test('resume rejects invalid offsets and requests reset on prefix mismatch', async (t) => {
  const dir = await createTempDir(t)
  const file = path.join(dir, 'artifact.bin')
  await fs.promises.writeFile(file, b4a.from('payload'))
  const manifest = await buildTarManifest(file, CLIENT_KEY)
  await t.exception(
    regenerateTarSuffix(manifest, -1, () => {}),
    {
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  await t.exception(
    regenerateTarSuffix(manifest, manifest.tarSize + 1, () => {}),
    {
      code: ERRORS.PROTOCOL_INVALID
    }
  )
  let writes = 0
  const mismatch = await regenerateTarSuffix(
    manifest,
    512,
    () => {
      writes++
    },
    { expectedPrefixSha256: b4a.alloc(32, 99) }
  )
  t.is(mismatch.status, 'RESET_REQUIRED')
  t.is(writes, 0)
})

test('TAR regeneration detects a changed source and closes its descriptor', async (t) => {
  const dir = await createTempDir(t)
  const file = path.join(dir, 'artifact.bin')
  await fs.promises.writeFile(file, b4a.from('payload'))
  const manifest = await buildTarManifest(file, CLIENT_KEY)
  await fs.promises.writeFile(file, b4a.from('changed'))

  await t.exception(collectTar(manifest), { code: ERRORS.FILE_BUSY })
  await fs.promises.rename(file, `${file}.renamed`)
  t.pass('source descriptor was closed')
})

test('bounded control records round-trip exact strict schemas', (t) => {
  const metadata = metadataForTar(b4a.alloc(deterministicTarSize(7)))
  t.alike(decodeMetadataRecord(encodeMetadataRecord(metadata)), metadata)

  const admissions = [
    { v: 1, status: 'ACCEPT', offset: 0 } as const,
    { v: 1, status: 'RESUME', offset: 513, prefixSha256: '22'.repeat(32) } as const,
    { v: 1, status: 'ALREADY_COMMITTED' } as const,
    { v: 1, status: 'REJECTED', code: ERRORS.FILE_TOO_LARGE } as const
  ]
  for (const value of admissions) {
    t.alike(decodeAdmissionRecord(encodeAdmissionRecord(value)), value)
  }

  const finals = [
    { v: 1, status: 'COMMITTED' } as const,
    { v: 1, status: 'FAILED', code: ERRORS.CHECKSUM_MISMATCH } as const
  ]
  for (const value of finals) t.alike(decodeFinalRecord(encodeFinalRecord(value)), value)
})

test('control decoders reject unknown fields, versions, types, hex, and bounds', (t) => {
  const valid = metadataForTar(b4a.alloc(deterministicTarSize(7)))
  const invalid: unknown[] = [
    { ...valid, extra: true },
    { ...valid, v: 2 },
    { ...valid, fileSize: -1 },
    { ...valid, fileSha256: valid.fileSha256.toUpperCase() },
    { ...valid, tarSize: 1 },
    null,
    []
  ]
  for (const value of invalid) {
    t.exception(() => decodeMetadataRecord(b4a.from(JSON.stringify(value))), {
      code: ERRORS.PROTOCOL_INVALID
    })
  }
  t.exception(() => decodeMetadataRecord(b4a.alloc(MAX_CONTROL_RECORD_BYTES + 1)), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () => decodeAdmissionRecord(b4a.from(JSON.stringify({ v: 1, status: 'RESUME', offset: 1 }))),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.exception(
    () =>
      decodeFinalRecord(b4a.from(JSON.stringify({ v: 1, status: 'FAILED', code: 'NOT_STABLE' }))),
    { code: ERRORS.PROTOCOL_INVALID }
  )
})

test('control framing handles fragmentation and rejects oversized frames', (t) => {
  const value = { v: 1, status: 'COMMITTED' } as const
  const frame = encodeControlFrame(encodeFinalRecord(value))
  const decoder = new ControlFrameDecoder(decodeFinalRecord)
  t.alike(decoder.push(frame.subarray(0, 2)), [])
  t.alike(decoder.push(frame.subarray(2)), [value])
  t.exception(() => new ControlFrameDecoder(decodeFinalRecord).push(b4a.from([0, 0, 16, 1])), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('one-entry TAR extraction validates and hashes the regular file', async (t) => {
  const body = b4a.from('payload')
  const tar = await archive(
    {
      name: 'artifact.bin',
      type: 'file',
      size: body.byteLength,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      uname: '',
      gname: '',
      pax: null
    },
    body
  )
  const staging = memoryStaging()
  const result = await validateAndExtractTar(
    [tar.subarray(0, 517), tar.subarray(517)],
    metadataForTar(tar),
    staging
  )

  t.alike(b4a.concat(staging.tar), tar)
  t.alike(b4a.concat(staging.file), body)
  t.alike(result.fileSha256, sha256(body))
  t.is(result.fileSize, body.byteLength)
  t.is(staging.completed, 1)
  t.is(staging.aborted, 0)
})

test('TAR extraction rejects unsafe paths', async (t) => {
  const names = [
    '/absolute',
    '../escape',
    'dir/file',
    'bad\\name',
    '.swarm-deploy',
    'history-deadbeef'
  ]
  for (const name of names) {
    const body = b4a.from('payload')
    const tar = await archive(
      {
        name,
        type: 'file',
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: new Date(0)
      },
      body
    )
    const staging = memoryStaging()
    await t.exception(validateAndExtractTar([tar], metadataForTar(tar, { name }), staging), {
      code: ERRORS.INVALID_FILENAME
    })
  }
})

test('TAR extraction rejects unsafe entry types and PAX surprises', async (t) => {
  const types = [
    'directory',
    'symlink',
    'link',
    'character-device',
    'block-device',
    'fifo'
  ] as const
  for (const type of types) {
    const tar = await archive({
      name: 'artifact.bin',
      type,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      linkname: type === 'symlink' || type === 'link' ? 'target' : ''
    })
    await t.exception(
      validateAndExtractTar(
        [tar],
        metadataForTar(tar, { fileSize: 0, fileSha256: b4a.toString(sha256(b4a.alloc(0)), 'hex') }),
        memoryStaging()
      ),
      { code: ERRORS.PROTOCOL_INVALID }
    )
  }
  const pax = await archive(
    {
      name: 'artifact.bin',
      type: 'file',
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      pax: { comment: 'surprise' }
    },
    b4a.from('payload')
  )
  await t.exception(validateAndExtractTar([pax], metadataForTar(pax), memoryStaging()), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('TAR extraction rejects extra, truncated, trailing, and digest attacks', async (t) => {
  const body = b4a.from('payload')
  const valid = await archive(
    {
      name: 'artifact.bin',
      type: 'file',
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0)
    },
    body
  )
  const second = await archive(
    {
      name: 'second.bin',
      type: 'file',
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0)
    },
    b4a.from('second')
  )
  const extra = b4a.concat([valid.subarray(0, valid.byteLength - 1024), second])
  const attacks = [
    { tar: extra, metadata: metadataForTar(extra) },
    { tar: valid.subarray(0, -1), metadata: metadataForTar(valid) },
    { tar: b4a.concat([valid, b4a.from('x')]), metadata: metadataForTar(valid) },
    {
      tar: valid,
      metadata: metadataForTar(valid, { fileSha256: '00'.repeat(32) })
    }
  ]
  for (const attack of attacks) {
    const staging = memoryStaging()
    await t.exception(validateAndExtractTar([attack.tar], attack.metadata, staging))
  }
})

test('protocol lifecycle requires explicit final success', (t) => {
  const lifecycle = new TarProtocolLifecycle()
  lifecycle.metadata()
  lifecycle.admission({ v: 1, status: 'ACCEPT', offset: 0 })
  lifecycle.beginTar()
  lifecycle.completeTar()
  t.exception(() => lifecycle.close(), { code: ERRORS.PROTOCOL_INVALID })

  const committed = new TarProtocolLifecycle()
  committed.metadata()
  committed.admission({ v: 1, status: 'ACCEPT', offset: 0 })
  committed.beginTar()
  committed.completeTar()
  committed.final({ v: 1, status: 'COMMITTED' })
  t.is(committed.result, 'COMMITTED')

  const idempotent = new TarProtocolLifecycle()
  idempotent.metadata()
  idempotent.admission({ v: 1, status: 'ALREADY_COMMITTED' })
  t.is(idempotent.result, 'ALREADY_COMMITTED')

  const reset = new TarProtocolLifecycle()
  reset.metadata()
  reset.admission({ v: 1, status: 'RESUME', offset: 512, prefixSha256: '22'.repeat(32) })
  reset.reset()
  reset.admission({ v: 1, status: 'ACCEPT', offset: 0 })
  reset.beginTar()
  t.is(reset.state, 'TAR')
})

test('direct wire rejects buffered bytes after exact TAR without waiting for EOF', async (t) => {
  const socket = readableSocket()
  const reader = new DirectWireReader(socket as never)
  socket.emit('data', b4a.from('ab'))
  await reader.tar(1, async () => {}, null, 100)
  await t.exception(reader.requireEnd(null, 100), {
    code: ERRORS.PROTOCOL_INVALID,
    message: 'Trailing bytes after exact TAR payload'
  })
  reader.closeReader()
})

test('protocol byte writer honors backpressure', async (t) => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const stream = {
    write() {
      return false
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return this
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    destroy() {}
  }
  let settled = false
  const pending = writeProtocolBytes(stream, b4a.from('x'), { timeout: 100 }).then(() => {
    settled = true
  })
  await Promise.resolve()
  t.is(settled, false)
  for (const listener of listeners.get('drain') || []) listener()
  await pending
  t.is(settled, true)
  t.is(
    [...listeners.values()].every((set) => set.size === 0),
    true
  )
})

test('protocol byte writer rejects an already-destroyed stream without waiting', async (t) => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const stream = {
    destroyed: true,
    write() {
      return false
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return this
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return this
    },
    destroy() {}
  }

  await t.exception(writeProtocolBytes(stream, b4a.from('x'), { timeout: 5 }), {
    code: ERRORS.PROTOCOL_INVALID,
    transport: true
  })
  t.is(listeners.size, 0)
})

test('protocol byte writer handles abort, timeout, and stream errors without leaks', async (t) => {
  function blocked() {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    let destroyed = 0
    return {
      listeners,
      get destroyed() {
        return destroyed
      },
      write() {
        return false
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)?.add(listener)
        return this
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener)
        return this
      },
      destroy() {
        destroyed++
      }
    }
  }

  const controller = createAbortController()
  const aborted = blocked()
  const abortPending = writeProtocolBytes(aborted, b4a.from('x'), {
    signal: controller.signal,
    timeout: 100
  })
  controller.abort()
  await t.exception(abortPending, { code: ERRORS.ABORTED })
  t.is(
    [...aborted.listeners.values()].every((set) => set.size === 0),
    true
  )

  const timed = blocked()
  await t.exception(writeProtocolBytes(timed, b4a.from('x'), { timeout: 5 }), {
    code: ERRORS.UPLOAD_IDLE_TIMEOUT
  })
  t.is(
    [...timed.listeners.values()].every((set) => set.size === 0),
    true
  )

  const errored = blocked()
  const errorPending = writeProtocolBytes(errored, b4a.from('x'), { timeout: 100 })
  for (const listener of errored.listeners.get('error') || []) listener(new Error('boom'))
  await t.exception(errorPending, /boom/)
  t.is(
    [...errored.listeners.values()].every((set) => set.size === 0),
    true
  )
})

test('manifest metadata conversion is exact and reset-aware', async (t) => {
  const dir = await createTempDir(t)
  const file = path.join(dir, 'artifact.bin')
  await fs.promises.writeFile(file, b4a.from('payload'))
  const manifest = await buildTarManifest(file, CLIENT_KEY)
  const metadata = metadataFromManifest(manifest, true)
  t.alike(Object.keys(metadata), [
    'v',
    'name',
    'fileSize',
    'fileSha256',
    'tarSize',
    'tarSha256',
    'transferId',
    'reset'
  ])
  t.is(metadata.reset, true)
  assertMetadataTransferId(CLIENT_KEY, metadata)
  t.exception(() => assertMetadataTransferId(b4a.alloc(32, 24), metadata), {
    code: ERRORS.PROTOCOL_INVALID
  })
})
