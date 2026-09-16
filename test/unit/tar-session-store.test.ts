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
import { prepareStorageRecovery, recoverStorage } from '../../dist/storage/recovery.js'
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

async function additionalFixture(
  layout: ReturnType<typeof initLayout>,
  owner: Buffer,
  name: string,
  content: string
): Promise<{
  metadata: ReturnType<typeof metadataFromManifest>
  archive: Buffer
}> {
  const sourceDirectory = path.join(layout.root, `source-${name}`)
  await fs.promises.mkdir(sourceDirectory)
  const source = path.join(sourceDirectory, name)
  await fs.promises.writeFile(source, content)
  const manifest = await buildTarManifest(source, owner)
  return { metadata: metadataFromManifest(manifest), archive: await tar(manifest) }
}

function promptly<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 250)
    })
  ]).finally(() => clearTimeout(timer))
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

test('restart purges malformed TAR session metadata and its discardable TAR staging', async (t) => {
  const { layout, metadata } = await fixture(t)
  const initial = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await initial.init()
  await initial.close()

  const id = 'ab'.repeat(32)
  const metadataPath = path.join(layout.sessions, `${id}.json`)
  const tarPath = path.join(layout.staging, `${id}.tar.part`)
  await fs.promises.writeFile(metadataPath, '{malformed')
  await fs.promises.writeFile(tarPath, 'discardable')

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())

  t.is(restarted.purgedSessions, 1)
  await t.exception(() => fs.promises.lstat(metadataPath), { code: 'ENOENT' })
  await t.exception(() => fs.promises.lstat(tarPath), { code: 'ENOENT' })
})

test('restart purges durable atomic session metadata residue', async (t) => {
  const { layout, metadata } = await fixture(t)
  const initial = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await initial.init()
  await initial.close()

  const residue = path.join(layout.sessions, `.${'ab'.repeat(32)}.json.${'cd'.repeat(32)}.tmp`)
  await fs.promises.writeFile(residue, 'incomplete atomic metadata')
  const events: string[] = []
  const storage = createStorage({
    afterOperation(name, target) {
      if (name === 'unlink' || name === 'sync') events.push(`${name}:${target}`)
    }
  })
  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await restarted.init()
  t.teardown(() => restarted.close())

  t.is(restarted.purgedSessions, 1)
  await t.exception(() => fs.promises.lstat(residue), { code: 'ENOENT' })
  const unlinked = events.indexOf(`unlink:${residue}`)
  t.ok(unlinked >= 0)
  t.ok(events.slice(unlinked + 1).includes(`sync:${layout.sessions}`))
})

test('restart purges unowned regular staging residue', async (t) => {
  const { layout, metadata } = await fixture(t)
  const initial = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await initial.init()
  await initial.close()

  const residue = path.join(layout.staging, 'interrupted-extract.tmp')
  await fs.promises.writeFile(residue, 'incomplete staging')
  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())

  t.is(restarted.purgedSessions, 1)
  await t.exception(() => fs.promises.lstat(residue), { code: 'ENOENT' })
})

test('restart fails closed for unknown symlink and non-regular staging entries', async (t) => {
  const { layout, metadata } = await fixture(t)
  const initial = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await initial.init()
  await initial.close()

  const target = path.join(layout.root, 'outside-target')
  const symlink = path.join(layout.staging, 'unknown-link')
  await fs.promises.writeFile(target, 'must not be followed')
  await fs.promises.symlink(target, symlink)
  const withLink = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await t.exception(() => withLink.init(), { code: ERRORS.PROTOCOL_INVALID })
  t.ok((await fs.promises.lstat(symlink)).isSymbolicLink())
  t.alike(await fs.promises.readFile(target), b4a.from('must not be followed'))

  await fs.promises.unlink(symlink)
  const directory = path.join(layout.staging, 'unknown-directory')
  await fs.promises.mkdir(directory)
  const withDirectory = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await t.exception(() => withDirectory.init(), { code: ERRORS.PROTOCOL_INVALID })
  t.ok((await fs.promises.lstat(directory)).isDirectory())
})

test('corrupt session recovery preserves journal-owned extracted staging', async (t) => {
  const { layout, metadata } = await fixture(t)
  const id = 'ef'.repeat(32)
  const initial = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await initial.init()
  await initial.close()

  const extractedPath = path.join(layout.staging, `${id}.part`)
  const contents = b4a.from('journal-owned')
  await fs.promises.writeFile(extractedPath, contents)
  const stat = await fs.promises.stat(extractedPath)
  await fs.promises.writeFile(path.join(layout.sessions, `${id}.json`), '{bad')
  await fs.promises.writeFile(path.join(layout.staging, `${id}.tar.part`), 'discardable')
  await fs.promises.writeFile(
    path.join(layout.journals, `${id}.json`),
    JSON.stringify({
      version: 1,
      state: 'committing',
      transferId: id,
      attemptId: '12'.repeat(32),
      sourceStagingIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
      record: {
        version: 1,
        name: 'journal-owned.bin',
        size: contents.byteLength,
        sha256: b4a.toString(sodiumSha256(contents), 'hex'),
        committedAt: 0,
        uploaderFingerprint: '34'.repeat(32),
        transferId: id
      }
    })
  )

  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.alike(await fs.promises.readFile(extractedPath), contents)
  await t.exception(() => fs.promises.lstat(path.join(layout.staging, `${id}.tar.part`)), {
    code: 'ENOENT'
  })
})

