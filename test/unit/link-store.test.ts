/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { initLayout } from '../../dist/storage/layout.js'
import {
  LinkStore,
  type ManagedSymlinkRecord,
  type ManualLinkOptions
} from '../../dist/storage/link-store.js'
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

  t.alike(
    await links.linkManual(desired('current', 'release-1', '2'.repeat(64), 'file'), options),
    {
      status: 'UNCHANGED'
    }
  )
  t.alike(await links.read('current'), {
    version: 2,
    mode: 'manual',
    name: 'current',
    target: 'release-1',
    transferId: '2'.repeat(64),
    targetKind: 'file'
  } satisfies ManagedSymlinkRecord)

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

const LATEST_ID = '1'.repeat(64)
const NEXT_ID = '2'.repeat(64)

/** Manual request options: `0.20.1` and `0.20.2` are managed, every other sibling is legacy. */
function manual(): ManualLinkOptions {
  return {
    managedArtifactNames: new Set(['0.20.1', '0.20.2']),
    automaticLinkNames: new Set<string>()
  }
}

function latestPath(layout: StorageLayout): string {
  return path.join(layout.root, 'latest')
}

async function clearLatest(layout: StorageLayout): Promise<void> {
  await fs.promises.rm(latestPath(layout), { force: true, recursive: true })
  await fs.promises.rm(recordFile(layout, 'latest'), { force: true })
}

function requestLatest(links: LinkStore, target = '0.20.1', id = LATEST_ID) {
  return links.linkManual(desired('latest', target, id), manual())
}

test('a manual link takes over an unrecorded symlink without ever following its old target', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.20.0', '0.20.1', '0.20.2'])
  const kept = path.join(layout.root, '0.20.0', 'keep.txt')
  await fs.promises.writeFile(kept, 'legacy payload')
  await fs.promises.symlink('0.20.0', path.join(layout.root, '0.19.5'))
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'keep.txt'), 'outside payload')

  const literals = [
    '0.20.0',
    './0.20.0/',
    path.join(layout.root, '0.20.0'),
    outside,
    '../escape',
    'no-such-target',
    '0.19.5',
    'latest',
    '0.20.1',
    './0.20.1',
    path.join(layout.root, '0.20.1')
  ]
  for (const literal of literals) {
    await fs.promises.symlink(literal, latestPath(layout))
    t.alike(await requestLatest(links), { status: 'LINKED' }, literal)
    t.is(await fs.promises.readlink(latestPath(layout)), '0.20.1', `${literal} is replaced`)
    t.alike(await links.read('latest'), {
      version: 2,
      mode: 'manual',
      name: 'latest',
      target: '0.20.1',
      transferId: LATEST_ID,
      targetKind: 'directory'
    } satisfies ManagedSymlinkRecord)
    t.alike(await requestLatest(links), { status: 'UNCHANGED' }, `${literal} is ordinary after`)
    t.alike(await fs.promises.readdir(layout.publications), [])
    t.alike(
      (await links.list()).map((record) => record.name),
      ['latest'],
      'nothing is recorded for the old target'
    )
    await clearLatest(layout)
  }

  t.is(await fs.promises.readFile(kept, 'utf8'), 'legacy payload')
  t.alike(await fs.promises.readdir(outside), ['keep.txt'], 'the outside directory is untouched')
  t.is(await fs.promises.readlink(path.join(layout.root, '0.19.5')), '0.20.0')
  await t.exception(() => fs.promises.lstat(path.join(path.dirname(layout.root), 'escape')), {
    code: 'ENOENT'
  })

  await fs.promises.symlink('0.20.0', latestPath(layout))
  await requestLatest(links)
  t.alike(await requestLatest(links, '0.20.2', NEXT_ID), { status: 'LINKED' })
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.2', 'later repoints are ordinary')
})

test('takeover never replaces a file or directory and keeps every ownership check', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['0.20.0', '0.20.1', 'rogue'])
  const request = (): Promise<unknown> => requestLatest(links)

  await fs.promises.writeFile(latestPath(layout), 'operator file')
  await t.exception(request, { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readFile(latestPath(layout), 'utf8'), 'operator file')
  await clearLatest(layout)

  await fs.promises.mkdir(latestPath(layout))
  await fs.promises.writeFile(path.join(latestPath(layout), 'inside'), 'kept')
  await t.exception(request, { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readFile(path.join(latestPath(layout), 'inside'), 'utf8'), 'kept')
  await clearLatest(layout)

  const record = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      version: 2,
      mode: 'manual',
      name: 'latest',
      target: '0.20.1',
      transferId: LATEST_ID,
      targetKind: 'directory',
      ...overrides
    })
  const cases: Array<[string, string, string]> = [
    ['foreign record', record({ name: 'other' }), ERRORS.LINK_FAILED],
    ['malformed record', '{not json', ERRORS.LINK_FAILED],
    ['unknown version', record({ version: 3 }), ERRORS.LINK_FAILED],
    ['automatic record', record({ mode: 'automatic' }), ERRORS.LINK_CONFLICT]
  ]
  for (const [label, contents, code] of cases) {
    await fs.promises.symlink('0.20.0', latestPath(layout))
    await fs.promises.writeFile(recordFile(layout, 'latest'), contents)
    await t.exception(request, { code }, label)
    t.is(await fs.promises.readlink(latestPath(layout)), '0.20.0', `${label}: link untouched`)
    t.is(await fs.promises.readFile(recordFile(layout, 'latest'), 'utf8'), contents)
    await clearLatest(layout)
  }

  await fs.promises.symlink('0.20.1', latestPath(layout))
  await request()
  await fs.promises.unlink(latestPath(layout))
  await fs.promises.symlink('rogue', latestPath(layout))
  await t.exception(request, { code: ERRORS.LINK_CONFLICT }, 'an owned link changed externally')
  t.is(await fs.promises.readlink(latestPath(layout)), 'rogue')
})

