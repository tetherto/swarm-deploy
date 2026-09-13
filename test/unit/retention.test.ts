/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { initLayout } from '../../dist/storage/layout.js'
import { SessionStore } from '../../dist/storage/session-store.js'
import { CommitStore } from '../../dist/storage/commit-store.js'
import { RetentionManager } from '../../dist/storage/retention.js'
import {
  buildTarManifest,
  metadataFromManifest,
  regenerateTarSuffix
} from '../../dist/tar-protocol/manifest.js'
import { createClock } from '../helpers/clock.js'
import { createTempDir } from '../helpers/files.js'

const OWNER = b4a.alloc(32, 101)

async function verifiedSession(t: Assert, name: string, content: string) {
  const root = await createTempDir(t)
  const source = path.join(await createTempDir(t), name)
  await fs.promises.writeFile(source, content)
  const manifest = await buildTarManifest(source, OWNER)
  const archiveChunks: Buffer[] = []
  await regenerateTarSuffix(manifest, 0, (chunk) => {
    archiveChunks.push(b4a.from(chunk))
  })
  const layout = initLayout(root)
  const sessions = new SessionStore({
    layout,
    maxStagingBytes: manifest.tarSize + manifest.fileSize
  })
  await sessions.init()
  t.teardown(() => sessions.close())
  const metadata = metadataFromManifest(manifest)
  await sessions.admit(OWNER, metadata)
  await sessions.append(OWNER, metadata, 0, b4a.concat(archiveChunks))
  return { layout, sessions, session: await sessions.verify(OWNER, metadata) }
}

test('retention expires a committed direct-TAR artifact', async (t) => {
  const { layout, sessions, session } = await verifiedSession(t, 'aged.txt', 'age me')
  const clock = createClock()
  const commits = new CommitStore({ layout, clock })
  await commits.commit(session)
  const retention = new RetentionManager({
    layout,
    sessionStore: sessions,
    commitStore: commits,
    maxAge: 1,
    clock,
    isSessionActive: () => false
  })
  clock.advance(2)
  const result = await retention.run()
  t.is(result.ageDeleted, 1)
  await t.exception(fs.promises.stat(path.join(layout.root, 'aged.txt')), { code: 'ENOENT' })
})

test('scrub removes tampered direct-TAR artifacts but preserves unknown paths', async (t) => {
  const { layout, sessions, session } = await verifiedSession(t, 'scrub.txt', 'valid before tamper')
  const commits = new CommitStore({ layout })
  await commits.commit(session)
  await fs.promises.writeFile(path.join(layout.root, 'scrub.txt'), 'tampered')
  await fs.promises.writeFile(path.join(layout.root, 'operator-note.txt'), 'preserve')
  const retention = new RetentionManager({
    layout,
    sessionStore: sessions,
    commitStore: commits,
    isSessionActive: () => false
  })
  const result = await retention.scrubCommitted()
  t.is(result.deleted, 1)
  t.alike(result.unknown, ['operator-note.txt'])
  t.is(await fs.promises.readFile(path.join(layout.root, 'operator-note.txt'), 'utf8'), 'preserve')
})
