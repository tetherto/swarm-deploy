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

function desired(
  name: string,
  target: string,
  transferId: string,
  targetKind: DesiredLink['targetKind'] = 'directory'
): DesiredLink {
  return { name, target, transferId, targetKind }
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
    version: 2,
    mode: 'automatic',
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

test('a dormant rule removes its link and ownership record', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.0', '0.18.1'])
  const names = new Set(['latest'])
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], names)
  const removed = await links.reconcile([], names)
  t.alike(removed.removed, ['latest'])
  t.is(await links.read('latest'), null)
  await t.exception(() => fs.promises.lstat(path.join(layout.root, 'latest')))
})

test('a crash before the record rewrite is removed with the rule', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.0', '0.18.1'])
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], new Set(['latest']))
  await fs.promises.unlink(path.join(layout.root, 'latest'))
  await fs.promises.symlink('0.18.1', path.join(layout.root, 'latest'))
  const removed = await links.reconcile([], new Set(), {
    managedArtifactNames: new Set(['0.18.0', '0.18.1'])
  })
  t.alike(removed.removed, ['latest'])
  t.is(await links.read('latest'), null)
  await t.exception(() => fs.promises.lstat(path.join(layout.root, 'latest')))
})

test('stale temporary links are swept at the start of reconciliation', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.18.1'])
  await fs.promises.symlink('0.18.1', path.join(layout.publications, '.link-' + 'a'.repeat(32)))
  await links.reconcile([desired('latest', '0.18.1', '1'.repeat(64))], new Set(['latest']))
  t.alike(await fs.promises.readdir(layout.publications), [])
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

test('manual linking creates, keeps, and repoints a durable manual link', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1', 'release-2'])
  const options = {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set(['latest'])
  }

  t.alike(await links.linkManual(desired('current', 'release-1', '1'.repeat(64)), options), {
    status: 'LINKED'
  })
  t.alike(await links.read('current'), {
    version: 2,
    mode: 'manual',
    name: 'current',
    target: 'release-1',
    transferId: '1'.repeat(64),
    targetKind: 'directory'
  } satisfies ManagedSymlinkRecord)
  t.is(await fs.promises.readlink(path.join(layout.root, 'current')), 'release-1')

  t.alike(await links.linkManual(desired('current', 'release-1', '2'.repeat(64)), options), {
    status: 'UNCHANGED'
  })
  t.is((await links.read('current'))?.transferId, '1'.repeat(64))

  t.alike(await links.linkManual(desired('current', 'release-2', '2'.repeat(64)), options), {
    status: 'LINKED'
  })
  t.is(await fs.promises.readlink(path.join(layout.root, 'current')), 'release-2')
  t.alike(await links.read('current'), {
    version: 2,
    mode: 'manual',
    name: 'current',
    target: 'release-2',
    transferId: '2'.repeat(64),
    targetKind: 'directory'
  } satisfies ManagedSymlinkRecord)
  t.alike(await fs.promises.readdir(layout.publications), [])
})

test('v1 records normalize to automatic ownership and strict v2 records reject malformed input', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1'])
  await fs.promises.writeFile(
    recordFile(layout, 'latest'),
    JSON.stringify({
      version: 1,
      name: 'latest',
      target: 'release-1',
      transferId: '1'.repeat(64),
      targetKind: 'directory'
    })
  )
  await fs.promises.symlink('release-1', path.join(layout.root, 'latest'))
  t.alike(await links.read('latest'), {
    version: 1,
    mode: 'automatic',
    name: 'latest',
    target: 'release-1',
    transferId: '1'.repeat(64),
    targetKind: 'directory'
  } satisfies ManagedSymlinkRecord)
  t.alike(await links.reconcile([], new Set()), {
    created: [],
    updated: [],
    removed: ['latest'],
    unchanged: []
  })

  for (const value of [
    {
      version: 2,
      mode: 'manual',
      name: 'current',
      target: 'release-1',
      transferId: '1'.repeat(64),
      targetKind: 'directory',
      extra: true
    },
    {
      version: 3,
      mode: 'manual',
      name: 'current',
      target: 'release-1',
      transferId: '1'.repeat(64),
      targetKind: 'directory'
    },
    {
      version: 1,
      mode: 'automatic',
      name: 'current',
      target: 'release-1',
      transferId: '1'.repeat(64),
      targetKind: 'directory'
    }
  ]) {
    await fs.promises.writeFile(recordFile(layout, 'current'), JSON.stringify(value))
    await t.exception(() => links.read('current'), { code: ERRORS.LINK_FAILED })
    await fs.promises.unlink(recordFile(layout, 'current'))
  }
})