test('restart purges corrupt canonical metadata and reconstructs valid reservations', async (t) => {
  const { layout, metadata } = await fixture(t)
  const peak = metadata.tarSize + metadata.fileSize
  const validName = 'remaining.bin'
  const valid = {
    ...metadata,
    name: validName,
    transferId: b4a.toString(
      computeTarTransferId(OTHER_OWNER, {
        name: validName,
        fileSize: metadata.fileSize,
        fileSha256: b4a.from(metadata.fileSha256, 'hex'),
        tarSize: metadata.tarSize,
        tarSha256: b4a.from(metadata.tarSha256, 'hex')
      }),
      'hex'
    )
  }
  const first = new SessionStore({ layout, maxStagingBytes: peak * 2 })
  await first.init()
  await first.admit(OWNER, metadata)
  await first.admit(OTHER_OWNER, valid)
  await first.close()

  const corruptPath = path.join(layout.sessions, `${metadata.transferId}.json`)
  const corrupt = JSON.parse(await fs.promises.readFile(corruptPath, 'utf8')) as {
    partialTar: { path: string }
  }
  corrupt.partialTar.path = 'not-canonical.tar.part'
  await fs.promises.writeFile(corruptPath, JSON.stringify(corrupt))

  const restarted = new SessionStore({ layout, maxStagingBytes: peak * 2 })
  await restarted.init()
  t.teardown(() => restarted.close())

  t.is(restarted.purgedSessions, 1)
  t.is(restarted.reservedBytes, peak)
  t.is((await restarted.admit(OTHER_OWNER, valid)).status, 'ACCEPT')
  await t.exception(() => fs.promises.lstat(corruptPath), { code: 'ENOENT' })
  await t.exception(
    () => fs.promises.lstat(path.join(layout.staging, `${metadata.transferId}.tar.part`)),
    { code: 'ENOENT' }
  )
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

test('verification does not block unrelated sessions and rejects same-session mutation', async (t) => {
  const first = await fixture(t, 'verification A payload')
  const second = await additionalFixture(
    first.layout,
    OTHER_OWNER,
    'verification-b.bin',
    'verification B payload'
  )
  let verificationStarted: () => void = () => {}
  let releaseVerification: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    verificationStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseVerification = resolve
  })
  let blocked = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (!blocked && name === 'read' && target.endsWith(`${first.metadata.transferId}.tar.part`)) {
        blocked = true
        verificationStarted()
        return gate
      }
    }
  })
  const store = new SessionStore({
    layout: first.layout,
    maxStagingBytes:
      first.metadata.tarSize +
      first.metadata.fileSize +
      second.metadata.tarSize +
      second.metadata.fileSize,
    storage
  })
  await store.init()
  await store.admit(OWNER, first.metadata)
  await store.append(OWNER, first.metadata, 0, first.archive)

  const verification = store.verify(OWNER, first.metadata)
  await started
  try {
    t.alike(await promptly(store.admit(OTHER_OWNER, second.metadata), 'session B admission'), {
      status: 'ACCEPT',
      offset: 0
    })
    t.is(
      await promptly(
        store.append(OTHER_OWNER, second.metadata, 0, second.archive.subarray(0, 512)),
        'session B append'
      ),
      512
    )
    await t.exception(
      promptly(store.admit(OWNER, { ...first.metadata, reset: true }), 'session A reset rejection'),
      { code: ERRORS.FILE_BUSY }
    )
    await t.exception(
      promptly(
        store.append(OWNER, first.metadata, first.metadata.tarSize, b4a.alloc(1)),
        'session A append rejection'
      ),
      { code: ERRORS.FILE_BUSY }
    )
    await t.exception(
      promptly(
        store.delete(b4a.from(first.metadata.transferId, 'hex')),
        'session A delete rejection'
      ),
      { code: ERRORS.FILE_BUSY }
    )
    t.is(
      await promptly(
        store.expire(0, (session) => session.id === first.metadata.transferId),
        'verification-safe expiry'
      ),
      0
    )

    let closed = false
    const closing = store.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    t.is(closed, false, 'close waits for in-flight verification')
    releaseVerification()
    t.is((await verification).state, 'verified')
    await promptly(closing, 'session store close')
  } finally {
    releaseVerification()
    await Promise.allSettled([verification])
    await store.close()
  }
})

