/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { selectUploadPaths, validateBasename, validateReplaceNames } from '../../dist/files.js'
import { createTempDir } from '../helpers/files.js'

test('file selection rejects a root symlink and skips child symlinks', async (t) => {
  const root = await createTempDir(t)
  const target = path.join(root, 'target.txt')
  const rootLink = path.join(root, 'root-link.txt')
  await fs.promises.writeFile(target, 'target')
  await fs.promises.symlink(target, rootLink)

  await t.exception(() => selectUploadPaths(rootLink), { code: ERRORS.INVALID_FILENAME })

  const directory = path.join(root, 'tree')
  await fs.promises.mkdir(directory)
  await fs.promises.writeFile(path.join(directory, 'regular.txt'), 'regular')
  await fs.promises.symlink(target, path.join(directory, 'child-link.txt'))
  const selected = await selectUploadPaths(directory)
  t.alike(selected.paths, [path.join(directory, 'regular.txt')])
  t.alike(selected.skipped, [
    {
      name: 'child-link.txt',
      path: path.join(directory, 'child-link.txt'),
      reason: 'symlink'
    }
  ])
})

test('file selection skips directories and invalid or reserved child names', async (t) => {
  const root = await createTempDir(t)
  await fs.promises.mkdir(path.join(root, 'nested'))
  await fs.promises.writeFile(path.join(root, '-invalid'), 'invalid')
  await fs.promises.writeFile(path.join(root, '.swarm-deploy'), 'reserved')
  await fs.promises.writeFile(path.join(root, 'history-deadbeef'), 'reserved')
  await fs.promises.writeFile(path.join(root, 'valid.bin'), 'valid')

  const selected = await selectUploadPaths(root)
  t.alike(selected.paths, [path.join(root, 'valid.bin')])
  t.alike(
    selected.skipped.map(({ name, reason }) => ({ name, reason })),
    [
      { name: '-invalid', reason: 'invalid-filename' },
      { name: '.swarm-deploy', reason: 'invalid-filename' },
      { name: 'history-deadbeef', reason: 'reserved-history' },
      { name: 'nested', reason: 'directory' }
    ]
  )
})

test('file selection classifies a real non-regular child', async (t) => {
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

  const selected = await selectUploadPaths(root)
  t.alike(
    selected.skipped.map(({ name, reason }) => ({ name, reason })),
    [{ name: 'pipe', reason: 'not-regular-file' }]
  )
})

test('directory selection is deterministic lexical order', async (t) => {
  const root = await createTempDir(t)
  for (const name of ['z.bin', 'B.bin', 'a.bin', '10.bin', '2.bin']) {
    await fs.promises.writeFile(path.join(root, name), name)
  }
  const selected = await selectUploadPaths(root)
  t.alike(
    selected.paths.map((entry) => path.basename(entry)),
    ['10.bin', '2.bin', 'B.bin', 'a.bin', 'z.bin']
  )
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
