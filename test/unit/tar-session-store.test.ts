/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { initLayout } from '../../dist/storage/layout.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { recoverStorage } from '../../dist/storage/recovery.js'
import { historyName } from '../../dist/files.js'
import {
  buildTarManifest,
  computeTarTransferId,
  metadataFromManifest,
  regenerateTarSuffix,
  type TarManifest
} from '../../dist/tar-protocol/manifest.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'

const OWNER = b4a.alloc(32, 7)
const OTHER_OWNER = b4a.alloc(32, 8)

async function tar(manifest: TarManifest): Promise<Buffer> {
  const chunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return b4a.concat(chunks)
}

async function fixture(
  t: Assert,
  content = 'TAR offset storage payload'
): Promise<{
  layout: ReturnType<typeof initLayout>
  metadata: ReturnType<typeof metadataFromManifest>
  archive: Buffer
}> {
  const root = await createTempDir(t)
  const sourceDirectory = path.join(root, 'source')
  await fs.promises.mkdir(sourceDirectory)
  const source = path.join(sourceDirectory, 'artifact.bin')
  await fs.promises.writeFile(source, b4a.from(content))
  const manifest = await buildTarManifest(source, OWNER)
  return {
    layout: initLayout(root),
    metadata: metadataFromManifest(manifest),
    archive: await tar(manifest)
  }
}

test('TAR admission reconstructs a durable offset and rehashes its prefix on restart', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const first = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await first.init()
  await first.admit(OWNER, metadata)
  await first.append(OWNER, metadata, 0, archive.subarray(0, 777))
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  const admission = await restarted.admit(OWNER, metadata)
  t.is(admission.status, 'RESUME')
  if (admission.status !== 'RESUME') throw new Error('Expected resumable TAR admission')
  t.is(admission.offset, 777)
  t.alike(admission.prefixSha256, sodiumSha256(archive.subarray(0, 777)))
  t.is(restarted.reservedBytes, metadata.tarSize + metadata.fileSize)
})

test('TAR admission rejects owner mismatch and reset durably truncates the admitted archive', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const store = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, archive.subarray(0, 512))
  const otherMetadata = {
    ...metadata,
    transferId: b4a.toString(
      computeTarTransferId(OTHER_OWNER, {
        name: metadata.name,
        fileSize: metadata.fileSize,
        fileSha256: b4a.from(metadata.fileSha256, 'hex'),
        tarSize: metadata.tarSize,
        tarSha256: b4a.from(metadata.tarSha256, 'hex')
      }),
      'hex'
    )
  }
  await t.exception(() => store.admit(OTHER_OWNER, otherMetadata), { code: ERRORS.FILE_BUSY })
  const reset = await store.admit(OWNER, { ...metadata, reset: true })
  t.alike(reset, { status: 'ACCEPT', offset: 0 })
  await store.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.alike(await restarted.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
})

test('TAR progress is not exposed when its data fsync fails', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let fail = false
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!fail || !filePath.endsWith('.tar.part')) return false
      fail = false
      return true
    }
  })
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  fail = true
  await t.exception(() => store.append(OWNER, metadata, 0, archive.subarray(0, 512)))
  t.alike(await store.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
})

test('failed append rolls staging back before a shorter retry and restart', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let failSync = false
  const storage = createStorage({
    failSyncFor: (filePath) => {
      if (!failSync || !filePath.endsWith('.tar.part')) return false
      failSync = false
      return true
    }
  })
  const first = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await first.init()
  await first.admit(OWNER, metadata)
  failSync = true
  await t.exception(() => first.append(OWNER, metadata, 0, archive.subarray(0, 777)))
  t.is(
    (await fs.promises.stat(path.join(layout.staging, `${metadata.transferId}.tar.part`))).size,
    0
  )
  await first.append(OWNER, metadata, 0, archive.subarray(0, 512))
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  const admission = await restarted.admit(OWNER, metadata)
  t.is(admission.status, 'RESUME')
  if (admission.status !== 'RESUME') throw new Error('Expected shorter durable retry')
  t.is(admission.offset, 512)
  t.alike(admission.prefixSha256, sodiumSha256(archive.subarray(0, 512)))
})