test('an unrecorded symlink changed after inspection is never overwritten', async (t) => {
  let swap: (() => Promise<void>) | null = null
  const { links, layout } = await createStore(t, {
    async beforeOperation(name, target) {
      if (name === 'symlink' && target.includes('.link-') && swap !== null) {
        const run = swap
        swap = null
        await run()
      }
    }
  })
  await mkdirs(layout, ['0.20.0', '0.20.1'])
  await fs.promises.writeFile(path.join(layout.root, '0.20.0', 'keep.txt'), 'legacy payload')
  const request = (): Promise<unknown> => requestLatest(links)

  await fs.promises.symlink('0.20.0', latestPath(layout))
  swap = async () => {
    await fs.promises.unlink(latestPath(layout))
    await fs.promises.symlink('rogue', latestPath(layout))
  }
  await t.exception(request, { code: ERRORS.LINK_CONFLICT }, 'another symlink won the race')
  t.is(await fs.promises.readlink(latestPath(layout)), 'rogue')
  t.is(await links.read('latest'), null)
  t.alike(await fs.promises.readdir(layout.publications), [], 'the temporary link is removed')
  await clearLatest(layout)

  await fs.promises.symlink('0.20.0', latestPath(layout))
  swap = async () => {
    await fs.promises.unlink(latestPath(layout))
    await fs.promises.writeFile(latestPath(layout), 'operator file')
  }
  await t.exception(request, { code: ERRORS.LINK_CONFLICT }, 'a file won the race')
  t.is(await fs.promises.readFile(latestPath(layout), 'utf8'), 'operator file')
  t.is(await links.read('latest'), null)
  await clearLatest(layout)

  await fs.promises.symlink('0.20.0', latestPath(layout))
  swap = async () => {
    await fs.promises.unlink(latestPath(layout))
    await fs.promises.mkdir(latestPath(layout))
  }
  await t.exception(request, { code: ERRORS.LINK_CONFLICT }, 'a directory won the race')
  t.ok((await fs.promises.lstat(latestPath(layout))).isDirectory())
  await clearLatest(layout)

  await fs.promises.symlink('0.20.0', latestPath(layout))
  const owner = JSON.stringify({
    version: 2,
    mode: 'manual',
    name: 'latest',
    target: '0.20.0',
    transferId: NEXT_ID,
    targetKind: 'directory'
  })
  swap = () => fs.promises.writeFile(recordFile(layout, 'latest'), owner)
  await t.exception(request, { code: ERRORS.LINK_CONFLICT }, 'an ownership record appeared')
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.0', 'the new owner keeps its link')
  t.is(await fs.promises.readFile(recordFile(layout, 'latest'), 'utf8'), owner)
  t.is(
    await fs.promises.readFile(path.join(layout.root, '0.20.0', 'keep.txt'), 'utf8'),
    'legacy payload'
  )
})

test('takeover refuses a symlink whose identity changed even when its text did not', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const base = createStorage()
  let looks = 0
  const storage: StorageAdapter = {
    ...base,
    async lstat(target) {
      const stat = await base.lstat(target)
      if (target !== latestPath(layout) || ++looks < 2) return stat
      return {
        dev: stat.dev,
        ino: Number(stat.ino) + 1,
        size: stat.size,
        isSymbolicLink: () => stat.isSymbolicLink(),
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile()
      }
    }
  }
  const links = new LinkStore({ layout, storage })
  await mkdirs(layout, ['0.20.0', '0.20.1'])
  await fs.promises.symlink('0.20.0', latestPath(layout))
  await t.exception(() => requestLatest(links), { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.0')
  t.is(await links.read('latest'), null)
})

test('a crash after the swap is taken over again by the same explicit request', async (t) => {
  const retries: Array<['0.20.1' | '0.20.2', string]> = [
    ['0.20.1', LATEST_ID],
    ['0.20.2', NEXT_ID]
  ]
  for (const [retryTarget, retryId] of retries) {
    let crash = true
    let recordPath = ''
    const { links, layout } = await createStore(t, {
      beforeOperation(name, _source, ...rest) {
        if (crash && name === 'rename' && rest[0] === recordPath) {
          throw new Error('injected crash before the ownership record')
        }
      }
    })
    recordPath = recordFile(layout, 'latest')
    await mkdirs(layout, ['0.20.0', '0.20.1', '0.20.2'])
    await fs.promises.writeFile(path.join(layout.root, '0.20.0', 'keep.txt'), 'legacy payload')
    await fs.promises.symlink('0.20.0', latestPath(layout))

    await t.exception(() => requestLatest(links), { code: ERRORS.LINK_FAILED })
    t.is(await fs.promises.readlink(latestPath(layout)), '0.20.1', 'the swap is visible')
    t.is(await links.read('latest'), null, 'but nothing is recorded yet')
    t.alike(await fs.promises.readdir(layout.publications), [])

    crash = false
    t.alike(
      await requestLatest(links, retryTarget, retryId),
      { status: 'LINKED' },
      `retry for ${retryTarget}`
    )
    t.is(await fs.promises.readlink(latestPath(layout)), retryTarget)
    t.is((await links.read('latest'))?.target, retryTarget)
    t.alike(await requestLatest(links, retryTarget, retryId), { status: 'UNCHANGED' })
    t.is(
      await fs.promises.readFile(path.join(layout.root, '0.20.0', 'keep.txt'), 'utf8'),
      'legacy payload'
    )
  }
})

test('a failure before the swap leaves the legacy link and payload exactly as they were', async (t) => {
  let fail = true
  const { links, layout } = await createStore(t, {
    beforeOperation(name, target) {
      if (fail && name === 'symlink' && target.includes('.link-')) {
        throw new Error('injected temporary link failure')
      }
    }
  })
  await mkdirs(layout, ['0.20.0', '0.20.1'])
  await fs.promises.symlink('0.20.0', latestPath(layout))
  await t.exception(() => requestLatest(links), { code: ERRORS.LINK_FAILED })
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.0')
  t.is(await links.read('latest'), null)
  t.ok((await fs.promises.lstat(path.join(layout.root, '0.20.0'))).isDirectory())

  fail = false
  t.alike(await requestLatest(links), { status: 'LINKED' })
})

/** Whether this volume treats names that differ only in case as one directory entry. */
async function caseInsensitive(layout: StorageLayout): Promise<boolean> {
  const probe = path.join(layout.root, 'case-probe')
  await fs.promises.writeFile(probe, 'probe')
  try {
    await fs.promises.lstat(path.join(layout.root, 'CASE-PROBE'))
    return true
  } catch {
    return false
  } finally {
    await fs.promises.rm(probe, { force: true })
  }
}

test('a case variant of a recorded link never bypasses its ownership record', async (t) => {
  for (const mode of ['automatic', 'manual'] as const) {
    const { links, layout } = await createStore(t)
    await mkdirs(layout, ['release-1', 'release-2'])
    const options: ManualLinkOptions = {
      managedArtifactNames: new Set(['release-1', 'release-2']),
      automaticLinkNames: new Set<string>(mode === 'automatic' ? ['latest'] : [])
    }
    const converge = (): Promise<unknown> =>
      mode === 'automatic'
        ? links.reconcile([desired('latest', 'release-1', LATEST_ID)], new Set(['latest']))
        : links.linkManual(desired('latest', 'release-1', LATEST_ID), options)
    await converge()
    const recorded = await links.read('latest')
    const request = (): Promise<unknown> =>
      links.linkManual(desired('Latest', 'release-2', NEXT_ID), options)

    if (await caseInsensitive(layout)) {
      await t.exception(request, { code: ERRORS.LINK_CONFLICT }, `${mode}: one entry, one owner`)
      t.is(await fs.promises.readlink(latestPath(layout)), 'release-1')
      t.alike(await links.read('latest'), recorded)
      t.is(await links.read('Latest'), null, 'no second record for the same entry')
      t.alike(await fs.promises.readdir(layout.publications), [])
      await converge()
      t.alike(await links.read('latest'), recorded, `${mode}: later convergence is undisturbed`)
    } else {
      t.alike(await request(), { status: 'LINKED' }, `${mode}: a distinct entry on this volume`)
      t.is(await fs.promises.readlink(latestPath(layout)), 'release-1')
      t.is(await fs.promises.readlink(path.join(layout.root, 'Latest')), 'release-2')
      t.alike(await links.read('latest'), recorded)
      t.is((await links.read('Latest'))?.target, 'release-2')
    }
  }
})

test('a case-only external rename of a recorded link keeps its record protected', async (t) => {
  const { links, layout } = await createStore(t)
  await mkdirs(layout, ['release-1', 'release-2'])
  const options: ManualLinkOptions = {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set<string>()
  }
  await links.linkManual(desired('latest', 'release-1', LATEST_ID), options)
  const recorded = await links.read('latest')
  await fs.promises.rename(latestPath(layout), path.join(layout.root, 'Latest'))
  const request = (): Promise<unknown> =>
    links.linkManual(desired('Latest', 'release-2', NEXT_ID), options)

  if (await caseInsensitive(layout)) {
    t.ok((await fs.promises.readdir(layout.root)).includes('Latest'), 'the entry is now `Latest`')
    await t.exception(request, { code: ERRORS.LINK_CONFLICT })
    t.is(await fs.promises.readlink(path.join(layout.root, 'Latest')), 'release-1')
    t.alike(await links.read('latest'), recorded)
    t.is(await links.read('Latest'), null)
  } else {
    t.alike(await request(), { status: 'LINKED' }, 'a distinct name on this volume')
    t.is(await fs.promises.readlink(path.join(layout.root, 'Latest')), 'release-2')
  }
  t.alike(await fs.promises.readdir(layout.publications), [])
})

test('takeover needs no inode identities, but fails closed beside a case-variant record without them', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const base = createStorage()
  const blind: StorageAdapter = {
    ...base,
    async lstat(target) {
      const stat = await base.lstat(target)
      if (!stat.isSymbolicLink()) return stat
      return {
        dev: Number.NaN,
        ino: Number.NaN,
        size: stat.size,
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false
      }
    }
  }
  const blindLinks = new LinkStore({ layout, storage: blind })
  const links = new LinkStore({ layout, storage: base })
  await mkdirs(layout, ['0.20.0', '0.20.1'])
  await fs.promises.symlink('0.20.0', latestPath(layout))
  t.alike(await requestLatest(blindLinks), { status: 'LINKED' }, 'the text checks still hold')
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.1')

  if (await caseInsensitive(layout)) {
    t.pass('names differing in case are one entry on this volume; see the case-alias tests')
    return
  }
  const variant = path.join(layout.root, 'Latest')
  await fs.promises.symlink('0.20.0', variant)
  await t.exception(() => blindLinks.linkManual(desired('Latest', '0.20.1', NEXT_ID), manual()), {
    code: ERRORS.LINK_CONFLICT
  })
  t.is(await fs.promises.readlink(variant), '0.20.0', 'independence could not be proven')
  t.alike(await links.linkManual(desired('Latest', '0.20.1', NEXT_ID), manual()), {
    status: 'LINKED'
  })
  t.is(await fs.promises.readlink(variant), '0.20.1', 'identities prove them distinct')
})

