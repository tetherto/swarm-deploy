/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { selectUploadTarget, validateBasename, validateReplaceNames } from '../../dist/files.js'
import { createTempDir } from '../helpers/files.js'

test('upload selection rejects a symlink root and accepts a regular file', async (t) => {
  const root = await createTempDir(t)
  const target = path.join(root, 'target.txt')
  const rootLink = path.join(root, 'root-link.txt')
  await fs.promises.writeFile(target, 'target')
  await fs.promises.symlink(target, rootLink)

  await t.exception(() => selectUploadTarget(rootLink), { code: ERRORS.INVALID_FILENAME })
  t.alike(await selectUploadTarget(target), { kind: 'file', name: 'target.txt', path: target })
})

test('a directory input becomes one recursive directory artifact', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await fs.promises.mkdir(source)
  await fs.promises.writeFile(path.join(source, 'b.txt'), 'b')
  await fs.promises.mkdir(path.join(source, 'nested'))
  await fs.promises.writeFile(path.join(source, 'nested', 'a.txt'), 'a')

  t.alike(await selectUploadTarget(source), {
    kind: 'directory',
    name: '0.18.1',
    path: source
  })
})

test('upload selection rejects an unsafe or reserved artifact name', async (t) => {
  const root = await createTempDir(t)
  for (const name of ['-invalid', 'history-deadbeef']) {
    const file = path.join(root, name)
    await fs.promises.writeFile(file, 'x')
    await t.exception(() => selectUploadTarget(file), { code: ERRORS.INVALID_FILENAME })
  }
  const directory = path.join(root, 'history-tree')
  await fs.promises.mkdir(directory)
  await t.exception(() => selectUploadTarget(directory), { code: ERRORS.INVALID_FILENAME })
})

test('upload selection rejects a non-regular, non-directory input', async (t) => {
  if (typeof Bare !== 'undefined') {
    t.pass('named FIFO creation is Node-only')
    return
  }
  const root = await createTempDir(t)
  const fifo = path.join(root, 'pipe')
  const { execFileSync } = require('node:child_process') as {
    execFileSync(command: string, args: string[]): void
  }
  execFileSync('mkfifo', [fifo])
  await t.exception(() => selectUploadTarget(fifo), { code: ERRORS.INVALID_FILENAME })
})

test('basename and replacement policy enforce reserved, duplicate, and USTAR limits', (t) => {
  t.is(validateBasename('a'.repeat(100)), 'a'.repeat(100))
  for (const name of ['a'.repeat(101), '.swarm-deploy']) {
    t.exception(() => validateBasename(name), { code: ERRORS.INVALID_FILENAME })
    t.exception(() => validateReplaceNames([name]), { code: ERRORS.INVALID_FILENAME })
  }
  t.exception(() => validateReplaceNames(['history-old']), { code: ERRORS.INVALID_FILENAME })
  t.exception(() => validateReplaceNames(['same.bin', 'same.bin']), {
    code: ERRORS.PROTOCOL_INVALID
  })
})
