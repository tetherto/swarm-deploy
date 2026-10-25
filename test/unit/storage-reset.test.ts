/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test, { type Assert } from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import process from '#process'
import { main, USAGE } from '../../dist/cli.js'
import { Client, ERRORS, Server, keyPairFromSeed, type SymlinkRule } from '../../dist/index.js'
import {
  acquireStorageLock,
  assertNoPendingStorageReset,
  initLayout
} from '../../dist/storage/layout.js'
import { inspectStorageReset, resetStorage } from '../../dist/storage/reset.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage, type StorageOperationName } from '../helpers/storage.js'
import { createLocalTestnet } from '../helpers/testnet.js'

type CliIo = NonNullable<Parameters<typeof main>[2]>

const ID_A = 'a1'.repeat(32)
const ID_B = 'b2'.repeat(32)
const ID_C = 'c3'.repeat(32)
const TOKEN = 'd4'.repeat(32)
const MUTATIONS = new Set<StorageOperationName>([
  'mkdir',
  'writeFile',
  'rename',
  'link',
  'symlink',
  'unlink',
  'rmdir',
  'rm',
  'write',
  'sync',
  'truncate',
  'chmod'
])

/** The documented lock digest: SHA-256 over each sorted name followed by a newline. */
function digestOf(names: string[]): string {
  const text = [...names]
    .sort()
    .map((name) => `${name}\n`)
    .join('')
  return b4a.toString(sodiumSha256(b4a.from(text)), 'hex')
}

function lockSummary(names: string[]): { count: number; sha256: string } {
  return { count: names.length, sha256: digestOf(names) }
}

function output() {
  let text = ''
  return {
    stream: {
      write(value: string) {
        text += value
      }
    },
    text: () => text
  }
}

function commitRecord(transferId: string, name: string, size: number): string {
  return JSON.stringify({
    version: 1,
    name,
    size,
    sha256: '00'.repeat(32),
    committedAt: 1,
    uploaderFingerprint: '11'.repeat(32),
    transferId
  })
}

function lockOwner(pid: number, startedAt: number, token = TOKEN): string {
  return JSON.stringify({ pid, startedAt, token })
}

async function writeLock(layout: StorageLayout, body: string): Promise<void> {
  await fs.promises.mkdir(layout.lock, { mode: 0o700 })
  await fs.promises.writeFile(path.join(layout.lock, 'owner.json'), body)
}

/** A root with one record per metadata class, as left behind by a deleted payload. */
async function seedStorage(t: Assert): Promise<{ root: string; layout: StorageLayout }> {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const write = (target: string, body: string) => fs.promises.writeFile(target, body)
  await write(path.join(root, 'kept.txt'), 'kept payload')
  await write(path.join(root, 'notes.md'), 'operator notes')
  await fs.promises.symlink('kept.txt', path.join(root, 'current'))
  await write(path.join(layout.commits, `${ID_A}.json`), commitRecord(ID_A, 'kept.txt', 12))
  await write(path.join(layout.commits, `${ID_B}.json`), commitRecord(ID_B, 'deleted.txt', 7))
  await write(path.join(layout.sessions, `${ID_C}.json`), '{"version":3}')
  await write(path.join(layout.staging, `${ID_C}.tar.part`), 'partial')
  await write(path.join(layout.journals, `${ID_B}.json`), '{"version":1}')
  await write(path.join(layout.publications, `${ID_B}.part`), 'publication')
  await write(
    path.join(layout.links, `${ID_A}.json`),
    JSON.stringify({
      version: 2,
      mode: 'manual',
      name: 'current',
      target: 'kept.txt',
      transferId: ID_A,
      targetKind: 'file'
    })
  )
  await fs.promises.mkdir(path.join(layout.trash, `${ID_C}.tree`))
  await write(path.join(layout.trash, `${ID_C}.tree`, 'leftover.bin'), 'trash')
  await fs.promises.mkdir(`${layout.lock}.retired-${TOKEN}`)
  await write(`${layout.lock}.retired-${TOKEN}/owner.json`, lockOwner(1, 1))
  await write(path.join(layout.internal, 'README-notes.txt'), 'unrelated operator file')
  return { root, layout }
}

async function snapshot(directory: string, base = directory): Promise<string[]> {
  const lines: string[] = []
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    const full = path.join(directory, name)
    const stat = await fs.promises.lstat(full)
    const relative = full.slice(base.length + 1)
    if (stat.isSymbolicLink()) lines.push(`${relative} -> ${await fs.promises.readlink(full)}`)
    else if (stat.isDirectory()) {
      lines.push(`${relative}/`)
      lines.push(...(await snapshot(full, base)))
    } else lines.push(`${relative} ${stat.size}`)
  }
  return lines
}

function recordingStorage() {
  const mutations: string[] = []
  const storage = createStorage({
    beforeOperation(name, target, ...rest) {
      const creating =
        name === 'open' &&
        (typeof rest[0] === 'string'
          ? rest[0].includes('w') || rest[0].includes('x') || rest[0].includes('a')
          : ((rest[0] as number) & (fs.constants.O_CREAT ?? 0o100)) !== 0)
      if (MUTATIONS.has(name) || creating) mutations.push(`${name} ${target}`)
    }
  })
  return { storage, mutations }
}

async function runReset(args: string[], io: Partial<CliIo> = {}) {
  const stdout = output()
  const stderr = output()
  const code = await main(
    ['reset-storage', ...args],
    {},
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      ...io
    }
  )
  return {
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
    lines: stdout
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
  }
}

function has(lines: string[], expected: string): boolean {
  return lines.includes(expected)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target)
    return true
  } catch {
    return false
  }
}

async function readMarker(archive: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.promises.readFile(path.join(archive, 'reset.json'), 'utf8'))
}

function archivePath(lines: string[]): string {
  const line = lines.find((candidate) => candidate.startsWith('archive: '))
  if (!line) throw new Error('archive line missing')
  return line.slice('archive: '.length)
}

test('reset-storage preview reports metadata left behind by a manual payload deletion without mutating storage', async (t) => {
  const { root } = await seedStorage(t)
  const before = await snapshot(root)
  const { storage, mutations } = recordingStorage()

  const result = await runReset(['--storage', root], { storage })
  t.is(result.code, 0)
  t.is(result.stderr, '')
  t.alike(result.lines, [
    `storage: ${root}`,
    'lock: free',
    'commits: 2 records (1 missing payloads)',
    'staging: 1 entries',
    'sessions: 1 entries',
    'journals: 1 entries',
    'publications: 1 entries',
    'links: 1 records',
    'trash: 1 entries',
    'obsolete locks: 1',
    'archives: 0',
    'unknown internal entries: 1 (README-notes.txt); left in place',
    'remaining payloads: 2 (kept.txt, notes.md)',
    'remaining symlinks: 1 (current)',
    'fresh start: no',
    'note: remaining payloads keep their names occupied; uploading the same name returns FILE_EXISTS until you remove them manually',
    'note: remaining symlinks have no ownership record after the reset; a --symlink rule or link request for that name fails closed with LINK_CONFLICT until you remove them manually',
    'result: preview only, nothing changed; re-run with --apply to archive this metadata'
  ])
  t.alike(mutations, [], 'preview performs no mutating storage operation')
  t.alike(await snapshot(root), before)

  const report = await inspectStorageReset({ storageDir: root })
  t.alike(report.commits.missingPayloads, ['deleted.txt'])
  t.is(report.applied, false)
  t.is(report.archive, null)
})