test('a case variant of a configured automatic name or managed artifact name is never taken over', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const base = createStorage()
  const blind: StorageAdapter = {
    ...base,
    async lstat(target) {
      const stat = await base.lstat(target)
      if (!stat.isSymbolicLink()) return stat
      return {
        dev: Number.NaN,
        ino: Number.NaN,
        size: stat.size,
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false
      }
    }
  }
  const links = new LinkStore({ layout, storage: base })
  const blindLinks = new LinkStore({ layout, storage: blind })
  const insensitive = await caseInsensitive(layout)
  await mkdirs(layout, ['release-1', 'release-2', 'Build-1'])

  // A hand-made `Latest` while the automatic `latest` rule is dormant: no record, no link.
  const reservedOptions: ManualLinkOptions = {
    managedArtifactNames: new Set(['release-1', 'release-2']),
    automaticLinkNames: new Set(['latest'])
  }
  const variant = path.join(layout.root, 'Latest')
  await fs.promises.symlink('release-1', variant)
  const takeVariant = (): Promise<unknown> =>
    links.linkManual(desired('Latest', 'release-2', NEXT_ID), reservedOptions)
  if (insensitive) {
    await t.exception(takeVariant, { code: ERRORS.LINK_CONFLICT }, 'the reserved automatic name')
    t.is(await fs.promises.readlink(variant), 'release-1')
    t.alike(await links.list(), [], 'nothing is recorded')
  } else {
    t.alike(await takeVariant(), { status: 'LINKED' }, 'a distinct name on this volume')
    t.is(await fs.promises.readlink(variant), 'release-2')
  }

  // `Build-1` is a managed artifact directory; `build-1` is a hand-made symlink name.
  const artifactOptions: ManualLinkOptions = {
    managedArtifactNames: new Set(['release-2', 'Build-1']),
    automaticLinkNames: new Set<string>()
  }
  const alias = path.join(layout.root, 'build-1')
  const takeAlias = (store: LinkStore): Promise<unknown> =>
    store.linkManual(desired('build-1', 'release-2', NEXT_ID), artifactOptions)
  if (insensitive) {
    await t.exception(() => takeAlias(links), { code: ERRORS.LINK_CONFLICT }, 'the artifact entry')
  } else {
    await fs.promises.symlink('release-1', alias)
    await t.exception(() => takeAlias(blindLinks), { code: ERRORS.LINK_CONFLICT })
    t.is(await fs.promises.readlink(alias), 'release-1', 'independence could not be proven')
    t.alike(await takeAlias(links), { status: 'LINKED' }, 'identities prove them distinct')
    t.is(await fs.promises.readlink(alias), 'release-2')
  }
  t.ok((await fs.promises.lstat(path.join(layout.root, 'Build-1'))).isDirectory())
  t.alike(await fs.promises.readdir(layout.publications), [])
})