test('rollback failure quarantines a TAR session until restart repairs it', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let failSync = false
  let failRollback = false
  const storage = createStorage({
    failSyncFor: (filePath) => failSync && filePath.endsWith('.tar.part'),
    beforeOperation(name, target) {
      if (failRollback && name === 'truncate' && target.endsWith('.tar.part')) {
        throw new Error('rollback truncate failed')
      }
    }
  })
  const first = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await first.init()
  await first.admit(OWNER, metadata)
  failSync = true
  failRollback = true
  let error: unknown = null
  try {
    await first.append(OWNER, metadata, 0, archive.subarray(0, 777))
  } catch (caught) {
    error = caught
  }
  t.ok(error && typeof error === 'object' && 'cleanupCause' in error)
  await t.exception(() => first.admit(OWNER, metadata))
  await t.exception(() => first.append(OWNER, metadata, 0, archive.subarray(0, 1)))
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.alike(await restarted.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
})

test('metadata failure with rollback failure quarantines TAR session until restart', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let failMetadata = false
  let failRollback = false
  const storage = createStorage({
    failWriteFor: (filePath) => failMetadata && filePath.startsWith(layout.sessions),
    beforeOperation(name, target) {
      if (failRollback && name === 'truncate' && target.endsWith('.tar.part')) {
        throw new Error('rollback truncate failed')
      }
    }
  })
  const first = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await first.init()
  await first.admit(OWNER, metadata)
  failMetadata = true
  failRollback = true
  let error: unknown = null
  try {
    await first.append(OWNER, metadata, 0, archive.subarray(0, 777))
  } catch (caught) {
    error = caught
  }
  t.ok(error && typeof error === 'object' && 'cleanupCause' in error)
  await t.exception(() => first.admit(OWNER, metadata))
  await t.exception(() => first.append(OWNER, metadata, 0, archive.subarray(0, 1)))
  failMetadata = false
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.alike(await restarted.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
})

test('complete TAR extraction creates journal-ready verified file staging', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const store = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, archive)
  const verified = await store.verify(OWNER, metadata)
  t.is(verified.state, 'verified')
  t.alike(
    await fs.promises.readFile(path.join(layout.staging, `${metadata.transferId}.part`)),
    b4a.from('TAR offset storage payload')
  )
  t.is((await store.readVerified(b4a.from(metadata.transferId, 'hex'))).tarSize, metadata.tarSize)
})

test('direct TAR verified staging commits and cleans both staging files', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const sessions = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await sessions.init()
  t.teardown(() => sessions.close())
  await sessions.admit(OWNER, metadata)
  await sessions.append(OWNER, metadata, 0, archive)
  const session = await sessions.verify(OWNER, metadata)
  const record = await new CommitStore({ layout }).commit(session)
  t.alike(
    await fs.promises.readFile(path.join(layout.root, metadata.name)),
    b4a.from('TAR offset storage payload')
  )
  await t.exception(
    () => fs.promises.lstat(path.join(layout.staging, `${metadata.transferId}.part`)),
    {
      code: 'ENOENT'
    }
  )
  await t.exception(
    () => fs.promises.lstat(path.join(layout.staging, `${metadata.transferId}.tar.part`)),
    { code: 'ENOENT' }
  )
  t.is(record.transferId, metadata.transferId)
})

