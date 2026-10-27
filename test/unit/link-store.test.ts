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