test('takeover requires the destination to be listed under exactly the requested spelling', async (t) => {
  const layout = initLayout(await createTempDir(t))
  const base = createStorage()
  const storage: StorageAdapter = {
    ...base,
    async readdir(target) {
      const names = await base.readdir(target)
      return target === layout.root ? names.filter((name) => name !== 'latest') : names
    }
  }
  const links = new LinkStore({ layout, storage })
  await mkdirs(layout, ['0.20.0', '0.20.1'])
  await fs.promises.symlink('0.20.0', latestPath(layout))
  await t.exception(() => requestLatest(links), { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readlink(latestPath(layout)), '0.20.0')
  t.is(await links.read('latest'), null)
  t.alike(await fs.promises.readdir(layout.publications), [])
})

// --- Rollback journal -------------------------------------------------------------------------

const PRIOR_ID = '3'.repeat(64)

function journalFile(layout: StorageLayout, name = 'latest'): string {
  const hash = b4a.toString(sodiumSha256(b4a.from(name)), 'hex')
  return path.join(layout.links, `${hash}.rollback.json`)
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file)
    return true
  } catch {
    return false
  }
}

/** The visible link text (`null` when absent, `'UNMANAGED'` for a non-symlink) and its record. */
interface Observed {
  link: string | null
  record: ManagedSymlinkRecord | null
}

async function observe(layout: StorageLayout, links: LinkStore): Promise<Observed> {
  let link: string | null
  try {
    const stat = await fs.promises.lstat(latestPath(layout))
    link = stat.isSymbolicLink() ? await fs.promises.readlink(latestPath(layout)) : 'UNMANAGED'
  } catch {
    link = null
  }
  return { link, record: await links.read('latest') }
}

const MUTATING = new Set([
  'rename',
  'unlink',
  'symlink',
  'write',
  'truncate',
  'rm',
  'rmdir',
  'link'
])

/**
 * Counts mutating storage operations and, at the `at`-th one, makes the process die: that
 * operation and every later mutation fail, as if the process had been killed right before it.
 */
interface Crash {
  count: number
  at: number | null
  dead: boolean
}

function crashing(crash: Crash): CreateStorageOptions {
  return {
    beforeOperation(name, _target, ...rest) {
      if (!MUTATING.has(name) && !(name === 'open' && rest[0] === 'wx')) return
      if (crash.dead) throw new Error('the process is dead')
      crash.count++
      if (crash.at !== null && crash.count === crash.at) {
        crash.dead = true
        throw new Error('injected crash')
      }
    }
  }
}

interface Prior {
  label: string
  /** Makes the previous state with a healthy store; `outside` is a directory beside the root. */
  setup(layout: StorageLayout, links: LinkStore, outside: string): Promise<void>
  target: '0.20.1' | '0.20.2'
  id: string
  status: 'LINKED' | 'UNCHANGED'
}

/** An unowned symlink with this exact text, or (`null`) one that names the `outside` directory. */
function adopted(label: string, literal: string | null): Prior {
  return {
    label,
    async setup(layout, _links, outside) {
      await fs.promises.symlink(literal ?? outside, latestPath(layout))
    },
    target: '0.20.1',
    id: LATEST_ID,
    status: 'LINKED'
  }
}

const PRIORS: Prior[] = [
  {
    label: 'no link and no record',
    setup: () => Promise.resolve(),
    target: '0.20.1',
    id: LATEST_ID,
    status: 'LINKED'
  },
  {
    label: 'a record without a link',
    async setup(layout, links) {
      await requestLatest(links, '0.20.2', PRIOR_ID)
      await fs.promises.rm(latestPath(layout))
    },
    target: '0.20.1',
    id: LATEST_ID,
    status: 'LINKED'
  },
  {
    label: 'a managed link to another target',
    async setup(_layout, links) {
      await requestLatest(links, '0.20.2', PRIOR_ID)
    },
    target: '0.20.1',
    id: LATEST_ID,
    status: 'LINKED'
  },
  {
    label: 'a managed link with a stale record (record-only change)',
    async setup(_layout, links) {
      await requestLatest(links, '0.20.1', PRIOR_ID)
    },
    target: '0.20.1',
    id: LATEST_ID,
    status: 'UNCHANGED'
  },
  {
    label: 'a managed record that disagrees with a link already at the target',
    async setup(layout, links) {
      await requestLatest(links, '0.20.2', PRIOR_ID)
      await fs.promises.rm(latestPath(layout))
      await fs.promises.symlink('0.20.1', latestPath(layout))
    },
    target: '0.20.1',
    id: LATEST_ID,
    status: 'LINKED'
  },
  adopted('an adopted absolute literal outside the root', null),
  adopted('an adopted dangling literal', 'no-such-target'),
  adopted('an adopted parent-relative literal', '../escape'),
  adopted('an adopted literal equal to the new target', '0.20.1'),
  adopted('an adopted literal naming another managed artifact', '0.20.2'),
  adopted('an adopted literal with quotes, a newline, and non-ASCII text', 'x "q"\n\\ é€😀')
]

interface Scenario {
  layout: StorageLayout
  links: LinkStore
  /** What the name looked like before the request; the expected state after a rollback. */
  before: Observed
}

async function scenarioStore(
  t: Parameters<Parameters<typeof test>[1]>[0],
  prior: Prior,
  crash: Crash,
  /** Failure injection for the store under test, in place of dying at `crash`'s operation. */
  inject?: (layout: StorageLayout) => CreateStorageOptions
): Promise<Scenario> {
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await mkdirs(layout, ['0.20.0', '0.20.1', '0.20.2'])
  const healthy = new LinkStore({ layout, storage: createStorage() })
  await prior.setup(layout, healthy, outside)
  const before = await observe(layout, healthy)
  const options = inject ? inject(layout) : crashing(crash)
  const links = new LinkStore({ layout, storage: createStorage(options) })
  return { layout, links, before }
}

function begin(links: LinkStore, prior: Prior) {
  return links.beginManual(desired('latest', prior.target, prior.id), manual())
}

test('a rollback restores the previous link and ownership record exactly, whatever they were', async (t) => {
  for (const prior of PRIORS) {
    const crash: Crash = { count: 0, at: null, dead: false }
    const { layout, links, before } = await scenarioStore(t, prior, crash)
    const label = prior.label

    const begun = await begin(links, prior)
    t.is(begun.status, prior.status, label)
    t.ok(begun.transaction, `${label}: a change is journaled`)
    t.ok(await exists(journalFile(layout)), `${label}: the journal is durable`)
    const after = await observe(layout, links)
    t.is(after.link, prior.target, `${label}: the new link is visible`)
    t.alike(after.record, {
      version: 2,
      mode: 'manual',
      name: 'latest',
      target: prior.target,
      transferId: prior.id,
      targetKind: 'directory'
    } satisfies ManagedSymlinkRecord)
    t.alike(
      (await links.pendingRollbacks()).map((pending) => pending.name),
      ['latest'],
      `${label}: the journal is listed for retention pins`
    )

    await links.rollbackManual(begun.transaction!)
    t.alike(await observe(layout, links), before, `${label}: previous link and record are back`)
    t.absent(await exists(journalFile(layout)), `${label}: the journal is gone`)
    t.alike(await fs.promises.readdir(layout.publications), [], `${label}: no temporary link`)
    t.alike(await links.pendingRollbacks(), [])
  }

  // Finalizing keeps the change and drops only the journal.
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, PRIORS[2], crash)
  const begun = await begin(links, PRIORS[2])
  await links.commitManual(begun.transaction!)
  t.is((await observe(layout, links)).link, '0.20.1')
  t.absent(await exists(journalFile(layout)))
})

