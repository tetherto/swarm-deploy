/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import fs from '#fs'
import os from '#os'
import { nativeOpenFlag, safeOpenFlags } from '../../dist/open-flags.js'

/**
 * What the platform headers say, written out here independently of the table under test: the
 * flags a runtime without `O_EXCL` and `O_NOFOLLOW` in its `fs.constants` (Bare) must supply.
 */
const ABI = [
  { platform: 'darwin', arch: 'arm64', noFollow: 0x100, create: 0x200, exclusive: 0x800 },
  { platform: 'darwin', arch: 'x64', noFollow: 0x100, create: 0x200, exclusive: 0x800 },
  { platform: 'linux', arch: 'x64', noFollow: 0x20000, create: 0x40, exclusive: 0x80 },
  { platform: 'linux', arch: 'ia32', noFollow: 0x20000, create: 0x40, exclusive: 0x80 },
  { platform: 'linux', arch: 'arm64', noFollow: 0x8000, create: 0x40, exclusive: 0x80 },
  { platform: 'linux', arch: 'arm', noFollow: 0x8000, create: 0x40, exclusive: 0x80 }
] as const

test('every supported platform and architecture has its own open flag values', (t) => {
  for (const row of ABI) {
    const { platform, arch } = row
    const label = `${platform}/${arch}`
    t.is(nativeOpenFlag('O_NOFOLLOW', {}, platform, arch), row.noFollow, `${label} O_NOFOLLOW`)
    t.is(nativeOpenFlag('O_CREAT', {}, platform, arch), row.create, `${label} O_CREAT`)
    t.is(nativeOpenFlag('O_EXCL', {}, platform, arch), row.exclusive, `${label} O_EXCL`)
    t.is(safeOpenFlags('read', {}, platform, arch), row.noFollow, `${label} read`)
    t.is(safeOpenFlags('write', {}, platform, arch), 2 | row.noFollow, `${label} write`)
    t.is(
      safeOpenFlags('create', {}, platform, arch),
      1 | row.create | row.exclusive | row.noFollow,
      `${label} create`
    )
  }
  // The two values that were wrong, stated plainly.
  t.is(nativeOpenFlag('O_NOFOLLOW', {}, 'linux', 'arm64'), 32768, 'ARM Linux: 0x8000')
  t.not(
    nativeOpenFlag('O_NOFOLLOW', {}, 'linux', 'arm64'),
    nativeOpenFlag('O_NOFOLLOW', {}, 'linux', 'x64'),
    'ARM Linux does not use the x86 value, which there is O_LARGEFILE and follows a symlink'
  )
  t.is(nativeOpenFlag('O_EXCL', {}, 'darwin', 'arm64'), 2048, 'Darwin: 0x800')
  t.not(
    nativeOpenFlag('O_EXCL', {}, 'darwin', 'arm64'),
    nativeOpenFlag('O_EXCL', {}, 'linux', 'arm64'),
    'Darwin does not use the Linux value, which there is O_FSYNC and not exclusive'
  )
})

test('the runtime provides the flags where it can, and only what it provides counts', (t) => {
  const provided = { O_WRONLY: 1, O_CREAT: 0x11, O_EXCL: 0x22, O_NOFOLLOW: 0x44 }
  t.is(
    safeOpenFlags('create', provided, 'win32', 'x64'),
    1 | 0x11 | 0x22 | 0x44,
    'provided constants need no table, on any platform'
  )
  t.is(
    nativeOpenFlag('O_NOFOLLOW', { O_NOFOLLOW: 0x4242 }, 'linux', 'arm64'),
    0x4242,
    'a provided value wins over the table'
  )
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '256', null, {}]) {
    const label = `a provided ${String(bad)} is not trusted`
    t.is(nativeOpenFlag('O_NOFOLLOW', { O_NOFOLLOW: bad }, 'win32', 'x64'), undefined, label)
    t.is(
      nativeOpenFlag('O_NOFOLLOW', { O_NOFOLLOW: bad }, 'linux', 'arm64'),
      0x8000,
      `${label}: the table answers instead`
    )
  }
})

test('an unknown platform or architecture is refused, never guessed', (t) => {
  const unknown = [
    ['linux', 'mips'],
    ['linux', 'ppc64'],
    ['linux', 'riscv64'],
    ['linux', 'toString'],
    ['android', 'arm64'],
    ['freebsd', 'x64'],
    ['win32', 'x64']
  ] as const
  for (const [platform, arch] of unknown) {
    const label = `${platform}/${arch}`
    for (const name of ['O_CREAT', 'O_EXCL', 'O_NOFOLLOW'] as const) {
      t.is(nativeOpenFlag(name, {}, platform, arch), undefined, `${label} ${name}`)
    }
    for (const access of ['read', 'write', 'create'] as const) {
      t.is(safeOpenFlags(access, {}, platform, arch), undefined, `${label} ${access}`)
    }
  }
  // A runtime that provides some of the flags makes an unknown platform usable only for those.
  t.is(safeOpenFlags('read', { O_NOFOLLOW: 0x8000 }, 'linux', 'mips'), 0x8000)
  t.is(safeOpenFlags('create', { O_CREAT: 0x100, O_NOFOLLOW: 0x20000 }, 'linux', 'mips'), undefined)
})

test('the table agrees with the runtime constants wherever the runtime provides them', (t) => {
  const platform = os.platform()
  const arch = os.arch()
  let compared = 0
  for (const name of ['O_CREAT', 'O_EXCL', 'O_NOFOLLOW'] as const) {
    const real: unknown = fs.constants[name]
    const row = nativeOpenFlag(name, {}, platform, arch)
    if (typeof real !== 'number' || row === undefined) continue
    t.is(row, real, `${name} on ${platform}/${arch}`)
    compared++
  }
  if (compared === 0) t.pass(`nothing to compare on ${platform}/${arch}`)
})
