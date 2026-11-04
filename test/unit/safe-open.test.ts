/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { openSafeRegularFile, safeFileOpenFlags } from '../../dist/storage/layout.js'
import { createTempDir } from '../helpers/files.js'

// These run against the real filesystem with whatever flags this runtime and platform end up with
// (Node's own constants, or Bare's fallbacks), so a wrong flag fails here and not only in a table.

test('the private-state open never follows a symlink and creates only a new file', async (t) => {
  const dir = await createTempDir(t)
  const target = path.join(dir, 'target')
  const link = path.join(dir, 'link')
  const dangling = path.join(dir, 'dangling')
  const missing = path.join(dir, 'missing')
  await fs.promises.writeFile(target, 'protected state')
  await fs.promises.symlink(target, link)
  await fs.promises.symlink(missing, dangling)

  for (const access of ['read', 'write'] as const) {
    await t.exception(
      () => openSafeRegularFile(link, access),
      { code: ERRORS.PROTOCOL_INVALID },
      `${access} through a symlink is refused`
    )
  }
  await t.exception(
    () => openSafeRegularFile(link, 'create'),
    { code: ERRORS.PROTOCOL_INVALID },
    'create over a symlink to an existing file is refused'
  )
  await t.exception(
    () => openSafeRegularFile(dangling, 'create'),
    { code: ERRORS.PROTOCOL_INVALID },
    'create through a dangling symlink is refused'
  )
  await t.exception(
    () => openSafeRegularFile(target, 'create'),
    { code: ERRORS.PROTOCOL_INVALID },
    'create over an existing file is refused'
  )
  t.is(await fs.promises.readFile(target, 'utf8'), 'protected state', 'nothing was opened')
  t.is(await fs.promises.readlink(link), target, 'the links are as they were')
  await t.exception(
    () => fs.promises.lstat(missing),
    { code: 'ENOENT' },
    'nothing was created through the dangling link'
  )

  const created = path.join(dir, 'created')
  const handle = await openSafeRegularFile(created, 'create')
  await handle.close()
  t.ok((await fs.promises.lstat(created)).isFile(), 'a new file is created')
  await t.exception(
    () => openSafeRegularFile(created, 'create'),
    { code: ERRORS.PROTOCOL_INVALID },
    'and a second create of it is refused'
  )
  const reread = await openSafeRegularFile(created, 'read')
  await reread.close()
})

test('the open flags refuse an unknown access and keep the error type', async (t) => {
  await t.exception(
    () => safeFileOpenFlags('delete' as never),
    { code: ERRORS.PROTOCOL_INVALID },
    'an access that is not read, write or create'
  )
  for (const access of ['read', 'write', 'create'] as const) {
    t.is(typeof safeFileOpenFlags(access), 'number', access)
  }
})