test('an exact repeat changes nothing, so it journals nothing and has nothing to roll back', async (t) => {
  const crash: Crash = { count: 0, at: null, dead: false }
  const prior = PRIORS[2]
  const { layout, links } = await scenarioStore(t, prior, crash)
  const same = { ...prior, target: '0.20.2' as const, id: PRIOR_ID }
  const before = await observe(layout, links)
  crash.count = 0
  t.alike(await begin(links, same), { status: 'UNCHANGED', transaction: null })
  t.is(crash.count, 0, 'not one mutating operation')
  t.absent(await exists(journalFile(layout)))
  t.alike(await observe(layout, links), before)
})

type CrashPhase = 'begin' | 'rollback' | 'commit'

/**
 * For every previous state, dies before each mutating operation of the given phases, restarts on
 * healthy storage, and expects the previous state back with no journal left.
 */
async function crashAtEveryOperation(
  t: Parameters<Parameters<typeof test>[1]>[0],
  phases: CrashPhase[]
): Promise<void> {
  for (const prior of PRIORS) {
    // Count the mutating operations of each phase on a healthy run.
    const counted: Crash = { count: 0, at: null, dead: false }
    const probe = await scenarioStore(t, prior, counted)
    counted.count = 0
    const probed = await begin(probe.links, prior)
    const beginOps = counted.count
    counted.count = 0
    await probe.links.rollbackManual(probed.transaction!)
    const rollbackOps = counted.count
    t.ok(beginOps > 0 && rollbackOps > 0, `${prior.label}: ${beginOps} + ${rollbackOps} operations`)

    // Die before every operation of the phases, then restart.
    const points: Array<[CrashPhase, number]> = [
      ...Array.from({ length: beginOps }, (_, i): [CrashPhase, number] => ['begin', i + 1]),
      ...Array.from({ length: rollbackOps }, (_, i): [CrashPhase, number] => ['rollback', i + 1]),
      ['commit', 1]
    ]
    for (const [phase, at] of points.filter(([point]) => phases.includes(point))) {
      const label = `${prior.label}: crash before ${phase} operation ${at}`
      const crash: Crash = { count: 0, at: phase === 'begin' ? at : null, dead: false }
      const { layout, links, before } = await scenarioStore(t, prior, crash)
      let transaction: Awaited<ReturnType<typeof begin>>['transaction'] = null
      try {
        transaction = (await begin(links, prior)).transaction
        if (phase === 'begin') t.fail(`${label}: should have died`)
      } catch {
        t.is(phase, 'begin', `${label}: begin died`)
      }
      if (phase !== 'begin') {
        crash.count = 0
        crash.at = at
        const died =
          phase === 'rollback'
            ? links.rollbackManual(transaction!)
            : links.commitManual(transaction!)
        await died.then(
          () => t.fail(`${label}: should have died`),
          () => {}
        )
      }

      // The restart: a fresh store on healthy storage restores whatever the journal covers.
      const restarted = new LinkStore({ layout, storage: createStorage() })
      const recovery = await restarted.recoverRollbacks()
      t.alike(recovery.blocked, [], label)
      t.alike(await observe(layout, restarted), before, `${label}: the previous state is back`)
      t.absent(await exists(journalFile(layout)), `${label}: no journal remains`)
      t.alike(await restarted.pendingRollbacks(), [], label)
    }
  }
}

test('every crash point while a request makes its change restores the previous state at the next start', async (t) => {
  await crashAtEveryOperation(t, ['begin'])
})

test('every crash point while a request is restored or finalized restores the previous state at the next start', async (t) => {
  await crashAtEveryOperation(t, ['rollback', 'commit'])

  // Once the request is final nothing is left to recover.
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, PRIORS[2], crash)
  await links.commitManual((await begin(links, PRIORS[2])).transaction!)
  const restarted = new LinkStore({ layout, storage: createStorage() })
  t.alike(await restarted.recoverRollbacks(), { restored: [], blocked: [] })
  t.is((await observe(layout, restarted)).link, '0.20.1', 'a finalized change survives a restart')
})

function otherRecord(id: string, target = '0.20.0'): string {
  return JSON.stringify({
    version: 2,
    mode: 'manual',
    name: 'latest',
    target,
    transferId: id,
    targetKind: 'directory'
  })
}

test('a rollback never overwrites a change somebody else made, and fails closed until it is resolved', async (t) => {
  const prior = PRIORS[2]
  const externals: Array<[string, (layout: StorageLayout) => Promise<void>]> = [
    [
      'another symlink text',
      async (layout) => {
        await fs.promises.rm(latestPath(layout))
        await fs.promises.symlink('0.20.0', latestPath(layout))
      }
    ],
    [
      'the same text on a replaced symlink',
      async (layout) => {
        await fs.promises.rm(latestPath(layout))
        await fs.promises.symlink('0.20.1', latestPath(layout))
      }
    ],
    [
      'a regular file',
      async (layout) => {
        await fs.promises.rm(latestPath(layout))
        await fs.promises.writeFile(latestPath(layout), 'operator file')
      }
    ],
    [
      'a directory',
      async (layout) => {
        await fs.promises.rm(latestPath(layout))
        await fs.promises.mkdir(latestPath(layout))
      }
    ],
    ['a removed link', (layout) => fs.promises.rm(latestPath(layout))],
    [
      'an edited record',
      (layout) => fs.promises.writeFile(recordFile(layout, 'latest'), otherRecord('9'.repeat(64)))
    ],
    ['a removed record', (layout) => fs.promises.rm(recordFile(layout, 'latest'))]
  ]
  for (const [label, change] of externals) {
    const crash: Crash = { count: 0, at: null, dead: false }
    const { layout, links } = await scenarioStore(t, prior, crash)
    const begun = await begin(links, prior)
    await change(layout)
    const external = await observe(layout, links).catch(() => null)
    const entries = await fs.promises.readdir(layout.root)

    await t.exception(() => links.rollbackManual(begun.transaction!), { code: ERRORS.LINK_FAILED })
    t.alike(
      await fs.promises.readdir(layout.root),
      entries,
      `${label}: nothing was added or removed`
    )
    t.alike(await observe(layout, links).catch(() => null), external, `${label}: left as found`)
    t.ok(await exists(journalFile(layout)), `${label}: the journal is kept`)

    // A restart reports the name as blocked and changes nothing; requests for it fail closed,
    // and retention still sees what the journal holds.
    const restarted = new LinkStore({ layout, storage: createStorage() })
    t.alike(await restarted.recoverRollbacks(), { restored: [], blocked: ['latest'] }, label)
    await t.exception(() => requestLatest(restarted), { code: ERRORS.LINK_FAILED })
    await t.exception(() => begin(restarted, prior), { code: ERRORS.LINK_FAILED })
    t.alike(
      await observe(layout, restarted).catch(() => null),
      external,
      `${label}: still as found`
    )
    t.alike(
      (await restarted.pendingRollbacks()).map((pending) => [pending.name, pending.target]),
      [['latest', '0.20.1']],
      label
    )
  }

  // If somebody put the previous state back already, the rollback has nothing left to do.
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links, before } = await scenarioStore(t, prior, crash)
  const begun = await begin(links, prior)
  await fs.promises.rm(latestPath(layout))
  await fs.promises.symlink('0.20.2', latestPath(layout))
  await fs.promises.writeFile(recordFile(layout, 'latest'), JSON.stringify(before.record))
  await links.rollbackManual(begun.transaction!)
  t.alike(await observe(layout, links), before)
  t.absent(await exists(journalFile(layout)))
})