test('failed verification clears extracted staging and permits a clean retry', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const store = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await store.init()
  t.teardown(() => store.close())
  const corrupt = b4a.from(archive)
  corrupt[512] ^= 0xff
  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, corrupt)

  await t.exception(store.verify(OWNER, metadata), { code: ERRORS.CHECKSUM_MISMATCH })
  await t.exception(
    () => fs.promises.lstat(path.join(layout.staging, `${metadata.transferId}.part`)),
    { code: 'ENOENT' }
  )
  const reset = await store.admit(OWNER, { ...metadata, reset: true })
  t.alike(reset, { status: 'ACCEPT', offset: 0 })
  await store.append(OWNER, metadata, 0, archive)
  t.is((await store.verify(OWNER, metadata)).state, 'verified')
})

test('verification cleanup failure durably quarantines residue until restart', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  const extractedPath = path.join(layout.staging, `${metadata.transferId}.part`)
  const cleanupFailure = new Error('injected extracted staging cleanup failure')
  let failCleanup = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (failCleanup && name === 'unlink' && target === extractedPath) throw cleanupFailure
    }
  })
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await store.init()
  const corrupt = b4a.from(archive)
  corrupt[512] ^= 0xff
  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, corrupt)

  failCleanup = true
  let failure: unknown = null
  try {
    await store.verify(OWNER, metadata)
  } catch (error) {
    failure = error
  }
  t.is((failure as { cause?: { code?: string } }).cause?.code, ERRORS.CHECKSUM_MISMATCH)
  t.is((failure as { cleanupCause?: unknown }).cleanupCause, cleanupFailure)
  await t.exception(store.admit(OWNER, metadata), { code: ERRORS.FILE_BUSY })
  await t.exception(store.admit(OWNER, { ...metadata, reset: true }), { code: ERRORS.FILE_BUSY })
  await t.exception(store.append(OWNER, metadata, metadata.tarSize, b4a.alloc(1)), {
    code: ERRORS.FILE_BUSY
  })
  await t.exception(store.delete(b4a.from(metadata.transferId, 'hex')), {
    code: ERRORS.FILE_BUSY
  })
  await store.close()

  failCleanup = false
  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.is(restarted.reservedBytes, 0)
  for (const residue of [
    extractedPath,
    path.join(layout.staging, `${metadata.transferId}.tar.part`),
    path.join(layout.sessions, `${metadata.transferId}.json`)
  ]) {
    await t.exception(() => fs.promises.lstat(residue), { code: 'ENOENT' })
  }
  t.alike(await restarted.admit(OWNER, metadata), { status: 'ACCEPT', offset: 0 })
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

test('post-commit cleanup warning identifies the uploader fingerprint', async (t) => {
  const { layout, metadata, archive } = await fixture(t)
  let failCleanup = true
  const warnings: Array<{ message: string; details: Record<string, unknown> }> = []
  const storage = createStorage({
    beforeOperation(name, target) {
      if (failCleanup && name === 'unlink' && target.endsWith('.part')) {
        failCleanup = false
        throw new Error('interrupted staging cleanup')
      }
    }
  })
  const sessions = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize,
    storage
  })
  await sessions.init()
  t.teardown(() => sessions.close())
  await sessions.admit(OWNER, metadata)
  await sessions.append(OWNER, metadata, 0, archive)
  const record = await new CommitStore({
    layout,
    storage,
    logger: { warn: (message, details) => warnings.push({ message, details }) }
  }).commit(await sessions.verify(OWNER, metadata))

  t.alike(warnings, [
    {
      message: 'Committed artifact cleanup remains pending',
      details: {
        fingerprint: record.uploaderFingerprint,
        name: record.name,
        code: null,
        reason: 'interrupted staging cleanup'
      }
    }
  ])
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
    statfs: () => Promise.resolve({ bavail: peak * 2 + 99, bsize: 1 })
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

test('empty TAR appends and closed session reads are rejected without TTL progress', async (t) => {
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
})

test('restart purges legacy sessions and retires associated journals', async (t) => {
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
  const restarted = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await restarted.init()
  t.teardown(() => restarted.close())
  t.is(restarted.purgedSessions, 1)
  await t.exception(() => fs.promises.lstat(legacyStaging), { code: 'ENOENT' })
  await t.exception(
    () => fs.promises.lstat(path.join(layout.journals, `${metadata.transferId}.json`)),
    { code: 'ENOENT' }
  )
})