test('reset-storage --apply archives every metadata class, recreates empty directories, and preserves unrelated files and earlier archives', async (t) => {
  const { root, layout } = await seedStorage(t)
  const earlier = path.join(layout.internal, 'archive', 'reset-19700101T000000000Z-00000000')
  await fs.promises.mkdir(earlier, { recursive: true })
  await fs.promises.writeFile(
    path.join(earlier, 'reset.json'),
    JSON.stringify({ version: 1, status: 'completed', moved: ['commits'] })
  )
  await fs.promises.mkdir(path.join(earlier, 'commits'))
  await fs.promises.writeFile(path.join(earlier, 'commits', 'old.json'), '{}')
  const earlierBefore = await snapshot(earlier)
  const visibleBefore = (await snapshot(root)).filter((line) => !line.startsWith('.swarm-deploy'))

  const result = await runReset(['--storage', root, '--apply'])
  t.is(result.code, 0, result.stderr)
  const archive = archivePath(result.lines)
  t.ok(archive.startsWith(path.join(layout.internal, 'archive', 'reset-')))
  t.ok(has(result.lines, 'commits: 2 records (1 missing payloads)'))
  t.ok(has(result.lines, 'archives: 2'))
  t.ok(has(result.lines, 'fresh start: no'))
  t.ok(
    has(result.lines, 'result: metadata archived; the next server start begins with empty metadata')
  )

  for (const name of [
    'staging',
    'sessions',
    'commits',
    'journals',
    'publications',
    'links',
    'trash'
  ] as const) {
    t.alike(await fs.promises.readdir(layout[name]), [], `${name} is empty`)
  }
  t.alike(await snapshot(archive), [
    'commits/',
    `commits/${ID_A}.json ${commitRecord(ID_A, 'kept.txt', 12).length}`,
    `commits/${ID_B}.json ${commitRecord(ID_B, 'deleted.txt', 7).length}`,
    'journals/',
    `journals/${ID_B}.json 13`,
    'links/',
    `links/${ID_A}.json ${(await fs.promises.readFile(path.join(archive, 'links', `${ID_A}.json`))).byteLength}`,
    'locks/',
    `locks/lock.retired-${TOKEN}/`,
    `locks/lock.retired-${TOKEN}/owner.json ${lockOwner(1, 1).length}`,
    'publications/',
    `publications/${ID_B}.part 11`,
    `reset.json ${(await fs.promises.lstat(path.join(archive, 'reset.json'))).size}`,
    'sessions/',
    `sessions/${ID_C}.json 13`,
    'staging/',
    `staging/${ID_C}.tar.part 7`,
    'trash/',
    `trash/${ID_C}.tree/`,
    `trash/${ID_C}.tree/leftover.bin 5`
  ])
  const marker = await readMarker(archive)
  t.is(marker.status, 'completed')
  t.is(marker.root, root)
  t.is(marker.version, 2)
  t.alike(marker.moved, [
    'staging',
    'sessions',
    'commits',
    'journals',
    'publications',
    'links',
    'trash'
  ])
  t.alike(marker.locks, lockSummary([`lock.retired-${TOKEN}`]))
  t.is(
    await fs.promises.readFile(path.join(layout.internal, 'README-notes.txt'), 'utf8'),
    'unrelated operator file'
  )
  t.alike(await snapshot(earlier), earlierBefore, 'earlier archive is untouched')
  t.alike(
    (await snapshot(root)).filter((line) => !line.startsWith('.swarm-deploy')),
    visibleBefore,
    'visible payloads and symlinks are untouched'
  )
  const internal = await fs.promises.readdir(layout.internal)
  t.absent(internal.includes('lock'), 'the reset released its lock')
  t.absent(
    internal.some((name) => name.startsWith('lock.')),
    'the reset leaves no lock residue of its own'
  )

  const preview = await runReset(['--storage', root])
  t.is(preview.code, 0)
  t.ok(has(preview.lines, 'commits: 0 records'))
  t.ok(has(preview.lines, 'obsolete locks: 0'))
  t.ok(has(preview.lines, 'archives: 2'))
})

test('repeated resets each create a new archive and keep every previous one', async (t) => {
  const { root, layout } = await seedStorage(t)
  const first = await runReset(['--storage', root, '--apply'])
  t.is(first.code, 0, first.stderr)
  const firstArchive = archivePath(first.lines)
  const firstSnapshot = await snapshot(firstArchive)

  await fs.promises.writeFile(path.join(layout.commits, `${ID_C}.json`), commitRecord(ID_C, 'x', 1))
  const second = await runReset(['--storage', root, '--apply'])
  t.is(second.code, 0, second.stderr)
  const secondArchive = archivePath(second.lines)
  t.not(secondArchive, firstArchive)
  t.ok(has(second.lines, 'commits: 1 records (1 missing payloads)'))
  t.ok(has(second.lines, 'archives: 2'))
  t.alike(await snapshot(firstArchive), firstSnapshot, 'first archive is preserved')
  t.ok(await exists(path.join(secondArchive, 'commits', `${ID_C}.json`)))
  t.is((await readMarker(secondArchive)).status, 'completed')
  t.alike(await fs.promises.readdir(layout.commits), [])
})