/** The journal as parsed from disk, to be edited and written back. */
async function readJournalFile(layout: StorageLayout): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.promises.readFile(journalFile(layout), 'utf8')) as Record<
    string,
    unknown
  >
}

test('an open request acts only on a journal that is still its own, and never erases another', async (t) => {
  const prior = PRIORS[2] // a managed link to 0.20.2, then a request for 0.20.1
  const edits: Array<
    [string, (journal: Record<string, unknown>) => Record<string, unknown> | null]
  > = [
    // What another request or an operator might have left under the same file name.
    [
      'a journal of another request',
      (journal) => ({
        ...journal,
        token: 'f'.repeat(32),
        prior: { link: { state: 'SYMLINK', literal: '0.20.0', identity: null }, record: null }
      })
    ],
    // The same token, so only the fixed contents can tell it apart.
    [
      'the same token with another previous link',
      (journal) => ({
        ...journal,
        prior: {
          ...(journal.prior as object),
          link: { state: 'SYMLINK', literal: '0.20.0', identity: null }
        }
      })
    ],
    [
      'the same token with another previous record',
      (journal) => ({ ...journal, prior: { ...(journal.prior as object), record: null } })
    ],
    [
      'the same token with another intended link',
      (journal) => ({
        ...journal,
        intended: { ...(journal.intended as object), target: '0.20.0' }
      })
    ],
    [
      'the same token with another intended transfer',
      (journal) => ({
        ...journal,
        intended: { ...(journal.intended as object), transferId: '7'.repeat(64) }
      })
    ],
    [
      'the same token with another applied identity',
      (journal) => ({ ...journal, applied: { identity: { dev: '1', ino: '2' } } })
    ],
    ['a removed journal', () => null]
  ]
  for (const [label, edit] of edits) {
    for (const act of ['rollback', 'commit'] as const) {
      const crash: Crash = { count: 0, at: null, dead: false }
      const { layout, links } = await scenarioStore(t, prior, crash)
      const begun = await begin(links, prior)
      const applied = await observe(layout, links)
      const edited = edit(await readJournalFile(layout))
      if (edited === null) await fs.promises.rm(journalFile(layout))
      else await fs.promises.writeFile(journalFile(layout), JSON.stringify(edited))
      const left = edited === null ? null : await fs.promises.readFile(journalFile(layout), 'utf8')
      const entries = await fs.promises.readdir(layout.root)

      const attempt =
        act === 'rollback'
          ? () => links.rollbackManual(begun.transaction!)
          : () => links.commitManual(begun.transaction!)
      await t.exception(attempt, { code: ERRORS.LINK_FAILED }, `${label}: ${act}`)
      t.alike(await observe(layout, links), applied, `${label}: ${act} left the link and record`)
      t.alike(await fs.promises.readdir(layout.root), entries, `${label}: ${act} added nothing`)
      t.alike(await fs.promises.readdir(layout.publications), [], `${label}: ${act}`)
      t.is(
        await exists(journalFile(layout)),
        edited !== null,
        `${label}: ${act} created or removed no journal`
      )
      if (left !== null) {
        t.is(
          await fs.promises.readFile(journalFile(layout), 'utf8'),
          left,
          `${label}: ${act} left the other journal exactly as it was`
        )
      }
    }
  }
})

test('a journal whose last write did not land, or a recovered one, still settles', async (t) => {
  const prior = PRIORS[2]
  for (const act of ['rollback', 'commit'] as const) {
    const crash: Crash = { count: 0, at: null, dead: false }
    const { layout, links, before } = await scenarioStore(t, prior, crash)
    const begun = await begin(links, prior)
    const applied = await observe(layout, links)
    // The write that records the new link's identity may not have landed: the disk copy has
    // `applied` unset while the request holds it.
    const unapplied = { ...(await readJournalFile(layout)), applied: null }
    await fs.promises.writeFile(journalFile(layout), JSON.stringify(unapplied))
    if (act === 'rollback') {
      await links.rollbackManual(begun.transaction!)
      t.alike(await observe(layout, links), before, 'rolled back')
    } else {
      await links.commitManual(begun.transaction!)
      t.alike(await observe(layout, links), applied, 'committed')
    }
    t.absent(await exists(journalFile(layout)), act)
  }

  // The write of the applied identity fails once and the store is healthy again: the change
  // is undone with the journal still being its own, and the name is usable straight after.
  let writes = 0
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links, before } = await scenarioStore(t, prior, crash, (where) => ({
    beforeOperation(name, _target, ...rest) {
      if (name === 'rename' && rest[0] === journalFile(where) && ++writes === 2) {
        throw new Error('injected failure of the second journal write')
      }
    }
  }))
  await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED })
  t.alike(await observe(layout, links), before, 'the previous state is back')
  t.absent(await exists(journalFile(layout)))
  t.alike(await fs.promises.readdir(layout.publications), [])
  t.is((await begin(links, prior)).status, 'LINKED', 'the name works again')
})

