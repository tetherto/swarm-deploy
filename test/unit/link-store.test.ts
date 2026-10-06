/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { initLayout } from '../../dist/storage/layout.js'
import { LinkStore, type ManagedSymlinkRecord } from '../../dist/storage/link-store.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import type { DesiredLink } from '../../dist/symlinks.js'
import type { StorageAdapter, StorageLayout } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type CreateStorageOptions } from '../helpers/storage.js'

async function createStore(
  t: Parameters<Parameters<typeof test>[1]>[0],
  options: CreateStorageOptions = {}
): Promise<{ links: LinkStore; layout: StorageLayout }> {
  const layout = initLayout(await createTempDir(t))
  return { links: new LinkStore({ layout, storage: createStorage(options) }), layout }
}

function desired(name: string, target: string, transferId: string): DesiredLink {
  return { name, target, transferId, targetKind: 'directory' }
}

async function mkdirs(layout: StorageLayout, names: string[]): Promise<void> {
  for (const name of names) await fs.promises.mkdir(path.join(layout.root, name))
}

function recordFile(layout: StorageLayout, name: string): string {
  return path.join(layout.links, `${b4a.toString(sodiumSha256(b4a.from(name)), 'hex')}.json`)
}

test('reconciliation creates, keeps, and repoints an owned link', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.0', '0.18.1'])
  const names = new Set(['latest'])

  const created = await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], names)
  t.alike(created.created, ['latest'])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.0')
  const record = await links.read('latest')
  t.alike(record, {
    version: 1,
    name: 'latest',
    target: '0.18.0',
    transferId: '1'.repeat(64),
    targetKind: 'directory'
  } satisfies ManagedSymlinkRecord)
  t.is(links.recordPath('latest'), recordFile(layout, 'latest'))

  const unchanged = await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], names)
  t.alike(unchanged.unchanged, ['latest'])

  const updated = await links.reconcile([desired('latest', '0.18.1', '2'.repeat(64))], names)
  t.alike(updated.updated, ['latest'])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.1')
  t.is((await links.read('latest'))?.transferId, '2'.repeat(64))
  t.alike(await fs.promises.readdir(layout.publications), [])
})

test('reconciliation refuses every unmanaged destination without touching it', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1'])
  const names = new Set(['latest'])

  await fs.promises.writeFile(path.join(layout.root, 'latest'), 'operator file')
  await t.exception(() => links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names), {
    code: ERRORS.LINK_CONFLICT
  })
  t.is(await fs.promises.readFile(path.join(layout.root, 'latest'), 'utf8'), 'operator file')
  await fs.promises.unlink(path.join(layout.root, 'latest'))

  await fs.promises.mkdir(path.join(layout.root, 'latest'))
  await t.exception(() => links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names), {
    code: ERRORS.LINK_CONFLICT
  })
  t.ok((await fs.promises.lstat(path.join(layout.root, 'latest'))).isDirectory())
  await fs.promises.rmdir(path.join(layout.root, 'latest'))

  await fs.promises.symlink('0.18.1', path.join(layout.root, 'latest'))
  await t.exception(() => links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names), {
    code: ERRORS.LINK_CONFLICT
  })
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.1')
  t.is(await links.read('latest'), null)
})

test('a swapped owned link is not adopted and fails closed', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.0', '0.18.1', 'rogue'])
  const names = new Set(['latest'])
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], names)

  await fs.promises.unlink(path.join(layout.root, 'latest'))
  await fs.promises.symlink('rogue', path.join(layout.root, 'latest'))
  await t.exception(() => links.reconcile([desired('latest', '0.18.1', '2'.repeat(64))], names), {
    code: ERRORS.LINK_CONFLICT
  })
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), 'rogue')
})

test('a crash between visible replacement and the record converges on the desired link', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.0', '0.18.1'])
  const names = new Set(['latest'])
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], names)

  // Simulate the crash: the visible link already points at the new target while
  // the ownership record still names the old one.
  await fs.promises.unlink(path.join(layout.root, 'latest'))
  await fs.promises.symlink('0.18.1', path.join(layout.root, 'latest'))

  const result = await links.reconcile([desired('latest', '0.18.1', '2'.repeat(64))], names)
  t.alike(result.updated, ['latest'])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.1')
  t.is((await links.read('latest'))?.transferId, '2'.repeat(64))
})

test('a crash after the record but before the first link converges', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1'])
  const names = new Set(['latest'])
  await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names)

  // Simulate the crash: the ownership record is durable but no link exists yet.
  await fs.promises.unlink(path.join(layout.root, 'latest'))
  const result = await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names)
  t.alike(result.created, ['latest'])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.1')
})