test('corrupt journal retirement removes its file staging but preserves TAR evidence', async (t) => {
  const { layout, metadata } = await fixture(t)
  const store = new SessionStore({ layout, maxStagingBytes: metadata.tarSize + metadata.fileSize })
  await store.init()
  t.teardown(() => store.close())
  await fs.promises.writeFile(path.join(layout.journals, `${metadata.transferId}.json`), '{corrupt')
  await fs.promises.writeFile(path.join(layout.staging, `${metadata.transferId}.part`), 'file')
  const tarPath = path.join(layout.staging, `${metadata.transferId}.tar.part`)
  await fs.promises.writeFile(tarPath, 'tar')

  t.is(await prepareStorageRecovery({ layout, commitStore: new CommitStore({ layout }) }), 1)
  await t.exception(
    () => fs.promises.lstat(path.join(layout.staging, `${metadata.transferId}.part`)),
    {
      code: 'ENOENT'
    }
  )
  t.alike(await fs.promises.readFile(tarPath), b4a.from('tar'))
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

test('a session whose staging cannot be unlinked never strands its reservation', async (t) => {
  // Reservation accounting must stay equal to the sum over live sessions. A
  // failed unlink previously skipped the decrement, so the capacity stayed
  // spent and the name stayed permanently busy.
  const { layout, metadata, archive } = await fixture(t)
  const reservation = metadata.tarSize + metadata.fileSize
  let blockUnlink = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (blockUnlink && name === 'unlink' && target.endsWith('.tar.part')) {
        throw Object.assign(new Error('EIO: simulated unlink failure'), { code: 'EIO' })
      }
    }
  })
  const store = new SessionStore({ layout, maxStagingBytes: reservation * 4, storage })
  await store.init()
  t.teardown(() => store.close())

  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, archive.subarray(0, 600))
  t.is(store.reservedBytes, reservation, 'reservation is held while the session lives')

  blockUnlink = true
  await t.exception(store.delete(b4a.from(metadata.transferId, 'hex')))
  blockUnlink = false

  t.is(store.reservedBytes, 0, 'reservation is released even though the unlink failed')
  t.is(store.sessions.size, 0, 'session is dropped from the in-memory authority')
})

test('an unremovable expired session does not deny later admissions', async (t) => {
  // admit() sweeps expired sessions on every offer, so one session that cannot
  // be cleaned up must not take the whole upload path down with it.
  const clock = createClock()
  const { layout, metadata, archive } = await fixture(t)
  const reservation = metadata.tarSize + metadata.fileSize
  let blockUnlink = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (blockUnlink && name === 'unlink' && target.endsWith('.tar.part')) {
        throw Object.assign(new Error('EIO: simulated unlink failure'), { code: 'EIO' })
      }
    }
  })
  const store = new SessionStore({
    layout,
    maxStagingBytes: reservation * 4,
    resumeTtl: 1000,
    clock,
    storage
  })
  await store.init()
  t.teardown(() => store.close())

  await store.admit(OWNER, metadata)
  await store.append(OWNER, metadata, 0, archive.subarray(0, 600))

  blockUnlink = true
  clock.advance(5000)

  // The expired session is swept during this admission; its failure is counted
  // rather than propagated, so the offer itself still succeeds.
  const second = await fixture(t, 'a different payload entirely')
  const admission = await store.admit(OWNER, second.metadata)
  t.is(admission.status, 'ACCEPT', 'a later offer is still admitted')
  t.is(store.strandedSessions, 1, 'the failure is observable')
  t.absent(store.sessions.has(metadata.transferId), 'the stranded session is not retained')
  t.is(
    store.reservedBytes,
    second.metadata.tarSize + second.metadata.fileSize,
    'only the live session holds a reservation'
  )
})

test('a non-regular staging path fails with a typed error, not a null dereference', async (t) => {
  // assertSafeFile reports an unsafe path with a null cause. The ENOENT
  // tolerance check used to read `.code` straight off that cause, turning a
  // recoverable protocol error into an unhandled TypeError.
  const { layout, metadata } = await fixture(t)
  const store = new SessionStore({
    layout,
    maxStagingBytes: metadata.tarSize + metadata.fileSize
  })
  await store.init()
  t.teardown(() => store.close())
  await store.admit(OWNER, metadata)

  const tarPath = path.join(layout.staging, `${metadata.transferId}.tar.part`)
  await fs.promises.unlink(tarPath)
  await fs.promises.mkdir(tarPath)

  let failure: unknown = null
  try {
    await store.delete(b4a.from(metadata.transferId, 'hex'))
  } catch (error: unknown) {
    failure = error
  }
  t.ok(failure, 'the unsafe path is rejected')
  t.absent(failure instanceof TypeError, 'the guard does not dereference a null cause')
  t.is((failure as { code?: string }).code, ERRORS.PROTOCOL_INVALID, 'the error stays typed')
})