test('a one-off failure while creating the link puts back the previous record and clears the journal', async (t) => {
  const failures: Array<[string, Prior]> = [
    ['no link, a previous record', PRIORS[1]],
    ['no link, no record', PRIORS[0]]
  ]
  for (const [label, prior] of failures) {
    let failed = false
    const crash: Crash = { count: 0, at: null, dead: false }
    const { layout, links, before } = await scenarioStore(t, prior, crash, (where) => ({
      beforeOperation(name, target) {
        if (name === 'symlink' && target === latestPath(where) && !failed) {
          failed = true
          throw new Error('injected one-off symlink failure')
        }
      }
    }))
    await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED }, label)
    t.ok(failed, `${label}: the failure was injected`)
    t.alike(await observe(layout, links), before, `${label}: the previous record and no link`)
    t.absent(await exists(journalFile(layout)), `${label}: no journal is left blocking the name`)
    t.alike(await fs.promises.readdir(layout.publications), [], label)
    const next = await begin(links, prior)
    t.is(next.status, 'LINKED', `${label}: the next request works`)
    await links.rollbackManual(next.transaction!)
    t.alike(await observe(layout, links), before, `${label}: and restores as usual`)
  }

  // Somebody's file wins the creation race: the request is rejected as before, the file is
  // never touched, and no journal is left to block the name.
  const prior = PRIORS[1]
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links, before } = await scenarioStore(t, prior, crash, (where) => ({
    async beforeOperation(name, target) {
      if (name === 'symlink' && target === latestPath(where)) {
        await fs.promises.writeFile(latestPath(where), 'operator file')
      }
    }
  }))
  await t.exception(() => begin(links, prior), { code: ERRORS.LINK_CONFLICT })
  t.is(await fs.promises.readFile(latestPath(layout), 'utf8'), 'operator file')
  t.alike((await observe(layout, links)).record, before.record, 'the previous record is back')
  t.absent(await exists(journalFile(layout)))
})

test('when the failed creation cannot be undone the answer is LINK_FAILED, and the next request finishes it', async (t) => {
  const prior = PRIORS[1]
  const crash: Crash = { count: 0, at: null, dead: false }

  // The symlink fails once and putting the previous record back fails twice (the immediate
  // attempt and the retry through the journal), then storage is healthy.
  {
    let symlinkFailed = false
    let recordWrites = 0
    const { layout, links, before } = await scenarioStore(t, prior, crash, (where) => ({
      beforeOperation(name, target, ...rest) {
        if (name === 'symlink' && target === latestPath(where) && !symlinkFailed) {
          symlinkFailed = true
          throw new Error('injected one-off symlink failure')
        }
        if (symlinkFailed && name === 'rename' && rest[0] === recordFile(where, 'latest')) {
          if (++recordWrites <= 2) throw new Error('injected record write failure')
        }
      }
    }))
    await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED })
    t.ok(await exists(journalFile(layout)), 'the journal is kept to finish the undo')
    t.is((await observe(layout, links)).link, null, 'no link was made')
    // Healthy again: the next request puts the previous record back first, then proceeds.
    const next = await begin(links, prior)
    t.is(next.status, 'LINKED', 'the next request works')
    await links.rollbackManual(next.transaction!)
    t.alike(await observe(layout, links), before, 'and it restores the previous record')
    t.absent(await exists(journalFile(layout)))
  }

  // A file wins the creation race and the previous record cannot be put back: the answer is
  // LINK_FAILED, not the rejection of a request whose undo did not finish, and the name stays
  // blocked until the file is dealt with.
  {
    let writes = 0
    let raced = false
    const { layout, links } = await scenarioStore(t, prior, crash, (where) => ({
      async beforeOperation(name, target, ...rest) {
        if (name === 'symlink' && target === latestPath(where) && !raced) {
          raced = true
          await fs.promises.writeFile(latestPath(where), 'operator file')
        }
        // Only the write that puts the previous record back, after the race, fails.
        if (
          raced &&
          name === 'rename' &&
          rest[0] === recordFile(where, 'latest') &&
          ++writes === 1
        ) {
          throw new Error('injected record write failure')
        }
      }
    }))
    await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED })
    t.ok(await exists(journalFile(layout)), 'the journal is kept')
    t.is(await fs.promises.readFile(latestPath(layout), 'utf8'), 'operator file')
    await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED })
    // Once the file is gone the pending undo is finished and the request goes ahead.
    await fs.promises.rm(latestPath(layout))
    t.is((await begin(links, prior)).status, 'LINKED')
  }
})

test('a failed creation puts nothing back over a journal or record that is no longer its own', async (t) => {
  const foreign: ManagedSymlinkRecord = {
    version: 2,
    mode: 'manual',
    name: 'latest',
    target: '0.20.0',
    transferId: '7'.repeat(64),
    targetKind: 'directory'
  }
  // What changes under the request between its journal write and its failed `symlink()`.
  const variants: Array<[string, { journal: boolean; record: boolean }]> = [
    ['a replaced journal and a foreign record', { journal: true, record: true }],
    ['an edited record under the request’s own journal', { journal: false, record: true }],
    ['a replaced journal over the request’s own record', { journal: true, record: false }]
  ]
  for (const prior of [PRIORS[1], PRIORS[0]]) {
    for (const [name, changes] of variants) {
      const label = `${prior.label}, ${name}`
      let failed = false
      let journal = ''
      const crash: Crash = { count: 0, at: null, dead: false }
      const { layout, links } = await scenarioStore(t, prior, crash, (where) => ({
        async beforeOperation(operation, target) {
          if (operation !== 'symlink' || target !== latestPath(where) || failed) return
          failed = true
          if (changes.journal) {
            const replaced = { ...(await readJournalFile(where)), token: 'f'.repeat(32) }
            await fs.promises.writeFile(journalFile(where), JSON.stringify(replaced))
          }
          if (changes.record) {
            await fs.promises.writeFile(recordFile(where, 'latest'), JSON.stringify(foreign))
          }
          journal = await fs.promises.readFile(journalFile(where), 'utf8')
          throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
        }
      }))
      await t.exception(() => begin(links, prior), { code: ERRORS.LINK_FAILED }, label)
      t.ok(failed, `${label}: the failure was injected`)
      const intended: ManagedSymlinkRecord = {
        ...foreign,
        target: prior.target,
        transferId: prior.id
      }
      t.alike(
        await observe(layout, links),
        { link: null, record: changes.record ? foreign : intended },
        `${label}: the record is exactly as found, not the previous one`
      )
      t.is(
        await fs.promises.readFile(journalFile(layout), 'utf8'),
        journal,
        `${label}: the journal is left exactly as it was`
      )
      t.alike(await fs.promises.readdir(layout.publications), [], label)
    }
  }
})

test('on a case-insensitive volume a restore never reaches an entry listed under another spelling', async (t) => {
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, PRIORS[0], crash)
  if (!(await caseInsensitive(layout))) {
    t.pass(
      'this volume keeps `latest` and `Latest` apart; the exact-listing check has no case to catch'
    )
    return
  }
  const begun = await begin(links, PRIORS[0])
  await fs.promises.rename(latestPath(layout), path.join(layout.root, 'Latest'))
  await t.exception(() => links.rollbackManual(begun.transaction!), { code: ERRORS.LINK_FAILED })
  t.ok(await fs.promises.readdir(layout.root).then((names) => names.includes('Latest')))
  t.ok(await exists(journalFile(layout)))
})