test('direct TAR commits replace mutable files and retain history', async (t) => {
  const first = await fixture(t, 'first direct TAR payload')
  const sessions = new SessionStore({
    layout: first.layout,
    maxStagingBytes: (first.metadata.tarSize + first.metadata.fileSize) * 2
  })
  await sessions.init()
  t.teardown(() => sessions.close())
  const commits = new CommitStore({ layout: first.layout })
  await sessions.admit(OWNER, first.metadata)
  await sessions.append(OWNER, first.metadata, 0, first.archive)
  const firstRecord = await commits.commit(await sessions.verify(OWNER, first.metadata), {
    replaceNames: [first.metadata.name]
  })
  await sessions.retireCommitted(b4a.from(first.metadata.transferId, 'hex'))

  const second = await fixture(t, 'second direct TAR payload')
  await sessions.admit(OWNER, second.metadata)
  await sessions.append(OWNER, second.metadata, 0, second.archive)
  await commits.commit(await sessions.verify(OWNER, second.metadata), {
    replaceNames: [second.metadata.name]
  })
  t.alike(
    await fs.promises.readFile(path.join(first.layout.root, second.metadata.name)),
    b4a.from('second direct TAR payload')
  )
  t.alike(
    await fs.promises.readFile(path.join(first.layout.root, historyName(firstRecord.transferId))),
    b4a.from('first direct TAR payload')
  )
})

test('direct TAR journal recovery preserves then cleans tar staging after committed crash', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let failCleanup = true
  const storage = createStorage({
    beforeOperation(name, target) {
      if (failCleanup && name === 'unlink' && target.endsWith('.tar.part')) {
        failCleanup = false
        throw new Error('crash after durable commit')
      }
    }
  })
  const first = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await first.init()
  await first.admit(OWNER, metadata)
  await first.append(OWNER, metadata, 0, archive)
  await new CommitStore({ layout, storage }).commit(await first.verify(OWNER, metadata))
  await first.close()
  const tarPath = path.join(layout.staging, `${metadata.transferId}.tar.part`)
  t.ok(await fs.promises.lstat(tarPath))

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.ok(await fs.promises.lstat(tarPath))
  await recoverStorage({
    layout,
    sessionStore: restarted,
    commitStore: new CommitStore({ layout, storage })
  })
  await t.exception(() => fs.promises.lstat(tarPath), { code: 'ENOENT' })
})

test('verified TAR staging survives restart and rejects append or reset mutation', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const first = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await first.init()
  await first.admit(OWNER, metadata)
  await first.append(OWNER, metadata, 0, archive)
  await first.verify(OWNER, metadata)
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.alike(await restarted.admit(OWNER, metadata), { status: 'VERIFIED' })
  await t.exception(() => restarted.append(OWNER, metadata, metadata.tarSize, b4a.alloc(1)), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => restarted.admit(OWNER, { ...metadata, reset: true }), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is((await restarted.readVerified(b4a.from(metadata.transferId, 'hex'))).state, 'verified')
})

test('verification fsyncs extracted staging directory before publishing verified metadata', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const events: string[] = []
  const storage = createStorage({
    afterOperation(name, target, destination) {
      if (name === 'sync' || name === 'rename') {
        events.push(`${name}:${target}->${destination ?? ''}`)
      }
    }
  })
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, archive)
  events.length = 0
  await store.verify(OWNER, metadata)
  const fileSync = events.indexOf(
    `sync:${path.join(layout.staging, `${metadata.transferId}.part`)}->`
  )
  const directorySync = events.indexOf(`sync:${layout.staging}->`)
  const metadataRename = events.findIndex((event) =>
    event.endsWith(`->${path.join(layout.sessions, `${metadata.transferId}.json`)}`)
  )
  t.ok(fileSync >= 0)
  t.ok(directorySync > fileSync)
  t.ok(metadataRename > directorySync)
})