test('an unmanaged file that wins the creation race is left untouched and not recorded', async (t) => {
  let raced = false
  const layout = initLayout(await createTempDir(t))
  await fs.promises.mkdir(path.join(layout.root, '0.18.1'))
  const links = new LinkStore({
    layout,
    storage: createStorage({
      beforeOperation: async (name, target) => {
        if (name !== 'symlink' || raced) return
        raced = true
        await fs.promises.writeFile(target, 'operator file')
      }
    })
  })
  await t.exception(
    () => links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], new Set(['latest'])),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readFile(path.join(layout.root, 'latest'), 'utf8'), 'operator file')
  t.is(await links.read('latest'), null)
})

test('an externally removed owned link is recreated level-triggered', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1'])
  const names = new Set(['latest'])
  await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names)
  await fs.promises.unlink(path.join(layout.root, 'latest'))
  const result = await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], names)
  t.alike(result.created, ['latest'])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.1')
})

test('removing a rule removes a proven link and preserves an unprovable one', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1', 'rogue'])
  await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], new Set(['latest']))

  const removed = await links.reconcile([], new Set())
  t.alike(removed.removed, ['latest'])
  t.is(await links.read('latest'), null)
  await t.exception(() => fs.promises.lstat(path.join(layout.root, 'latest')))

  await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], new Set(['latest']))
  await fs.promises.unlink(path.join(layout.root, 'latest'))
  await fs.promises.symlink('rogue', path.join(layout.root, 'latest'))
  await t.exception(() => links.reconcile([], new Set()), { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), 'rogue')
})

test('a foreign ownership record and a missing capability fail closed', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1'])
  await fs.promises.writeFile(
    path.join(layout.links, `${'f'.repeat(64)}.json`),
    JSON.stringify({
      version: 1,
      name: 'latest',
      target: '0.18.1',
      transferId: '1'.repeat(64),
      targetKind: 'directory'
    })
  )
  await t.exception(() => links.reconcile([], new Set()), { code: ERRORS.LINK_FAILED })

  const incapable: StorageAdapter = { ...createStorage(), symlink: undefined, readlink: undefined }
  t.exception(() => new LinkStore({ layout, storage: incapable }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })
})

test('an ownership record with an unsafe name or target is rejected before any path is used', async (t) => {
  const { links, layout } = await createStore(t)
  const cases: Array<[string, Record<string, unknown>]> = [
    ['traversing name', { name: '../escape', target: '0.18.1' }],
    ['reserved name', { name: `history-${'1'.repeat(64)}`, target: '0.18.1' }],
    ['traversing target', { name: 'latest', target: '../outside' }],
    ['absolute target', { name: 'latest', target: '/etc' }],
    ['nested target', { name: 'latest', target: 'a/b' }],
    ['internal target', { name: 'latest', target: '.swarm-deploy' }]
  ]
  for (const [label, fields] of cases) {
    const name = fields.name as string
    await fs.promises.writeFile(
      recordFile(layout, name),
      JSON.stringify({ version: 1, transferId: '1'.repeat(64), targetKind: 'directory', ...fields })
    )
    await t.exception(() => links.reconcile([], new Set()), { code: ERRORS.LINK_FAILED }, label)
    await fs.promises.unlink(recordFile(layout, name))
  }
  t.alike(await fs.promises.readdir(layout.root), ['.swarm-deploy'])
})

test('storage failures surface as stable link errors without paths or errno text', async (t) => {
  const layout = initLayout(await createTempDir(t))
  await fs.promises.mkdir(path.join(layout.root, '0.18.1'))
  const links = new LinkStore({
    layout,
    storage: createStorage({
      beforeOperation: (name, target) => {
        if (name === 'symlink') throw Object.assign(new Error(`EIO: ${target}`), { code: 'EIO' })
      }
    })
  })
  const error = await links
    .reconcile([desired('latest', '0.18.1', '1'.repeat(64))], new Set(['latest']))
    .then(
      () => null,
      (caught: unknown) => caught as { code: string; message: string }
    )
  t.is(error?.code, ERRORS.LINK_FAILED)
  t.absent(error?.message.includes(layout.root))
  t.absent(error?.message.includes('EIO'))
  t.is(await links.read('latest'), null)
})

test('a temporary link is cleaned up when the rename fails', async (t) => {
  const layout = initLayout(await createTempDir(t))
  await fs.promises.mkdir(path.join(layout.root, '0.18.0'))
  await fs.promises.mkdir(path.join(layout.root, '0.18.1'))
  let failRename = false
  const links = new LinkStore({
    layout,
    storage: createStorage({
      beforeOperation: (name, source) => {
        if (failRename && name === 'rename' && source.startsWith(layout.publications)) {
          throw new Error('injected rename failure')
        }
      }
    })
  })
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], new Set(['latest']))
  failRename = true
  await t.exception(() =>
    links.reconcile([desired('latest', '0.18.1', '2'.repeat(64))], new Set(['latest']))
  )
  t.alike(await fs.promises.readdir(layout.publications), [])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.0')
  t.is((await links.read('latest'))?.target, '0.18.0')
})