test('a link that cannot be restored exactly is refused before anything changes, and keep still adopts it', async (t) => {
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, adopted('lossy', '0.20.�'), crash)
  const before = await observe(layout, links)
  await t.exception(() => begin(links, PRIORS[0]), { code: ERRORS.LINK_CONFLICT })
  t.alike(await observe(layout, links), before, 'the symlink and its record are untouched')
  t.absent(await exists(journalFile(layout)), 'nothing was journaled')
  t.alike(await fs.promises.readdir(layout.publications), [])
  t.alike(
    await requestLatest(links),
    { status: 'LINKED' },
    'a request without rollback still adopts it'
  )
})

test('a stale journal is resolved before the next request for that name, or that request fails closed', async (t) => {
  for (const policy of ['begin', 'keep'] as const) {
    const crash: Crash = { count: 0, at: null, dead: false }
    const prior = PRIORS[2]
    const { layout, links, before } = await scenarioStore(t, prior, crash)
    await begin(links, prior)
    // Nobody finalized or restored it: this is what an interrupted process leaves behind.
    const next = new LinkStore({ layout, storage: createStorage() })
    const again =
      policy === 'begin'
        ? (await begin(next, { ...prior, target: '0.20.2', id: PRIOR_ID })).status
        : (await requestLatest(next, '0.20.2', PRIOR_ID)).status
    t.is(
      again,
      'UNCHANGED',
      `${policy}: the previous state was restored first, then this request ran`
    )
    t.alike(await observe(layout, next), before)
    t.absent(await exists(journalFile(layout)))
  }

  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, PRIORS[0], crash)
  await begin(links, PRIORS[0])
  await fs.promises.rm(latestPath(layout))
  await fs.promises.writeFile(latestPath(layout), 'operator file')
  const next = new LinkStore({ layout, storage: createStorage() })
  await t.exception(() => requestLatest(next), { code: ERRORS.LINK_FAILED })
  t.is(await fs.promises.readFile(latestPath(layout), 'utf8'), 'operator file')
  // Removing the journal is the operator's decision that the state is theirs.
  await fs.promises.rm(journalFile(layout))
  await t.exception(() => requestLatest(next), { code: ERRORS.LINK_CONFLICT })
})

test('an untrusted journal is validated strictly and fails closed without touching anything', async (t) => {
  const prior = PRIORS[2]
  const crash: Crash = { count: 0, at: null, dead: false }
  const { layout, links } = await scenarioStore(t, prior, crash)
  await begin(links, prior)
  const valid = JSON.parse(await fs.promises.readFile(journalFile(layout), 'utf8')) as Record<
    string,
    unknown
  >
  const priorState = valid.prior as {
    link: Record<string, unknown>
    record: Record<string, unknown>
  }
  const variants: Array<[string, () => unknown]> = [
    ['not JSON', () => '{'],
    ['an array', () => '[]'],
    ['an extra key', () => ({ ...valid, extra: 1 })],
    ['a missing key', () => ({ ...valid, applied: undefined })],
    ['another version', () => ({ ...valid, version: 2 })],
    ['a short token', () => ({ ...valid, token: 'ab' })],
    ['an unsafe name', () => ({ ...valid, name: '../latest' })],
    ['another name than its file', () => ({ ...valid, name: 'other' })],
    [
      'the name as its own target',
      () => ({ ...valid, intended: { ...(valid.intended as object), target: 'latest' } })
    ],
    [
      'a bad transfer ID',
      () => ({ ...valid, intended: { ...(valid.intended as object), transferId: 'x' } })
    ],
    [
      'a bad artifact kind',
      () => ({ ...valid, intended: { ...(valid.intended as object), targetKind: 'symlink' } })
    ],
    [
      'an unsafe target',
      () => ({ ...valid, intended: { ...(valid.intended as object), target: '../x' } })
    ],
    [
      'an unknown prior link state',
      () => ({ ...valid, prior: { ...priorState, link: { state: 'FILE' } } })
    ],
    [
      'an empty literal',
      () => ({
        ...valid,
        prior: { ...priorState, link: { state: 'SYMLINK', literal: '', identity: null } }
      })
    ],
    [
      'a NUL in the literal',
      () => ({
        ...valid,
        prior: { ...priorState, link: { state: 'SYMLINK', literal: 'a\u0000b', identity: null } }
      })
    ],
    [
      'an oversize literal',
      () => ({
        ...valid,
        prior: {
          ...priorState,
          link: { state: 'SYMLINK', literal: 'a'.repeat(5000), identity: null }
        }
      })
    ],
    ['a journal over the size limit', () => `${JSON.stringify(valid)}${' '.repeat(40_000)}`],
    [
      'a bad identity',
      () => ({
        ...valid,
        prior: {
          ...priorState,
          link: { state: 'SYMLINK', literal: 'a', identity: { dev: 'x', ino: '1' } }
        }
      })
    ],
    [
      'an automatic prior record',
      () => ({
        ...valid,
        prior: { ...priorState, record: { ...priorState.record, mode: 'automatic' } }
      })
    ],
    [
      'a version 1 prior record',
      () => {
        const { mode: _mode, ...rest } = priorState.record
        return { ...valid, prior: { ...priorState, record: { ...rest, version: 1 } } }
      }
    ],
    [
      'an applied value with an extra key',
      () => ({ ...valid, applied: { identity: null, extra: 1 } })
    ]
  ]
  const file = journalFile(layout)
  const before = await observe(layout, links)
  const check = async (label: string): Promise<void> => {
    const fresh = new LinkStore({ layout, storage: createStorage() })
    await t.exception(() => fresh.recoverRollbacks(), { code: ERRORS.LINK_FAILED }, label)
    await t.exception(() => fresh.pendingRollbacks(), { code: ERRORS.LINK_FAILED }, label)
    await t.exception(() => requestLatest(fresh), { code: ERRORS.LINK_FAILED }, label)
    t.alike(await observe(layout, fresh), before, `${label}: nothing was touched`)
  }
  for (const [label, build] of variants) {
    const body = build()
    await fs.promises.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body))
    await check(label)
  }

  // A journal for another name copied under this one is foreign; a link or directory is no file.
  const other = journalFile(layout, 'other')
  await fs.promises.writeFile(other, JSON.stringify({ ...valid, name: 'other' }))
  await fs.promises.rm(file)
  await fs.promises.writeFile(file, await fs.promises.readFile(other))
  await check('a journal copied from another name')
  await fs.promises.rm(file)
  await fs.promises.rm(other)
  await fs.promises.writeFile(path.join(layout.root, 'real.json'), JSON.stringify(valid))
  await fs.promises.symlink(path.join(layout.root, 'real.json'), file)
  await check('a symlinked journal')
  await fs.promises.rm(file)
  await fs.promises.mkdir(file)
  await check('a directory in place of the journal')
})