test('admission free-space checks include prior TAR peak reservations', async (t) => {
  const { layout, metadata } = await fixture(t)
  const peak = metadata.tarSize + metadata.fileSize
  const storage = {
    ...createStorage(),
    statfs: async () => ({ bavail: peak * 2 + 99, bsize: 1 })
  }
  const store = new SessionStore({
    layout,
    maxStagingBytes: peak * 3,
    minFreeBytes: 100,
    storage
  })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  const second = {
    ...metadata,
    name: 'second.bin',
    transferId: b4a.toString(
      computeTarTransferId(OTHER_OWNER, {
        name: 'second.bin',
        fileSize: metadata.fileSize,
        fileSha256: b4a.from(metadata.fileSha256, 'hex'),
        tarSize: metadata.tarSize,
        tarSha256: b4a.from(metadata.tarSha256, 'hex')
      }),
      'hex'
    )
  }
  await t.exception(() => store.admit(OTHER_OWNER, second), { code: ERRORS.DISK_RESERVE })
})

test('empty TAR appends and closed cleanup APIs are rejected without TTL progress', async (t) => {
  const { layout, metadata } = await fixture(t)
  const clock = createClock()
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    clock
  })
  await store.init()
  await store.admit(OWNER, metadata)
  clock.advance(10)
  await t.exception(() => store.append(OWNER, metadata, 0, b4a.alloc(0)), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is(await store.expire(9), 1)
  await store.close()
  await t.exception(() => store.readVerified(b4a.from(metadata.transferId, 'hex')), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => store.deleteByOwner(OWNER), { code: ERRORS.PROTOCOL_INVALID })
  await t.exception(() => store.deleteUnauthorized(() => true), { code: ERRORS.PROTOCOL_INVALID })
})

test('restart purges legacy staging only when its journal is absent', async (t) => {
  const { layout, metadata } = await fixture(t)
  const first = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await first.init()
  await first.close()
  await fs.promises.writeFile(
    path.join(layout.sessions, `${metadata.transferId}.json`),
    '{"version":1}'
  )
  const legacyStaging = path.join(layout.staging, `${metadata.transferId}.part`)
  await fs.promises.writeFile(legacyStaging, 'legacy')

  const purged = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await purged.init()
  await purged.close()
  await t.exception(() => fs.promises.lstat(legacyStaging), { code: 'ENOENT' })

  await fs.promises.writeFile(
    path.join(layout.sessions, `${metadata.transferId}.json`),
    '{"version":1}'
  )
  await fs.promises.writeFile(legacyStaging, 'journal-owned?')
  await fs.promises.writeFile(
    path.join(layout.journals, `${metadata.transferId}.json`),
    '{not json'
  )
  const blocked = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await t.exception(() => blocked.init())
  t.alike(await fs.promises.readFile(legacyStaging), b4a.from('journal-owned?'))
})

test('deleting TAR sessions finish cleanup durably on restart', async (t) => {
  const { layout, metadata } = await fixture(t)
  let fail = true
  const storage = createStorage({
    beforeOperation(name, target) {
      if (fail && name === 'unlink' && target.endsWith('.tar.part')) {
        fail = false
        throw new Error('interrupted delete')
      }
    }
  })
  const first = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await first.init()
  await first.admit(OWNER, metadata)
  await t.exception(() => first.delete(b4a.from(metadata.transferId, 'hex')))
  await first.close()

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.is(restarted.reservedBytes, 0)
  t.alike(await restarted.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
})

test('active TAR sessions remain protected from TTL expiry', async (t) => {
  const { layout, metadata } = await fixture(t)
  const clock = createClock()
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    clock,
    isSessionActive: () => true
  })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)
  clock.advance(11)
  t.is(await store.expire(10), 0)
  t.is(store.reservedBytes, metadata.tarSize + metadata.fileSize)
})

test('TAR sessions reserve peak staging across restart and expire only while inactive', async (t) => {
  const { layout, metadata } = await fixture(t)
  const clock = createClock()
  const limit = metadata.tarSize + metadata.fileSize
  const store = new SessionStore({ layout, maxStagingBytes: limit, resumeTtl: 10, clock })
  await store.init()
  await store.admit(OWNER, metadata)
  clock.advance(11)
  t.is(await store.expire(10, () => false), 0)
  t.is(await store.expire(10), 1)
  t.is(store.reservedBytes, 0)
  await store.close()
})