test('automatic reconciliation preserves manual ownership and rejects manual collisions', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1', 'release-2'])
  await links.linkManual(desired('current', 'release-1', '1'.repeat(64)), {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set()
  })

  t.alike(await links.reconcile([], new Set()), {
    created: [],
    updated: [],
    removed: [],
    unchanged: []
  })
  t.is((await links.read('current'))?.mode, 'manual')
  t.is(await fs.promises.readlink(path.join(layout.root, 'current')), 'release-1')

  await t.exception(
    () => links.reconcile([desired('current', 'release-2', '2'.repeat(64))], new Set(['current'])),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is((await links.read('current'))?.mode, 'manual')
  t.is(await fs.promises.readlink(path.join(layout.root, 'current')), 'release-1')
})

test('manual linking fails closed for automatic, v1, unmanaged, and reserved destinations', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1', 'release-2'])
  const options = {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set(['latest'])
  }
  await links.reconcile([desired('latest', 'release-1', '1'.repeat(64))], new Set(['latest']))
  await t.exception(
    () => links.linkManual(desired('latest', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), 'release-1')

  await fs.promises.symlink('release-1', path.join(layout.root, 'unrecorded'))
  await t.exception(
    () => links.linkManual(desired('unrecorded', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readlink(path.join(layout.root, 'unrecorded')), 'release-1')

  await fs.promises.writeFile(path.join(layout.root, 'operator'), 'operator file')
  await t.exception(
    () => links.linkManual(desired('operator', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readFile(path.join(layout.root, 'operator'), 'utf8'), 'operator file')

  await t.exception(
    () => links.linkManual(desired('release-1', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  await t.exception(
    () => links.linkManual(desired('current', 'missing', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
})

test('manual linking does not adopt legacy ownership or externally changed manual links', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1', 'release-2', 'rogue'])
  const options = {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set<string>()
  }
  await fs.promises.writeFile(
    recordFile(layout, 'legacy'),
    JSON.stringify({
      version: 1,
      name: 'legacy',
      target: 'release-1',
      transferId: '1'.repeat(64),
      targetKind: 'directory'
    })
  )
  await fs.promises.symlink('release-1', path.join(layout.root, 'legacy'))
  await t.exception(
    () => links.linkManual(desired('legacy', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readlink(path.join(layout.root, 'legacy')), 'release-1')
  t.is((await links.read('legacy'))?.version, 1)

  await links.linkManual(desired('current', 'release-1', '1'.repeat(64)), options)
  await fs.promises.unlink(path.join(layout.root, 'current'))
  await fs.promises.symlink('rogue', path.join(layout.root, 'current'))
  await t.exception(
    () => links.linkManual(desired('current', 'release-2', '2'.repeat(64)), options),
    { code: ERRORS.LINK_CONFLICT }
  )
  t.is(await fs.promises.readlink(path.join(layout.root, 'current')), 'rogue')
  t.is((await links.read('current'))?.target, 'release-1')
})

test('manual links preserve file and directory target kinds across crash convergence', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['directory-1', 'directory-2'])
  await fs.promises.writeFile(path.join(layout.root, 'file-1'), 'one')
  const options = {
    managedArtifactNames: new Set(['directory-1', 'directory-2', 'file-1']),
    automaticLinkNames: new Set<string>()
  }
  await links.linkManual(desired('file-current', 'file-1', '1'.repeat(64), 'file'), options)
  await links.linkManual(desired('directory-current', 'directory-1', '2'.repeat(64)), options)
  t.is((await links.read('file-current'))?.targetKind, 'file')
  t.is((await links.read('directory-current'))?.targetKind, 'directory')

  // Simulate a crash after the visible swap but before the manual record rewrite.
  await fs.promises.unlink(path.join(layout.root, 'directory-current'))
  await fs.promises.symlink('directory-2', path.join(layout.root, 'directory-current'))
  t.alike(
    await links.linkManual(desired('directory-current', 'directory-2', '3'.repeat(64)), options),
    { status: 'LINKED' }
  )
  t.is((await links.read('directory-current'))?.target, 'directory-2')

  // Simulate a crash after the durable manual record but before the first link.
  await fs.promises.unlink(path.join(layout.root, 'file-current'))
  t.alike(
    await links.linkManual(desired('file-current', 'file-1', '1'.repeat(64), 'file'), options),
    { status: 'LINKED' }
  )
  t.is(await fs.promises.readlink(path.join(layout.root, 'file-current')), 'file-1')
})