test('reset-storage refuses a live lock without mutation and completes with --wait once the holder releases', async (t) => {
  const { root, layout } = await seedStorage(t)
  const release = await acquireStorageLock(layout)
  const before = await snapshot(root)

  const preview = await runReset(['--storage', root])
  t.is(preview.code, 0)
  t.ok(
    preview.lines.some((line) => line.startsWith(`lock: held by pid ${process.pid} (lock age `)),
    preview.stdout
  )

  const { storage, mutations } = recordingStorage()
  const refused = await runReset(['--storage', root, '--apply'], { storage })
  t.is(refused.code, 1)
  t.ok(
    refused.stderr.startsWith(`Storage is locked by pid ${process.pid} (lock age `),
    refused.stderr
  )
  t.ok(refused.stderr.includes('stop that server and retry, or wait for it with --wait'))
  t.alike(mutations, [], 'a refused reset never mutates storage')
  t.alike(await snapshot(root), before)

  const waiting = runReset(['--storage', root, '--apply', '--wait', '10000'], {
    pollInterval: 10
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  t.ok(await exists(layout.lock), 'the reset keeps waiting while the lock is held')
  await release()
  const completed = await waiting
  t.is(completed.code, 0, completed.stderr)
  t.ok(has(completed.lines, `lock: held by pid ${process.pid} (lock age 0s)`))
  t.is((await readMarker(archivePath(completed.lines))).status, 'completed')
  t.absent(await exists(layout.lock))

  const timedOut = await (async () => {
    const again = await acquireStorageLock(layout)
    t.teardown(() => again())
    return runReset(['--storage', root, '--apply', '--wait', '30'], { pollInterval: 10 })
  })()
  t.is(timedOut.code, 1)
  t.ok(timedOut.stderr.startsWith('Storage is locked by pid'))
})

test('reset-storage retires dead holders and refuses live or unreadable locks without an override', async (t) => {
  const { root, layout } = await seedStorage(t)
  const dead = 4_000_000
  const deadToken = 'f6'.repeat(32)
  await writeLock(layout, lockOwner(dead, Date.now() - 60_000, deadToken))
  const isProcessAlive = (pid: number) => pid !== dead

  const preview = await runReset(['--storage', root], { isProcessAlive })
  t.is(preview.code, 0)
  t.ok(
    preview.lines.some((line) =>
      /^lock: stale, pid 4000000 is not running \(lock age (59|60|61)s\); will be retired$/.test(
        line
      )
    ),
    preview.stdout
  )

  const retired = await runReset(['--storage', root, '--apply'], { isProcessAlive })
  t.is(retired.code, 0, retired.stderr)
  const archive = archivePath(retired.lines)
  t.alike(
    (await fs.promises.readdir(path.join(archive, 'locks'))).sort(),
    [`lock.retired-${TOKEN}`, `lock.retired-${deadToken}`].sort(),
    'the dead holder lock is retired and archived with the older residue'
  )
  t.absent(await exists(layout.lock))

  // A reused PID: the recorded PID is alive (this process) but is not a server for this root.
  await writeLock(layout, lockOwner(process.pid, Date.now(), 'e5'.repeat(32)))
  const reused = await runReset(['--storage', root, '--apply'])
  t.is(reused.code, 1)
  t.ok(reused.stderr.startsWith(`Storage is locked by pid ${process.pid}`), reused.stderr)
  t.ok(await exists(layout.lock), 'a live PID is never treated as stale by itself')

  const beforeOverride = await snapshot(root)
  const asserted = await runReset([
    '--storage',
    root,
    '--apply',
    '--stale-pid',
    String(process.pid)
  ])
  t.is(asserted.code, 2)
  t.alike(await snapshot(root), beforeOverride, 'no option bypasses a live lock')

  await fs.promises.rm(layout.lock, { recursive: true })
  await writeLock(layout, '{not json')
  await fs.promises.rm(layout.sessions, { recursive: true })
  const beforeMalformed = await snapshot(root)
  const malformed = await runReset(['--storage', root])
  t.is(malformed.code, 0)
  t.ok(
    has(
      malformed.lines,
      'lock: unreadable; reset refused until the server is stopped and its lock reconciled'
    )
  )
  const refused = await runReset(['--storage', root, '--apply'])
  t.is(refused.code, 1)
  t.ok(refused.stderr.includes('Storage lock is unreadable'))
  t.alike(await snapshot(root), beforeMalformed, 'unreadable ownership never permits mutations')
})

test('reset-storage rejects unsafe roots and symlink escapes before touching anything', async (t) => {
  const scratch = await createTempDir(t)

  const missing = path.join(scratch, 'missing')
  for (const args of [[], ['--apply']]) {
    const result = await runReset(['--storage', missing, ...args])
    t.is(result.code, 2)
    t.ok(result.stderr.startsWith('Missing storage directory'), result.stderr)
    t.absent(await exists(missing), 'a missing root is never created')
  }

  const plain = path.join(scratch, 'plain')
  await fs.promises.mkdir(plain)
  const uninitialized = await runReset(['--storage', plain, '--apply'])
  t.is(uninitialized.code, 2)
  t.is(uninitialized.stderr, `Not an initialized storage root: ${plain}\n`)
  t.alike(await fs.promises.readdir(plain), [], 'no internal directory is created')

  const filesystemRoot = await runReset(['--storage', '/', '--apply'])
  t.is(filesystemRoot.code, 2)
  t.is(filesystemRoot.stderr, 'Refusing to reset a filesystem root: /\n')

  const { root, layout } = await seedStorage(t)
  const before = await snapshot(root)
  const rootLink = path.join(scratch, 'root-link')
  await fs.promises.symlink(root, rootLink)
  const viaRootLink = await runReset(['--storage', rootLink, '--apply'])
  t.is(viaRootLink.code, 2)
  t.ok(viaRootLink.stderr.startsWith('Unsafe storage directory'), viaRootLink.stderr)
  t.alike(await snapshot(root), before)

  const parentLink = path.join(scratch, 'parent-link')
  await fs.promises.symlink(path.dirname(root), parentLink)
  const viaAncestor = await runReset([
    '--storage',
    path.join(parentLink, path.basename(root)),
    '--apply'
  ])
  t.is(viaAncestor.code, 2)
  t.alike(await snapshot(root), before, 'symlink ancestors cannot redirect a reset')

  const internalAsName = await runReset(['--storage', layout.internal, '--apply'])
  t.is(internalAsName.code, 2)
  t.ok(internalAsName.stderr.startsWith('Refusing to reset an internal directory'))
  t.alike(await snapshot(root), before)

  const escaped = path.join(scratch, 'escaped')
  await fs.promises.mkdir(escaped)
  await fs.promises.writeFile(path.join(escaped, 'precious.json'), 'outside')
  const outsideBefore = await snapshot(escaped)
  await fs.promises.rm(layout.commits, { recursive: true })
  await fs.promises.symlink(escaped, layout.commits)
  for (const args of [[], ['--apply']]) {
    const result = await runReset(['--storage', root, ...args])
    t.is(result.code, 2)
    t.is(result.stderr, `Unsafe storage directory: ${layout.commits}\n`)
  }
  t.alike(await snapshot(escaped), outsideBefore, 'the symlink target is untouched')
  t.absent(await exists(path.join(layout.internal, 'archive')), 'no archive is created')
  await fs.promises.unlink(layout.commits)
  await fs.promises.mkdir(layout.commits)

  await fs.promises.symlink(escaped, layout.lock)
  const unsafeLock = await runReset(['--storage', root])
  t.is(unsafeLock.code, 0)
  t.ok(has(unsafeLock.lines, 'lock: unsafe path; the reset refuses to proceed'))
  const unsafeLockApply = await runReset(['--storage', root, '--apply'])
  t.is(unsafeLockApply.code, 2)
  t.is(unsafeLockApply.stderr, `Unsafe storage lock path: ${layout.lock}\n`)
  t.alike(await snapshot(escaped), outsideBefore)
  await fs.promises.unlink(layout.lock)

  const internalLink = path.join(scratch, 'internal-link')
  await fs.promises.mkdir(internalLink)
  await fs.promises.symlink(layout.internal, path.join(internalLink, '.swarm-deploy'))
  const viaInternalLink = await runReset(['--storage', internalLink, '--apply'])
  t.is(viaInternalLink.code, 2)
  t.ok(viaInternalLink.stderr.startsWith('Unsafe storage directory'))
  t.absent(await exists(path.join(layout.internal, 'archive')))

  for (const args of [
    ['--storage', root, '--wait', '5'],
    ['--storage', root, '--stale-pid', '5'],
    ['--storage', root, 'extra'],
    ['--apply'],
    ['--storage', root, '--apply', '--wait', '0'],
    ['--storage', root, '--apply', '--apply']
  ]) {
    const result = await runReset(args)
    t.is(result.code, 2, args.join(' '))
    t.ok(result.stderr.includes(USAGE), args.join(' '))
  }
  t.ok(USAGE.includes('swarm-deploy reset-storage --storage <dir> [--apply'))
})

test('an interrupted reset leaves a recoverable in-progress archive and a re-run completes it', async (t) => {
  const { root, layout } = await seedStorage(t)
  let tripped = false
  const storage = createStorage({
    beforeOperation(name, target) {
      if (name === 'rename' && target === layout.journals && !tripped) {
        tripped = true
        throw new Error('Injected rename failure')
      }
    }
  })

  const interrupted = await runReset(['--storage', root, '--apply'], { storage })
  t.is(interrupted.code, 1)
  t.is(interrupted.stderr, 'Injected rename failure\n')
  const archives = await fs.promises.readdir(path.join(layout.internal, 'archive'))
  t.is(archives.length, 1)
  const first = path.join(layout.internal, 'archive', archives[0])
  const marker = await readMarker(first)
  t.is(marker.status, 'in-progress')
  t.alike(marker.moved, ['staging', 'sessions', 'commits'])
  t.alike(marker.locks, lockSummary([]))
  t.is((marker.attempts as Array<{ failed?: string }>)[0]?.failed, 'Injected rename failure')
  t.ok(await exists(path.join(first, 'commits', `${ID_A}.json`)))
  t.alike(await fs.promises.readdir(layout.commits), [], 'moved directories are recreated empty')
  t.alike(await fs.promises.readdir(layout.journals), [`${ID_B}.json`], 'unmoved metadata stays')
  t.alike(await fs.promises.readdir(layout.links), [`${ID_A}.json`])
  t.absent(await exists(layout.lock), 'the lock is released after a failure')
  t.ok(
    await exists(path.join(layout.internal, 'reset-pending.json')),
    'startup stays blocked after interruption'
  )

  const preview = await runReset(['--storage', root])
  t.is(preview.code, 0)
  t.ok(has(preview.lines, 'archives: 1 (1 interrupted)'))
  t.ok(
    has(
      preview.lines,
      `reset pending: yes (resumes archive ${archives[0]}); server startup is blocked until reset-storage --apply finishes`
    )
  )
  t.ok(has(preview.lines, `interrupted archive: ${archives[0]} holds staging, sessions, commits`))
  t.ok(has(preview.lines, 'commits: 0 records'))
  t.ok(has(preview.lines, 'journals: 1 entries'))

  const firstBefore = await snapshot(first)
  const completed = await runReset(['--storage', root, '--apply'], { storage })
  t.is(completed.code, 0, completed.stderr)
  t.is(archivePath(completed.lines), first, 'the retry resumes the interrupted archive')
  t.ok(
    has(
      completed.lines,
      'resumed: yes; the interrupted archive already held staging, sessions, commits'
    )
  )
  t.alike(await fs.promises.readdir(path.join(layout.internal, 'archive')), archives)
  const finished = await readMarker(first)
  t.is(finished.status, 'completed')
  t.absent('failed' in finished, 'no failure is recorded beside the attempts')
  t.alike(finished.moved, [
    'staging',
    'sessions',
    'commits',
    'journals',
    'publications',
    'links',
    'trash'
  ])
  t.alike(finished.locks, lockSummary([`lock.retired-${TOKEN}`]))
  const attempts = (finished.attempts ?? []) as Array<{ pid: number; failed?: string }>
  t.is(attempts.length, 2, 'every attempt is recorded in the one archive')
  t.is(finished.attemptCount, 2)
  t.is(attempts[0]?.failed, 'Injected rename failure')
  t.is(attempts[1]?.failed, undefined)
  t.ok(await exists(path.join(first, 'journals', `${ID_B}.json`)))
  t.ok(await exists(path.join(first, 'links', `${ID_A}.json`)))
  for (const line of firstBefore.filter((entry) => !entry.startsWith('reset.json'))) {
    t.ok((await snapshot(first)).includes(line), `${line} is still archived`)
  }
  t.ok(has(completed.lines, 'archives: 1'))
  t.absent(
    await exists(path.join(layout.internal, 'reset-pending.json')),
    'successful retry clears the startup guard'
  )

  // A server starts on the reset root even with the interrupted archive present.
  await fs.promises.rm(layout.sessions, { recursive: true })
  const testnet = await createLocalTestnet(t)
  const server = new Server({
    seed: b4a.alloc(32, 41),
    storageDir: root,
    allowedKeys: [keyPairFromSeed(b4a.alloc(32, 42)).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  await server.listen()
  t.ok(await exists(layout.sessions), 'the server recreates a directory a crash left missing')
  await server.close()
})

const METADATA = [
  'staging',
  'sessions',
  'commits',
  'journals',
  'publications',
  'links',
  'trash'
] as const

test('a retry after a hard stop resumes the pending archive, and that one archive restores the whole reset', async (t) => {
  const { root, layout } = await seedStorage(t)
  const original: Record<string, string[]> = {}
  for (const name of METADATA) original[name] = await snapshot(layout[name])
  const visibleBefore = (await snapshot(root)).filter((line) => !line.startsWith('.swarm-deploy'))

  // The state of a process killed mid-reset before any error handling ran:
  // staging and sessions are already inside the archive, staging was recreated
  // but sessions was not, the marker still says nothing moved, and the dead
  // process never released its lock.
  const dead = 4_000_001
  const deadToken = 'f7'.repeat(32)
  const archiveId = 'reset-20260101T000000000Z-0badc0de'
  const archive = path.join(layout.internal, 'archive', archiveId)
  await fs.promises.mkdir(archive, { recursive: true })
  await fs.promises.rename(layout.staging, path.join(archive, 'staging'))
  await fs.promises.rename(layout.sessions, path.join(archive, 'sessions'))
  await fs.promises.mkdir(layout.staging)
  const legacyMarker = JSON.stringify({
    version: 1,
    status: 'in-progress',
    root,
    startedAt: 1,
    pid: dead,
    moved: []
  })
  await fs.promises.writeFile(path.join(archive, 'reset.json'), legacyMarker)
  await fs.promises.writeFile(
    path.join(layout.internal, 'reset-pending.json'),
    JSON.stringify({ kind: 'storage-reset', version: 1, archive: archiveId })
  )
  await writeLock(layout, lockOwner(dead, Date.now() - 5_000, deadToken))
  const isProcessAlive = (pid: number) => pid !== dead

  const preview = await runReset(['--storage', root], { isProcessAlive })
  t.is(preview.code, 0, preview.stderr)
  t.ok(
    has(
      preview.lines,
      `reset pending: yes (resumes archive ${archiveId}); server startup is blocked until reset-storage --apply finishes`
    )
  )
  t.ok(has(preview.lines, `interrupted archive: ${archiveId} holds staging, sessions`))
  t.ok(has(preview.lines, 'archives: 1 (1 interrupted)'))
  t.ok(preview.lines.some((line) => line.startsWith(`lock: stale, pid ${dead} is not running`)))
  await t.exception(() => assertNoPendingStorageReset(layout), { code: ERRORS.PROTOCOL_INVALID })

  const retry = await runReset(['--storage', root, '--apply'], { isProcessAlive })
  t.is(retry.code, 0, retry.stderr)
  t.is(archivePath(retry.lines), archive, 'the retry continues the archive that holds the data')
  t.ok(has(retry.lines, 'resumed: yes; the interrupted archive already held staging, sessions'))
  t.alike(
    await fs.promises.readdir(path.join(layout.internal, 'archive')),
    [archiveId],
    'no second archive is created'
  )
  t.ok(has(retry.lines, 'archives: 1'))

  const marker = await readMarker(archive)
  t.is(marker.status, 'completed')
  t.is(marker.version, 2, 'the retry upgrades a version 1 marker to the bounded format')
  t.alike(
    marker.moved,
    [...METADATA],
    'the completed marker is reconciled from what the archive holds, not from the stale marker'
  )
  t.alike(marker.locks, lockSummary([`lock.retired-${TOKEN}`, `lock.retired-${deadToken}`]))
  t.is(
    await fs.promises.readFile(path.join(archive, 'reset.v1.json'), 'utf8'),
    legacyMarker,
    'the original version 1 marker is kept verbatim'
  )
  const attempts = (marker.attempts ?? []) as Array<{ pid: number }>
  t.alike(
    attempts.map((attempt) => attempt.pid),
    [dead, process.pid],
    'the interrupted attempt and the retry are linked in one marker'
  )
  for (const name of METADATA) {
    t.alike(await fs.promises.readdir(layout[name]), [], `${name} is empty after the retry`)
  }
  t.absent(await exists(path.join(layout.internal, 'reset-pending.json')))
  t.absent(await exists(layout.lock))
  await assertNoPendingStorageReset(layout)
  t.alike(
    (await snapshot(root)).filter((line) => !line.startsWith('.swarm-deploy')),
    visibleBefore,
    'visible payloads and symlinks are untouched'
  )

  // Restoring this one archive recovers every metadata class, including the
  // directories moved before the interruption.
  for (const name of METADATA) {
    const held = await exists(path.join(archive, name))
    t.ok(held, `${name} is in the archive that the pending marker names`)
    if (!held) continue
    await fs.promises.rmdir(layout[name])
    await fs.promises.rename(path.join(archive, name), layout[name])
    t.alike(await snapshot(layout[name]), original[name], `${name} is restored exactly`)
  }
  t.is(await fs.promises.readFile(path.join(layout.staging, `${ID_C}.tar.part`), 'utf8'), 'partial')
})

test('a retry after a stop between the completed marker and the guard removal finishes without a new archive', async (t) => {
  const { root, layout } = await seedStorage(t)
  const first = await runReset(['--storage', root, '--apply'])
  t.is(first.code, 0, first.stderr)
  const archive = archivePath(first.lines)
  const archiveId = path.basename(archive)
  await fs.promises.writeFile(
    path.join(layout.internal, 'reset-pending.json'),
    JSON.stringify({ kind: 'storage-reset', version: 1, archive: archiveId })
  )

  const retry = await runReset(['--storage', root, '--apply'])
  t.is(retry.code, 0, retry.stderr)
  t.is(archivePath(retry.lines), archive)
  t.ok(
    has(
      retry.lines,
      `resumed: yes; the interrupted archive already held ${[...METADATA, '1 lock residue entry'].join(', ')}`
    )
  )
  t.alike(await fs.promises.readdir(path.join(layout.internal, 'archive')), [archiveId])
  const marker = await readMarker(archive)
  t.is(marker.status, 'completed')
  t.is(((marker.attempts ?? []) as unknown[]).length, 2)
  t.is(marker.attemptCount, 2)
  t.alike(marker.locks, lockSummary([`lock.retired-${TOKEN}`]))
  t.absent(await exists(path.join(archive, 'reset.v1.json')), 'a version 2 marker needs no copy')
  t.absent(await exists(path.join(layout.internal, 'reset-pending.json')))
  for (const name of METADATA) {
    t.alike(await fs.promises.readdir(layout[name]), [], `${name} stays empty`)
  }
  t.ok(await exists(path.join(archive, 'commits', `${ID_A}.json`)))
})

test('a resumed reset refuses conflicting live data or a missing archive without changing anything', async (t) => {
  const { root, layout } = await seedStorage(t)
  let tripped = false
  const failing = createStorage({
    beforeOperation(name, target) {
      if (name === 'rename' && target === layout.journals && !tripped) {
        tripped = true
        throw new Error('Injected rename failure')
      }
    }
  })
  t.is((await runReset(['--storage', root, '--apply'], { storage: failing })).code, 1)
  const archives = path.join(layout.internal, 'archive')
  const [archiveId] = await fs.promises.readdir(archives)

  // Live data appears in a directory the archive already holds.
  const intruder = path.join(layout.commits, 'intruder.json')
  await fs.promises.writeFile(intruder, 'new data')
  const before = await snapshot(root)
  const conflict = await runReset(['--storage', root, '--apply'])
  t.is(conflict.code, 2)
  t.is(
    conflict.stderr,
    `Reset archive ${archiveId} already holds commits but the live commits directory is not empty; reconcile the two by hand before resetting\n`
  )
  t.alike(await snapshot(root), before, 'a refused retry moves nothing')
  t.ok(await exists(path.join(layout.internal, 'reset-pending.json')))

  // The archive the pending marker names was removed by hand.
  await fs.promises.unlink(intruder)
  const scratch = await createTempDir(t)
  await fs.promises.rename(path.join(archives, archiveId), path.join(scratch, archiveId))
  const missing = await runReset(['--storage', root, '--apply'])
  t.is(missing.code, 2)
  t.ok(
    missing.stderr.startsWith(`Pending reset archive ${archiveId} is missing or unreadable;`),
    missing.stderr
  )
  t.alike(await fs.promises.readdir(archives), [], 'no replacement archive hides the missing one')
  t.alike(await fs.promises.readdir(layout.journals), [`${ID_B}.json`], 'live metadata is kept')
  t.ok(await exists(path.join(layout.internal, 'reset-pending.json')))
})

/** The size the version 1 reader allowed; the old marker outgrew it near 185 lock entries. */
const OLD_MARKER_LIMIT = 16 * 1024

function retiredName(index: number): string {
  return `lock.retired-${index.toString(16).padStart(64, '0')}`
}

/** Stopped servers leave `lock.retired-*` residue behind; this seeds `count` of it. */
async function seedRetiredLocks(layout: StorageLayout, count: number): Promise<string[]> {
  const names: string[] = []
  for (let index = 1; index <= count; index++) {
    const name = retiredName(index)
    await fs.promises.mkdir(path.join(layout.internal, name))
    await fs.promises.writeFile(path.join(layout.internal, name, 'owner.json'), lockOwner(1, 1))
    names.push(name)
  }
  return names
}

async function markerSize(archive: string): Promise<number> {
  return (await fs.promises.lstat(path.join(archive, 'reset.json'))).size
}

test('hundreds of retired locks keep the marker small, and an interrupted reset still resumes and completes', async (t) => {
  const { root, layout } = await seedStorage(t)
  const seeded = await seedRetiredLocks(layout, 300)
  const allLocks = [`lock.retired-${TOKEN}`, ...seeded]
  t.ok(allLocks.length >= 250)

  let moves = 0
  const failing = createStorage({
    beforeOperation(name, target) {
      if (
        name === 'rename' &&
        path.dirname(target) === layout.internal &&
        path.basename(target).startsWith('lock.retired-') &&
        ++moves === 220
      ) {
        throw new Error('Injected rename failure')
      }
    }
  })
  const interrupted = await runReset(['--storage', root, '--apply'], { storage: failing })
  t.is(interrupted.code, 1)
  t.is(interrupted.stderr, 'Injected rename failure\n')
  const archives = await fs.promises.readdir(path.join(layout.internal, 'archive'))
  t.is(archives.length, 1)
  const archive = path.join(layout.internal, 'archive', archives[0])
  const stopped = await readMarker(archive)
  t.is(stopped.status, 'in-progress')
  t.ok((await markerSize(archive)) < OLD_MARKER_LIMIT, 'the marker no longer grows with residue')
  t.alike(stopped.moved, [...METADATA], 'the marker names directories, never every lock')
  t.alike(
    (stopped.locks as { count: number }).count,
    219,
    'the marker count is reconciled from the archive after the failure'
  )
  t.is((await fs.promises.readdir(path.join(archive, 'locks'))).length, 219)

  const preview = await runReset(['--storage', root])
  t.is(preview.code, 0, preview.stderr)
  t.ok(has(preview.lines, 'archives: 1 (1 interrupted)'))
  t.ok(
    has(
      preview.lines,
      `interrupted archive: ${archives[0]} holds ${[...METADATA, '219 lock residue entries'].join(', ')}`
    ),
    'the preview summarizes lock residue instead of printing every name'
  )
  t.ok(has(preview.lines, 'obsolete locks: 82'))
  t.ok(
    preview.lines.every((line) => line.length < 600),
    'no report line grows with residue'
  )

  const resumed = await runReset(['--storage', root, '--apply'])
  t.is(resumed.code, 0, resumed.stderr)
  t.is(archivePath(resumed.lines), archive)
  t.ok(
    has(
      resumed.lines,
      `resumed: yes; the interrupted archive already held ${[...METADATA, '219 lock residue entries'].join(', ')}`
    )
  )
  t.alike(await fs.promises.readdir(path.join(layout.internal, 'archive')), archives)

  const archivedLocks = (await fs.promises.readdir(path.join(archive, 'locks'))).sort()
  t.alike(archivedLocks, [...allLocks].sort(), 'every retired lock is in the archive')
  const marker = await readMarker(archive)
  t.is(marker.status, 'completed')
  t.is(marker.version, 2)
  t.alike(marker.moved, [...METADATA])
  t.alike(marker.locks, lockSummary(allLocks), 'the digest covers every lock name')
  t.alike(marker.locks, lockSummary(archivedLocks), 'and matches the archive directory listing')
  t.is(marker.attemptCount, 2)
  t.ok((await markerSize(archive)) < OLD_MARKER_LIMIT)
  t.absent(
    (await fs.promises.readdir(layout.internal)).some((name) => name.startsWith('lock.')),
    'no residue is left live'
  )
  t.absent(await exists(path.join(layout.internal, 'reset-pending.json')))

  const completed = await inspectStorageReset({ storageDir: root })
  t.is(completed.archives.length, 1)
  t.is(completed.archives[0].status, 'completed', 'a completed archive is never reported unknown')
  t.alike(completed.archives[0].held.lockEntries, 301)
  const after = await runReset(['--storage', root])
  t.ok(has(after.lines, 'archives: 1'), 'the completed archive is not listed as interrupted')
  t.absent(after.lines.some((line) => line.startsWith('interrupted archive:')))
  t.ok(has(after.lines, 'obsolete locks: 0'))
})

test('the attempt history stays bounded across many failed retries and keeps the first attempt', async (t) => {
  const { root, layout } = await seedStorage(t)
  const message = `Injected failure ${'x'.repeat(2_000)}`
  let failures = 0
  const failing = createStorage({
    beforeOperation(name, target) {
      if (name === 'rename' && target === layout.journals && failures < 20) {
        failures++
        throw new Error(message)
      }
    }
  })
  let firstStartedAt = -1
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = await runReset(['--storage', root, '--apply'], { storage: failing })
    t.is(result.code, 1, `attempt ${attempt} is interrupted`)
    if (attempt === 1) {
      const [name] = await fs.promises.readdir(path.join(layout.internal, 'archive'))
      firstStartedAt = (await readMarker(path.join(layout.internal, 'archive', name)))
        .startedAt as number
    }
  }
  const [archiveId] = await fs.promises.readdir(path.join(layout.internal, 'archive'))
  const archive = path.join(layout.internal, 'archive', archiveId)
  const stopped = await readMarker(archive)
  t.is(stopped.attemptCount, 20)
  t.is((stopped.attempts as unknown[]).length, 16, 'only the newest attempts are kept')
  t.ok((await markerSize(archive)) < OLD_MARKER_LIMIT, 'long failure text cannot outgrow the bound')
  for (const attempt of stopped.attempts as Array<{ failed?: string }>) {
    t.is(attempt.failed?.length, 256, 'each failure is clipped')
    t.ok(attempt.failed?.endsWith('...'))
  }

  const done = await runReset(['--storage', root, '--apply'], { storage: failing })
  t.is(done.code, 0, done.stderr)
  t.is(archivePath(done.lines), archive)
  const marker = await readMarker(archive)
  t.is(marker.status, 'completed')
  t.is(marker.attemptCount, 21)
  const attempts = marker.attempts as Array<{ failed?: string }>
  t.is(attempts.length, 16)
  t.is(attempts.at(-1)?.failed, undefined, 'the final attempt succeeded')
  t.is(marker.startedAt, firstStartedAt, 'the first attempt stays at the top level')
  t.is(marker.pid, process.pid)
})

test('version 1 markers stay readable and are upgraded without losing their evidence', async (t) => {
  const { root, layout } = await seedStorage(t)
  const claimed = Array.from({ length: 400 }, (_, index) => `locks/${retiredName(index + 1)}`)

  // An older completed reset whose marker listed every lock and outgrew the old limit.
  const older = path.join(layout.internal, 'archive', 'reset-20250101T000000000Z-aaaaaaaa')
  await fs.promises.mkdir(older, { recursive: true })
  const olderMarker = JSON.stringify({
    version: 1,
    status: 'completed',
    root,
    startedAt: 1,
    pid: 2,
    moved: [...METADATA, ...claimed],
    completedAt: 3
  })
  t.ok(olderMarker.length > OLD_MARKER_LIMIT)
  await fs.promises.writeFile(path.join(older, 'reset.json'), olderMarker)

  // An interrupted reset from the previous format: a long list, a folded failure,
  // and a pending pointer, with only part of what it claims physically archived.
  const dead = 4_000_002
  const archiveId = 'reset-20260101T000000000Z-0badc0de'
  const archive = path.join(layout.internal, 'archive', archiveId)
  await fs.promises.mkdir(path.join(archive, 'locks', retiredName(1)), { recursive: true })
  await fs.promises.rename(layout.staging, path.join(archive, 'staging'))
  await fs.promises.mkdir(layout.staging)
  const legacy = JSON.stringify({
    version: 1,
    status: 'in-progress',
    root,
    startedAt: 5,
    pid: dead,
    attempts: [
      { startedAt: 5, pid: dead },
      { startedAt: 9, pid: dead }
    ],
    moved: ['staging', ...claimed],
    failed: 'old failure'
  })
  t.ok(legacy.length > OLD_MARKER_LIMIT)
  await fs.promises.writeFile(path.join(archive, 'reset.json'), legacy)
  await fs.promises.writeFile(
    path.join(layout.internal, 'reset-pending.json'),
    JSON.stringify({ kind: 'storage-reset', version: 1, archive: archiveId })
  )

  const preview = await runReset(['--storage', root])
  t.is(preview.code, 0, preview.stderr)
  t.ok(has(preview.lines, 'archives: 2 (1 interrupted)'), 'the large completed marker is readable')
  t.ok(
    has(preview.lines, `interrupted archive: ${archiveId} holds staging, 1 lock residue entry`),
    'held entries come from the filesystem, not from the 400 claimed in the marker'
  )

  const retry = await runReset(['--storage', root, '--apply'])
  t.is(retry.code, 0, retry.stderr)
  t.is(archivePath(retry.lines), archive)
  const marker = await readMarker(archive)
  t.is(marker.version, 2)
  t.is(marker.status, 'completed')
  t.is(marker.root, root)
  t.is(marker.startedAt, 5)
  t.is(marker.pid, dead)
  t.is(marker.attemptCount, 3)
  const attempts = marker.attempts as Array<{ pid: number; failed?: string }>
  t.alike(
    attempts.map((attempt) => attempt.failed),
    [undefined, 'old failure', undefined],
    'the version 1 failure is folded into the attempt that failed'
  )
  t.alike(marker.moved, [...METADATA])
  t.alike(marker.locks, lockSummary([retiredName(1), `lock.retired-${TOKEN}`]))
  t.ok((await markerSize(archive)) < OLD_MARKER_LIMIT)
  t.is(
    await fs.promises.readFile(path.join(archive, 'reset.v1.json'), 'utf8'),
    legacy,
    'the full original marker, including all 400 claimed entries, is kept verbatim'
  )
  t.is(await fs.promises.readFile(path.join(older, 'reset.json'), 'utf8'), olderMarker)
  t.absent(await exists(path.join(older, 'reset.v1.json')), 'completed archives are never touched')
})

test('a resumed reset refuses markers the writer never produces and changes nothing', async (t) => {
  const { root, layout } = await seedStorage(t)
  let tripped = false
  const failing = createStorage({
    beforeOperation(name, target) {
      if (name === 'rename' && target === layout.journals && !tripped) {
        tripped = true
        throw new Error('Injected rename failure')
      }
    }
  })
  t.is((await runReset(['--storage', root, '--apply'], { storage: failing })).code, 1)
  const [archiveId] = await fs.promises.readdir(path.join(layout.internal, 'archive'))
  const markerPath = path.join(layout.internal, 'archive', archiveId, 'reset.json')
  const valid = JSON.parse(await fs.promises.readFile(markerPath, 'utf8')) as Record<
    string,
    unknown
  >
  const variants: Array<[string, Record<string, unknown>]> = [
    ['an unknown version', { ...valid, version: 3 }],
    ['an unknown status', { ...valid, status: 'done' }],
    ['a non-string root', { ...valid, root: 7 }],
    ['an empty attempt list', { ...valid, attempts: [] }],
    ['a non-object attempt', { ...valid, attempts: ['x'] }],
    ['an attempt without a PID', { ...valid, attempts: [{ startedAt: 1 }] }],
    ['a count below the attempts kept', { ...valid, attemptCount: 0 }],
    ['a fractional count', { ...valid, attemptCount: 1.5 }]
  ]
  for (const [label, marker] of variants) {
    await fs.promises.writeFile(markerPath, JSON.stringify(marker))
    const before = await snapshot(root)
    const refused = await runReset(['--storage', root, '--apply'])
    t.is(refused.code, 2, label)
    t.is(
      refused.stderr,
      `Pending reset archive ${archiveId} has an unrecognized marker; reconcile it before resetting\n`,
      label
    )
    t.alike(await snapshot(root), before, `${label} moves nothing`)
  }

  // A marker this tool wrote always reads back: restoring it lets the retry finish.
  await fs.promises.writeFile(markerPath, JSON.stringify(valid))
  const retry = await runReset(['--storage', root, '--apply'])
  t.is(retry.code, 0, retry.stderr)
})

test('a reset after manual payload deletion unblocks a fresh re-upload and link, while retained payloads and symlinks still conflict', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 151)
  const clientSeed = b4a.alloc(32, 152)
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const inputs = await createTempDir(t)
  const release = path.join(inputs, 'release-1')
  await fs.promises.writeFile(release, 'release one')
  const failures: string[] = []
  const createServer = (symlinks: SymlinkRule[] = [{ selector: '/^release-\\d+$/' }]) => {
    const server = new Server({
      seed: serverSeed,
      storageDir: root,
      allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
      maxFileBytes: 1024,
      maxStagingBytes: 4096,
      minFreeBytes: 0,
      dht: testnet.createNode(),
      symlinks
    })
    server.on('failure', (event) => failures.push(event.reason))
    return server
  }
  // A post-commit link conflict is reported on the server; the client only
  // learns that its upload did not finish cleanly.
  const expectLinkConflict = async (): Promise<void> => {
    failures.length = 0
    await t.exception(() => client.upload(release))
    t.alike(failures, [ERRORS.LINK_CONFLICT])
  }
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: keyPairFromSeed(serverSeed).publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  t.teardown(() => client.close())

  const first = createServer()
  await first.listen()
  t.is((await client.upload(release)).status, 'COMMITTED')
  t.is((await client.link('release-1', 'current')).status, 'LINKED')
  await first.close()

  // The operator deletes the payload by hand. The commit record, the manual
  // link ledger entry, and the now-dangling symlink all remain.
  await fs.promises.unlink(path.join(root, 'release-1'))
  const dangling = await runReset(['--storage', root])
  t.is(dangling.code, 0)
  t.ok(has(dangling.lines, 'commits: 1 records (1 missing payloads)'))
  t.ok(has(dangling.lines, 'links: 1 records'))
  t.ok(has(dangling.lines, 'remaining payloads: 0'))
  t.ok(has(dangling.lines, 'remaining symlinks: 1 (current)'))
  t.ok(has(dangling.lines, 'fresh start: no'))

  // Without a reset, the stale manual ledger entry blocks a server that now
  // wants `current` as an automatic link: the upload commits, then fails.
  const automatic = createServer([{ selector: '/^release-\\d+$/', name: 'current' }])
  await automatic.listen()
  await expectLinkConflict()
  await automatic.close()
  t.ok(await exists(path.join(root, 'release-1')), 'the blocked upload still committed')

  // A reset archives the ledger, but the committed payload and the dangling
  // symlink remain, and the report says so.
  const reset = await resetStorage({ storageDir: root })
  t.is(reset.applied, true)
  t.is(reset.freshStart, false)
  t.alike(reset.remaining.payloads, ['release-1'])
  t.alike(reset.remaining.symlinks, ['current'])
  t.is(reset.links.records, 1)

  // The retained payload keeps its name occupied for a fresh upload.
  const retained = createServer()
  await retained.listen()
  await t.exception(() => client.upload(release), { code: ERRORS.FILE_EXISTS })
  await retained.close()

  // With the payload removed by hand but the symlink kept, the name is free
  // again, while the unrecorded symlink still blocks the automatic link.
  await fs.promises.unlink(path.join(root, 'release-1'))
  const partial = await runReset(['--storage', root, '--apply'])
  t.is(partial.code, 0, partial.stderr)
  t.ok(has(partial.lines, 'remaining payloads: 0'))
  t.ok(has(partial.lines, 'remaining symlinks: 1 (current)'))
  t.ok(has(partial.lines, 'fresh start: no'))
  const unrecorded = createServer([{ selector: '/^release-\\d+$/', name: 'current' }])
  await unrecorded.listen()
  await expectLinkConflict()
  await unrecorded.close()

  // Removing every visible entry by hand makes the next reset a true fresh start.
  await fs.promises.unlink(path.join(root, 'release-1'))
  await fs.promises.unlink(path.join(root, 'current'))
  const fresh = await runReset(['--storage', root, '--apply'])
  t.is(fresh.code, 0, fresh.stderr)
  t.ok(has(fresh.lines, 'remaining payloads: 0'))
  t.ok(has(fresh.lines, 'remaining symlinks: 0'))
  t.ok(has(fresh.lines, 'fresh start: yes'))
  t.absent(fresh.lines.some((line) => line.startsWith('note:')))
  const last = createServer([
    { selector: '/^release-\\d+$/', name: 'current' },
    { selector: '/^release-\\d+$/' }
  ])
  t.teardown(() => last.close())
  await last.listen()
  t.is((await client.upload(release)).status, 'COMMITTED')
  t.is(await fs.promises.readlink(path.join(root, 'current')), 'release-1')
  t.is((await client.link('release-1', 'promoted')).status, 'LINKED')
  t.is(await fs.promises.readlink(path.join(root, 'promoted')), 'release-1')
  t.is(await fs.promises.readFile(path.join(root, 'release-1'), 'utf8'), 'release one')
  t.is((await fs.promises.readdir(path.join(layout.internal, 'archive'))).length, 3)
})

test('reset waits for an upload to finish and reports the payload that now remains', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  const release = await acquireStorageLock(layout)
  t.teardown(release)
  const waiting = runReset(['--storage', root, '--apply', '--wait', '10000'], { pollInterval: 10 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await fs.promises.writeFile(path.join(root, 'finished-while-waiting'), 'payload')
  await release()
  const result = await waiting
  t.is(result.code, 0, result.stderr)
  t.ok(has(result.lines, 'fresh start: no'))
  t.ok(has(result.lines, 'remaining payloads: 1 (finished-while-waiting)'))
})

test('server refuses to recover or serve a storage root with an incomplete reset', async (t) => {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  await fs.promises.writeFile(path.join(layout.internal, 'reset-pending.json'), '{}')
  const testnet = await createLocalTestnet(t)
  const server = new Server({
    seed: b4a.alloc(32, 43),
    storageDir: root,
    allowedKeys: [keyPairFromSeed(b4a.alloc(32, 44)).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  t.teardown(() => server.close())
  let recovered = false
  server.on('recovery', () => {
    recovered = true
  })
  await t.exception(() => server.listen(), { code: ERRORS.PROTOCOL_INVALID })
  t.absent(recovered, 'no recovery runs against partly archived metadata')
  t.ok(await exists(path.join(layout.internal, 'reset-pending.json')))
})
