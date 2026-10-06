# Managed Symlinks and Directory Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a directory as one recursive, deterministically framed, atomically committed managed artifact, and let a server maintain safe declarative symlinks that always point at the newest matching managed artifact.

**Architecture:** A new canonical tree layer (`src/tar-protocol/tree.ts`, `tree-manifest.ts`, `tree-extract.ts`) frames a whole directory as one deterministic multi-entry USTAR stream whose header bytes are rebuilt and compared block by block during extraction; the existing single-file TAR path is left byte-identical. Directory sessions (v4), commit records (v3), and directory journals publish a verified `.tree` staging directory by rename under the root lease, and delete by renaming into a private trash directory. A separate symlink layer (`src/symlinks.ts`, `src/storage/link-store.ts`) compiles operator rules, selects the newest matching `CommitRecord`, and converges ownership-proven symlinks level-triggered from startup, commit, recovery, and retention.

**Tech Stack:** TypeScript 7, Node.js 22–24, Bare, Brittle 4, `sodium-native` SHA-256, `tar-stream` 3.2.1 (test-only cross-check), direct HyperDHT, durable JSON sidecars.

## Global Constraints

- The single-file protocol stays byte-identical: `canonicalUstarHeader()`, `deterministicTarSize()`, `computeTarTransferId()`, `TAR_TRANSFER_DOMAIN`, `MetadataRecord`, `encodeMetadataRecord()`, `decodeMetadataRecord()`, and session versions 2 and 3 are not modified.
- Directory metadata uses a distinct validated key set containing `kind: 'directory'`. An old server's `exactKeys()` decoder rejects it without mutating storage.
- Directory artifacts are create-only. A directory offer whose name is in `replaceNames`, a file-to-directory kind change, and a directory-to-file kind change are all rejected.
- The package exposes no user-facing "atomic directory" term or option.
- `--symlink <plain-exact-or-/regex/> <safe-link-basename>` is repeatable. A selector that begins and ends with `/` is a regular expression with no flags; anything else is an exact managed artifact basename.
- A link target is always exactly the selected record's basename. It never contains `/`, `\`, `..`, an absolute prefix, the storage root, or `.swarm-deploy`.
- The server never adopts, replaces, moves, or deletes an unmanaged file, directory, or symlink. Every unprovable path is preserved and fails closed.
- Link selection is level-triggered: startup, successful commit, already-committed retry, recovery, and retention reconciliation compute the same desired set from validated `CommitRecord` values only.
- `RetentionManagerOptions.reconcileLinks` is invoked with the root lease already held and must never call `withRootLease()`. `Server.reconcileAfterCommit()` is the only caller that acquires the lease itself. `withRootLease()` is a non-reentrant promise chain; a nested acquisition deadlocks.
- Tree limits: each path component is a safe basename of at most 100 UTF-8 bytes; the stored TAR name is at most 100 UTF-8 bytes; maximum depth 32; maximum entries 10,000; aggregate regular-file bytes bounded by `maxFileBytes`; aggregate persistent staging bounded by `maxStagingBytes`.
- Canonical tree framing: normalized file mode `0644`, directory mode `0755`, `uid` 0, `gid` 0, `mtime` 0, `uname` `''`, `gname` `''`, typeflag `0` for files and `5` for directories.
- Recursive deletion uses `lstat`, `unlink`, and `rmdir` only. `storage.rm({ recursive: true })` is never used on a path reachable from the visible storage root, and no removal follows a symlink.
- No error message includes absolute source paths, archive contents, secrets, or unvalidated symlink targets.
- New behavior must pass both the Node.js and Bare suites.
- No commit in this plan may introduce a skipped test. `test.skip` and `t.skip` are never used; a test that asserts behavior this plan removes is deleted outright in the same task that removes the behavior. Every test written in a task goes red and green inside that same task, so `rg -n 'test\.skip|t\.skip' test` prints nothing at every commit.

---

## File Structure

**New source files**

- `src/tar-protocol/tree.ts`: canonical tree model — limits, relative-path validation, bytewise ordering, parent-before-child and case-fold rules, hash field framing, tree digest, and the client-side filesystem snapshot with per-entry identities.
- `src/tar-protocol/tree-manifest.ts`: deterministic multi-entry TAR generation, tree transfer-ID domain, `TreeManifest`, resume suffix regeneration, and tree wire metadata construction.
- `src/tar-protocol/tree-extract.ts`: streaming canonical tree TAR validator and extractor, including every malicious-archive rejection.
- `src/storage/tree-fs.ts`: safe recursive tree primitives over a `StorageAdapter` — component-validated creation, no-follow file opens, directory sync, canonical walk, digest recomputation, and `lstat`/`unlink`/`rmdir` removal.
- `src/storage/tree-staging.ts`: the `TreeExtractionTarget` that writes a verified tree into `.swarm-deploy/staging/<transfer-id>.tree/`.
- `src/symlinks.ts`: `SymlinkRule` validation and compilation, plus deterministic newest-record selection.
- `src/storage/link-store.ts`: managed-link ownership records, the link update transaction, level-triggered reconciliation, and rule-removal convergence.

**Modified source files**

- `src/types.ts`: `ArtifactKind`, `TransferEvent.kind`.
- `src/errors.ts`: `LINK_CONFLICT`, `LINK_FAILED`, `UNSUPPORTED_STORAGE`.
- `src/storage/types.ts`: optional `StorageAdapter.symlink`/`readlink`; `StorageLayout.links`/`trash`.
- `src/storage/layout.ts`: create, protect, and identity-check `links` and `trash`.
- `src/tar-protocol/ustar.ts`: `TAR_DIRECTORY_MODE`, `canonicalUstarTreeHeader()`, `deterministicTreeTarSize()`.
- `src/tar-protocol/controls.ts`: `TreeMetadataRecord` and its encoder/decoder, plus the `AnyMetadataRecord` dispatching decoder.
- `src/tar-protocol/direct-wire.ts`: kind-dispatching metadata read and write.
- `src/files.ts`: `selectUploadTarget()` replaces batch child selection.
- `src/client.ts`: one recursive directory artifact per directory input; batch result, failure, and skip surfaces removed.
- `src/storage/tar-session-store.ts`: session version 4, tree staging, tree verification, tree residue sweeping.
- `src/storage/commit-journal.ts`: directory commit record version 3, directory journal version 3, shared commit-order comparison (Task 7, schemas only).
- `src/storage/commit-store.ts`: directory commit transaction, kind-aware inspection and scanning, directory recovery (Task 8), then trash-rename deletion and trash sweeping (Task 9).
- `src/storage/recovery.ts`: `links`/`trash` layout assertions and the trash-sweep call (Task 9 only; the directory journal needs no new entry point).
- `src/storage/retention.ts`: kind-aware scrub, directory digest verification, link reconciliation hook, and link-target pinning.
- `src/hooks.ts`: `HookArtifact.kind` and `entryCount`.
- `src/server.ts`: `symlinks` option, directory lifecycle, link reconciliation ordering, kind-bearing events.
- `src/cli.ts`: repeatable two-value `--symlink`, simplified upload output.
- `src/index.ts`: new public type exports.

**New test files**

- `test/helpers/trees.ts`, `test/unit/tree-canonical.test.ts`, `test/unit/storage-tree.test.ts`, `test/unit/tree-manifest.test.ts`, `test/unit/tree-extract.test.ts`, `test/unit/commit-journal.test.ts`, `test/unit/symlink-rules.test.ts`, `test/unit/link-store.test.ts`.

**Modified test files**

- `test/unit/files.test.ts`, `test/unit/tar-session-store.test.ts`, `test/unit/commit-recovery.test.ts`, `test/unit/retention.test.ts`, `test/unit/direct-behavior.test.ts`, `test/unit/cli.test.ts`, `test/unit/tar-property.test.ts`, `test/integration/direct-upload.test.ts`, `test/integration/behavior-observability.test.ts`, `test/integration/source-parent-optout.test.ts`, `test/types/public-api.ts`, `test/run.ts`, `tsconfig.test.json`.

**Modified documentation**

- `README.md`, `docs/spec/swarm-deploy.md`, `CHANGELOG.md`.

---

### Task 1: Canonical tree model and USTAR tree headers

**Files:**

- Create: `src/tar-protocol/tree.ts`
- Create: `test/unit/tree-canonical.test.ts`
- Create: `test/helpers/trees.ts`
- Modify: `src/types.ts`
- Modify: `src/tar-protocol/ustar.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Produces: `ArtifactKind` from `src/types.ts`.
- Produces: `MAX_TREE_DEPTH`, `MAX_TREE_ENTRIES`, `MAX_TREE_NAME_BYTES`, `TREE_DIGEST_DOMAIN`, `TreeEntry`, `TreeIdentity`, `TreeSnapshotEntry`, `TreeSnapshot`, `TreeDigestEntry`, `hashField()`, `tarEntryName()`, `assertTreeEntryPath()`, `compareTreePaths()`, `assertCanonicalTreeEntries()`, `treeDigest()`, `snapshotTree()`, `revalidateTreeSnapshot()`.
- Produces: `TAR_DIRECTORY_MODE`, `canonicalUstarTreeHeader()`, `deterministicTreeTarSize()` from `src/tar-protocol/ustar.ts`.
- Consumes: `validateBasename()` and `isReservedHistoryName()` from `src/files.ts`; `SodiumSha256` from `src/tar-protocol/hash.ts`.

- [ ] **Step 1: Add the tree fixture helper**

Create `test/helpers/trees.ts`:

```ts
import fs from '#fs'
import path from '#path'

export interface TreeSpec {
  /** Relative POSIX paths. A trailing `/` creates an empty directory. */
  [relativePath: string]: string
}

/** Writes `spec` under `root`, creating parents, and returns `root`. */
export async function writeTree(root: string, spec: TreeSpec): Promise<string> {
  for (const relativePath of Object.keys(spec).sort()) {
    const target = path.join(root, ...relativePath.split('/').filter(Boolean))
    if (relativePath.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true })
      continue
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, spec[relativePath])
  }
  return root
}
```

- [ ] **Step 2: Write the failing canonical-model test**

Create `test/unit/tree-canonical.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { pack } from 'tar-stream'
import { ERRORS } from '../../dist/errors.js'
import {
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  compareTreePaths,
  snapshotTree,
  tarEntryName,
  treeDigest,
  type TreeEntry
} from '../../dist/tar-protocol/tree.js'
import {
  canonicalUstarHeader,
  canonicalUstarTreeHeader,
  deterministicTreeTarSize
} from '../../dist/tar-protocol/ustar.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const FILE_DIGEST = b4a.alloc(32, 7)

function entry(kind: 'file' | 'directory', treePath: string, size = 0): TreeEntry {
  return { kind, path: treePath, size }
}

test('tree entry paths reject traversal, absolute, reserved, and overlong components', (t) => {
  t.is(assertTreeEntryPath('a/b/c.bin', 'file'), 'a/b/c.bin')
  t.is(assertTreeEntryPath('a', 'directory'), 'a')
  for (const value of [
    '',
    '.',
    '..',
    'a/..',
    '../a',
    '/a',
    'a/',
    'a//b',
    'a\\b',
    'a/\u0000b',
    '.hidden',
    '-leading',
    'history-deadbeef',
    `${'a'.repeat(101)}`,
    Array.from({ length: MAX_TREE_DEPTH + 1 }, () => 'd').join('/')
  ]) {
    t.exception(() => assertTreeEntryPath(value, 'file'), { code: ERRORS.INVALID_FILENAME }, value)
  }
  // A directory stores a trailing slash, so its path is bounded one byte tighter.
  t.is(assertTreeEntryPath('a'.repeat(99), 'directory'), 'a'.repeat(99))
  t.exception(() => assertTreeEntryPath('a'.repeat(100), 'directory'), {
    code: ERRORS.INVALID_FILENAME
  })
})

test('tree ordering is bytewise with parents before children', (t) => {
  t.ok(compareTreePaths('a', 'a-b') < 0)
  t.ok(compareTreePaths('a-b', 'a/b') < 0)
  t.ok(compareTreePaths('a', 'a/b') < 0)
  t.is(compareTreePaths('a/b', 'a/b'), 0)
  assertCanonicalTreeEntries([
    entry('directory', 'a'),
    entry('file', 'a-b.bin', 1),
    entry('file', 'a/b.bin', 2),
    entry('directory', 'a/c'),
    entry('file', 'a/c/d.bin', 3)
  ])
  for (const entries of [
    [entry('file', 'b.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'a.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'A.bin', 1), entry('file', 'a.bin', 1)],
    [entry('file', 'missing/child.bin', 1)],
    [entry('file', 'a', 1), entry('file', 'a/child.bin', 1)],
    [entry('directory', 'a', 1)]
  ]) {
    t.exception(() => assertCanonicalTreeEntries(entries), { code: ERRORS.PROTOCOL_INVALID })
  }
})

test('tree digest is order sensitive and ignores nothing', (t) => {
  const base = treeDigest([
    { entry: entry('directory', 'a') },
    { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST }
  ])
  t.is(base.byteLength, 32)
  t.alike(
    base,
    treeDigest([
      { entry: entry('directory', 'a') },
      { entry: entry('file', 'a/b.bin', 3), sha256: FILE_DIGEST }
    ])
  )
  t.absent(
    b4a.equals(
      base,
      treeDigest([
        { entry: entry('directory', 'a') },
        { entry: entry('file', 'a/c.bin', 3), sha256: FILE_DIGEST }
      ])
    )
  )
  t.absent(
    b4a.equals(
      base,
      treeDigest([
        { entry: entry('directory', 'a') },
        { entry: entry('file', 'a/b.bin', 4), sha256: FILE_DIGEST }
      ])
    )
  )
  t.absent(b4a.equals(base, treeDigest([{ entry: entry('directory', 'a') }])))
})

test('a canonical tree file header is byte-identical to the single-file header', (t) => {
  t.alike(canonicalUstarTreeHeader('payload.bin', 'file', 1234), canonicalUstarHeader('payload.bin', 1234))
  t.is(tarEntryName(entry('directory', 'nested')), 'nested/')
  t.is(tarEntryName(entry('file', 'nested/x.bin', 1)), 'nested/x.bin')
  t.exception(() => canonicalUstarTreeHeader('nested/', 'directory', 1), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('a canonical tree directory header matches tar-stream USTAR framing', async (t) => {
  const output = pack()
  output.entry({
    name: 'nested/',
    type: 'directory',
    size: 0,
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    uname: '',
    gname: ''
  })
  output.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of output as AsyncIterable<Uint8Array>) chunks.push(b4a.from(chunk))
  t.alike(b4a.concat(chunks).subarray(0, 512), canonicalUstarTreeHeader('nested/', 'directory', 0))
})

test('deterministic tree TAR size accounts for every header, payload, and pad block', (t) => {
  t.is(deterministicTreeTarSize([]), 1024)
  t.is(deterministicTreeTarSize([entry('directory', 'a')]), 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 1)]), 512 + 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 512)]), 512 + 512 + 1024)
  t.is(deterministicTreeTarSize([entry('file', 'a.bin', 513)]), 512 + 1024 + 1024)
})

test('tree snapshots are canonical, keep empty directories, and reject unsafe entries', async (t) => {
  const root = await createTempDir(t)
  await writeTree(root, {
    'b.bin': 'bb',
    'a/deep/c.bin': 'ccc',
    'a/empty/': '',
    'A.bin': 'A'
  })
  const snapshot = await snapshotTree(root)
  t.alike(
    snapshot.entries.map((value) => `${value.kind}:${value.path}`),
    [
      'file:A.bin',
      'directory:a',
      'directory:a/deep',
      'file:a/deep/c.bin',
      'directory:a/empty',
      'file:b.bin'
    ]
  )
  t.is(snapshot.entryCount, 6)
  t.is(snapshot.payloadBytes, 1 + 3 + 2)
  t.ok(snapshot.entries.every((value) => typeof value.absolutePath === 'string'))

  const unsafe = await createTempDir(t)
  await writeTree(unsafe, { 'ok.bin': 'ok' })
  await fs.promises.symlink(path.join(unsafe, 'ok.bin'), path.join(unsafe, 'link.bin'))
  await t.exception(() => snapshotTree(unsafe), { code: ERRORS.INVALID_FILENAME })

  const hardlinked = await createTempDir(t)
  await writeTree(hardlinked, { 'ok.bin': 'ok' })
  await fs.promises.link(path.join(hardlinked, 'ok.bin'), path.join(hardlinked, 'same.bin'))
  await t.exception(() => snapshotTree(hardlinked), { code: ERRORS.INVALID_FILENAME })

  const named = await createTempDir(t)
  await writeTree(named, { '-invalid': 'x' })
  await t.exception(() => snapshotTree(named), { code: ERRORS.INVALID_FILENAME })
})

test('tree snapshots reject an over-count tree without reading every file', async (t) => {
  const root = await createTempDir(t)
  const spec: Record<string, string> = {}
  for (let index = 0; index <= MAX_TREE_ENTRIES; index++) spec[`f${index}.bin`] = 'x'
  await writeTree(root, spec)
  await t.exception(() => snapshotTree(root), { code: ERRORS.PROTOCOL_INVALID })
})
```

- [ ] **Step 3: Register the test and run it to verify red**

Add `"test/unit/tree-canonical.test.ts"` to the `files` array in `tsconfig.test.json` and `require('./unit/tree-canonical.test.js')` as the first `require` in `test/run.ts`.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports `Cannot find module '../../dist/tar-protocol/tree.js'` and that `canonicalUstarTreeHeader` and `deterministicTreeTarSize` are not exported from `../../dist/tar-protocol/ustar.js`.

- [ ] **Step 4: Add the public artifact kind**

In `src/types.ts`, after the `Binary` block:

```ts
/** Whether a managed artifact is one regular file or one recursive directory. */
export type ArtifactKind = 'file' | 'directory'
```

- [ ] **Step 5: Add canonical USTAR tree framing**

In `src/tar-protocol/ustar.ts`, add after `TAR_MODE`:

```ts
export const TAR_DIRECTORY_MODE = 0o755
```

Then add at the end of the file:

```ts
/**
 * Builds the canonical USTAR header block for one tree entry.
 *
 * `storedName` is the exact TAR name field: the relative path for a file and
 * the relative path plus `/` for a directory. For a one-component file name
 * this returns exactly `canonicalUstarHeader(storedName, size)`.
 */
export function canonicalUstarTreeHeader(
  storedName: string,
  kind: 'file' | 'directory',
  size: number
): Buffer {
  if (kind !== 'file' && kind !== 'directory') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid canonical TAR entry kind')
  }
  if (kind === 'directory' && size !== 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid canonical TAR directory size')
  }
  assertUstarFileSize(size)
  const encoded = b4a.from(storedName)
  if (encoded.byteLength === 0 || encoded.byteLength > 100) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Canonical TAR name overflow')
  }
  const header = b4a.alloc(TAR_BLOCK_BYTES)
  const set = (offset: number, value: Uint8Array): void => {
    header.set(value, offset)
  }
  set(0, encoded)
  set(100, octal(kind === 'directory' ? TAR_DIRECTORY_MODE : TAR_MODE, 6))
  set(108, octal(TAR_UID, 6))
  set(116, octal(TAR_GID, 6))
  set(124, octal(size, 11))
  set(136, octal(TAR_MTIME_MS / 1000, 11))
  header[156] = kind === 'directory' ? 53 : 48
  set(257, b4a.from([0x75, 0x73, 0x74, 0x61, 0x72, 0]))
  set(263, b4a.from('00'))
  if (TAR_UNAME) set(265, b4a.from(TAR_UNAME))
  if (TAR_GNAME) set(297, b4a.from(TAR_GNAME))
  set(329, octal(0, 6))
  set(337, octal(0, 6))

  let checksum = 8 * 32
  for (let index = 0; index < 148; index++) checksum += header[index]
  for (let index = 156; index < TAR_BLOCK_BYTES; index++) checksum += header[index]
  set(148, octal(checksum, 6))
  return header
}

/** The exact deterministic archive length for an ordered canonical entry list. */
export function deterministicTreeTarSize(
  entries: readonly { kind: 'file' | 'directory'; size: number }[]
): number {
  let total = TAR_END_BYTES
  for (const entry of entries) {
    assertUstarFileSize(entry.size)
    const payload = entry.kind === 'directory' ? 0 : entry.size
    const padding = (TAR_BLOCK_BYTES - (payload % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    total += TAR_BLOCK_BYTES + payload + padding
    if (!Number.isSafeInteger(total)) throw invalidSize()
  }
  return total
}
```

- [ ] **Step 6: Implement the canonical tree model**

Create `src/tar-protocol/tree.ts`:

```ts
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import type { ArtifactKind } from '../types.js'
import { SodiumSha256 } from './hash.js'

export const TREE_DIGEST_DOMAIN = 'swarm-deploy/tree/v1'
export const MAX_TREE_DEPTH = 32
export const MAX_TREE_ENTRIES = 10_000
export const MAX_TREE_NAME_BYTES = 100

export interface TreeEntry {
  kind: ArtifactKind
  /** Relative POSIX path inside the artifact, with no leading or trailing `/`. */
  path: string
  /** Regular-file byte length; always `0` for a directory. */
  size: number
}

export interface TreeIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs: number
}

export interface TreeSnapshotEntry extends TreeEntry {
  absolutePath: string
  identity: TreeIdentity
}

export interface TreeSnapshot {
  rootPath: string
  root: TreeIdentity
  entries: TreeSnapshotEntry[]
  entryCount: number
  payloadBytes: number
}

export interface TreeDigestEntry {
  entry: TreeEntry
  /** Required for a file entry and forbidden for a directory entry. */
  sha256?: Uint8Array
}

export interface TreeSnapshotOptions {
  signal?: AbortSignalLike | null
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function unsafeName(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.INVALID_FILENAME, message)
}

/** The exact TAR name field for an entry: directories carry a trailing `/`. */
export function tarEntryName(entry: Pick<TreeEntry, 'kind' | 'path'>): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path
}

export function assertTreeEntryPath(value: unknown, kind: ArtifactKind): string {
  if (typeof value !== 'string' || value.length === 0) throw unsafeName('Invalid tree entry path')
  if (value.includes('\\') || value.includes('\u0000')) throw unsafeName('Invalid tree entry path')
  const components = value.split('/')
  if (components.length > MAX_TREE_DEPTH) throw unsafeName('Tree entry path is too deep')
  for (const component of components) {
    if (component.length === 0) throw unsafeName('Invalid tree entry path')
    validateBasename(component)
    if (isReservedHistoryName(component)) throw unsafeName('Reserved tree entry path')
  }
  const stored = b4a.from(tarEntryName({ kind, path: value }))
  if (stored.byteLength > MAX_TREE_NAME_BYTES) throw unsafeName('Tree entry path is too long')
  return value
}

/** Bytewise order. A parent is a proper prefix, so it always sorts first. */
export function compareTreePaths(left: string, right: string): number {
  return b4a.compare(b4a.from(left), b4a.from(right))
}

export function assertCanonicalTreeEntries(entries: readonly TreeEntry[]): void {
  if (!Array.isArray(entries)) throw invalid('Invalid tree entry list')
  if (entries.length > MAX_TREE_ENTRIES) throw invalid('Tree has too many entries')
  const directories = new Set<string>()
  const folded = new Set<string>()
  let previous: string | null = null
  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw invalid('Invalid tree entry kind')
    if (entry.kind === 'directory' && entry.size !== 0) throw invalid('Invalid tree directory size')
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw invalid('Invalid tree entry size')
    }
    assertTreeEntryPath(entry.path, entry.kind)
    if (previous !== null && compareTreePaths(previous, entry.path) >= 0) {
      throw invalid('Noncanonical tree entry order')
    }
    const fold = entry.path.toLowerCase()
    if (folded.has(fold)) throw invalid('Case-folded duplicate tree entry path')
    folded.add(fold)
    const separator = entry.path.lastIndexOf('/')
    if (separator !== -1 && !directories.has(entry.path.slice(0, separator))) {
      throw invalid('Tree entry has no parent directory entry')
    }
    if (entry.kind === 'directory') directories.add(entry.path)
    previous = entry.path
  }
}

/** Length-prefixed, labelled field framing shared by tree digests and tree transfer IDs. */
export function hashField(
  hash: SodiumSha256,
  label: string,
  value: Uint8Array | string | number
): void {
  const valueBytes = typeof value === 'number' ? b4a.from(String(value)) : b4a.from(value)
  hash
    .update(b4a.from(`${label}\u0000`))
    .update(b4a.from(`${valueBytes.byteLength}:`))
    .update(valueBytes)
}

export function treeDigest(entries: readonly TreeDigestEntry[]): Buffer {
  assertCanonicalTreeEntries(entries.map((value) => value.entry))
  const hash = new SodiumSha256()
  hashField(hash, 'domain', TREE_DIGEST_DOMAIN)
  hashField(hash, 'entryCount', entries.length)
  for (const { entry, sha256 } of entries) {
    hashField(hash, 'kind', entry.kind)
    hashField(hash, 'path', entry.path)
    hashField(hash, 'size', entry.size)
    if (entry.kind === 'directory') {
      if (sha256 !== undefined) throw invalid('Unexpected tree directory digest')
      continue
    }
    if (!b4a.isBuffer(sha256) || sha256.byteLength !== 32) throw invalid('Invalid tree file digest')
    hashField(hash, 'sha256', sha256)
  }
  return hash.digest()
}

function identityOf(stat: fs.Stats): TreeIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function classify(stat: fs.Stats): ArtifactKind {
  if (stat.isSymbolicLink()) throw unsafeName('Tree entries cannot be symbolic links')
  if (stat.isDirectory()) return 'directory'
  if (!stat.isFile()) throw unsafeName('Tree entries must be regular files or directories')
  if (typeof stat.nlink === 'number' && stat.nlink > 1) {
    throw unsafeName('Tree entries cannot be hard links')
  }
  return 'file'
}

/**
 * Walks `rootPath` recursively and returns the canonical entry list with one
 * snapshotted identity per entry. Any unsafe or non-regular member rejects the
 * whole directory; nothing is ever silently dropped.
 */
export async function snapshotTree(
  rootPath: string,
  { signal = null }: TreeSnapshotOptions = {}
): Promise<TreeSnapshot> {
  throwIfAborted(signal)
  const rootStat = await fs.promises.lstat(rootPath)
  if (classify(rootStat) !== 'directory') throw unsafeName('Tree root must be a directory')
  const seen = new Set<string>([`${rootStat.dev}:${rootStat.ino}`])
  const entries: TreeSnapshotEntry[] = []
  let payloadBytes = 0

  const walk = async (absolute: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_TREE_DEPTH) throw unsafeName('Tree entry path is too deep')
    const names = await fs.promises.readdir(absolute)
    names.sort((left, right) => compareTreePaths(left, right))
    for (const name of names) {
      throwIfAborted(signal)
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const entryAbsolute = path.join(absolute, name)
      const stat = await fs.promises.lstat(entryAbsolute)
      const kind = classify(stat)
      assertTreeEntryPath(entryPath, kind)
      if (entries.length >= MAX_TREE_ENTRIES) throw invalid('Tree has too many entries')
      if (kind === 'directory') {
        const identity = `${stat.dev}:${stat.ino}`
        if (seen.has(identity)) throw unsafeName('Tree contains a filesystem cycle')
        seen.add(identity)
        entries.push({
          kind,
          path: entryPath,
          size: 0,
          absolutePath: entryAbsolute,
          identity: identityOf(stat)
        })
        await walk(entryAbsolute, entryPath, depth + 1)
        continue
      }
      if (payloadBytes > Number.MAX_SAFE_INTEGER - stat.size) {
        throw invalid('Tree payload exceeds safe integer range')
      }
      payloadBytes += stat.size
      entries.push({
        kind,
        path: entryPath,
        size: stat.size,
        absolutePath: entryAbsolute,
        identity: identityOf(stat)
      })
    }
  }

  await walk(rootPath, '', 1)
  assertCanonicalTreeEntries(entries)
  return {
    rootPath,
    root: identityOf(rootStat),
    entries,
    entryCount: entries.length,
    payloadBytes
  }
}

export function assertSameTreeIdentity(
  expected: TreeIdentity,
  actual: fs.Stats,
  message: string
): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, message)
  }
}

/** Reproves every snapshotted identity before a resume regenerates the archive. */
export async function revalidateTreeSnapshot(
  snapshot: TreeSnapshot,
  { signal = null }: TreeSnapshotOptions = {}
): Promise<void> {
  throwIfAborted(signal)
  const rootStat = await fs.promises.lstat(snapshot.rootPath)
  if (classify(rootStat) !== 'directory') throw unsafeName('Tree root must be a directory')
  if (rootStat.dev !== snapshot.root.dev || rootStat.ino !== snapshot.root.ino) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree root changed during TAR generation')
  }
  for (const entry of snapshot.entries) {
    throwIfAborted(signal)
    const stat = await fs.promises.lstat(entry.absolutePath)
    if (classify(stat) !== entry.kind) {
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree entry kind changed during TAR generation')
    }
    if (entry.kind === 'directory') {
      if (stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree directory changed during TAR generation')
      }
      continue
    }
    assertSameTreeIdentity(entry.identity, stat, 'Tree entry changed during TAR generation')
  }
  const refreshed = await snapshotTree(snapshot.rootPath, { signal })
  if (refreshed.entryCount !== snapshot.entryCount) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree listing changed during TAR generation')
  }
  for (let index = 0; index < refreshed.entries.length; index++) {
    if (
      refreshed.entries[index].path !== snapshot.entries[index].path ||
      refreshed.entries[index].kind !== snapshot.entries[index].kind
    ) {
      throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree listing changed during TAR generation')
    }
  }
}
```

- [ ] **Step 7: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tree-canonical.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tree-canonical.test.js
./node_modules/.bin/brittle-node .test-dist/unit/tar-protocol.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tar-protocol.test.js
```

Expected: all four pass with no warnings. `tar-protocol.test.js` proves the single-file header and size helpers are unchanged.

- [ ] **Step 8: Self-review**

Confirm `canonicalUstarHeader` and `deterministicTarSize` have no diff, that every rejection in `assertTreeEntryPath` and `assertCanonicalTreeEntries` has a test, and that `snapshotTree` never calls `fs.promises.stat` (which follows symlinks).

Run:

```bash
git diff -- src/tar-protocol/ustar.ts
npm run format && npm run lint
```

Expected: the `ustar.ts` diff only adds `TAR_DIRECTORY_MODE`, `canonicalUstarTreeHeader`, and `deterministicTreeTarSize`; lint exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/tar-protocol/tree.ts src/tar-protocol/ustar.ts \
  test/unit/tree-canonical.test.ts test/helpers/trees.ts test/run.ts tsconfig.test.json
git commit -m "feat: model canonical recursive directory trees"
```

---

### Task 2: Storage layout, symlink capability, and safe recursive tree primitives

**Files:**

- Create: `src/storage/tree-fs.ts`
- Create: `test/unit/storage-tree.test.ts`
- Modify: `src/errors.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/layout.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: `assertTreeEntryPath()`, `compareTreePaths()`, `assertCanonicalTreeEntries()`, `treeDigest()`, `TreeEntry` from Task 1.
- Produces: `ERRORS.LINK_CONFLICT`, `ERRORS.LINK_FAILED`, `ERRORS.UNSUPPORTED_STORAGE`.
- Produces: `StorageLayout.links`, `StorageLayout.trash`, optional `StorageAdapter.symlink()`/`readlink()`, `SymlinkCapableStorage`.
- Produces from `src/storage/tree-fs.ts`: `assertSymlinkCapable()`, `createTreeRoot()`, `createTreeSubdirectory()`, `openTreeFile()`, `syncTreeDirectories()`, `walkTree()`, `digestTree()`, `removeTree()`, `inspectTreePath()`, `TreeDigestResult`, `TreePathState`.

- [ ] **Step 1: Write the failing storage-primitive test**

Create `test/unit/storage-tree.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { initLayout, protectedDirectories } from '../../dist/storage/layout.js'
import {
  assertSymlinkCapable,
  createTreeRoot,
  createTreeSubdirectory,
  digestTree,
  inspectTreePath,
  openTreeFile,
  removeTree,
  syncTreeDirectories,
  walkTree
} from '../../dist/storage/tree-fs.js'
import { treeDigest } from '../../dist/tar-protocol/tree.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'
import { writeTree } from '../helpers/trees.js'

test('the layout creates and protects the private links and trash directories', async (t) => {
  const layout = initLayout(await createTempDir(t))
  t.is(layout.links, path.join(layout.internal, 'links'))
  t.is(layout.trash, path.join(layout.internal, 'trash'))
  for (const directory of [layout.links, layout.trash]) {
    t.ok((await fs.promises.lstat(directory)).isDirectory())
    t.ok(protectedDirectories(layout).includes(directory))
  }
})

test('symlink capability is required explicitly', (t) => {
  const storage = createStorage()
  t.exception(() => assertSymlinkCapable({ ...storage, symlink: undefined, readlink: undefined }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })
  const capable = {
    ...storage,
    symlink: () => Promise.resolve(),
    readlink: () => Promise.resolve('target')
  }
  t.is(assertSymlinkCapable(capable), undefined)
})

test('tree creation validates every component and never follows a symlink', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const treePath = path.join(layout.staging, 'aa.tree')
  await createTreeRoot(treePath, layout.staging, storage)
  await createTreeSubdirectory(treePath, 'nested', storage)
  const handle = await openTreeFile(treePath, 'nested/file.bin', storage)
  await handle.write(b4a.from('payload'), 0, 7, 0)
  await handle.sync()
  await handle.close()
  await syncTreeDirectories(treePath, storage)

  for (const unsafe of ['../escape', '/abs', 'nested/../escape', 'nested//x', 'a\\b']) {
    await t.exception(() => createTreeSubdirectory(treePath, unsafe, storage), {
      code: ERRORS.INVALID_FILENAME
    })
    await t.exception(() => openTreeFile(treePath, unsafe, storage), {
      code: ERRORS.INVALID_FILENAME
    })
  }

  await fs.promises.symlink(layout.root, path.join(treePath, 'nested', 'escape'))
  await t.exception(() => createTreeSubdirectory(treePath, 'nested/escape/evil', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
  await t.exception(() => openTreeFile(treePath, 'nested/escape/evil.bin', storage), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('walking and digesting a tree reproduces the canonical digest', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'b.bin': 'bb', 'a/c.bin': 'ccc', 'a/empty/': '' })
  const entries = await walkTree(root, storage)
  t.alike(
    entries.map((entry) => `${entry.kind}:${entry.path}:${entry.size}`),
    ['directory:a:0', 'file:a/c.bin:3', 'directory:a/empty:0', 'file:b.bin:2']
  )
  const result = await digestTree(root, storage)
  t.is(result.entryCount, 4)
  t.is(result.payloadBytes, 5)
  t.alike(
    result.treeSha256,
    treeDigest([
      { entry: { kind: 'directory', path: 'a', size: 0 } },
      { entry: { kind: 'file', path: 'a/c.bin', size: 3 }, sha256: sodiumSha256(b4a.from('ccc')) },
      { entry: { kind: 'directory', path: 'a/empty', size: 0 } },
      { entry: { kind: 'file', path: 'b.bin', size: 2 }, sha256: sodiumSha256(b4a.from('bb')) }
    ])
  )
})

test('digesting a tree rejects a symlink, a device, and an unsafe name', async (t) => {
  const storage = createStorage()
  const root = await createTempDir(t)
  await writeTree(root, { 'ok.bin': 'ok' })
  await fs.promises.symlink(path.join(root, 'ok.bin'), path.join(root, 'link.bin'))
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
  await fs.promises.unlink(path.join(root, 'link.bin'))
  await fs.promises.writeFile(path.join(root, '-bad'), 'bad')
  await t.exception(() => digestTree(root, storage), { code: ERRORS.INVALID_FILENAME })
})

test('removing a tree unlinks symlinks without following them and reports residue', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  const outside = await createTempDir(t)
  await fs.promises.writeFile(path.join(outside, 'keep.bin'), 'keep')
  const treePath = path.join(layout.trash, 'bb.tree')
  await writeTree(treePath, { 'a/b.bin': 'x', 'a/empty/': '' })
  await fs.promises.symlink(outside, path.join(treePath, 'a', 'escape'))

  t.is(await removeTree(treePath, layout.trash, storage), true)
  t.is(await inspectTreePath(treePath, layout.trash, storage), 'MISSING')
  t.ok((await fs.promises.lstat(path.join(outside, 'keep.bin'))).isFile())
  t.is(await removeTree(treePath, layout.trash, storage), false)
})

test('inspecting a tree path distinguishes managed directories from unmanaged paths', async (t) => {
  const storage = createStorage()
  const layout = initLayout(await createTempDir(t))
  t.is(await inspectTreePath(path.join(layout.root, 'absent'), layout.root, storage), 'MISSING')
  await fs.promises.mkdir(path.join(layout.root, 'tree'))
  t.is(await inspectTreePath(path.join(layout.root, 'tree'), layout.root, storage), 'DIRECTORY')
  await fs.promises.writeFile(path.join(layout.root, 'file.bin'), 'x')
  t.is(await inspectTreePath(path.join(layout.root, 'file.bin'), layout.root, storage), 'UNMANAGED')
  await fs.promises.symlink('tree', path.join(layout.root, 'link'))
  t.is(await inspectTreePath(path.join(layout.root, 'link'), layout.root, storage), 'UNMANAGED')
})
```

- [ ] **Step 2: Register the test and run it to verify red**

Add `"test/unit/storage-tree.test.ts"` to `tsconfig.test.json` and `require('./unit/storage-tree.test.js')` after the tree-canonical require in `test/run.ts`.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `Cannot find module '../../dist/storage/tree-fs.js'` and `Property 'links' does not exist on type 'StorageLayout'`.

- [ ] **Step 3: Add the new error codes**

In `src/errors.ts`, inside `ERRORS`, after `COMMIT_FAILED`:

```ts
  LINK_CONFLICT: 'LINK_CONFLICT',
  LINK_FAILED: 'LINK_FAILED',
  UNSUPPORTED_STORAGE: 'UNSUPPORTED_STORAGE',
```

- [ ] **Step 4: Extend the storage adapter and layout types**

In `src/storage/types.ts`, add to `StorageAdapter` after `statfs?`:

```ts
  /** Required only when symlink rules are configured. */
  symlink?(target: string, path: string): Promise<void>
  readlink?(path: string): Promise<string>
```

Add after the `StorageAdapter` interface:

```ts
export type SymlinkCapableStorage = StorageAdapter & {
  symlink(target: string, path: string): Promise<void>
  readlink(path: string): Promise<string>
}
```

Add to `StorageLayout` after `publications`:

```ts
  /** Private managed-symlink ownership records. */
  links: string
  /** Private destination a managed directory is renamed into before deletion. */
  trash: string
```

- [ ] **Step 5: Create and protect the new private directories**

In `src/storage/layout.ts`, inside `initLayout`'s `layout` object after `publications`:

```ts
    links: path.join(internal, 'links'),
    trash: path.join(internal, 'trash'),
```

Then after `assertDirectorySync(layout.publications)`:

```ts
  assertDirectorySync(layout.links)
  assertDirectorySync(layout.trash)
```

And in `protectedDirectories`, after `layout.publications`:

```ts
    layout.links,
    layout.trash
```

- [ ] **Step 6: Implement the safe recursive tree primitives**

Create `src/storage/tree-fs.ts`:

```ts
import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { SodiumSha256 } from '../tar-protocol/hash.js'
import {
  assertCanonicalTreeEntries,
  assertTreeEntryPath,
  compareTreePaths,
  treeDigest,
  type TreeDigestEntry,
  type TreeEntry
} from '../tar-protocol/tree.js'
import { openSafeRegularFile, withSafeDirectoryIdentity } from './layout.js'
import type { StorageAdapter, StorageFileHandle, StorageStats, SymlinkCapableStorage } from './types.js'

const READ_BYTES = 64 * 1024

export type TreePathState = 'MISSING' | 'DIRECTORY' | 'UNMANAGED'

export interface TreeDigestResult {
  entries: TreeEntry[]
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
}

function storageError(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function unsafeName(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.INVALID_FILENAME, message)
}

export function assertSymlinkCapable(
  storage: StorageAdapter
): asserts storage is SymlinkCapableStorage {
  if (typeof storage.symlink !== 'function' || typeof storage.readlink !== 'function') {
    throw new SwarmDeployError(
      ERRORS.UNSUPPORTED_STORAGE,
      'Storage adapter does not support symbolic links'
    )
  }
}

async function syncDirectory(directory: string, storage: StorageAdapter): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Resolves `relativePath` inside `treePath` one validated component at a time,
 * revalidating each parent's directory identity. Nothing is concatenated
 * without validation and no component may be a symbolic link.
 */
async function resolveParent(
  treePath: string,
  relativePath: string,
  kind: 'file' | 'directory',
  storage: StorageAdapter
): Promise<{ parent: string; target: string }> {
  assertTreeEntryPath(relativePath, kind)
  const components = relativePath.split('/')
  let parent = treePath
  for (const component of components.slice(0, -1)) {
    const next = path.join(parent, component)
    await withSafeDirectoryIdentity(parent, storage, async () => {
      const stat = await storage.lstat(next)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw storageError('Unsafe tree directory')
      }
    })
    parent = next
  }
  return { parent, target: path.join(parent, components[components.length - 1]) }
}

export async function createTreeRoot(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<void> {
  await withSafeDirectoryIdentity(parent, storage, () => storage.mkdir(treePath, { mode: 0o700 }))
  await withSafeDirectoryIdentity(parent, storage, () => syncDirectory(parent, storage))
}

export async function createTreeSubdirectory(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter
): Promise<void> {
  const { parent, target } = await resolveParent(treePath, relativePath, 'directory', storage)
  await withSafeDirectoryIdentity(parent, storage, () => storage.mkdir(target, { mode: 0o700 }))
}

export async function openTreeFile(
  treePath: string,
  relativePath: string,
  storage: StorageAdapter
): Promise<StorageFileHandle> {
  const { parent, target } = await resolveParent(treePath, relativePath, 'file', storage)
  return withSafeDirectoryIdentity(parent, storage, () =>
    openSafeRegularFile(target, 'create', storage)
  )
}

/** Synchronizes every directory in the tree, deepest first. */
export async function syncTreeDirectories(
  treePath: string,
  storage: StorageAdapter
): Promise<void> {
  const directories = [treePath]
  for (const entry of await walkTree(treePath, storage)) {
    if (entry.kind === 'directory') directories.push(path.join(treePath, ...entry.path.split('/')))
  }
  for (const directory of directories.reverse()) {
    await withSafeDirectoryIdentity(directory, storage, () => syncDirectory(directory, storage))
  }
}

export async function walkTree(treePath: string, storage: StorageAdapter): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = await withSafeDirectoryIdentity(absolute, storage, () => storage.readdir(absolute))
    names.sort((left, right) => compareTreePaths(left, right))
    for (const name of names) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      const entryAbsolute = path.join(absolute, name)
      const stat = await storage.lstat(entryAbsolute)
      if (stat.isSymbolicLink()) throw unsafeName('Tree entries cannot be symbolic links')
      if (stat.isDirectory()) {
        assertTreeEntryPath(entryPath, 'directory')
        entries.push({ kind: 'directory', path: entryPath, size: 0 })
        await walk(entryAbsolute, entryPath)
        continue
      }
      if (!stat.isFile()) throw unsafeName('Tree entries must be regular files or directories')
      assertTreeEntryPath(entryPath, 'file')
      entries.push({ kind: 'file', path: entryPath, size: stat.size })
    }
  }
  await walk(treePath, '')
  assertCanonicalTreeEntries(entries)
  return entries
}

async function digestTreeFile(
  filePath: string,
  size: number,
  storage: StorageAdapter
): Promise<Buffer> {
  const handle = await openSafeRegularFile(filePath, 'read', storage)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== size) {
      throw storageError('Tree file changed during digest')
    }
    const hash = new SodiumSha256()
    let position = 0
    while (position < size) {
      const bytes = b4a.alloc(Math.min(READ_BYTES, size - position))
      let offset = 0
      while (offset < bytes.byteLength) {
        const read = await handle.read(bytes, offset, bytes.byteLength - offset, position + offset)
        const count = typeof read === 'number' ? read : read.bytesRead
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw storageError('Truncated tree file')
        }
        offset += count
      }
      hash.update(bytes)
      position += bytes.byteLength
    }
    const after = await handle.stat()
    if (!after.isFile() || after.size !== size || after.dev !== before.dev || after.ino !== before.ino) {
      throw storageError('Tree file changed during digest')
    }
    return hash.digest()
  } finally {
    await handle.close()
  }
}

/** Recomputes the canonical tree digest from the extracted contents alone. */
export async function digestTree(
  treePath: string,
  storage: StorageAdapter
): Promise<TreeDigestResult> {
  const entries = await walkTree(treePath, storage)
  const digests: TreeDigestEntry[] = []
  let payloadBytes = 0
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      digests.push({ entry })
      continue
    }
    const absolute = path.join(treePath, ...entry.path.split('/'))
    const parent = path.dirname(absolute)
    const sha256 = await withSafeDirectoryIdentity(parent, storage, () =>
      digestTreeFile(absolute, entry.size, storage)
    )
    if (payloadBytes > Number.MAX_SAFE_INTEGER - entry.size) {
      throw storageError('Tree payload exceeds safe integer range')
    }
    payloadBytes += entry.size
    digests.push({ entry, sha256 })
  }
  return {
    entries,
    entryCount: entries.length,
    payloadBytes,
    treeSha256: treeDigest(digests)
  }
}

export async function inspectTreePath(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<TreePathState> {
  return withSafeDirectoryIdentity(parent, storage, async () => {
    let stat: StorageStats
    try {
      stat = await storage.lstat(treePath)
    } catch (error: unknown) {
      if (isMissing(error)) return 'MISSING'
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'UNMANAGED'
    return 'DIRECTORY'
  })
}

/**
 * Removes `treePath` recursively using only `lstat`, `unlink`, and `rmdir`. A
 * symbolic link inside the tree is unlinked, never traversed, so nothing
 * outside the tree can be reached. Returns `false` when the path was absent.
 */
export async function removeTree(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): Promise<boolean> {
  const state = await inspectTreePath(treePath, parent, storage)
  if (state === 'MISSING') return false
  if (state === 'UNMANAGED') throw storageError('Refusing to remove an unmanaged tree path')

  const removeDirectory = async (absolute: string): Promise<void> => {
    const names = await withSafeDirectoryIdentity(absolute, storage, () => storage.readdir(absolute))
    for (const name of names.sort()) {
      const child = path.join(absolute, name)
      const stat = await storage.lstat(child)
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        await removeDirectory(child)
        continue
      }
      await withSafeDirectoryIdentity(absolute, storage, () => storage.unlink(child))
    }
    await storage.rmdir(absolute)
  }

  await removeDirectory(treePath)
  await withSafeDirectoryIdentity(parent, storage, () => syncDirectory(parent, storage))
  return true
}
```

- [ ] **Step 7: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/storage-tree.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/storage-tree.test.js
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-node .test-dist/unit/tar-session-store.test.js
```

Expected: all four pass. The two existing storage suites prove the extra protected directories break nothing.

- [ ] **Step 8: Self-review and commit**

Confirm no code path in `tree-fs.ts` calls `storage.rm`, `assertSafeFile`, or `fs.promises` directly, and that `removeTree` refuses an unmanaged path instead of deleting it.

```bash
rg -n 'storage\.rm\(|assertSafeFile|fs\.promises' src/storage/tree-fs.ts
npm run format && npm run lint
git add src/errors.ts src/storage/types.ts src/storage/layout.ts src/storage/tree-fs.ts \
  test/unit/storage-tree.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: add safe recursive tree storage primitives"
```

Expected: the `rg` command prints nothing; lint exits 0.

---

### Task 3: Directory wire metadata, tree transfer identity, and deterministic generation

**Files:**

- Create: `src/tar-protocol/tree-manifest.ts`
- Create: `test/unit/tree-manifest.test.ts`
- Modify: `src/tar-protocol/controls.ts`
- Modify: `src/tar-protocol/direct-wire.ts`
- Modify: `test/unit/tar-property.test.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: everything Task 1 produces, plus `assertSourceParent()` and `CONTROL_VERSION` from `src/tar-protocol/controls.ts`.
- Produces: `TreeMetadataRecord`, `AnyMetadataRecord`, `isTreeMetadata()`, `encodeTreeMetadataRecord()`, `decodeTreeMetadataRecord()`, `encodeAnyMetadataRecord()`, `decodeAnyMetadataRecord()`.
- Produces: `TREE_TRANSFER_DOMAIN`, `TreeManifest`, `computeTreeTransferId()`, `buildTreeManifest()`, `regenerateTreeTarSuffix()`, `treeMetadataFromManifest()`, `assertTreeMetadataTransferId()`.
- Produces: `decodeDirectMetadata` now returns `AnyMetadataRecord`; `writeMetadata()` accepts `AnyMetadataRecord`.

- [ ] **Step 1: Write the failing metadata and manifest test**

Create `test/unit/tree-manifest.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import {
  CONTROL_VERSION,
  decodeAnyMetadataRecord,
  decodeMetadataRecord,
  encodeAnyMetadataRecord,
  encodeMetadataRecord,
  encodeTreeMetadataRecord,
  isTreeMetadata,
  type TreeMetadataRecord
} from '../../dist/tar-protocol/controls.js'
import {
  assertTreeMetadataTransferId,
  buildTreeManifest,
  computeTreeTransferId,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest,
  type TreeManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { buildTarManifest, metadataFromManifest } from '../../dist/tar-protocol/manifest.js'
import { deterministicTreeTarSize } from '../../dist/tar-protocol/ustar.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 31)

async function collect(manifest: TreeManifest, offset = 0): Promise<Buffer> {
  const chunks: Buffer[] = []
  const result = await regenerateTreeTarSuffix(manifest, offset, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  if (result.status !== 'MATCH') throw new Error('Unexpected reset')
  return b4a.concat(chunks)
}

test('file metadata stays byte-identical and never carries a kind', async (t) => {
  const root = await createTempDir(t)
  const file = path.join(root, 'payload.bin')
  await fs.promises.writeFile(file, 'payload')
  const record = metadataFromManifest(await buildTarManifest(file, OWNER))
  t.absent('kind' in record)
  t.alike(encodeAnyMetadataRecord(record), encodeMetadataRecord(record))
  t.alike(decodeAnyMetadataRecord(encodeMetadataRecord(record)), record)
  t.is(isTreeMetadata(decodeAnyMetadataRecord(encodeMetadataRecord(record))), false)
})

test('directory metadata is a distinct key set an exact-key file decoder rejects', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a/b.bin': 'bb', 'c.bin': 'c' })
  const manifest = await buildTreeManifest(source, OWNER)
  const record = treeMetadataFromManifest(manifest)
  t.is(record.kind, 'directory')
  t.is(record.name, '0.18.1')
  t.is(record.entryCount, 3)
  t.is(record.payloadBytes, 3)
  t.is(record.tarSize, manifest.tarSize)
  t.is(isTreeMetadata(decodeAnyMetadataRecord(encodeTreeMetadataRecord(record))), true)
  t.alike(decodeAnyMetadataRecord(encodeTreeMetadataRecord(record)), record)
  t.exception(() => decodeMetadataRecord(encodeTreeMetadataRecord(record)), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('directory metadata validation bounds every field', (t) => {
  const base: TreeMetadataRecord = {
    v: CONTROL_VERSION,
    kind: 'directory',
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256: 'a'.repeat(64),
    tarSize: 512 * 2 + 512 + 1024,
    tarSha256: 'b'.repeat(64),
    transferId: 'c'.repeat(64),
    reset: false
  }
  t.alike(decodeAnyMetadataRecord(encodeTreeMetadataRecord(base)), base)
  for (const invalid of [
    { ...base, kind: 'file' },
    { ...base, name: 'history-aa' },
    { ...base, entryCount: -1 },
    { ...base, entryCount: 10_001 },
    { ...base, payloadBytes: 1.5 },
    { ...base, treeSha256: 'Z'.repeat(64) },
    { ...base, tarSize: base.tarSize + 1 },
    { ...base, tarSize: 1024 },
    { ...base, tarSize: 512 * 4096 },
    { ...base, reset: 'no' },
    { ...base, sourceParent: '../escape' }
  ]) {
    t.exception(() => encodeTreeMetadataRecord(invalid as TreeMetadataRecord), {
      code: /INVALID_FILENAME|PROTOCOL_INVALID/
    })
  }
})

test('a tree transfer ID commits to every directory metadata field', (t) => {
  const immutable = {
    name: '0.18.1',
    entryCount: 2,
    payloadBytes: 10,
    treeSha256: b4a.alloc(32, 1),
    tarSize: 2560,
    tarSha256: b4a.alloc(32, 2)
  }
  const base = computeTreeTransferId(OWNER, immutable)
  t.is(base.byteLength, 32)
  for (const changed of [
    { ...immutable, name: '0.18.2' },
    { ...immutable, entryCount: 3 },
    { ...immutable, payloadBytes: 11 },
    { ...immutable, treeSha256: b4a.alloc(32, 3) },
    { ...immutable, tarSize: 3072 },
    { ...immutable, tarSha256: b4a.alloc(32, 4) },
    { ...immutable, sourceParent: 'releases' }
  ]) {
    t.absent(b4a.equals(base, computeTreeTransferId(OWNER, changed)))
  }
  t.absent(b4a.equals(base, computeTreeTransferId(b4a.alloc(32, 32), immutable)))
})

test('a generated tree archive is deterministic, resumable, and self-describing', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'releases', '0.18.1')
  await writeTree(source, { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'zzz' })
  const manifest = await buildTreeManifest(source, OWNER)
  t.is(manifest.sourceParent, 'releases')
  t.is(manifest.entryCount, 4)
  t.is(manifest.tarSize, deterministicTreeTarSize(manifest.snapshot.entries))
  const whole = await collect(manifest)
  t.is(whole.byteLength, manifest.tarSize)
  const rebuilt = await buildTreeManifest(source, OWNER)
  t.alike(rebuilt.tarSha256, manifest.tarSha256)
  t.alike(rebuilt.treeSha256, manifest.treeSha256)
  t.alike(rebuilt.transferId, manifest.transferId)
  for (const offset of [0, 512, 1024, manifest.tarSize - 1024, manifest.tarSize]) {
    const suffix = await collect(manifest, offset)
    t.alike(suffix, whole.subarray(offset))
  }
  assertTreeMetadataTransferId(OWNER, treeMetadataFromManifest(manifest))
  const forged = { ...treeMetadataFromManifest(manifest), entryCount: manifest.entryCount + 1 }
  t.exception(() => assertTreeMetadataTransferId(OWNER, forged), {
    code: ERRORS.PROTOCOL_INVALID
  })
})

test('an empty directory and an opted-out parent still produce a valid artifact', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, 'empty')
  await fs.promises.mkdir(source)
  const manifest = await buildTreeManifest(source, OWNER, { includeSourceParent: false })
  t.is(manifest.entryCount, 0)
  t.is(manifest.payloadBytes, 0)
  t.is(manifest.tarSize, 1024)
  t.is(manifest.sourceParent, undefined)
  t.absent('sourceParent' in treeMetadataFromManifest(manifest))
  t.alike(await collect(manifest), b4a.alloc(1024))
})

test('a resume detects a mutated file, a mutated listing, and a prefix mismatch', async (t) => {
  const root = await createTempDir(t)
  const source = path.join(root, '0.18.1')
  await writeTree(source, { 'a.bin': 'aaaa', 'b.bin': 'bbbb' })
  const manifest = await buildTreeManifest(source, OWNER)
  const reset = await regenerateTreeTarSuffix(manifest, 512, () => {}, {
    expectedPrefixSha256: b4a.alloc(32, 9)
  })
  t.is(reset.status, 'RESET_REQUIRED')
  t.is(reset.bytesSent, 0)

  await fs.promises.writeFile(path.join(source, 'a.bin'), 'cccc')
  await t.exception(() => collect(manifest), { code: ERRORS.FILE_BUSY })

  const listing = await createTempDir(t)
  const second = path.join(listing, '0.18.2')
  await writeTree(second, { 'a.bin': 'aaaa' })
  const stable = await buildTreeManifest(second, OWNER)
  await fs.promises.writeFile(path.join(second, 'added.bin'), 'x')
  await t.exception(() => collect(stable), { code: ERRORS.FILE_BUSY })
})
```

- [ ] **Step 2: Register the test and run it to verify red**

Add `"test/unit/tree-manifest.test.ts"` to `tsconfig.test.json` and `require('./unit/tree-manifest.test.js')` after the storage-tree require in `test/run.ts`.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `Cannot find module '../../dist/tar-protocol/tree-manifest.js'` and `encodeTreeMetadataRecord` / `decodeAnyMetadataRecord` / `isTreeMetadata` are not exported from `controls.js`.

- [ ] **Step 3: Add the directory wire record**

In `src/tar-protocol/controls.ts`, import the tree limit and add the record type after `MetadataRecord`:

```ts
import { MAX_TREE_ENTRIES } from './tree.js'
import { TAR_BLOCK_BYTES } from './ustar.js'

/**
 * A recursive directory offer. The key set is disjoint from the file record's,
 * so an older server's `exactKeys()` check rejects it before touching storage.
 */
export interface TreeMetadataRecord {
  v: typeof CONTROL_VERSION
  kind: 'directory'
  name: string
  sourceParent?: string
  entryCount: number
  payloadBytes: number
  treeSha256: string
  tarSize: number
  tarSha256: string
  transferId: string
  reset: boolean
}

export type AnyMetadataRecord = MetadataRecord | TreeMetadataRecord

export function isTreeMetadata(value: AnyMetadataRecord): value is TreeMetadataRecord {
  return (value as TreeMetadataRecord).kind === 'directory'
}
```

Add the validator after `validateMetadata`:

```ts
const TAR_END_BLOCKS = 2 * TAR_BLOCK_BYTES

function validateTreeMetadata(value: unknown): TreeMetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  const expected = [
    'v',
    'kind',
    'name',
    'entryCount',
    'payloadBytes',
    'treeSha256',
    'tarSize',
    'tarSha256',
    'transferId',
    'reset'
  ]
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) expected.push('sourceParent')
  exactKeys(value, expected)
  assertVersion(value.v)
  if (value.kind !== 'directory') throw invalid('Invalid artifact kind')
  assertName(value.name)
  if (Object.prototype.hasOwnProperty.call(value, 'sourceParent')) {
    assertSourceParent(value.sourceParent)
  }
  assertSafeUint(value.entryCount, 'tree entry count')
  if (value.entryCount > MAX_TREE_ENTRIES) throw invalid('Invalid tree entry count')
  assertSafeUint(value.payloadBytes, 'tree payload size')
  assertHex32(value.treeSha256, 'tree digest')
  assertSafeUint(value.tarSize, 'TAR size')
  assertHex32(value.tarSha256, 'TAR digest')
  assertHex32(value.transferId, 'transfer ID')
  if (typeof value.reset !== 'boolean') throw invalid('Invalid reset flag')
  const headers = TAR_BLOCK_BYTES * value.entryCount
  const minimum = TAR_END_BLOCKS + headers + value.payloadBytes
  const maximum = minimum + (TAR_BLOCK_BYTES - 1) * value.entryCount
  if (value.tarSize % TAR_BLOCK_BYTES !== 0 || value.tarSize < minimum || value.tarSize > maximum) {
    throw invalid('Noncanonical TAR size')
  }
  return value as unknown as TreeMetadataRecord
}

function validateAnyMetadata(value: unknown): AnyMetadataRecord {
  if (!isRecord(value)) throw invalid('Metadata record must be an object')
  return Object.prototype.hasOwnProperty.call(value, 'kind')
    ? validateTreeMetadata(value)
    : validateMetadata(value)
}
```

Add the codecs next to the existing metadata codecs:

```ts
export function encodeTreeMetadataRecord(value: TreeMetadataRecord): Buffer {
  return encodeRecord(value, validateTreeMetadata)
}

export function decodeTreeMetadataRecord(bytes: Uint8Array): TreeMetadataRecord {
  return validateTreeMetadata(parseRecord(bytes))
}

export function encodeAnyMetadataRecord(value: AnyMetadataRecord): Buffer {
  return encodeRecord(value, validateAnyMetadata)
}

export function decodeAnyMetadataRecord(bytes: Uint8Array): AnyMetadataRecord {
  return validateAnyMetadata(parseRecord(bytes))
}
```

- [ ] **Step 4: Dispatch metadata on the wire**

In `src/tar-protocol/direct-wire.ts`, replace the metadata imports and writer:

```ts
import {
  decodeAdmissionRecord,
  decodeAnyMetadataRecord,
  decodeFinalRecord,
  encodeAdmissionRecord,
  encodeAnyMetadataRecord,
  encodeFinalRecord,
  MAX_CONTROL_RECORD_BYTES,
  type AdmissionRecord,
  type AnyMetadataRecord,
  type FinalRecord
} from './controls.js'
```

```ts
export function writeMetadata(
  socket: DirectDhtSocket,
  metadata: AnyMetadataRecord,
  options: ProtocolWriteOptions = {}
): Promise<void> {
  return writeFramedProtocolRecord(socket as never, encodeAnyMetadataRecord(metadata), options)
}
```

```ts
export const decodeDirectMetadata = decodeAnyMetadataRecord
```

- [ ] **Step 5: Implement tree manifest generation and resume**

Create `src/tar-protocol/tree-manifest.ts`:

```ts
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { safeFileOpenFlags } from '../storage/layout.js'
import {
  assertSourceParent,
  CONTROL_VERSION,
  decodeTreeMetadataRecord,
  encodeTreeMetadataRecord,
  type TreeMetadataRecord
} from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import type { TarResumeResult } from './manifest.js'
import { deriveSourceParent } from './manifest.js'
import {
  assertCanonicalTreeEntries,
  assertSameTreeIdentity,
  hashField,
  revalidateTreeSnapshot,
  snapshotTree,
  tarEntryName,
  treeDigest,
  type TreeDigestEntry,
  type TreeSnapshot,
  type TreeSnapshotEntry
} from './tree.js'
import {
  canonicalUstarTreeHeader,
  deterministicTreeTarSize,
  TAR_BLOCK_BYTES,
  TAR_DIRECTORY_MODE,
  TAR_GID,
  TAR_GNAME,
  TAR_MODE,
  TAR_MTIME_MS,
  TAR_UID,
  TAR_UNAME
} from './ustar.js'
import { MAX_TREE_DEPTH, MAX_TREE_ENTRIES } from './tree.js'

export const TREE_TRANSFER_DOMAIN = 'swarm-deploy/direct-tree/v1'
const READ_BYTES = 64 * 1024

export interface TreeManifest {
  kind: 'directory'
  path: string
  name: string
  sourceParent?: string
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
  tarSize: number
  tarSha256: Buffer
  transferId: Buffer
  snapshot: TreeSnapshot
}

export interface TreeManifestOptions {
  signal?: AbortSignalLike | null
  includeSourceParent?: boolean
}

export interface TreeResumeOptions {
  signal?: AbortSignalLike | null
  expectedPrefixSha256?: Uint8Array | null
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertClientKey(key: Uint8Array): void {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw invalid('Invalid client public key')
}

function canonicalName(directoryPath: string): string {
  const name = validateBasename(path.basename(path.resolve(directoryPath)))
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
  }
  return name
}

export function computeTreeTransferId(
  clientPublicKey: Uint8Array,
  immutable: {
    name: string
    sourceParent?: string
    entryCount: number
    payloadBytes: number
    treeSha256: Uint8Array
    tarSize: number
    tarSha256: Uint8Array
  }
): Buffer {
  assertClientKey(clientPublicKey)
  for (const [label, value] of [
    ['tree entry count', immutable.entryCount],
    ['tree payload size', immutable.payloadBytes],
    ['TAR size', immutable.tarSize]
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw invalid(`Invalid ${label}`)
    }
  }
  if (!b4a.isBuffer(immutable.treeSha256) || immutable.treeSha256.byteLength !== 32) {
    throw invalid('Invalid tree digest')
  }
  if (!b4a.isBuffer(immutable.tarSha256) || immutable.tarSha256.byteLength !== 32) {
    throw invalid('Invalid TAR digest')
  }
  const hash = new SodiumSha256()
  hashField(hash, 'domain', TREE_TRANSFER_DOMAIN)
  hashField(hash, 'clientPublicKey', clientPublicKey)
  hashField(hash, 'kind', 'directory')
  hashField(hash, 'name', immutable.name)
  if (immutable.sourceParent !== undefined) {
    assertSourceParent(immutable.sourceParent)
    hashField(hash, 'sourceParent', immutable.sourceParent)
  }
  hashField(hash, 'entryCount', immutable.entryCount)
  hashField(hash, 'payloadBytes', immutable.payloadBytes)
  hashField(hash, 'treeSha256', immutable.treeSha256)
  hashField(hash, 'tarSize', immutable.tarSize)
  hashField(hash, 'tarSha256', immutable.tarSha256)
  hashField(hash, 'fileMode', TAR_MODE)
  hashField(hash, 'directoryMode', TAR_DIRECTORY_MODE)
  hashField(hash, 'uid', TAR_UID)
  hashField(hash, 'gid', TAR_GID)
  hashField(hash, 'mtimeMs', TAR_MTIME_MS)
  hashField(hash, 'uname', TAR_UNAME)
  hashField(hash, 'gname', TAR_GNAME)
  hashField(hash, 'maxDepth', MAX_TREE_DEPTH)
  hashField(hash, 'maxEntries', MAX_TREE_ENTRIES)
  hashField(hash, 'pax', 'none')
  return hash.digest()
}

async function* readEntryPayload(
  entry: TreeSnapshotEntry,
  signal: AbortSignalLike | null | undefined
): AsyncGenerator<Buffer> {
  const handle = await fs.promises.open(entry.absolutePath, safeFileOpenFlags('read'))
  try {
    assertSameTreeIdentity(entry.identity, await handle.stat(), 'Tree entry changed while opening')
    let position = 0
    while (position < entry.size) {
      throwIfAborted(signal)
      const chunk = b4a.alloc(Math.min(READ_BYTES, entry.size - position))
      const read = await handle.read(chunk, 0, chunk.byteLength, position)
      const count = typeof read === 'number' ? read : read.bytesRead
      if (count !== chunk.byteLength) {
        throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree entry was truncated')
      }
      position += count
      yield chunk
    }
    assertSameTreeIdentity(
      entry.identity,
      await handle.stat(),
      'Tree entry changed during TAR generation'
    )
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Yields the exact deterministic archive, hashing each entry payload in order. */
async function* generateTreeTar(
  snapshot: TreeSnapshot,
  digests: TreeDigestEntry[],
  signal: AbortSignalLike | null | undefined
): AsyncGenerator<Buffer> {
  for (const entry of snapshot.entries) {
    throwIfAborted(signal)
    yield canonicalUstarTreeHeader(tarEntryName(entry), entry.kind, entry.size)
    if (entry.kind === 'directory') {
      digests.push({ entry: { kind: entry.kind, path: entry.path, size: 0 } })
      continue
    }
    const hash = new SodiumSha256()
    for await (const chunk of readEntryPayload(entry, signal)) {
      hash.update(chunk)
      yield chunk
    }
    digests.push({
      entry: { kind: entry.kind, path: entry.path, size: entry.size },
      sha256: hash.digest()
    })
    const padding = (TAR_BLOCK_BYTES - (entry.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (padding > 0) yield b4a.alloc(padding)
  }
  yield b4a.alloc(2 * TAR_BLOCK_BYTES)
}

export async function buildTreeManifest(
  directoryPath: string,
  clientPublicKey: Uint8Array,
  { signal = null, includeSourceParent = true }: TreeManifestOptions = {}
): Promise<TreeManifest> {
  assertClientKey(clientPublicKey)
  const name = canonicalName(directoryPath)
  const sourceParent =
    includeSourceParent === false ? undefined : deriveSourceParent(path.resolve(directoryPath))
  const snapshot = await snapshotTree(directoryPath, { signal })
  assertCanonicalTreeEntries(snapshot.entries)
  const digests: TreeDigestEntry[] = []
  const tarHash = new SodiumSha256()
  let tarSize = 0
  for await (const chunk of generateTreeTar(snapshot, digests, signal)) {
    tarHash.update(chunk)
    tarSize += chunk.byteLength
  }
  await revalidateTreeSnapshot(snapshot, { signal })
  if (tarSize !== deterministicTreeTarSize(snapshot.entries)) {
    throw invalid('Noncanonical deterministic TAR length')
  }
  const treeSha256 = treeDigest(digests)
  const tarSha256 = tarHash.digest()
  const transferId = computeTreeTransferId(clientPublicKey, {
    name,
    ...(sourceParent === undefined ? {} : { sourceParent }),
    entryCount: snapshot.entryCount,
    payloadBytes: snapshot.payloadBytes,
    treeSha256,
    tarSize,
    tarSha256
  })
  return {
    kind: 'directory',
    path: directoryPath,
    name,
    ...(sourceParent === undefined ? {} : { sourceParent }),
    entryCount: snapshot.entryCount,
    payloadBytes: snapshot.payloadBytes,
    treeSha256,
    tarSize,
    tarSha256,
    transferId,
    snapshot
  }
}

export async function regenerateTreeTarSuffix(
  manifest: TreeManifest,
  offset: number,
  write: (chunk: Buffer) => void | Promise<void>,
  { signal = null, expectedPrefixSha256 = null }: TreeResumeOptions = {}
): Promise<TarResumeResult> {
  if (!manifest || typeof manifest !== 'object') throw invalid('Invalid tree manifest')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > manifest.tarSize) {
    throw invalid('Invalid TAR resume offset')
  }
  if (typeof write !== 'function') throw invalid('Invalid TAR suffix writer')
  if (
    expectedPrefixSha256 !== null &&
    (!b4a.isBuffer(expectedPrefixSha256) || expectedPrefixSha256.byteLength !== 32)
  ) {
    throw invalid('Invalid expected prefix digest')
  }

  const digests: TreeDigestEntry[] = []
  const tarHash = new SodiumSha256()
  const prefixHash = new SodiumSha256()
  let position = 0
  let bytesSent = 0
  let prefixSha256: Buffer | null = offset === 0 ? prefixHash.digest() : null
  let resetRequired =
    prefixSha256 !== null &&
    expectedPrefixSha256 !== null &&
    !sodium.sodium_memcmp(prefixSha256, expectedPrefixSha256)

  for await (const chunk of generateTreeTar(manifest.snapshot, digests, signal)) {
    throwIfAborted(signal)
    tarHash.update(chunk)
    const end = position + chunk.byteLength
    if (position < offset) {
      const prefixEnd = Math.min(chunk.byteLength, offset - position)
      prefixHash.update(chunk.subarray(0, prefixEnd))
      if (end >= offset) {
        prefixSha256 = prefixHash.digest()
        if (expectedPrefixSha256 && !sodium.sodium_memcmp(prefixSha256, expectedPrefixSha256)) {
          resetRequired = true
        }
        if (!resetRequired && prefixEnd < chunk.byteLength) {
          const suffix = chunk.subarray(prefixEnd)
          await write(suffix)
          bytesSent += suffix.byteLength
        }
      }
    } else if (!resetRequired) {
      await write(chunk)
      bytesSent += chunk.byteLength
    }
    position = end
  }
  await revalidateTreeSnapshot(manifest.snapshot, { signal })
  if (position !== manifest.tarSize || (!resetRequired && bytesSent !== manifest.tarSize - offset)) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Regenerated TAR length changed')
  }
  if (
    !digestMatches(treeDigest(digests), manifest.treeSha256) ||
    !digestMatches(tarHash.digest(), manifest.tarSha256)
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Tree changed during TAR regeneration')
  }
  if (prefixSha256 === null) throw invalid('Unable to hash TAR prefix')
  if (resetRequired) return { status: 'RESET_REQUIRED', prefixSha256, bytesSent: 0 }
  return { status: 'MATCH', prefixSha256, bytesSent }
}

export function treeMetadataFromManifest(manifest: TreeManifest, reset = false): TreeMetadataRecord {
  return {
    v: CONTROL_VERSION,
    kind: 'directory',
    name: manifest.name,
    ...(manifest.sourceParent === undefined ? {} : { sourceParent: manifest.sourceParent }),
    entryCount: manifest.entryCount,
    payloadBytes: manifest.payloadBytes,
    treeSha256: b4a.toString(manifest.treeSha256, 'hex'),
    tarSize: manifest.tarSize,
    tarSha256: b4a.toString(manifest.tarSha256, 'hex'),
    transferId: b4a.toString(manifest.transferId, 'hex'),
    reset
  }
}

export function assertTreeMetadataTransferId(
  clientPublicKey: Uint8Array,
  offeredMetadata: TreeMetadataRecord
): void {
  const metadata = decodeTreeMetadataRecord(encodeTreeMetadataRecord(offeredMetadata))
  const expected = computeTreeTransferId(clientPublicKey, {
    name: metadata.name,
    ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent }),
    entryCount: metadata.entryCount,
    payloadBytes: metadata.payloadBytes,
    treeSha256: b4a.from(metadata.treeSha256, 'hex'),
    tarSize: metadata.tarSize,
    tarSha256: b4a.from(metadata.tarSha256, 'hex')
  })
  if (!sodium.sodium_memcmp(expected, b4a.from(metadata.transferId, 'hex'))) {
    throw invalid('Noncanonical tree transfer ID')
  }
}
```

Export `deriveSourceParent` is already public in `src/tar-protocol/manifest.ts`; reuse it unchanged.

- [ ] **Step 6: Add the deterministic tree property test**

Append to `test/unit/tar-property.test.ts`:

```ts
test('property: random safe trees frame deterministically and resume at every block', async (t) => {
  const { createTempDir } = require('../helpers/files.js') as typeof import('../helpers/files.js')
  const { writeTree } = require('../helpers/trees.js') as typeof import('../helpers/trees.js')
  const { buildTreeManifest, regenerateTreeTarSuffix } =
    require('../../dist/tar-protocol/tree-manifest.js') as typeof import('../../dist/tar-protocol/tree-manifest.js')
  const owner = b4a.alloc(32, 44)
  const next = random(SEED ^ 0x1234abcd)
  for (let iteration = 0; iteration < 25; iteration++) {
    const root = await createTempDir(t)
    const source = `${root}/artifact`
    const spec: Record<string, string> = {}
    const files = 1 + (next() % 6)
    for (let index = 0; index < files; index++) {
      const depth = 1 + (next() % 3)
      const segments = Array.from({ length: depth }, (_value, level) => `d${level}${next() % 3}`)
      spec[`${segments.join('/')}/f${index}.bin`] = 'x'.repeat(next() % 1500)
    }
    spec[`empty${next() % 3}/`] = ''
    await writeTree(source, spec)

    const manifest = await buildTreeManifest(source, owner)
    const chunks: Buffer[] = []
    await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    const whole = b4a.concat(chunks)
    t.is(whole.byteLength, manifest.tarSize)
    const rebuilt = await buildTreeManifest(source, owner)
    t.alike(rebuilt.transferId, manifest.transferId)
    for (let offset = 0; offset <= manifest.tarSize; offset += 512) {
      const suffix: Buffer[] = []
      const result = await regenerateTreeTarSuffix(manifest, offset, (chunk) => {
        suffix.push(b4a.from(chunk))
      })
      t.is(result.status, 'MATCH')
      t.alike(b4a.concat(suffix), whole.subarray(offset))
    }
  }
})
```

- [ ] **Step 7: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tree-manifest.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tree-manifest.test.js
./node_modules/.bin/brittle-node .test-dist/unit/tar-protocol.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tar-protocol.test.js
npm run test:property
```

Expected: all pass. `tar-protocol.test.js` proves `decodeMetadataRecord` still rejects anything but the exact file key set.

- [ ] **Step 8: Self-review and commit**

Confirm `git diff -- src/tar-protocol/manifest.ts` is empty and that `validateMetadata` is unmodified.

```bash
git diff --stat -- src/tar-protocol/manifest.ts
git add src/tar-protocol/controls.ts src/tar-protocol/direct-wire.ts \
  src/tar-protocol/tree-manifest.ts test/unit/tree-manifest.test.ts \
  test/unit/tar-property.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: frame a directory as one deterministic archive"
```

Expected: the `manifest.ts` diff is empty.

---

### Task 4: Tree extraction and malicious archive rejection

**Files:**

- Create: `src/tar-protocol/tree-extract.ts`
- Create: `test/unit/tree-extract.test.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: `TreeMetadataRecord`, `decodeTreeMetadataRecord()`, `encodeTreeMetadataRecord()` from Task 3; `canonicalUstarTreeHeader()` from Task 1.
- Produces: `TreeFileSink`, `TreeExtractionTarget`, `TreeExtractionResult`, `TreeExtractionOptions`, `validateAndExtractTreeTar()`.

- [ ] **Step 1: Write the failing extraction test**

Create `test/unit/tree-extract.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import { treeMetadataFromManifest, buildTreeManifest, regenerateTreeTarSuffix } from '../../dist/tar-protocol/tree-manifest.js'
import {
  validateAndExtractTreeTar,
  type TreeExtractionTarget
} from '../../dist/tar-protocol/tree-extract.js'
import { canonicalUstarTreeHeader } from '../../dist/tar-protocol/ustar.js'
import type { TreeMetadataRecord } from '../../dist/tar-protocol/controls.js'
import { createTempDir } from '../helpers/files.js'
import { writeTree } from '../helpers/trees.js'

const OWNER = b4a.alloc(32, 57)

interface MemoryTarget extends TreeExtractionTarget {
  directories: string[]
  files: Map<string, Buffer>
  aborted: unknown
  completed: boolean
}

function memoryTarget(): MemoryTarget {
  const directories: string[] = []
  const files = new Map<string, Buffer>()
  const target: MemoryTarget = {
    directories,
    files,
    aborted: null,
    completed: false,
    createDirectory(relativePath) {
      directories.push(relativePath)
      return Promise.resolve()
    },
    createFile(relativePath) {
      const chunks: Buffer[] = []
      return Promise.resolve({
        write(chunk) {
          chunks.push(b4a.from(chunk))
          return Promise.resolve()
        },
        close() {
          files.set(relativePath, b4a.concat(chunks))
          return Promise.resolve()
        }
      })
    },
    complete() {
      target.completed = true
      return Promise.resolve()
    },
    abort(error) {
      target.aborted = error
      return Promise.resolve()
    }
  }
  return target
}

async function fixture(
  t: Parameters<Parameters<typeof test>[1]>[0],
  spec: Record<string, string>
): Promise<{ metadata: TreeMetadataRecord; archive: Buffer }> {
  const source = path.join(await createTempDir(t), '0.18.1')
  await writeTree(source, spec)
  const manifest = await buildTreeManifest(source, OWNER)
  const chunks: Buffer[] = []
  await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { metadata: treeMetadataFromManifest(manifest), archive: b4a.concat(chunks) }
}

function feed(archive: Buffer, size = 97): Buffer[] {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < archive.byteLength; offset += size) {
    chunks.push(archive.subarray(offset, Math.min(offset + size, archive.byteLength)))
  }
  return chunks
}

test('a canonical tree archive extracts with an independently recomputed digest', async (t) => {
  const { metadata, archive } = await fixture(t, {
    'a/b.bin': 'bb',
    'a/empty/': '',
    'z.bin': 'zzz'
  })
  const target = memoryTarget()
  const result = await validateAndExtractTreeTar(feed(archive), metadata, target)
  t.is(result.entryCount, metadata.entryCount)
  t.is(result.payloadBytes, metadata.payloadBytes)
  t.is(result.tarSize, metadata.tarSize)
  t.is(b4a.toString(result.treeSha256, 'hex'), metadata.treeSha256)
  t.is(b4a.toString(result.tarSha256, 'hex'), metadata.tarSha256)
  t.alike(target.directories, ['a', 'a/empty'])
  t.alike([...target.files.keys()].sort(), ['a/b.bin', 'z.bin'])
  t.alike(target.files.get('a/b.bin'), b4a.from('bb'))
  t.is(target.completed, true)
  t.is(target.aborted, null)
})

test('an empty directory artifact extracts to no entries', async (t) => {
  const { metadata, archive } = await fixture(t, {})
  const target = memoryTarget()
  const result = await validateAndExtractTreeTar([archive], metadata, target)
  t.is(result.entryCount, 0)
  t.is(result.tarSize, 1024)
  t.alike(target.directories, [])
  t.is(target.files.size, 0)
})

test('extraction rejects every malicious or noncanonical archive', async (t) => {
  const { metadata, archive } = await fixture(t, { 'a/b.bin': 'bb', 'z.bin': 'zzz' })

  const mutate = (change: (bytes: Buffer) => Buffer): Promise<void> => {
    const target = memoryTarget()
    return t
      .exception(() => validateAndExtractTreeTar([change(b4a.from(archive))], metadata, target), {
        code: /PROTOCOL_INVALID|INVALID_FILENAME|CHECKSUM_MISMATCH/
      })
      .then(() => {
        t.not(target.aborted, null)
        t.is(target.completed, false)
      })
  }

  // Path traversal in the first header's name field.
  await mutate((bytes) => {
    bytes.fill(0, 0, 100)
    bytes.set(b4a.from('../escape'), 0)
    return bytes
  })
  // Absolute path.
  await mutate((bytes) => {
    bytes.fill(0, 0, 100)
    bytes.set(b4a.from('/etc/passwd'), 0)
    return bytes
  })
  // Backslash and NUL-bearing components.
  await mutate((bytes) => {
    bytes.fill(0, 0, 100)
    bytes.set(b4a.from('a\\b.bin'), 0)
    return bytes
  })
  // Symlink, hardlink, character device, block device, FIFO, and PAX typeflags.
  for (const typeflag of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K']) {
    await mutate((bytes) => {
      bytes[156] = typeflag.charCodeAt(0)
      return bytes
    })
  }
  // Non-normalized mode.
  await mutate((bytes) => {
    bytes.set(b4a.from('000777 '), 100)
    return bytes
  })
  // Non-zero mtime.
  await mutate((bytes) => {
    bytes.set(b4a.from('12345670000 '), 136)
    return bytes
  })
  // Non-zero USTAR prefix field.
  await mutate((bytes) => {
    bytes.set(b4a.from('evil'), 345)
    return bytes
  })
  // Duplicate relative path: replace the second header name with the first.
  await mutate((bytes) => {
    const second = 512 + 512
    bytes.fill(0, second, second + 100)
    bytes.set(b4a.from('a'), second)
    return bytes
  })
  // Non-zero payload padding.
  await mutate((bytes) => {
    bytes[512 + 512 + 512 + 2] = 1
    return bytes
  })
  // Non-zero trailing terminator block.
  await mutate((bytes) => {
    bytes[bytes.byteLength - 1] = 1
    return bytes
  })

  // Truncated archive.
  const truncated = memoryTarget()
  await t.exception(
    () => validateAndExtractTreeTar([archive.subarray(0, archive.byteLength - 1024)], metadata, truncated),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  // Trailing data after the exact deterministic length.
  const trailing = memoryTarget()
  await t.exception(
    () => validateAndExtractTreeTar([b4a.concat([archive, b4a.alloc(512)])], metadata, trailing),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  // A digest that does not match the offered tree digest.
  const forged = memoryTarget()
  await t.exception(
    () => validateAndExtractTreeTar([archive], { ...metadata, treeSha256: 'f'.repeat(64) }, forged),
    { code: ERRORS.CHECKSUM_MISMATCH }
  )
})

test('extraction rejects a child before its parent and an over-count bomb', async (t) => {
  const orphan = b4a.concat([
    canonicalUstarTreeHeader('a/b.bin', 'file', 1),
    b4a.alloc(512),
    b4a.alloc(1024)
  ])
  const orphanMetadata: TreeMetadataRecord = {
    v: 1,
    kind: 'directory',
    name: '0.18.1',
    entryCount: 1,
    payloadBytes: 1,
    treeSha256: 'a'.repeat(64),
    tarSize: orphan.byteLength,
    tarSha256: 'b'.repeat(64),
    transferId: 'c'.repeat(64),
    reset: false
  }
  await t.exception(() => validateAndExtractTreeTar([orphan], orphanMetadata, memoryTarget()), {
    code: ERRORS.PROTOCOL_INVALID
  })

  const headers: Buffer[] = []
  for (let index = 0; index < 4; index++) {
    headers.push(canonicalUstarTreeHeader(`d${index}`, 'directory', 0))
  }
  const bomb = b4a.concat([...headers, b4a.alloc(1024)])
  await t.exception(
    () =>
      validateAndExtractTreeTar(
        [bomb],
        { ...orphanMetadata, entryCount: 2, payloadBytes: 0, tarSize: bomb.byteLength },
        memoryTarget()
      ),
    { code: ERRORS.PROTOCOL_INVALID }
  )
})
```

- [ ] **Step 2: Register the test and run it to verify red**

Add `"test/unit/tree-extract.test.ts"` to `tsconfig.test.json` and `require('./unit/tree-extract.test.js')` after the tree-manifest require in `test/run.ts`.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `Cannot find module '../../dist/tar-protocol/tree-extract.js'`.

- [ ] **Step 3: Implement the streaming canonical tree reader**

Create `src/tar-protocol/tree-extract.ts`:

```ts
import b4a from 'b4a'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import {
  decodeTreeMetadataRecord,
  encodeTreeMetadataRecord,
  type TreeMetadataRecord
} from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import {
  assertTreeEntryPath,
  compareTreePaths,
  MAX_TREE_ENTRIES,
  treeDigest,
  type TreeDigestEntry,
  type TreeEntry
} from './tree.js'
import { canonicalUstarTreeHeader, TAR_BLOCK_BYTES } from './ustar.js'

export interface TreeFileSink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface TreeExtractionTarget {
  createDirectory(relativePath: string): Promise<void>
  createFile(relativePath: string, size: number): Promise<TreeFileSink>
  complete(): Promise<void>
  abort(error: unknown): Promise<void>
}

export interface TreeExtractionOptions {
  signal?: AbortSignalLike | null
}

export interface TreeExtractionResult {
  entries: TreeEntry[]
  entryCount: number
  payloadBytes: number
  treeSha256: Buffer
  tarSize: number
  tarSha256: Buffer
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  let value = 0
  let digits = 0
  for (let index = offset; index < offset + length; index++) {
    const byte = block[index]
    if (byte === 0x20 || byte === 0) break
    if (byte < 0x30 || byte > 0x37) throw invalid('Noncanonical tree TAR header')
    value = value * 8 + (byte - 0x30)
    digits++
    if (!Number.isSafeInteger(value)) throw invalid('Noncanonical tree TAR header')
  }
  if (digits === 0) throw invalid('Noncanonical tree TAR header')
  return value
}

function parseStoredName(block: Buffer): string {
  let end = 0
  while (end < 100 && block[end] !== 0) end++
  for (let index = end; index < 100; index++) {
    if (block[index] !== 0) throw invalid('Noncanonical tree TAR header')
  }
  if (end === 0) throw invalid('Noncanonical tree TAR header')
  return b4a.toString(block.subarray(0, end), 'utf8')
}

/**
 * Validates and extracts a canonical multi-entry tree archive.
 *
 * Only the name, typeflag, and size fields are parsed. Every other field is
 * proved by rebuilding the whole 512-byte canonical header and comparing it
 * byte for byte, so mode, uid, gid, mtime, uname, gname, magic, checksum, and
 * the USTAR prefix are all pinned by one comparison.
 */
export async function validateAndExtractTreeTar(
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  offeredMetadata: TreeMetadataRecord,
  target: TreeExtractionTarget,
  { signal = null }: TreeExtractionOptions = {}
): Promise<TreeExtractionResult> {
  if (
    !target ||
    typeof target !== 'object' ||
    typeof target.createDirectory !== 'function' ||
    typeof target.createFile !== 'function' ||
    typeof target.complete !== 'function' ||
    typeof target.abort !== 'function'
  ) {
    throw invalid('Invalid tree extraction target')
  }
  const metadata = decodeTreeMetadataRecord(encodeTreeMetadataRecord(offeredMetadata))
  const tarHash = new SodiumSha256()
  const digests: TreeDigestEntry[] = []
  const directories = new Set<string>()
  const folded = new Set<string>()

  let position = 0
  let pending: Buffer = b4a.alloc(0)
  let payloadBytes = 0
  let previousPath: string | null = null
  let terminatorBlocks = 0
  let sink: TreeFileSink | null = null
  let sinkHash: SodiumSha256 | null = null
  let sinkEntry: TreeEntry | null = null
  let payloadRemaining = 0
  let paddingRemaining = 0

  const consumeHeader = async (block: Buffer): Promise<void> => {
    if (block.every((byte) => byte === 0)) {
      terminatorBlocks++
      if (terminatorBlocks > 2) throw invalid('Trailing tree TAR payload')
      return
    }
    if (terminatorBlocks > 0) throw invalid('Tree TAR entry after terminator')
    const storedName = parseStoredName(block)
    const typeflag = block[156]
    if (typeflag !== 48 && typeflag !== 53) throw invalid('Unsupported tree TAR entry type')
    const kind = typeflag === 53 ? 'directory' : 'file'
    if (kind === 'directory' && !storedName.endsWith('/')) {
      throw invalid('Noncanonical tree TAR header')
    }
    if (kind === 'file' && storedName.endsWith('/')) throw invalid('Noncanonical tree TAR header')
    const relativePath = kind === 'directory' ? storedName.slice(0, -1) : storedName
    assertTreeEntryPath(relativePath, kind)
    const size = parseOctal(block, 124, 12)
    if (kind === 'directory' && size !== 0) throw invalid('Invalid tree directory size')
    if (!b4a.equals(block, canonicalUstarTreeHeader(storedName, kind, size))) {
      throw invalid('Noncanonical tree TAR header')
    }
    if (digests.length >= Math.min(metadata.entryCount, MAX_TREE_ENTRIES)) {
      throw invalid('Tree TAR entry count exceeds the offer')
    }
    if (previousPath !== null && compareTreePaths(previousPath, relativePath) >= 0) {
      throw invalid('Noncanonical tree entry order')
    }
    const fold = relativePath.toLowerCase()
    if (folded.has(fold)) throw invalid('Case-folded duplicate tree entry path')
    folded.add(fold)
    const separator = relativePath.lastIndexOf('/')
    if (separator !== -1 && !directories.has(relativePath.slice(0, separator))) {
      throw invalid('Tree entry has no parent directory entry')
    }
    previousPath = relativePath
    const entry: TreeEntry = { kind, path: relativePath, size: kind === 'directory' ? 0 : size }
    if (kind === 'directory') {
      directories.add(relativePath)
      digests.push({ entry })
      await target.createDirectory(relativePath)
      return
    }
    if (payloadBytes > metadata.payloadBytes - size) throw invalid('Tree payload exceeds the offer')
    payloadBytes += size
    sinkEntry = entry
    sinkHash = new SodiumSha256()
    sink = await target.createFile(relativePath, size)
    payloadRemaining = size
    paddingRemaining = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    if (payloadRemaining === 0) await closeSink()
  }

  const closeSink = async (): Promise<void> => {
    if (!sink || !sinkHash || !sinkEntry) throw invalid('Tree extraction state is inconsistent')
    await sink.close()
    digests.push({ entry: sinkEntry, sha256: sinkHash.digest() })
    sink = null
    sinkHash = null
    sinkEntry = null
  }

  try {
    throwIfAborted(signal)
    for await (const value of source) {
      throwIfAborted(signal)
      if (!b4a.isBuffer(value)) throw invalid('Invalid TAR source bytes')
      if (position > metadata.tarSize - value.byteLength) throw invalid('Trailing tree TAR payload')
      tarHash.update(value)
      position += value.byteLength
      let offset = 0
      while (offset < value.byteLength) {
        if (payloadRemaining > 0) {
          const take = Math.min(payloadRemaining, value.byteLength - offset)
          const chunk = value.subarray(offset, offset + take)
          sinkHash!.update(chunk)
          await sink!.write(chunk)
          payloadRemaining -= take
          offset += take
          if (payloadRemaining === 0) await closeSink()
          continue
        }
        if (paddingRemaining > 0) {
          const take = Math.min(paddingRemaining, value.byteLength - offset)
          for (let index = offset; index < offset + take; index++) {
            if (value[index] !== 0) throw invalid('Nonzero tree TAR padding')
          }
          paddingRemaining -= take
          offset += take
          continue
        }
        const take = Math.min(TAR_BLOCK_BYTES - pending.byteLength, value.byteLength - offset)
        pending = b4a.concat([pending, value.subarray(offset, offset + take)])
        offset += take
        if (pending.byteLength < TAR_BLOCK_BYTES) continue
        const block = pending
        pending = b4a.alloc(0)
        await consumeHeader(block)
      }
    }
    if (
      pending.byteLength !== 0 ||
      payloadRemaining !== 0 ||
      paddingRemaining !== 0 ||
      sink !== null
    ) {
      throw invalid('Truncated tree TAR payload')
    }
    if (position !== metadata.tarSize) throw invalid('Truncated tree TAR payload')
    if (terminatorBlocks !== 2) throw invalid('Missing tree TAR terminator')
    if (digests.length !== metadata.entryCount) throw invalid('Tree entry count mismatch')
    if (payloadBytes !== metadata.payloadBytes) throw invalid('Tree payload size mismatch')
    const treeSha256 = treeDigest(digests)
    const tarSha256 = tarHash.digest()
    if (!digestMatches(treeSha256, b4a.from(metadata.treeSha256, 'hex'))) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Extracted tree digest mismatch')
    }
    if (!digestMatches(tarSha256, b4a.from(metadata.tarSha256, 'hex'))) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'TAR digest mismatch')
    }
    await target.complete()
    return {
      entries: digests.map((value) => value.entry),
      entryCount: digests.length,
      payloadBytes,
      treeSha256,
      tarSize: metadata.tarSize,
      tarSha256
    }
  } catch (error) {
    await Promise.resolve(target.abort(error)).catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw invalid('Tree extraction failed', error)
  }
}
```

- [ ] **Step 4: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tree-extract.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tree-extract.test.js
```

Expected: both pass with no warnings.

- [ ] **Step 5: Self-review and commit**

Confirm the reader never concatenates a parsed archive path to any absolute path, never trusts a checksum field, and that every malicious case in the test aborts the target exactly once.

```bash
rg -n 'path\.join|path\.resolve' src/tar-protocol/tree-extract.ts
npm run format && npm run lint
git add src/tar-protocol/tree-extract.ts test/unit/tree-extract.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: verify a canonical recursive tree archive"
```

Expected: the `rg` command prints nothing; lint exits 0.

---

### Task 5: Default recursive directory upload in the client

**Files:**

- Modify: `src/files.ts`
- Modify: `src/client.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Modify: `test/unit/files.test.ts`
- Modify: `test/unit/direct-behavior.test.ts`
- Modify: `test/integration/behavior-observability.test.ts`
- Modify: `test/integration/direct-upload.test.ts`
- Modify: `test/integration/source-parent-optout.test.ts`

This task proves client behavior only, against the fake socket and fake DHT node that `test/unit/direct-behavior.test.ts` already defines. It writes no test that needs a server able to accept a directory offer; those live in Task 12, written failing and made green there. The three integration files are touched only to delete assertions and narrowing guards for the batch result shape that this task removes, so every suite still compiles and passes at this commit.

**Interfaces:**

- Consumes: `buildTreeManifest()`, `regenerateTreeTarSuffix()`, `treeMetadataFromManifest()`, `TreeManifest` from Task 3; `decodeTreeMetadataRecord()` from Task 3.
- Produces: `UploadTarget`, `SelectUploadTargetOptions`, `selectUploadTarget()` replacing `selectUploadPaths()`, `UploadPathSelection`, `SelectedUploadPath`, `SkippedUploadPath`, `FailedUploadPath`, `UploadPathEntry`, and `SkippedUploadReason`.
- Produces: `UploadResult` gains `kind: ArtifactKind` and optional `entryCount`; `ClientUploadResult` becomes an alias of `UploadResult`; `BatchUploadResult`, `BatchUploadFailure`, `SkippedUploadEntry`, and the `skipped` client event are removed.

- [ ] **Step 1: Rewrite the failing selection test**

Replace the first four tests in `test/unit/files.test.ts` with:

```ts
import { selectUploadTarget, validateBasename, validateReplaceNames } from '../../dist/files.js'

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
```

Keep the final `basename and replacement policy` test unchanged.

- [ ] **Step 2: Write the failing client wire test against the fake socket**

`test/unit/direct-behavior.test.ts` already defines `FakeSocket` and `fakeClientNode(socket)` and already drives a real `Client` through them (`test/unit/direct-behavior.test.ts:483` and `:504`). That is the full client boundary this task needs: a directory upload can be proven end to end on the wire without any server. Append:

```ts
test('Client uploads a directory as one directory offer and one canonical tree archive', async (t) => {
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true })
  await fs.promises.writeFile(path.join(source, 'b.txt'), 'b')
  await fs.promises.writeFile(path.join(source, 'nested', 'a.txt'), 'a')

  const socket = new FakeSocket(keyPairFromSeed(SERVER_SEED).publicKey)
  socket.onWrite = (_bytes, index) => {
    if (index === 0) {
      queueMicrotask(() =>
        socket.feed(encodeControlFrame(encodeAdmissionRecord({ v: 1, status: 'ACCEPT', offset: 0 })))
      )
    }
    return true
  }
  socket.onEnd = () =>
    socket.feed(encodeControlFrame(encodeFinalRecord({ v: 1, status: 'COMMITTED' })))
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 5_000,
    dht: fakeClientNode(socket)
  })
  const events: Array<{ name: string; kind: string; status: string; final: boolean }> = []
  client.on('result', (event) => events.push(event))
  t.teardown(() => client.close())

  const result = await client.upload(source)
  t.is(result.status, 'COMMITTED')
  t.is(result.kind, 'directory')
  t.is(result.name, '0.18.1')
  t.is(result.entryCount, 3)
  t.is(result.size, 2)
  t.alike(events, [{ name: '0.18.1', kind: 'directory', status: 'COMMITTED', final: true }])

  // Exactly one offer frame, and it is a directory offer, not a batch of children.
  const offer = decodeTreeMetadataRecord(socket.writes[0].subarray(4))
  t.is(offer.kind, 'directory')
  t.is(offer.name, '0.18.1')
  t.is(offer.entryCount, 3)
  t.is(offer.payloadBytes, 2)
  t.is(offer.sourceParent, path.basename(path.dirname(source)))

  // The payload is byte-identical to the canonical archive the manifest describes.
  const manifest = await buildTreeManifest(source, keyPairFromSeed(CLIENT_SEED).publicKey)
  const expected: Buffer[] = []
  await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
    expected.push(b4a.from(chunk))
  })
  t.ok(b4a.equals(b4a.concat(socket.writes.slice(1)), b4a.concat(expected)))
  t.is(offer.tarSize, manifest.tarSize)
})

test('Client reports a single-file upload as kind file with no entry count', async (t) => {
  const input = path.join(await createTempDir(t), 'artifact.txt')
  await fs.promises.writeFile(input, 'payload')
  const socket = new FakeSocket(keyPairFromSeed(SERVER_SEED).publicKey)
  socket.onWrite = (_bytes, index) => {
    if (index === 0) {
      queueMicrotask(() =>
        socket.feed(encodeControlFrame(encodeAdmissionRecord({ v: 1, status: 'ACCEPT', offset: 0 })))
      )
    }
    return true
  }
  socket.onEnd = () =>
    socket.feed(encodeControlFrame(encodeFinalRecord({ v: 1, status: 'COMMITTED' })))
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: keyPairFromSeed(SERVER_SEED).publicKey,
    idleTimeout: 5_000,
    dht: fakeClientNode(socket)
  })
  t.teardown(() => client.close())

  const result = await client.upload(input)
  t.is(result.kind, 'file')
  t.is(result.name, 'artifact.txt')
  t.is(result.entryCount, undefined)
  t.is(decodeMetadataRecord(socket.writes[0].subarray(4)).name, 'artifact.txt')
})
```

Extend that file's imports with `encodeFinalRecord`, `decodeMetadataRecord`, and `decodeTreeMetadataRecord` from `../../dist/tar-protocol/controls.js`, and add:

```ts
import {
  buildTreeManifest,
  regenerateTreeTarSuffix
} from '../../dist/tar-protocol/tree-manifest.js'
```

- [ ] **Step 3: Delete the obsolete batch assertions from the integration suites**

`UploadResult` stops being a union in this task, so three integration assertions describe a shape that no longer exists. Deleting them is required for `tsc -p tsconfig.test.json` to pass; nothing is skipped, and the replacement server-side directory coverage is written and made green in Task 12.

In `test/integration/behavior-observability.test.ts`:

- Delete the whole `directory uploads emit per-file nonfinal results and one exact aggregate result` test (`test/integration/behavior-observability.test.ts:133` through the closing `})` at `:183`). It asserts `result.results`, `result.skipped`, and per-file nonfinal `result` events, all of which this task removes.
- Delete `type ClientResultEvent` from the `../../dist/index.js` import list; after the test above is gone it has no remaining use in the file.

In `test/integration/direct-upload.test.ts`, delete the now-dead narrowing guard:

```ts
  if (!('size' in result)) throw new Error('Expected single upload result')
```

In `test/integration/source-parent-optout.test.ts`, delete the equivalent dead guard:

```ts
  if (!('transferId' in result)) throw new Error('Expected single upload result')
```

- [ ] **Step 4: Run the focused suites to verify red**

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports that `selectUploadTarget` is not exported from `../../dist/files.js`, that `kind` and `entryCount` do not exist on `UploadResult`, and that `kind` does not exist on the `result` event payload.

- [ ] **Step 5: Replace batch selection with single-target selection**

In `src/files.ts`, delete `classifyEntry`, `SelectedEntry`, `SkippedEntry`, `ClassifiedEntry`, `SkippedUploadReason`, `SelectedUploadPath`, `SkippedUploadPath`, `FailedUploadPath`, `UploadPathEntry`, `UploadPathSelection`, `SelectUploadPathsOptions`, and `selectUploadPaths`, and add:

```ts
export interface SelectUploadTargetOptions {
  signal?: {
    readonly aborted: boolean
    addEventListener(event: 'abort', callback: () => void, options?: { once?: boolean }): void
    removeEventListener(event: 'abort', callback: () => void): void
  } | null
}

export interface UploadTarget {
  kind: ArtifactKind
  /** The managed artifact basename. */
  name: string
  path: string
}

/**
 * Classifies one upload input. A directory becomes exactly one recursive
 * directory artifact; children are never uploaded independently.
 */
export async function selectUploadTarget(
  inputPath: string,
  { signal = null }: SelectUploadTargetOptions = {}
): Promise<UploadTarget> {
  throwIfAborted(signal)
  const stat = await fs.promises.lstat(inputPath)
  throwIfAborted(signal)
  if (stat.isSymbolicLink()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Symlinks are not supported')
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file or directory')
  }
  const name = validateBasename(path.basename(path.resolve(inputPath)))
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved artifact name')
  }
  return { kind: stat.isDirectory() ? 'directory' : 'file', name, path: inputPath }
}
```

Add `import type { ArtifactKind } from './types.js'` at the top.

- [ ] **Step 6: Upload a directory as one artifact**

In `src/client.ts`:

Replace the `files.js` import with `import { selectUploadTarget } from './files.js'` and add:

```ts
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest,
  type TreeManifest
} from './tar-protocol/tree-manifest.js'
import type { AnyMetadataRecord } from './tar-protocol/controls.js'
import type { ArtifactKind } from './types.js'
```

Delete `BatchUploadFailure`, `SkippedUploadEntry`, `BatchUploadResult`, the `skipped` entry of `ClientEventMap`, and the `files`/`committed`/`failed`/`skipped` fields of `ClientResultEvent`. Then:

```ts
export interface UploadResult {
  status: UploadStatus
  kind: ArtifactKind
  name: string
  /** Payload bytes: the file size, or the aggregate regular-file bytes of a tree. */
  size: number
  /** The file digest, or the canonical tree digest of a directory artifact. */
  digest: Digest
  transferId: TransferId
  /** Present only for a directory artifact. */
  entryCount?: number
}
export type ClientUploadResult = UploadResult
export interface ClientResultEvent {
  name: string
  kind: ArtifactKind
  status: UploadStatus | ErrorCode
  final: boolean
}
```

Add the manifest adapters above the class:

```ts
type AnyManifest = TarManifest | TreeManifest

function isTreeManifest(manifest: AnyManifest): manifest is TreeManifest {
  return 'kind' in manifest && manifest.kind === 'directory'
}
function manifestMetadata(manifest: AnyManifest, reset: boolean): AnyMetadataRecord {
  return isTreeManifest(manifest)
    ? treeMetadataFromManifest(manifest, reset)
    : metadataFromManifest(manifest, reset)
}
function manifestPayloadBytes(manifest: AnyManifest): number {
  return isTreeManifest(manifest) ? manifest.payloadBytes : manifest.fileSize
}
function manifestDigest(manifest: AnyManifest): Buffer {
  return isTreeManifest(manifest) ? manifest.treeSha256 : manifest.fileSha256
}
function regenerateSuffix(
  manifest: AnyManifest,
  offset: number,
  write: (chunk: Buffer) => void | Promise<void>,
  options: { signal: AbortSignalLike; expectedPrefixSha256: Uint8Array | null }
): Promise<TarResumeResult> {
  return isTreeManifest(manifest)
    ? regenerateTreeTarSuffix(manifest, offset, write, options)
    : regenerateTarSuffix(manifest, offset, write, options)
}
```

Import `TarResumeResult` from `./tar-protocol/manifest.js`. Change `uploadManifest(manifest: AnyManifest, ...)` to build metadata with `manifestMetadata(manifest, reset)`, regenerate with `regenerateSuffix(...)`, and return:

```ts
  private result(manifest: AnyManifest, status: UploadStatus, final: boolean): UploadResult {
    const kind: ArtifactKind = isTreeManifest(manifest) ? 'directory' : 'file'
    const result: UploadResult = {
      status,
      kind,
      name: manifest.name,
      size: manifestPayloadBytes(manifest),
      digest: b4a.from(manifestDigest(manifest)),
      transferId: b4a.from(manifest.transferId),
      ...(isTreeManifest(manifest) ? { entryCount: manifest.entryCount } : {})
    }
    this.logger.info('Direct upload completed', { name: result.name, status: result.status })
    this.emitSafe('result', { name: result.name, kind, status, final })
    return result
  }
```

Replace `perform()` with:

```ts
  private async perform(inputPath: string): Promise<UploadResult> {
    if (typeof inputPath !== 'string' || !inputPath) {
      throw fail(ERRORS.INVALID_FILENAME, 'Invalid upload path')
    }
    const target = await selectUploadTarget(inputPath, { signal: this.signal })
    const options = { signal: this.signal, includeSourceParent: this.includeSourceParent }
    return this.uploadManifest(
      target.kind === 'directory'
        ? await buildTreeManifest(target.path, this.publicKey, options)
        : await buildTarManifest(target.path, this.publicKey, options)
    )
  }
  upload(inputPath: string): Promise<UploadResult> { /* unchanged body */ }
```

In the `upload()` catch handler, the final failure event now needs a name and kind; capture them before the queue:

```ts
  upload(inputPath: string): Promise<UploadResult> {
    if (this.closed) return Promise.reject(fail(ERRORS.ABORTED, 'Client is closed'))
    const operation = this.queue
      .then(() => this.perform(inputPath))
      .catch((error: unknown) => {
        const reason = codeOf(error)
        this.emitSafe('failure', { fingerprint: fingerprint(this.serverPublicKey), reason })
        throw error
      })
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
```

The successful `result` event is already emitted by `result()`, so the failure path emits only `failure`.

- [ ] **Step 7: Simplify the CLI upload output and public exports**

In `src/cli.ts`, replace `printUploadResult` with:

```ts
function printUploadResult(result: ClientUploadResult, io: CliIo): number {
  writeLine(io.stdout, `${result.name} ${result.kind} ${result.status}`)
  return result.status === 'COMMITTED' || result.status === 'ALREADY_COMMITTED' ? 0 : 1
}
```

In `src/index.ts`, remove `SkippedUploadReason`, `BatchUploadFailure`, `BatchUploadResult`, and `SkippedUploadEntry`, and add:

```ts
export type { ArtifactKind } from './types.js'
export type { UploadTarget } from './files.js'
```

- [ ] **Step 8: Run the focused suites on Node and Bare to verify green**

Run the unit suites in the sandbox and the integration suites outside it, because HyperDHT network-interface discovery needs local OS access:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/files.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/files.test.js
./node_modules/.bin/brittle-node .test-dist/unit/direct-behavior.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/direct-behavior.test.js
./node_modules/.bin/brittle-node .test-dist/integration/direct-upload.test.js
./node_modules/.bin/brittle-node .test-dist/integration/behavior-observability.test.js
./node_modules/.bin/brittle-node .test-dist/integration/source-parent-optout.test.js
```

Expected: all pass on both runtimes. File uploads are byte-unchanged, so every remaining integration assertion holds.

- [ ] **Step 9: Self-review and commit**

Confirm no `skipped` emitter, batch loop, or per-child manifest build remains, and that no test was skipped rather than converted:

```bash
rg -n 'skipped|BatchUpload|selectUploadPaths' src
rg -n 'test\.skip' test
npm run format && npm run lint
git add src/files.ts src/client.ts src/cli.ts src/index.ts \
  test/unit/files.test.ts test/unit/direct-behavior.test.ts \
  test/integration/direct-upload.test.ts test/integration/behavior-observability.test.ts \
  test/integration/source-parent-optout.test.ts
git commit -m "feat: upload a directory as one recursive artifact"
```

Expected: both `rg` commands print nothing.

---

### Task 6: Directory sessions at persisted version 4

**Files:**

- Create: `src/storage/tree-staging.ts`
- Modify: `src/storage/tar-session-store.ts`
- Modify: `test/unit/tar-session-store.test.ts`

**Interfaces:**

- Consumes: `validateAndExtractTreeTar()` and `TreeExtractionTarget` from Task 4; `createTreeRoot()`, `createTreeSubdirectory()`, `openTreeFile()`, `syncTreeDirectories()`, `removeTree()`, `inspectTreePath()`, `digestTree()` from Task 2.
- Produces: `createTreeStagingTarget()` from `src/storage/tree-staging.ts`.
- Produces: `TREE_SESSION_VERSION = 4`; `TarSession` gains required `kind: ArtifactKind`, optional `entryCount`, and optional `treePath`; `admit()`, `append()`, `verify()` accept `AnyMetadataRecord`.

- [ ] **Step 1: Write the failing session test**

Append to `test/unit/tar-session-store.test.ts` (reusing the file's existing `createStore`/`createTempDir`/`createStorage` helpers):

```ts
async function treeInput(
  t: Assert,
  name: string,
  spec: Record<string, string>
): Promise<{ metadata: TreeMetadataRecord; archive: Buffer }> {
  const source = path.join(await createTempDir(t), name)
  await writeTree(source, spec)
  const manifest = await buildTreeManifest(source, OWNER)
  const chunks: Buffer[] = []
  await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { metadata: treeMetadataFromManifest(manifest), archive: b4a.concat(chunks) }
}

test('a directory session verifies into a staging tree at version 4', async (t) => {
  const { store, layout } = await createStore(t)
  const tree = await treeInput(t, '0.18.1', { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'zzz' })
  t.alike(await store.admit(OWNER, tree.metadata), { status: 'ACCEPT', offset: 0 })
  await store.append(OWNER, tree.metadata, 0, tree.archive)
  const session = await store.verify(OWNER, tree.metadata)
  t.is(session.kind, 'directory')
  t.is(session.entryCount, tree.metadata.entryCount)
  t.is(session.size, tree.metadata.payloadBytes)
  t.is(session.treePath, path.join(layout.staging, `${tree.metadata.transferId}.tree`))

  const persisted = JSON.parse(
    await fs.promises.readFile(
      path.join(layout.sessions, `${tree.metadata.transferId}.json`),
      'utf8'
    )
  ) as { version: number; kind: string; entryCount: number }
  t.is(persisted.version, 4)
  t.is(persisted.kind, 'directory')
  t.is(persisted.entryCount, tree.metadata.entryCount)

  const digested = await digestTree(session.treePath!, createStorage())
  t.is(b4a.toString(digested.treeSha256, 'hex'), tree.metadata.treeSha256)
  t.alike(
    (await store.readVerified(b4a.from(tree.metadata.transferId, 'hex'))).kind,
    'directory'
  )
})

test('a file session keeps writing version 2 or 3 and reports kind file', async (t) => {
  const { store, layout } = await createStore(t)
  const file = await input(t, 'payload.bin', b4a.from('payload'))
  await store.admit(OWNER, file.metadata)
  await store.append(OWNER, file.metadata, 0, file.archive)
  const session = await store.verify(OWNER, file.metadata)
  t.is(session.kind, 'file')
  t.is(session.treePath, undefined)
  const persisted = JSON.parse(
    await fs.promises.readFile(
      path.join(layout.sessions, `${file.metadata.transferId}.json`),
      'utf8'
    )
  ) as { version: number }
  t.ok(persisted.version === 2 || persisted.version === 3)
})

test('a verified directory session survives a restart and rejects a kind change', async (t) => {
  const { store, layout, storage } = await createStore(t)
  const tree = await treeInput(t, '0.18.1', { 'a.bin': 'aaaa' })
  await store.admit(OWNER, tree.metadata)
  await store.append(OWNER, tree.metadata, 0, tree.archive)
  await store.verify(OWNER, tree.metadata)
  await store.close()

  const restarted = new TarSessionStore({ layout, maxStagingBytes: 1024 * 1024, storage })
  t.teardown(() => restarted.close())
  await restarted.init()
  t.alike(await restarted.admit(OWNER, tree.metadata), { status: 'VERIFIED' })
  const session = await restarted.readVerified(b4a.from(tree.metadata.transferId, 'hex'))
  t.is(session.kind, 'directory')

  const fileShape = {
    v: 1 as const,
    name: tree.metadata.name,
    fileSize: 4,
    fileSha256: 'a'.repeat(64),
    tarSize: 2048,
    tarSha256: 'b'.repeat(64),
    transferId: tree.metadata.transferId,
    reset: false
  }
  await t.exception(() => restarted.admit(OWNER, fileShape), { code: ERRORS.PROTOCOL_INVALID })
})

test('a partial directory session resumes at its durable TAR offset', async (t) => {
  const { store } = await createStore(t)
  const tree = await treeInput(t, '0.18.1', { 'a.bin': 'a'.repeat(900), 'b/c.bin': 'cc' })
  await store.admit(OWNER, tree.metadata)
  await store.append(OWNER, tree.metadata, 0, tree.archive.subarray(0, 1024))
  const resumed = await store.admit(OWNER, tree.metadata)
  if (resumed.status !== 'RESUME') throw new Error('Expected a resume')
  t.is(resumed.offset, 1024)
  await store.append(OWNER, tree.metadata, 1024, tree.archive.subarray(1024))
  t.is((await store.verify(OWNER, tree.metadata)).state, 'verified')
})

test('startup removes a stray staging tree with no session and no journal', async (t) => {
  const { store, layout, storage } = await createStore(t)
  await store.close()
  const stray = path.join(layout.staging, `${'a'.repeat(64)}.tree`)
  await writeTree(stray, { 'nested/x.bin': 'x' })
  const restarted = new TarSessionStore({ layout, maxStagingBytes: 1024 * 1024, storage })
  t.teardown(() => restarted.close())
  await restarted.init()
  await t.exception(() => fs.promises.lstat(stray))
  t.ok(restarted.purgedSessions >= 1)
})

test('deleting a directory session removes its staging tree', async (t) => {
  const { store, layout } = await createStore(t)
  const tree = await treeInput(t, '0.18.1', { 'a.bin': 'a' })
  await store.admit(OWNER, tree.metadata)
  await store.append(OWNER, tree.metadata, 0, tree.archive)
  await store.verify(OWNER, tree.metadata)
  const treePath = path.join(layout.staging, `${tree.metadata.transferId}.tree`)
  t.ok((await fs.promises.lstat(treePath)).isDirectory())
  t.is(await store.delete(b4a.from(tree.metadata.transferId, 'hex')), true)
  await t.exception(() => fs.promises.lstat(treePath))
  t.is(store.reservedBytes, 0)
})
```

Add these imports to the file:

```ts
import { digestTree } from '../../dist/storage/tree-fs.js'
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import type { TreeMetadataRecord } from '../../dist/tar-protocol/controls.js'
import { writeTree } from '../helpers/trees.js'
```

If the file's existing fixture helper is not named `input` or `createStore`, rename the new helpers' calls to the file's existing ones rather than adding duplicates.

- [ ] **Step 2: Run the focused suite to verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tar-session-store.test.js
```

Expected: FAIL — compilation reports `kind` and `treePath` do not exist on `TarSession` and that `admit` does not accept a `TreeMetadataRecord`.

- [ ] **Step 3: Implement the tree staging target**

Create `src/storage/tree-staging.ts`:

```ts
import type { TreeExtractionTarget, TreeFileSink } from '../tar-protocol/tree-extract.js'
import {
  createTreeRoot,
  createTreeSubdirectory,
  openTreeFile,
  removeTree,
  syncTreeDirectories
} from './tree-fs.js'
import type { StorageAdapter } from './types.js'

/**
 * Writes an extracted tree into `treePath`, which must live directly under
 * `parent`. Every path is created exclusively, with no-follow opens, from
 * validated components only.
 */
export function createTreeStagingTarget(
  treePath: string,
  parent: string,
  storage: StorageAdapter
): TreeExtractionTarget {
  let created = false
  const ensureRoot = async (): Promise<void> => {
    if (created) return
    await createTreeRoot(treePath, parent, storage)
    created = true
  }
  return {
    async createDirectory(relativePath: string): Promise<void> {
      await ensureRoot()
      await createTreeSubdirectory(treePath, relativePath, storage)
    },
    async createFile(relativePath: string): Promise<TreeFileSink> {
      await ensureRoot()
      const handle = await openTreeFile(treePath, relativePath, storage)
      let position = 0
      return {
        async write(chunk: Uint8Array): Promise<void> {
          let offset = 0
          while (offset < chunk.byteLength) {
            const written = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              position + offset
            )
            const count = typeof written === 'number' ? written : written.bytesWritten
            if (!Number.isSafeInteger(count) || count <= 0) {
              throw new Error('Unable to write staged tree file')
            }
            offset += count
          }
          position += chunk.byteLength
        },
        async close(): Promise<void> {
          await handle.sync()
          await handle.close()
        }
      }
    },
    async complete(): Promise<void> {
      await ensureRoot()
      await syncTreeDirectories(treePath, storage)
    },
    async abort(): Promise<void> {
      if (!created) return
      await removeTree(treePath, parent, storage).catch(() => {})
    }
  }
}
```

- [ ] **Step 4: Persist and verify directory sessions**

In `src/storage/tar-session-store.ts`:

```ts
const VERSION = 3
const LEGACY_VERSION = 2
export const TREE_SESSION_VERSION = 4
```

```ts
export interface TarSession {
  id: string
  transferId: Buffer
  ownerKey: Buffer
  kind: ArtifactKind
  name: string
  sourceParent?: string
  /** Payload bytes: the file size, or the aggregate tree payload size. */
  size: number
  /** The file digest, or the canonical tree digest. */
  digest: Buffer
  /** Present only for a directory session. */
  entryCount?: number
  tarSize: number
  tarDigest: Buffer
  tarPath: string
  /** Present only for a directory session. */
  treePath?: string
  state: State
  createdAt: number
  updatedAt: number
  partialTarSize: number
}

interface PersistedTreeSession {
  version: typeof TREE_SESSION_VERSION
  kind: 'directory'
  transferId: string
  ownerKey: string
  name: string
  sourceParent?: string
  entryCount: number
  payloadBytes: number
  treeSha256: string
  tarSize: number
  tarSha256: string
  partialTar: { path: string; size: number }
  createdAt: number
  updatedAt: number
  state: State
}
```

Replace the private `metadata()` with:

```ts
  private metadata(input: AnyMetadataRecord): AnyMetadataRecord {
    return decodeAnyMetadataRecord(encodeAnyMetadataRecord(input))
  }

  private treeStagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.tree`)
  }
```

Extend `sameMetadata`:

```ts
function sameMetadata(
  session: TarSession,
  metadata: AnyMetadataRecord,
  owner: Uint8Array
): boolean {
  if (!sodium.sodium_memcmp(session.ownerKey, owner)) return false
  if (session.name !== metadata.name) return false
  if (session.sourceParent !== metadata.sourceParent) return false
  if (session.tarSize !== metadata.tarSize) return false
  if (!sodium.sodium_memcmp(session.tarDigest, b4a.from(metadata.tarSha256, 'hex'))) return false
  if (isTreeMetadata(metadata)) {
    return (
      session.kind === 'directory' &&
      session.entryCount === metadata.entryCount &&
      session.size === metadata.payloadBytes &&
      sodium.sodium_memcmp(session.digest, b4a.from(metadata.treeSha256, 'hex'))
    )
  }
  return (
    session.kind === 'file' &&
    session.size === metadata.fileSize &&
    sodium.sodium_memcmp(session.digest, b4a.from(metadata.fileSha256, 'hex'))
  )
}
```

In `fromDisk`, dispatch on version 4 first:

```ts
    if (record.version === TREE_SESSION_VERSION) return this.treeFromDisk(id, record)
```

and add:

```ts
  private treeFromDisk(id: string, record: Record<string, unknown>): TarSession {
    const persisted = record as unknown as PersistedTreeSession
    if (persisted.kind !== 'directory' || persisted.transferId !== id) {
      throw problem('Invalid tree session')
    }
    const ownerKey = bytes(persisted.ownerKey, 'owner key')
    uint(persisted.entryCount, 'tree entry count')
    uint(persisted.payloadBytes, 'tree payload size')
    uint(persisted.tarSize, 'TAR size')
    uint(persisted.createdAt, 'creation time')
    uint(persisted.updatedAt, 'update time')
    if (
      !persisted.partialTar ||
      persisted.partialTar.path !== `${id}.tar.part` ||
      ![RECEIVING, VERIFIED, DELETING].includes(persisted.state)
    ) {
      throw problem('Invalid tree session metadata')
    }
    uint(persisted.partialTar.size, 'partial TAR size')
    if (persisted.partialTar.size > persisted.tarSize) throw problem('Oversized partial TAR')
    const metadata = decodeTreeMetadataRecord(
      encodeTreeMetadataRecord({
        v: 1,
        kind: 'directory',
        name: persisted.name,
        ...(persisted.sourceParent === undefined ? {} : { sourceParent: persisted.sourceParent }),
        entryCount: persisted.entryCount,
        payloadBytes: persisted.payloadBytes,
        treeSha256: hex(bytes(persisted.treeSha256, 'tree digest')),
        tarSize: persisted.tarSize,
        tarSha256: hex(bytes(persisted.tarSha256, 'TAR digest')),
        transferId: id,
        reset: false
      })
    )
    assertTreeMetadataTransferId(ownerKey, metadata)
    return {
      id,
      transferId: b4a.from(id, 'hex'),
      ownerKey,
      kind: 'directory',
      name: metadata.name,
      sourceParent: metadata.sourceParent,
      size: metadata.payloadBytes,
      digest: b4a.from(metadata.treeSha256, 'hex'),
      entryCount: metadata.entryCount,
      tarSize: metadata.tarSize,
      tarDigest: b4a.from(metadata.tarSha256, 'hex'),
      tarPath: this.tarPath(id),
      treePath: this.treeStagingPath(id),
      partialTarSize: persisted.partialTar.size,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      state: persisted.state
    }
  }
```

In the existing `fromDisk` return, add `kind: 'file'`. In `serialize`, dispatch:

```ts
  private serialize(session: TarSession): PersistedTarSession | PersistedTreeSession {
    if (session.kind === 'directory') {
      return {
        version: TREE_SESSION_VERSION,
        kind: 'directory',
        transferId: session.id,
        ownerKey: hex(session.ownerKey),
        name: session.name,
        sourceParent: session.sourceParent,
        entryCount: session.entryCount!,
        payloadBytes: session.size,
        treeSha256: hex(session.digest),
        tarSize: session.tarSize,
        tarSha256: hex(session.tarDigest),
        partialTar: { path: `${session.id}.tar.part`, size: session.partialTarSize },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        state: session.state
      }
    }
    /* existing version 2/3 body unchanged */
  }
```

In `admit`, replace the transfer-ID assertion and session construction with kind-aware code:

```ts
      const metadata = this.metadata(input)
      if (isTreeMetadata(metadata)) assertTreeMetadataTransferId(ownerKey, metadata)
      else assertMetadataTransferId(ownerKey, metadata)
```

```ts
      const reservation = metadata.tarSize + (isTreeMetadata(metadata) ? metadata.payloadBytes : metadata.fileSize)
```

```ts
      session = isTreeMetadata(metadata)
        ? {
            id,
            transferId: b4a.from(id, 'hex'),
            ownerKey: b4a.from(ownerKey),
            kind: 'directory',
            name: metadata.name,
            sourceParent: metadata.sourceParent,
            size: metadata.payloadBytes,
            digest: b4a.from(metadata.treeSha256, 'hex'),
            entryCount: metadata.entryCount,
            tarSize: metadata.tarSize,
            tarDigest: b4a.from(metadata.tarSha256, 'hex'),
            tarPath: this.tarPath(id),
            treePath: this.treeStagingPath(id),
            partialTarSize: 0,
            createdAt: now,
            updatedAt: now,
            state: RECEIVING
          }
        : { /* existing file session literal with kind: 'file' */ }
```

In `verify`, branch the extraction:

```ts
      if (session.kind === 'directory') {
        const treePath = this.treeStagingPath(session.id)
        await removeTree(treePath, this.layout.staging, this.storage).catch(() => {})
        const target = createTreeStagingTarget(treePath, this.layout.staging, this.storage)
        try {
          await validateAndExtractTreeTar(this.readTar(session), metadata as TreeMetadataRecord, target)
          await withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
            syncDirectory(this.layout.staging, this.storage)
          )
          await this.run(async () => { /* identical VERIFIED transition as the file path */ })
          return session
        } catch (error) {
          if (session.state !== VERIFIED) {
            try {
              await removeTree(treePath, this.layout.staging, this.storage)
            } catch (cleanupCause) {
              await this.quarantineVerificationFailure(session, error, cleanupCause)
            }
          }
          throw error
        } finally {
          await this.run(() => {
            this.verifying.delete(session.id)
          })
        }
      }
```

In `readVerified`, for a directory session assert the staging tree:

```ts
      if (session.kind === 'directory') {
        if ((await inspectTreePath(session.treePath!, this.layout.staging, this.storage)) !== 'DIRECTORY') {
          throw problem('Session is not verified')
        }
        return session
      }
      await assertSafeFile(this.filePath(session.id), this.storage)
```

In `init`, extend the staging sweep so `<64hex>.tree` directories are recognized:

```ts
      const expected = new Set<string>()
      for (const session of this.sessions.values()) {
        expected.add(`${session.id}.tar.part`)
        if (session.state === VERIFIED && session.kind === 'file') expected.add(`${session.id}.part`)
        if (session.state === VERIFIED && session.kind === 'directory') {
          expected.add(`${session.id}.tree`)
        }
      }
      for (const name of await this.storage.readdir(this.layout.staging)) {
        if (expected.has(name)) continue
        const tree = /^([0-9a-f]{64})\.tree$/.exec(name)
        if (tree) {
          if (await readCommitJournal(tree[1], this.layout, this.storage)) continue
          await removeTree(path.join(this.layout.staging, name), this.layout.staging, this.storage)
          this.purgedSessions++
          continue
        }
        /* existing `.part` / `.tar.part` handling unchanged */
      }
```

In `removeSession`, remove a directory session's tree:

```ts
      await this.remove(session.tarPath, this.layout.staging)
      if (session.kind === 'directory') {
        await removeTree(this.treeStagingPath(session.id), this.layout.staging, this.storage)
      } else {
        await this.remove(this.filePath(session.id), this.layout.staging)
      }
      await this.remove(this.sessionPath(session.id), this.layout.sessions)
```

Also, in `init`'s `DELETING` branch, call `removeTree(this.treeStagingPath(id), ...)` for a directory session before removing the session file.

- [ ] **Step 5: Run the focused suite on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tar-session-store.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tar-session-store.test.js
```

Expected: both pass, including every pre-existing version 2 and 3 compatibility test.

- [ ] **Step 6: Self-review and commit**

Confirm `serialize()` still writes version 2 for a file session without a source parent and version 3 with one, and that no directory code path calls `assertSafeFile` on a tree.

```bash
rg -n 'LEGACY_VERSION|TREE_SESSION_VERSION' src/storage/tar-session-store.ts
git add src/storage/tree-staging.ts src/storage/tar-session-store.ts test/unit/tar-session-store.test.ts
git commit -m "feat: stage a verified directory tree in a session"
```

---

### Task 7: Directory commit record and journal schemas

This task changes only `src/storage/commit-journal.ts`, which is a pure schema and comparison module with no filesystem transaction in it. Everything it produces is consumed by Task 8, so it is reviewable on its own: the durable shapes, their validation, and the ordering interface.

**Files:**

- Create: `test/unit/commit-journal.test.ts`
- Modify: `src/storage/commit-journal.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: `MAX_TREE_ENTRIES` from Task 1; `validateBasename()` and `isReservedHistoryName()` from `src/files.ts`.
- Produces: `DIRECTORY_COMMIT_VERSION = 3`, `DIRECTORY_JOURNAL_VERSION = 3`, `DIRECTORY_PHASES`, `DirectoryPhase`, `DirectoryCommitJournal`, the widened `AnyCommitJournal`, `isDirectoryJournal()`, `compareCommitOrder()`, `commitRecordKind()`.
- Produces: `CommitRecord.kind` and `CommitRecord.entryCount`, the version 3 branch of `assertCommitRecordShape()`, and the version 3 branches of `serializeJournal()` and `readCommitJournal()`.

- [ ] **Step 1: Write the failing schema, ordering, and journal round-trip test**

Create `test/unit/commit-journal.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />

import test, { type Assert } from 'brittle'
import fs from '#fs'
import path from '#path'
import { ERRORS } from '../../dist/errors.js'
import {
  assertCommitRecord,
  commitRecordKind,
  compareCommitOrder,
  CorruptJournalError,
  DIRECTORY_COMMIT_VERSION,
  DIRECTORY_JOURNAL_VERSION,
  DIRECTORY_PHASES,
  isDirectoryJournal,
  readCommitJournal,
  serializeJournal,
  type CommitRecord,
  type DirectoryCommitJournal
} from '../../dist/storage/commit-journal.js'
import { MAX_TREE_ENTRIES } from '../../dist/tar-protocol/tree.js'
import { initLayout } from '../../dist/storage/layout.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'

const ID = 'a'.repeat(64)
const OTHER_ID = 'd'.repeat(64)
const DIGEST = 'b'.repeat(64)
const UPLOADER = 'c'.repeat(64)
const ATTEMPT = 'e'.repeat(64)
const IDENTITY = { dev: '66', ino: '1234' }

function directoryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: DIRECTORY_COMMIT_VERSION,
    kind: 'directory',
    name: '0.18.1',
    size: 3,
    sha256: DIGEST,
    entryCount: 4,
    committedAt: 1_000,
    uploaderFingerprint: UPLOADER,
    transferId: ID,
    ...overrides
  }
}

function fileRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: 'payload.bin',
    size: 7,
    sha256: DIGEST,
    committedAt: 1_000,
    uploaderFingerprint: UPLOADER,
    transferId: ID,
    ...overrides
  }
}

function directoryJournal(
  overrides: Partial<Record<keyof DirectoryCommitJournal, unknown>> = {}
): Record<string, unknown> {
  return {
    version: DIRECTORY_JOURNAL_VERSION,
    intent: 'create-directory',
    state: 'committing',
    phase: 'journaled',
    transferId: ID,
    attemptId: ATTEMPT,
    name: '0.18.1',
    stagingTreeName: `${ID}.tree`,
    stagingTreeIdentity: IDENTITY,
    record: directoryRecord(),
    ...overrides
  }
}

/** Writes one journal file into a fresh storage root and returns that root. */
async function writeJournal(
  t: Assert,
  id: string,
  journal: Record<string, unknown>
): Promise<string> {
  const root = await createTempDir(t)
  const layout = initLayout(root)
  await fs.promises.writeFile(path.join(layout.journals, `${id}.json`), JSON.stringify(journal))
  return root
}

test('a version 3 directory record validates and keeps its directory fields', (t) => {
  const record = assertCommitRecord(directoryRecord())
  t.is(record.version, 3)
  t.is(record.kind, 'directory')
  t.is(record.entryCount, 4)
  t.is(record.replaces, undefined)
  t.is(commitRecordKind(record), 'directory')
  t.is(commitRecordKind(assertCommitRecord(fileRecord()) as CommitRecord), 'file')
  t.alike([...DIRECTORY_PHASES], ['journaled', 'renamed', 'sidecar', 'cleanup'])
})

test('a malformed directory record is rejected field by field', (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wrong kind', directoryRecord({ kind: 'file' })],
    ['absent kind', directoryRecord({ kind: undefined })],
    ['absent entry count', directoryRecord({ entryCount: undefined })],
    ['fractional entry count', directoryRecord({ entryCount: 1.5 })],
    ['negative entry count', directoryRecord({ entryCount: -1 })],
    ['entry count above the ceiling', directoryRecord({ entryCount: MAX_TREE_ENTRIES + 1 })],
    [
      'replacement metadata',
      directoryRecord({
        replaces: { name: '0.18.0', transferId: OTHER_ID, historyName: `history-${OTHER_ID}` }
      })
    ],
    ['unknown version', directoryRecord({ version: 4 })],
    ['reserved name', directoryRecord({ name: `history-${OTHER_ID}` })]
  ]
  for (const [label, candidate] of cases) {
    t.exception(() => assertCommitRecord(candidate), { code: ERRORS.PROTOCOL_INVALID }, label)
  }
})

test('a file or replacement record never carries directory fields', (t) => {
  t.exception(() => assertCommitRecord(fileRecord({ kind: 'directory' })), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(() => assertCommitRecord(fileRecord({ entryCount: 1 })), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.exception(
    () =>
      assertCommitRecord(
        fileRecord({
          version: 2,
          kind: 'directory',
          replaces: { name: 'current', transferId: OTHER_ID, historyName: `history-${OTHER_ID}` }
        })
      ),
    { code: ERRORS.PROTOCOL_INVALID }
  )
  t.execution(() => assertCommitRecord(fileRecord()))
})

test('commit order is newest first and total across equal timestamps', (t) => {
  const at = (committedAt: number, transferId: string, name: string): CommitRecord =>
    assertCommitRecord({ ...fileRecord(), committedAt, transferId, name })
  const newest = at(30, ID, 'c.bin')
  const tieLow = at(20, '1'.repeat(64), 'b.bin')
  const tieHigh = at(20, '2'.repeat(64), 'a.bin')
  const sorted = [tieHigh, newest, tieLow].sort(compareCommitOrder)
  t.alike(
    sorted.map((record) => record.transferId),
    [newest.transferId, tieLow.transferId, tieHigh.transferId]
  )
  // A total order: reversing the input cannot change the result.
  t.alike(
    [tieLow, newest, tieHigh].sort(compareCommitOrder).map((record) => record.transferId),
    sorted.map((record) => record.transferId)
  )
  t.is(compareCommitOrder(newest, newest), 0)
  const sameId = at(20, ID, 'a.bin')
  const sameIdLater = at(20, ID, 'z.bin')
  t.ok(compareCommitOrder(sameId, sameIdLater) < 0)
})

test('a directory journal round-trips through serialize and read', async (t) => {
  const journal = directoryJournal()
  const serialized = serializeJournal(journal as unknown as DirectoryCommitJournal)
  t.alike(Object.keys(serialized).sort(), [
    'attemptId',
    'intent',
    'name',
    'phase',
    'record',
    'stagingTreeIdentity',
    'stagingTreeName',
    'state',
    'transferId',
    'version'
  ])
  const root = await writeJournal(t, ID, serialized)
  const read = await readCommitJournal(ID, initLayout(root), createStorage())
  t.ok(isDirectoryJournal(read))
  t.alike(read, journal)
  t.absent(isDirectoryJournal(null))
})

test('every directory phase survives a durable phase transition', async (t) => {
  for (const phase of DIRECTORY_PHASES) {
    const journal = directoryJournal({ phase })
    const root = await writeJournal(
      t,
      ID,
      serializeJournal(journal as unknown as DirectoryCommitJournal)
    )
    const read = await readCommitJournal(ID, initLayout(root), createStorage())
    t.is(read && 'phase' in read ? read.phase : null, phase)
  }
})

test('a corrupt directory journal is rejected instead of silently repaired', async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wrong intent', directoryJournal({ intent: 'replace' })],
    ['unknown state', directoryJournal({ state: 'done' })],
    ['unknown phase', directoryJournal({ phase: 'renaming' })],
    ['staging name mismatch', directoryJournal({ stagingTreeName: `${OTHER_ID}.tree` })],
    ['staging name is a part file', directoryJournal({ stagingTreeName: `${ID}.part` })],
    ['non-hex attempt', directoryJournal({ attemptId: 'not-hex' })],
    ['identity missing', directoryJournal({ stagingTreeIdentity: { dev: '66' } })],
    ['reserved journal name', directoryJournal({ name: `history-${OTHER_ID}` })],
    [
      'record is not a directory record',
      directoryJournal({ record: fileRecord() })
    ],
    [
      'record name disagrees with the journal name',
      directoryJournal({ record: directoryRecord({ name: '0.18.2' }) })
    ],
    [
      'record transfer disagrees with the journal ID',
      directoryJournal({ record: directoryRecord({ transferId: OTHER_ID }) })
    ]
  ]
  for (const [label, journal] of cases) {
    const root = await writeJournal(t, ID, journal)
    await t.exception(
      () => readCommitJournal(ID, initLayout(root), createStorage()),
      CorruptJournalError,
      label
    )
  }
})

test('file and replacement journals read back unchanged', async (t) => {
  const file = {
    version: 1,
    state: 'committing',
    transferId: ID,
    attemptId: ATTEMPT,
    sourceStagingIdentity: IDENTITY,
    record: fileRecord()
  }
  const root = await writeJournal(t, ID, file)
  const read = await readCommitJournal(ID, initLayout(root), createStorage())
  t.absent(isDirectoryJournal(read))
  t.is(read?.version, 1)
})
```

- [ ] **Step 2: Register the test and run it to verify red**

`tsconfig.test.json` uses an explicit `files` array, so add `"test/unit/commit-journal.test.ts"` to it, and add `require('./unit/commit-journal.test.js')` to `test/run.ts` immediately before `require('./unit/commit-recovery.test.js')`.

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/commit-journal.test.js
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports that `commitRecordKind`, `compareCommitOrder`, `DIRECTORY_COMMIT_VERSION`, `DIRECTORY_JOURNAL_VERSION`, `DIRECTORY_PHASES`, `isDirectoryJournal`, and `DirectoryCommitJournal` are not exported from `../../dist/storage/commit-journal.js`.

- [ ] **Step 3: Implement the directory record, journal, and shared commit order**

In `src/storage/commit-journal.ts`:

```ts
const COMMIT_VERSION = 1
const REPLACEMENT_COMMIT_VERSION = 2
const DIRECTORY_COMMIT_VERSION = 3
const JOURNAL_VERSION = 1
const REPLACEMENT_JOURNAL_VERSION = 2
const DIRECTORY_JOURNAL_VERSION = 3
```

```ts
export interface CommitRecord {
  version: number
  /** Present only on a version 3 directory record. */
  kind?: 'directory'
  name: string
  /** Payload bytes: the file size, or the aggregate tree payload size. */
  size: number
  /** The file digest, or the canonical tree digest. */
  sha256: string
  /** Present only on a version 3 directory record. */
  entryCount?: number
  committedAt: number
  uploaderFingerprint: string
  transferId: string
  release?: CommitRelease
  replaces?: CommitReplacement
}

/** Newest first: descending commit time, then transfer ID and name for determinism. */
export function compareCommitOrder(left: CommitRecord, right: CommitRecord): number {
  if (left.committedAt !== right.committedAt) return right.committedAt - left.committedAt
  if (left.transferId !== right.transferId) return left.transferId < right.transferId ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function commitRecordKind(record: CommitRecord): 'file' | 'directory' {
  return record.kind === 'directory' ? 'directory' : 'file'
}
```

In `assertCommitRecordShape`, accept version 3 and bound the new fields:

```ts
  if (
    candidate.version !== COMMIT_VERSION &&
    candidate.version !== REPLACEMENT_COMMIT_VERSION &&
    candidate.version !== DIRECTORY_COMMIT_VERSION
  ) {
    throw storageError('Invalid commit record version')
  }
  // existing transferId/name/size/digest/createdAt/committedAt checks stay unchanged here
  if (candidate.version === DIRECTORY_COMMIT_VERSION) {
    if (candidate.kind !== 'directory') throw storageError('Invalid commit artifact kind')
    assertSafeUint(candidate.entryCount, 'commit entry count')
    if ((candidate.entryCount as number) > MAX_TREE_ENTRIES) {
      throw storageError('Invalid commit entry count')
    }
    if (candidate.replaces !== undefined) {
      throw storageError('Unexpected commit replacement metadata')
    }
  } else {
    if (candidate.kind !== undefined) throw storageError('Unexpected commit artifact kind')
    if (candidate.entryCount !== undefined) throw storageError('Unexpected commit entry count')
  }
```

with `import { MAX_TREE_ENTRIES } from '../tar-protocol/tree.js'`. Keep the existing `REPLACEMENT_COMMIT_VERSION` replacement check. The existing `validateBasename`/`isReservedHistoryName` name check already rejects a reserved directory name, so no extra name rule is needed.

Add the journal:

```ts
export const DIRECTORY_PHASES = ['journaled', 'renamed', 'sidecar', 'cleanup'] as const
export type DirectoryPhase = (typeof DIRECTORY_PHASES)[number]

/**
 * The create-only directory transaction. A directory is published by renaming
 * its verified staging tree, so the journal names the staging tree and its
 * inode identity instead of a hardlink source.
 */
export interface DirectoryCommitJournal {
  version: 3
  intent: 'create-directory'
  state: 'committing' | 'aborting'
  phase: DirectoryPhase
  transferId: string
  attemptId: string
  name: string
  stagingTreeName: string
  stagingTreeIdentity: FileIdentity
  record: CommitRecord
}

export type AnyCommitJournal = CommitJournal | ReplacementJournal | DirectoryCommitJournal

export function isDirectoryJournal(
  journal: AnyCommitJournal | null
): journal is DirectoryCommitJournal {
  return journal !== null && journal.version === DIRECTORY_JOURNAL_VERSION
}

function parseDirectoryJournal(
  id: string,
  journal: Record<string, unknown>
): DirectoryCommitJournal {
  if (
    journal.intent !== 'create-directory' ||
    (journal.state !== 'committing' && journal.state !== 'aborting') ||
    !(DIRECTORY_PHASES as readonly string[]).includes(journal.phase as string) ||
    !sameTransferId(journal.transferId as string, id) ||
    !isHex(journal.attemptId) ||
    journal.stagingTreeName !== `${id}.tree`
  ) {
    throw new CorruptJournalError('Invalid directory journal')
  }
  let name: string
  try {
    name = validateBasename(journal.name as string)
    if (isReservedHistoryName(name)) throw storageError('Reserved directory name')
  } catch (error: unknown) {
    throw new CorruptJournalError('Invalid directory journal name', error)
  }
  const record = parseRecord(journal.record)
  if (!sameTransferId(record.transferId, id)) throw new CorruptJournalError('Commit journal ID mismatch')
  if (record.version !== DIRECTORY_COMMIT_VERSION || record.name !== name) {
    throw new CorruptJournalError('Directory journal record mismatch')
  }
  return {
    version: DIRECTORY_JOURNAL_VERSION,
    intent: 'create-directory',
    state: journal.state,
    phase: journal.phase as DirectoryPhase,
    transferId: id,
    attemptId: journal.attemptId,
    name,
    stagingTreeName: journal.stagingTreeName as string,
    stagingTreeIdentity: parseIdentity(journal.stagingTreeIdentity),
    record
  }
}
```

In `serializeJournal`, add the version 3 branch before the replacement branch, emitting exactly these ten fields in this order: `version`, `intent`, `state`, `phase`, `transferId`, `attemptId`, `name`, `stagingTreeName`, `stagingTreeIdentity`, `record`. In `readCommitJournal`, add before the replacement check:

```ts
    if (journal.version === DIRECTORY_JOURNAL_VERSION) return parseDirectoryJournal(id, journal)
```

Export `DIRECTORY_COMMIT_VERSION` and `DIRECTORY_JOURNAL_VERSION` from the final export block, and export `DIRECTORY_PHASES`, `DirectoryPhase`, `DirectoryCommitJournal`, `isDirectoryJournal`, `compareCommitOrder`, and `commitRecordKind` inline as written above.

- [ ] **Step 4: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/commit-journal.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/commit-journal.test.js
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
```

Expected: all pass. The existing commit and retention suites prove that widening `CommitRecord` and `AnyCommitJournal` left version 1 and version 2 behavior untouched.

- [ ] **Step 5: Self-review and commit**

Confirm the task changed no transaction code and that no production file outside `commit-journal.ts` moved:

```bash
git status --short
rg -n 'DIRECTORY_COMMIT_VERSION|DIRECTORY_JOURNAL_VERSION|compareCommitOrder' src
npm run format && npm run lint
git add src/storage/commit-journal.ts test/unit/commit-journal.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: add directory commit record and journal schemas"
```

Expected: the only modified source file is `src/storage/commit-journal.ts`, and the new symbols appear nowhere else in `src` yet.

---

### Task 8: Directory commit transaction and crash recovery

**Files:**

- Modify: `src/storage/commit-store.ts`
- Modify: `test/unit/commit-recovery.test.ts`

**Interfaces:**

- Consumes: everything Task 7 produces; `digestTree()` and `inspectTreePath()` from Task 2; `TarSession.kind`/`entryCount`/`treePath` from Task 6; `assertTreeMetadataTransferId()` from Task 3.
- Produces: `CommitStore._treeStagingPath()`, `_rootTreeState()`, `_commitDirectory()`, `_setDirectoryPhase()`, `_rollbackDirectory()`, `_inspectDirectory()`, `_recoverDirectoryJournal()`, `_writeFreshJournal()` (the renamed `_writeReplacementJournal`), and `CommitSession.kind`/`entryCount` plus `CommitOffer.kind`/`entryCount`.
- Does not touch `src/storage/recovery.ts`: the directory journal reuses the existing `recoverJournal` entry point, and private trash sweeping arrives with deletion in Task 9.

- [ ] **Step 1: Write the failing directory commit and recovery test**

Append to `test/unit/commit-recovery.test.ts` (reusing its existing harness helpers):

```ts
test('a directory commit publishes by rename and persists a version 3 record', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'z' })
  const record = await harness.commits.commit(session)
  t.is(record.version, 3)
  t.is(record.kind, 'directory')
  t.is(record.name, '0.18.1')
  t.is(record.entryCount, 4)
  t.is(record.size, 3)
  t.is(record.replaces, undefined)
  const finalPath = path.join(harness.layout.root, '0.18.1')
  t.ok((await fs.promises.lstat(finalPath)).isDirectory())
  t.alike((await fs.promises.readdir(finalPath)).sort(), ['a', 'z.bin'])
  await t.exception(() => fs.promises.lstat(path.join(harness.layout.staging, `${record.transferId}.tree`)))
  t.alike(await fs.promises.readdir(harness.layout.journals), [])
  t.alike((await harness.commits.list()).map((value) => value.name), ['0.18.1'])
})

test('a directory artifact is create-only and never changes kind', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  await harness.commits.commit(first)

  const second = await harness.stageTree('0.18.1', { 'a.bin': 'b' })
  await t.exception(() => harness.commits.commit(second), { code: ERRORS.FILE_EXISTS })
  await t.exception(
    () => harness.commits.commit(await harness.stageTree('0.18.1', { 'a.bin': 'c' }), {
      replaceNames: ['0.18.1']
    }),
    { code: ERRORS.FILE_EXISTS }
  )

  const asFile = await harness.stage(b4a.from('file'), '0.18.1')
  await t.exception(() => harness.commits.commit(asFile), { code: ERRORS.FILE_EXISTS })

  const fileFirst = await harness.stage(b4a.from('file'), 'plain.bin')
  await harness.commits.commit(fileFirst)
  const dirSecond = await harness.stageTree('plain.bin', { 'a.bin': 'a' })
  await t.exception(() => harness.commits.commit(dirSecond), { code: ERRORS.FILE_EXISTS })
})

test('an unchanged directory offer is already committed and a mutated one is not', async (t) => {
  const harness = await createHarness(t)
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  const record = await harness.commits.commit(session)
  const offer = {
    name: record.name,
    kind: 'directory' as const,
    size: record.size,
    entryCount: record.entryCount,
    digest: b4a.from(record.sha256, 'hex'),
    transferId: b4a.from(record.transferId, 'hex')
  }
  t.alike(await harness.commits.inspect(record.name, offer), {
    status: 'ALREADY_COMMITTED',
    record
  })
  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1', 'a.bin'), 'mutated')
  t.alike(await harness.commits.inspect(record.name, offer), { status: 'FILE_EXISTS' })
})

test('directory recovery converges from every crash boundary', async (t) => {
  // Crash after the journal is durable but before the rename.
  const beforeRename = await createHarness(
    t,
    crashStorage('after', (name, target) => name === 'sync' && target.endsWith('journals'))
  )
  const session = await beforeRename.stageTree('0.18.1', { 'a.bin': 'a' })
  await t.exception(() => beforeRename.commits.commit(session))
  t.alike(await fs.promises.readdir(beforeRename.layout.root).then((names) => names.sort()), [
    '.swarm-deploy'
  ])
  t.is(
    (await beforeRename.commits.recoverJournal(session.id, beforeRename.sessions)).status,
    'RESUMABLE'
  )
  t.alike(await fs.promises.readdir(beforeRename.layout.journals), [])

  // Crash after the rename but before the sidecar.
  const beforeSidecar = await createHarness(
    t,
    crashStorage(
      'before',
      (name, _target, destination) =>
        name === 'rename' &&
        typeof destination === 'string' &&
        destination.includes(`${path.sep}commits${path.sep}`)
    )
  )
  const renamed = await beforeSidecar.stageTree('0.18.1', { 'a.bin': 'a' })
  await t.exception(() => beforeSidecar.commits.commit(renamed))
  const recovered = await beforeSidecar.commits.recoverJournal(renamed.id, beforeSidecar.sessions)
  t.is(recovered.status, 'COMMITTED')
  t.is(recovered.record?.kind, 'directory')
  t.ok((await fs.promises.lstat(path.join(beforeSidecar.layout.root, '0.18.1'))).isDirectory())
  t.alike(await fs.promises.readdir(beforeSidecar.layout.journals), [])

  // Crash after the sidecar but before cleanup: recovery removes residue only.
  const afterSidecar = await createHarness(t)
  const cleaned = await afterSidecar.stageTree('0.18.1', { 'a.bin': 'a' })
  const record = await afterSidecar.commits.commit(cleaned)
  t.is((await afterSidecar.commits.recoverJournal(record.transferId, afterSidecar.sessions)).status, 'MISSING')
})

test('a directory recovery refuses an unmanaged path at the artifact name', async (t) => {
  const harness = await createHarness(
    t,
    crashStorage(
      'before',
      (name, _target, destination) =>
        name === 'rename' &&
        typeof destination === 'string' &&
        destination.includes(`${path.sep}commits${path.sep}`)
    )
  )
  const session = await harness.stageTree('0.18.1', { 'a.bin': 'a' })
  await t.exception(() => harness.commits.commit(session))
  await fs.promises.rm(path.join(harness.layout.root, '0.18.1'), { recursive: true })
  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1'), 'foreign')
  await t.exception(() => harness.commits.recoverJournal(session.id, harness.sessions), {
    code: ERRORS.PROTOCOL_INVALID
  })
  t.is(
    await fs.promises.readFile(path.join(harness.layout.root, '0.18.1'), 'utf8'),
    'foreign'
  )
})
```

Add two helpers to the same file. `crashStorage` is a one-shot injector built on the existing `createStorage` hooks, so `createHarness(t, storage)` keeps its current two-argument signature:

```ts
function crashStorage(
  when: 'before' | 'after',
  hit: (name: StorageOperationName, target: string, destination?: unknown) => boolean
): TestStorage {
  let crashed = false
  const trip: StorageOperationHook = (name, target, ...rest) => {
    if (crashed || !hit(name, target, rest[0])) return
    crashed = true
    throw new Error(`crash at ${name} ${target}`)
  }
  const noop: StorageOperationHook = () => {}
  return createStorage({
    beforeOperation: when === 'before' ? trip : noop,
    afterOperation: when === 'after' ? trip : noop
  })
}
```

Extend `Harness` with `stageTree(name: string, spec: Record<string, string>): Promise<TarSession>` and implement it next to the existing `stage`, mirroring it through the tree helpers:

```ts
  async function stageTree(name: string, spec: Record<string, string>): Promise<TarSession> {
    const sourceRoot = await createTempDir(t)
    await writeTree(path.join(sourceRoot, name), spec)
    const manifest = await buildTreeManifest(path.join(sourceRoot, name), OWNER)
    const metadata = treeMetadataFromManifest(manifest)
    const chunks: Buffer[] = []
    await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    await sessions.admit(OWNER, metadata)
    await sessions.append(OWNER, metadata, 0, b4a.concat(chunks))
    return sessions.verify(OWNER, metadata)
  }
```

and add it to the returned harness object and to the `Harness` interface. Add the imports:

```ts
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { writeTree } from '../helpers/trees.js'
```

and widen the existing storage-helper import to `import { createStorage, type StorageOperationHook, type StorageOperationName, type TestStorage } from '../helpers/storage.js'`.

- [ ] **Step 2: Run the focused suite to verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports that `CommitOffer` does not accept `kind` or `entryCount`; once that compiles, `commit()` rejects the directory session because `CommitSession.kind` is unknown to `assertSession`.

- [ ] **Step 3: Implement the directory commit transaction**

In `src/storage/commit-store.ts`:

Extend the session and offer shapes:

```ts
interface CommitSession {
  id: string
  transferId: Uint8Array
  ownerKey: Uint8Array
  kind: 'file' | 'directory'
  name: string
  sourceParent?: string
  size: number
  digest: Uint8Array
  entryCount?: number
  tarSize: number
  tarDigest: Uint8Array
  state: string
}

interface CommitOffer {
  name: string
  kind: 'file' | 'directory'
  size: number
  digest: Uint8Array
  entryCount?: number
  transferId: Uint8Array
  release?: ReleaseCoordinates | null
}
```

In `assertSession`, branch the authentication:

```ts
  if (candidate.kind === 'directory') {
    assertSafeUint(candidate.entryCount, 'session entry count')
    assertTreeMetadataTransferId(candidate.ownerKey as Uint8Array, {
      v: 1,
      kind: 'directory',
      name: candidate.name as string,
      ...(candidate.sourceParent === undefined
        ? {}
        : { sourceParent: candidate.sourceParent as string }),
      entryCount: candidate.entryCount as number,
      payloadBytes: candidate.size as number,
      treeSha256: toHex(candidate.digest as Uint8Array),
      tarSize: candidate.tarSize as number,
      tarSha256: toHex(candidate.tarDigest as Uint8Array),
      transferId: candidate.id,
      reset: false
    })
    return
  }
  if (candidate.kind !== 'file') throw storageError('Invalid session artifact kind')
  /* existing assertMetadataTransferId call unchanged */
```

Add paths and state helpers:

```ts
  _treeStagingPath(id: string): string {
    return path.join(this.layout.staging, `${id}.tree`)
  }

  /** The visible state of one top-level directory path, without following links. */
  _rootTreeState(name: string): Promise<TreePathState> {
    return inspectTreePath(this._finalPath(name), this.layout.root, this.storage)
  }
```

Make `_recordFromSession` kind-aware:

```ts
  _recordFromSession(session: CommitSession, release?: CommitRelease): CommitRecord {
    assertSession(session)
    const base = {
      name: session.name,
      size: session.size,
      sha256: toHex(session.digest),
      committedAt: this.clock.now(),
      uploaderFingerprint: fingerprint(session.ownerKey),
      transferId: session.id,
      ...(release === undefined ? {} : { release })
    }
    return assertRecord(
      session.kind === 'directory'
        ? {
            version: DIRECTORY_COMMIT_VERSION,
            kind: 'directory' as const,
            entryCount: session.entryCount,
            ...base
          }
        : { version: COMMIT_VERSION, ...base }
    )
  }
```

Dispatch in `_commit`, immediately after `const record = this._recordFromSession(session, release)` and the reserved-name check:

```ts
    if (session.kind === 'directory') {
      return this._commitDirectory(record, retentionManager, signal, mutable)
    }
```

Add the transaction:

```ts
  /**
   * Publishes one verified staging tree by rename. Directory artifacts are
   * create-only: a configured mutable name, an occupied destination, and a
   * kind change are all existing-name conflicts.
   */
  async _commitDirectory(
    record: CommitRecord,
    retentionManager: RetentionManager | null,
    signal: AbortSignalLike | null,
    mutable: Set<string>
  ): Promise<CommitRecord> {
    if (mutable.has(record.name)) {
      throw existsError('Directory artifacts cannot be replaced')
    }
    const treePath = this._treeStagingPath(record.transferId)
    const finalPath = this._finalPath(record.name)
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'DIRECTORY') {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Verified staging tree is missing')
    }
    const digested = await digestTree(treePath, this.storage)
    if (
      digested.entryCount !== record.entryCount ||
      digested.payloadBytes !== record.size ||
      !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
    ) {
      throw new SwarmDeployError(ERRORS.CHECKSUM_MISMATCH, 'Staging tree checksum mismatch')
    }
    const stagingTreeIdentity = fileIdentity(
      await withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
        this.storage.lstat(treePath)
      )
    )
    for (const existing of await this._scanRecords()) {
      if (existing.name === record.name) throw existsError('Destination already exists')
    }
    if ((await this._rootTreeState(record.name)) !== 'MISSING') {
      throw existsError('Destination already exists')
    }
    if (retentionManager) {
      await retentionManager._runUnlocked({ incomingBytes: record.size, trigger: 'commit' })
    }
    assertNotAborted(signal)

    const attempt = attemptId()
    let journal: DirectoryCommitJournal = {
      version: DIRECTORY_JOURNAL_VERSION,
      intent: 'create-directory',
      state: 'committing',
      phase: 'journaled',
      transferId: record.transferId,
      attemptId: attempt,
      name: record.name,
      stagingTreeName: `${record.transferId}.tree`,
      stagingTreeIdentity,
      record
    }
    await this._writeFreshJournal(journal)

    let linearized = false
    try {
      assertNotAborted(signal)
      if ((await this._rootTreeState(record.name)) !== 'MISSING') {
        throw existsError('Destination already exists')
      }
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
          this.storage.rename(treePath, finalPath)
        )
      )
      await this._syncRoot()
      journal = await this._setDirectoryPhase(journal, 'renamed')

      assertNotAborted(signal)
      await this._writeRecord(record)
      linearized = true
      journal = await this._setDirectoryPhase(journal, 'sidecar')

      await this._removeFile(this._sessionPath(record.transferId), this.layout.sessions)
      await this._removeFile(this._tarStagingPath(record.transferId), this.layout.staging)
      await this._discardJournal(record.transferId, attempt)
      return record
    } catch (err) {
      if (linearized) {
        this._reportCleanupPending(record, err)
        return record
      }
      try {
        await this._rollbackDirectory(journal)
        await this._discardJournal(record.transferId, attempt)
      } catch (cleanupError) {
        throw new AggregateError([err, cleanupError], 'Unable to roll back directory commit')
      }
      throw err
    }
  }

  async _setDirectoryPhase(
    journal: DirectoryCommitJournal,
    phase: DirectoryPhase
  ): Promise<DirectoryCommitJournal> {
    const next: DirectoryCommitJournal = { ...journal, phase }
    await writeAtomic(
      this._journalPath(journal.transferId),
      b4a.from(JSON.stringify(serializeJournal(next))),
      this.storage
    )
    return next
  }

  /** Returns a proven renamed tree to staging; a foreign destination is preserved. */
  async _rollbackDirectory(journal: DirectoryCommitJournal): Promise<void> {
    const finalPath = this._finalPath(journal.name)
    const treePath = this._treeStagingPath(journal.transferId)
    if ((await this._rootTreeState(journal.name)) !== 'DIRECTORY') return
    const visible = fileIdentity(
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.lstat(finalPath)
      )
    )
    if (!identitiesEqual(visible, journal.stagingTreeIdentity)) {
      throw storageError('Foreign artifact at directory destination')
    }
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'MISSING') {
      throw storageError('Directory staging tree already exists')
    }
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.staging, this.storage, () =>
        this.storage.rename(finalPath, treePath)
      )
    )
    await this._syncRoot()
  }
```

`_writeFreshJournal` is the existing `_writeReplacementJournal` (`src/storage/commit-store.ts:556`) renamed and widened: change its signature to `async _writeFreshJournal(journal: ReplacementJournal | DirectoryCommitJournal): Promise<void>` and update its single existing caller in `_replace` (`src/storage/commit-store.ts:1172`). Its body already treats the journal opaquely, so no other change is needed. Keep the doc comment, reworded to "A replacement or directory commit always starts a fresh attempt; leftovers belong to recovery."

Make inspection kind-aware. In `inspect`, validate the offer kind and dispatch:

```ts
    if (offer.kind !== 'file' && offer.kind !== 'directory') {
      throw storageError('Invalid commit offer kind')
    }
    if (offer.kind === 'directory') assertSafeUint(offer.entryCount, 'commit offer entry count')
```

and in `_inspect`, before the existing regular-file logic:

```ts
    if (offer.kind === 'directory') return this._inspectDirectory(name, offer)
```

```ts
  async _inspectDirectory(
    name: string,
    offer: CommitOffer
  ): Promise<{ status: 'AVAILABLE' } | { status: 'ALREADY_COMMITTED'; record: CommitRecord } | { status: 'FILE_EXISTS' }> {
    if ((await this._rootTreeState(name)) === 'MISSING') {
      const occupied = await this._safeFileOrAbsent(this._finalPath(name), this.layout.root)
      return occupied ? { status: 'FILE_EXISTS' } : { status: 'AVAILABLE' }
    }
    const id = toHex(offer.transferId)
    const record = await this._readRecordOrAbsent(this._recordPath(id))
    if (
      !record ||
      record.kind !== 'directory' ||
      record.name !== name ||
      record.size !== offer.size ||
      record.entryCount !== offer.entryCount ||
      !sameHex32(record.sha256, toHex(offer.digest)) ||
      !sameHex32(record.transferId, id)
    ) {
      return { status: 'FILE_EXISTS' }
    }
    const digested = await digestTree(this._finalPath(name), this.storage)
    if (
      digested.entryCount !== record.entryCount ||
      digested.payloadBytes !== record.size ||
      !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
    ) {
      return { status: 'FILE_EXISTS' }
    }
    return { status: 'ALREADY_COMMITTED', record }
  }
```

Guard `_planReplacement` against a directory record occupying the mutable name by throwing `existsError('Destination already exists')` when `(await this._rootTreeState(record.name)) === 'DIRECTORY'`.

- [ ] **Step 4: Implement directory recovery**

In `recoverJournal`, add before the replacement branch:

```ts
    if (isDirectoryJournal(journal)) {
      return withNameLease(this.layout.root, journal.name, () =>
        this._recoverDirectoryJournal(id, journal, sessionStore)
      )
    }
```

```ts
  /**
   * Converges one directory attempt. The durable sidecar is the linearization
   * point: before it a proven renamed tree returns to staging, after it the
   * published tree is kept and only residue is removed. A destination that
   * cannot be proven is preserved and fails closed.
   */
  async _recoverDirectoryJournal(
    id: string,
    journal: DirectoryCommitJournal,
    sessionStore: SessionStore
  ): Promise<{ status: 'COMMITTED' | 'RESUMABLE'; record: CommitRecord }> {
    const { record, name, attemptId: attempt } = journal
    const sidecar = await this._readRecordOrAbsent(this._recordPath(id))
    if (sidecar && !recordsEqual(sidecar, record)) {
      throw storageError('Commit sidecar does not match journal')
    }
    const state = await this._rootTreeState(name)
    if (state === 'UNMANAGED') throw storageError('Foreign artifact at directory destination')

    if (state === 'DIRECTORY') {
      const digested = await digestTree(this._finalPath(name), this.storage)
      if (
        digested.entryCount !== record.entryCount ||
        digested.payloadBytes !== record.size ||
        !digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
      ) {
        throw storageError('Published directory does not match its journal')
      }
      if (!sidecar) await this._writeRecord(record)
      await this._removeFile(this._sessionPath(id), this.layout.sessions)
      await this._removeFile(this._tarStagingPath(id), this.layout.staging)
      await this._discardJournal(id, attempt)
      return { status: 'COMMITTED', record }
    }

    if (sidecar) await this._removeFile(this._recordPath(id), this.layout.commits)
    if (!sessionStore || typeof sessionStore.readVerified !== 'function') {
      throw storageError('Session store cannot validate recovery state')
    }
    const session = await sessionStore.readVerified(b4a.from(id, 'hex'))
    this._assertSessionMatchesRecord(session, record, 'Directory journal does not match verified session')
    const treePath = this._treeStagingPath(id)
    if ((await inspectTreePath(treePath, this.layout.staging, this.storage)) !== 'DIRECTORY') {
      throw new CorruptJournalError('Directory journal does not own verified staging')
    }
    await this._discardJournal(id, attempt)
    return { status: 'RESUMABLE', record }
  }
```

`src/storage/recovery.ts` needs no change here. A directory journal is dispatched inside `CommitStore.recoverJournal`, whose signature in the `CommitStore` interface at `src/storage/recovery.ts:40` is unchanged, so directory recovery reaches it through the existing call site without a new entry point. The `links` and `trash` directories exist from Task 2 but are not yet referenced by this task, so extending `assertRecoveryLayout` would be unreachable hardening; it lands in Task 9 Step 4 together with the trash sweep that first needs it.

- [ ] **Step 5: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
```

Expected: all pass on both runtimes. The retention suite proves the file commit and replacement transactions are unchanged.

- [ ] **Step 6: Self-review and commit**

Confirm no directory path uses `storage.link`, that `_commitDirectory` never runs for a mutable name, that recovery never deletes an unprovable destination, and that this task left `commit-journal.ts` and `recovery.ts` untouched.

```bash
rg -n '_commitDirectory|storage\.link' src/storage/commit-store.ts
git diff --stat -- src/storage/commit-journal.ts src/storage/recovery.ts
npm run format && npm run lint
git add src/storage/commit-store.ts test/unit/commit-recovery.test.ts
git commit -m "feat: commit a directory artifact by rename"
```

Expected: `git diff --stat` prints nothing for those two files.

---

### Task 9: Directory deletion, trash, and kind-aware retention

**Files:**

- Modify: `src/storage/commit-store.ts`
- Modify: `src/storage/retention.ts`
- Modify: `src/storage/recovery.ts`
- Modify: `test/unit/retention.test.ts`

**Interfaces:**

- Consumes: `commitRecordKind()`, `compareCommitOrder()`, `DIRECTORY_COMMIT_VERSION` from Task 7; `CommitStore._rootTreeState()` from Task 8; `digestTree()`, `inspectTreePath()`, `removeTree()` from Task 2.
- Produces: `CommitStore._trashTreePath()`, `CommitStore._removeManagedTree()`, the directory branches of `CommitStore.delete()` and `purge()`, and `CommitStore.sweepTrash()`.
- Produces: the `recoverStorage` trash-sweep call, `sweepTrash()` on the `CommitStore` interface in `src/storage/recovery.ts`, the widened `'corrupt-journal' | 'trash-residue'` cleanup reason, and `layout.links`/`layout.trash` in `assertRecoveryLayout()`. This is the first and only implementation of each; nothing temporary precedes it.
- Produces: `RetentionManagerOptions.reconcileLinks?: (records: CommitRecord[]) => Promise<ReadonlySet<string>>`, `RetentionManagerOptions.managedLinkNames?: () => ReadonlySet<string>`, and directory branches of `inspectManagedFinal()`.
- Produces: `retention.ts` imports `compareCommitOrder` instead of defining a private `compareNewest`.

- [ ] **Step 1: Write the failing retention and deletion test**

Append to `test/unit/retention.test.ts`:

```ts
test('deleting a directory artifact renames it into private trash first', async (t) => {
  const renames: Array<[string, string]> = []
  const storage = createStorage({
    afterOperation: (name, target, ...rest) => {
      if (name === 'rename') renames.push([target, String(rest[0])])
    }
  })
  const harness = await createHarness(t, { storage })
  const record = await harness.publishTree('0.18.1', { 'a/b.bin': 'bb' })
  const finalPath = path.join(harness.layout.root, '0.18.1')
  t.ok((await fs.promises.lstat(finalPath)).isDirectory())

  t.is(await harness.commits.delete(record), true)
  t.is(await exists(finalPath), false)
  t.is(await exists(path.join(harness.layout.trash, `${record.transferId}.tree`)), false)
  t.ok(
    renames.some(
      ([from, to]) => from === finalPath && to.includes(path.join('.swarm-deploy', 'trash'))
    )
  )
  t.alike(await harness.commits.list(), [])
})

test('trash sweeping removes proven residue and ignores foreign entries', async (t) => {
  const harness = await createHarness(t)
  const stray = path.join(harness.layout.trash, `${'b'.repeat(64)}.tree`)
  await fs.promises.mkdir(path.join(stray, 'nested'), { recursive: true })
  await fs.promises.writeFile(path.join(stray, 'nested', 'x.bin'), 'x')
  const foreign = path.join(harness.layout.trash, 'operator-notes.txt')
  await fs.promises.writeFile(foreign, 'keep me')
  t.is(await harness.commits.sweepTrash(), 1)
  t.is(await exists(stray), false)
  t.is(await fs.promises.readFile(foreign, 'utf8'), 'keep me')
  t.is(await harness.commits.sweepTrash(), 0)
})

test('storage recovery sweeps trash residue and reports it once', async (t) => {
  const harness = await createHarness(t)
  const stray = path.join(harness.layout.trash, `${'c'.repeat(64)}.tree`)
  await fs.promises.mkdir(stray, { recursive: true })
  await fs.promises.writeFile(path.join(stray, 'x.bin'), 'x')
  const events: Array<Record<string, unknown>> = []
  await recoverStorage({
    layout: harness.layout,
    commitStore: harness.commits,
    sessionStore: harness.sessions,
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>)
  })
  t.is(await exists(stray), false)
  t.alike(
    events.filter((event) => event.type === 'cleanup'),
    [{ type: 'cleanup', transfer: 'trash', name: null, reason: 'trash-residue' }]
  )
})

test('scrub validates a directory artifact by type cheaply and by digest at startup', async (t) => {
  const harness = await createHarness(t)
  const record = await harness.publishTree('0.18.1', { 'a.bin': 'aaa' })
  const manager = harness.manager()
  t.is((await manager.scrubCommitted({ hash: false })).records.length, 1)
  t.is((await manager.scrubCommitted({ hash: true })).records.length, 1)

  await fs.promises.writeFile(path.join(harness.layout.root, '0.18.1', 'a.bin'), 'mutated')
  const cheap = await manager.scrubCommitted({ hash: false })
  t.is(cheap.records.length, 1)
  const hashed = await manager.scrubCommitted({ hash: true })
  t.is(hashed.records.length, 0)
  t.is(hashed.deleted, 1)
  t.ok(hashed.unknown.includes('0.18.1'))
  t.ok((await fs.promises.lstat(path.join(harness.layout.root, '0.18.1'))).isDirectory())
  t.is(await exists(path.join(harness.layout.commits, `${record.transferId}.json`)), false)
})

test('age, count, version, and quota retention delete directory artifacts', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publishTree('api-1.0.0', { 'a.bin': 'a' }, { series: 'api', version: '1.0.0' })
  harness.clock.advance(10)
  const second = await harness.publishTree('api-2.0.0', { 'a.bin': 'bb' }, { series: 'api', version: '2.0.0' })
  const result = await harness.manager({ maxCount: 1 }).run()
  t.is(result.countDeleted, 1)
  t.alike(
    (await harness.commits.list()).map((value) => value.transferId),
    [second.transferId]
  )
  t.is(await exists(path.join(harness.layout.root, 'api-1.0.0')), false)
  t.is(first.kind, 'directory')
})

test('link reconciliation runs before deletion and pins every selected target', async (t) => {
  const harness = await createHarness(t)
  const old = await harness.publishTree('0.18.0', { 'a.bin': 'a' })
  harness.clock.advance(10)
  const fresh = await harness.publishTree('0.18.1', { 'a.bin': 'b' })
  const seen: string[][] = []
  const manager = harness.manager({
    maxCount: undefined,
    maxAge: 1,
    reconcileLinks: (records) => {
      seen.push(records.map((record) => record.name).sort())
      return Promise.resolve(new Set([fresh.transferId]))
    }
  })
  harness.clock.advance(100)
  const result = await manager.run()
  t.alike(seen, [['0.18.0', '0.18.1']])
  t.is(result.ageDeleted, 1)
  t.alike(
    (await harness.commits.list()).map((value) => value.transferId),
    [fresh.transferId]
  )
  t.is(await exists(path.join(harness.layout.root, '0.18.0')), false)
  t.is(old.name, '0.18.0')
})

test('scrub ignores a configured managed link name instead of reporting it unknown', async (t) => {
  const harness = await createHarness(t)
  await harness.publishTree('0.18.1', { 'a.bin': 'a' })
  await fs.promises.symlink('0.18.1', path.join(harness.layout.root, 'latest'))
  const scrub = await harness
    .manager({ managedLinkNames: () => new Set(['latest']) })
    .scrubCommitted({ hash: false })
  t.alike(scrub.unknown, [])
  t.is(scrub.records.length, 1)
})
```

Add `publishTree` to the `Harness` interface as `publishTree(name: string, spec: Record<string, string>, release?: ReleaseCoordinates): Promise<CommitRecord>` and implement it inside `createHarness` next to `publish`:

```ts
  async function stageTree(name: string, spec: Record<string, string>): Promise<TarSession> {
    const sourceRoot = await createTempDir(t)
    await writeTree(path.join(sourceRoot, name), spec)
    const manifest = await buildTreeManifest(path.join(sourceRoot, name), OWNER)
    const metadata = treeMetadataFromManifest(manifest)
    const chunks: Buffer[] = []
    await regenerateTreeTarSuffix(manifest, 0, (chunk) => {
      chunks.push(b4a.from(chunk))
    })
    await sessions.admit(OWNER, metadata)
    await sessions.append(OWNER, metadata, 0, b4a.concat(chunks))
    return sessions.verify(OWNER, metadata)
  }
```

and return:

```ts
    async publishTree(name, spec, release) {
      const session = await stageTree(name, spec)
      const record = await commits.commit(session, release === undefined ? {} : { release })
      await sessions.retireCommitted(session.transferId)
      return record
    },
```

with the same `tree-manifest.js` and `../helpers/trees.js` imports added in Task 8. Also add `import { recoverStorage } from '../../dist/storage/recovery.js'` to the suite's imports.

- [ ] **Step 2: Run the focused suite to verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports that `sweepTrash` does not exist on `CommitStore` and that `reconcileLinks` and `managedLinkNames` are not valid `RetentionManager` options.

- [ ] **Step 3: Delete a directory by renaming it into trash**

In `src/storage/commit-store.ts`, add the private trash path and the sweeper:

```ts
  _trashTreePath(id: string): string {
    return path.join(this.layout.trash, `${id}.tree`)
  }

  /**
   * Removes proven private trash trees left by an interrupted deletion. Only a
   * `<64-hex>.tree` entry is ours; anything else in the directory is left alone.
   */
  async sweepTrash(): Promise<number> {
    await this._assertLayout()
    const names = await withSafeDirectoryIdentity(this.layout.trash, this.storage, () =>
      this.storage.readdir(this.layout.trash)
    )
    let removed = 0
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}\.tree$/.test(name)) continue
      if (await removeTree(path.join(this.layout.trash, name), this.layout.trash, this.storage)) {
        removed++
      }
    }
    return removed
  }
```

and the deletion transaction:

```ts
  /**
   * Removes a managed directory by renaming it into the private trash first, so
   * the visible name disappears atomically, and only then removing the sidecar
   * and recursively deleting the trash tree.
   */
  async _removeManagedTree(record: CommitRecord): Promise<{ removed: boolean; preservedPath: boolean }> {
    const finalPath = this._finalPath(record.name)
    const trashPath = this._trashTreePath(record.transferId)
    const state = await this._rootTreeState(record.name)
    if (state === 'MISSING') return { removed: false, preservedPath: false }
    if (state === 'UNMANAGED') return { removed: false, preservedPath: true }
    if ((await inspectTreePath(trashPath, this.layout.trash, this.storage)) !== 'MISSING') {
      await removeTree(trashPath, this.layout.trash, this.storage)
    }
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      withSafeDirectoryIdentity(this.layout.trash, this.storage, () =>
        this.storage.rename(finalPath, trashPath)
      )
    )
    await this._syncRoot()
    await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
    await removeTree(trashPath, this.layout.trash, this.storage)
    return { removed: true, preservedPath: false }
  }
```

In `delete()`, dispatch before the regular-file path:

```ts
    if (record.kind === 'directory') {
      const removed = await this._removeManagedTree(record)
      if (removed.preservedPath) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
        return true
      }
      if (!removed.removed) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
      }
      return true
    }
```

In `purge()`, dispatch the same way, honouring `preservePath`:

```ts
    if (record.kind === 'directory') {
      if (preservePath) {
        await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
        return { purged: true, preservedPath: true }
      }
      const removed = await this._removeManagedTree(record)
      await this._removeFile(this._recordPath(record.transferId), this.layout.commits)
      return { purged: true, preservedPath: removed.preservedPath }
    }
```

- [ ] **Step 4: Sweep private trash during storage recovery**

In `src/storage/recovery.ts`, add the two new directories to `assertRecoveryLayout`:

```ts
    layout.journals,
    layout.links,
    layout.trash
```

Add `sweepTrash` to that file's local `CommitStore` interface (`src/storage/recovery.ts:40`):

```ts
  sweepTrash(): Promise<number>
```

Widen the cleanup event reason in `RecoveryEvent` (`src/storage/recovery.ts:72`):

```ts
  | { type: 'cleanup'; transfer: string; name: null; reason: 'corrupt-journal' | 'trash-residue' }
```

and in `recoverStorage`, after the journal loop closes and before `const retention = new RetentionManager({`:

```ts
  const sweptTrash = await commitStore.sweepTrash()
  if (sweptTrash > 0) {
    report(logger, 'warn', 'Swept managed directory trash residue', { trees: sweptTrash })
    emit(onEvent, { type: 'cleanup', transfer: 'trash', name: null, reason: 'trash-residue' })
  }
```

The sweep runs before the scrub so a half-deleted tree never counts toward the quota that the scrub measures.

- [ ] **Step 5: Make retention kind aware and reconcile links first**

In `src/storage/retention.ts`:

Delete the private `compareNewest` and import the shared comparison plus the tree helpers:

```ts
import { commitRecordKind, compareCommitOrder, type CommitRecord } from './commit-journal.js'
import { digestTree, inspectTreePath } from './tree-fs.js'
```

Replace every `compareNewest` call with `compareCommitOrder`.

Add to `RetentionManagerOptions` and the class fields:

```ts
  /**
   * Reconciles managed symlinks and returns the transfer IDs pinned by a rule.
   * Called once per pass with the scrubbed record set, with the root lease
   * already held; it must not acquire the root lease itself.
   */
  reconcileLinks?: (records: CommitRecord[]) => Promise<ReadonlySet<string>>
  /** Names in the storage root that are server-managed symlinks, not artifacts. */
  managedLinkNames?: () => ReadonlySet<string>
```

Validate them in the constructor:

```ts
    if (reconcileLinks !== undefined && typeof reconcileLinks !== 'function') {
      throw storageError('Invalid link reconciliation callback')
    }
    if (managedLinkNames !== undefined && typeof managedLinkNames !== 'function') {
      throw storageError('Invalid managed link name callback')
    }
```

Extend `inspectManagedFinal` with a directory branch, right after the `isSymbolicLink()` check:

```ts
    if (commitRecordKind(record) === 'directory') {
      if (initial.isSymbolicLink() || !initial.isDirectory()) return 'NON_REGULAR'
      if (!hash) return 'VALID'
      let digested
      try {
        digested = await digestTree(finalPath, storage)
      } catch {
        return 'DIGEST_INVALID'
      }
      if (digested.entryCount !== record.entryCount || digested.payloadBytes !== record.size) {
        return 'WRONG_SIZE'
      }
      return digestMatches(digested.treeSha256, b4a.from(record.sha256, 'hex'))
        ? 'VALID'
        : 'DIGEST_INVALID'
    }
    if (!initial.isFile()) return 'NON_REGULAR'
```

In `scrubCommitted`, exclude managed link names from the unknown set and preserve a mutated directory's path:

```ts
    const linkNames = this.managedLinkNames ? this.managedLinkNames() : new Set<string>()
    const unknown = rootNames
      .filter((name) => name !== '.swarm-deploy' && !knownNames.has(name) && !linkNames.has(name))
      .sort()
```

```ts
        purged = await this.commitStore.purge(record, {
          preservePath: status === 'CHANGED' || commitRecordKind(record) === 'directory'
        })
```

In `_run`, reconcile before any deletion and union the pinned set:

```ts
    const scrub = await this.scrubCommitted({ hash: false })
    const current = scrub.records.slice()
    const linkPinned = this.reconcileLinks
      ? await this.reconcileLinks(current.slice())
      : new Set<string>()
    const pinned = (record: CommitRecord): boolean =>
      this._isPinned(record) || linkPinned.has(record.transferId)
```

Replace every `this._isPinned(record)` inside the age, count, version, and quota stages with `pinned(record)`.

- [ ] **Step 6: Run the focused suites on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/retention.test.js
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/commit-recovery.test.js
```

Expected: all pass on both runtimes.

- [ ] **Step 7: Self-review and commit**

Confirm `reconcileLinks` is never awaited outside `_run`, that no retention path calls `withRootLease` twice, that a mutated directory is preserved as unknown rather than deleted, and that `sweepTrash` never calls `storage.rm` with `recursive`.

```bash
rg -n 'withRootLease|reconcileLinks' src/storage/retention.ts
rg -n 'recursive' src/storage/commit-store.ts src/storage/tree-fs.ts
npm run format && npm run lint
git add src/storage/commit-store.ts src/storage/retention.ts src/storage/recovery.ts \
  test/unit/retention.test.ts
git commit -m "feat: delete directory artifacts through private trash"
```

Expected: the `recursive` search matches nothing.

---

### Task 10: Symlink rule parsing and deterministic selection

**Files:**

- Create: `src/symlinks.ts`
- Create: `test/unit/symlink-rules.test.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: `compareCommitOrder()`, `commitRecordKind()`, `CommitRecord` from Task 7; `validateBasename()`, `isReservedHistoryName()` from `src/files.ts`.
- Produces: `SymlinkRule`, `CompiledSymlinkRule`, `DesiredLink`, `MAX_SYMLINK_SELECTOR_BYTES`, `compileSymlinkRules()`, `symlinkRuleNames()`, `selectDesiredLinks()`.

- [ ] **Step 1: Write the failing rule and selection test**

Create `test/unit/symlink-rules.test.ts`:

```ts
/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import { ERRORS } from '../../dist/errors.js'
import {
  compileSymlinkRules,
  selectDesiredLinks,
  symlinkRuleNames,
  type SymlinkRule
} from '../../dist/symlinks.js'
import type { CommitRecord } from '../../dist/storage/commit-journal.js'

function fileRecord(
  name: string,
  committedAt: number,
  transferId = name.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0')
): CommitRecord {
  return {
    version: 1,
    name,
    size: 1,
    sha256: 'a'.repeat(64),
    committedAt,
    uploaderFingerprint: 'b'.repeat(64),
    transferId
  }
}

function directoryRecord(name: string, committedAt: number, transferId: string): CommitRecord {
  return {
    version: 3,
    kind: 'directory',
    name,
    size: 1,
    sha256: 'c'.repeat(64),
    entryCount: 1,
    committedAt,
    uploaderFingerprint: 'd'.repeat(64),
    transferId
  }
}

test('rules accept exact and unflagged regex selectors and are repeatable', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz', name: 'current.tar.gz' },
    { selector: '/^app-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$/', name: 'app-latest.tar.gz' },
    { selector: 'a'.repeat(64), name: 'pinned.bin' }
  ])
  t.is(rules.length, 4)
  t.is(rules[0].exact, null)
  t.is(rules[1].exact, 'release.tar.gz')
  t.is(rules[0].matches('0.18.1'), true)
  t.is(rules[0].matches('0.18.1-rc.1'), false)
  t.is(rules[2].matches('app-1.2.3.tar.gz'), true)
  t.alike([...symlinkRuleNames(rules)].sort(), [
    'app-latest.tar.gz',
    'current.tar.gz',
    'latest',
    'pinned.bin'
  ])
})

test('rule compilation rejects every malformed configuration', (t) => {
  for (const rules of [
    [{ selector: '/[unclosed/', name: 'latest' }],
    [{ selector: '//', name: 'latest' }],
    [{ selector: '/^a$/i', name: 'latest' }],
    [{ selector: '', name: 'latest' }],
    [{ selector: 'a'.repeat(201), name: 'latest' }],
    [{ selector: '../escape', name: 'latest' }],
    [{ selector: 'history-aa', name: 'latest' }],
    [{ selector: 'latest', name: 'latest' }],
    [{ selector: 'release.tar.gz', name: 'history-latest' }],
    [{ selector: 'release.tar.gz', name: '.swarm-deploy' }],
    [{ selector: 'release.tar.gz', name: 'a/b' }],
    [{ selector: 'release.tar.gz', name: 'a'.repeat(101) }],
    [
      { selector: 'one.bin', name: 'latest' },
      { selector: 'two.bin', name: 'latest' }
    ],
    [{ selector: 'release.tar.gz' } as unknown as SymlinkRule],
    [{ selector: 'release.tar.gz', name: 'latest', extra: 1 } as unknown as SymlinkRule],
    'release.tar.gz' as unknown as Iterable<SymlinkRule>
  ]) {
    t.exception(() => compileSymlinkRules(rules as Iterable<SymlinkRule>), {
      code: /PROTOCOL_INVALID|INVALID_FILENAME/
    })
  }
  t.alike(compileSymlinkRules(undefined), [])
  t.alike(compileSymlinkRules(null), [])
})

test('selection picks the newest matching record deterministically', (t) => {
  const rules = compileSymlinkRules([
    { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
    { selector: 'release.tar.gz', name: 'current.tar.gz' }
  ])
  const records = [
    directoryRecord('0.18.0', 100, '1'.repeat(64)),
    directoryRecord('0.18.1', 200, '2'.repeat(64)),
    directoryRecord('0.18.2', 200, '0'.repeat(64)),
    fileRecord('history-aaaa', 300, '3'.repeat(64)),
    fileRecord('unrelated.bin', 400, '4'.repeat(64))
  ]
  t.alike(selectDesiredLinks(rules, records), [
    { name: 'latest', target: '0.18.2', transferId: '0'.repeat(64), targetKind: 'directory' }
  ])

  const withFile = [...records, fileRecord('release.tar.gz', 50, '5'.repeat(64))]
  t.alike(selectDesiredLinks(rules, withFile), [
    { name: 'latest', target: '0.18.2', transferId: '0'.repeat(64), targetKind: 'directory' },
    {
      name: 'current.tar.gz',
      target: 'release.tar.gz',
      transferId: '5'.repeat(64),
      targetKind: 'file'
    }
  ])
})

test('a rule is dormant until a managed target exists and never targets itself', (t) => {
  const rules = compileSymlinkRules([
    { selector: 'release.tar.gz', name: 'current.tar.gz' },
    { selector: '/^latest$/', name: 'latest' }
  ])
  t.alike(selectDesiredLinks(rules, []), [])
  t.alike(selectDesiredLinks(rules, [fileRecord('latest', 10, '6'.repeat(64))]), [])
  t.is(ERRORS.LINK_CONFLICT, 'LINK_CONFLICT')
})
```

- [ ] **Step 2: Register the test and run it to verify red**

Add `"test/unit/symlink-rules.test.ts"` to `tsconfig.test.json` and `require('./unit/symlink-rules.test.js')` to `test/run.ts` after the tree-extract require.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `Cannot find module '../../dist/symlinks.js'`.

- [ ] **Step 3: Implement rule compilation and selection**

Create `src/symlinks.ts`:

```ts
import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from './errors.js'
import { isReservedHistoryName, validateBasename } from './files.js'
import {
  commitRecordKind,
  compareCommitOrder,
  type CommitRecord
} from './storage/commit-journal.js'
import type { ArtifactKind } from './types.js'

export const MAX_SYMLINK_SELECTOR_BYTES = 200

export interface SymlinkRule {
  /** An exact managed artifact basename, or `/pattern/` with no flags. */
  selector: string
  /** The safe basename of the managed link, a sibling of its target. */
  name: string
}

export interface CompiledSymlinkRule {
  readonly selector: string
  readonly name: string
  /** The exact target basename, or `null` for a regular-expression selector. */
  readonly exact: string | null
  matches(name: string): boolean
}

export interface DesiredLink {
  name: string
  /** Always exactly the selected record's basename. */
  target: string
  transferId: string
  targetKind: ArtifactKind
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertLinkName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid symlink name')
  }
  const name = validateBasename(value)
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved symlink name')
  }
  if (b4a.from(name).byteLength > 100) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid symlink name')
  }
  return name
}

/**
 * Validates and snapshots operator symlink rules. The regex source is bounded,
 * has no flags, and runs only against validated 100-byte artifact basenames; it
 * is trusted operator configuration, and an invalid one is a startup error.
 */
export function compileSymlinkRules(
  rules: Iterable<SymlinkRule> | null | undefined
): readonly CompiledSymlinkRule[] {
  if (rules === null || rules === undefined) return Object.freeze([])
  if (
    typeof rules === 'string' ||
    typeof rules !== 'object' ||
    typeof (rules as Iterable<SymlinkRule>)[Symbol.iterator] !== 'function'
  ) {
    throw invalid('Invalid symlink rules')
  }
  const compiled: CompiledSymlinkRule[] = []
  const names = new Set<string>()
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw invalid('Invalid symlink rule')
    const keys = Object.keys(rule).sort()
    if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'selector') {
      throw invalid('Invalid symlink rule')
    }
    const name = assertLinkName(rule.name)
    if (names.has(name)) throw invalid('Duplicate symlink name')
    names.add(name)
    const { selector } = rule
    if (typeof selector !== 'string' || selector.length === 0) throw invalid('Invalid symlink selector')
    if (b4a.from(selector).byteLength > MAX_SYMLINK_SELECTOR_BYTES) {
      throw invalid('Invalid symlink selector')
    }
    if (selector.length >= 2 && selector.startsWith('/') && selector.endsWith('/')) {
      const source = selector.slice(1, -1)
      if (source.length === 0) throw invalid('Invalid symlink selector')
      let pattern: RegExp
      try {
        pattern = new RegExp(source)
      } catch (error: unknown) {
        throw invalid('Invalid symlink selector', error)
      }
      compiled.push(
        Object.freeze({
          selector,
          name,
          exact: null,
          matches: (candidate: string): boolean => pattern.test(candidate)
        })
      )
      continue
    }
    const exact = validateBasename(selector)
    if (isReservedHistoryName(exact)) throw invalid('Reserved symlink selector')
    if (exact === name) throw invalid('Symlink selector equals its own name')
    compiled.push(
      Object.freeze({
        selector,
        name,
        exact,
        matches: (candidate: string): boolean => candidate === exact
      })
    )
  }
  return Object.freeze(compiled)
}

export function symlinkRuleNames(rules: readonly CompiledSymlinkRule[]): ReadonlySet<string> {
  return new Set(rules.map((rule) => rule.name))
}

/**
 * Computes the desired links from validated commit records only. A rule with no
 * match is dormant. Replacement history names never match, and a candidate
 * whose name equals its own link name is skipped.
 */
export function selectDesiredLinks(
  rules: readonly CompiledSymlinkRule[],
  records: readonly CommitRecord[]
): DesiredLink[] {
  const desired: DesiredLink[] = []
  for (const rule of rules) {
    let selected: CommitRecord | null = null
    for (const record of records) {
      if (isReservedHistoryName(record.name)) continue
      if (record.name === rule.name) continue
      if (!rule.matches(record.name)) continue
      if (selected === null || compareCommitOrder(record, selected) < 0) selected = record
    }
    if (selected === null) continue
    desired.push({
      name: rule.name,
      target: selected.name,
      transferId: selected.transferId,
      targetKind: commitRecordKind(selected)
    })
  }
  return desired
}
```

- [ ] **Step 4: Run the focused suite on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/symlink-rules.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/symlink-rules.test.js
```

Expected: both pass.

- [ ] **Step 5: Self-review and commit**

Confirm the regex is constructed with no flags argument, that selection reads only `CommitRecord` fields, and that nothing in `symlinks.ts` touches the filesystem.

```bash
rg -n 'new RegExp|fs\.|storage' src/symlinks.ts
git add src/symlinks.ts test/unit/symlink-rules.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: select a symlink target from managed records"
```

Expected: `rg` prints only the single `new RegExp(source)` line.

---

### Task 11: Managed link ownership, transaction, and reconciliation

**Files:**

- Create: `src/storage/link-store.ts`
- Create: `test/unit/link-store.test.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**

- Consumes: `DesiredLink` from Task 10; `assertSymlinkCapable()` from Task 2; `writeAtomic()`, `readJson()`, `MetadataFormatError` from `src/storage/atomic-file.ts`; `withSafeDirectoryIdentity()` from `src/storage/layout.ts`.
- Produces: `ManagedSymlinkRecord`, `LinkReconcileResult`, `LinkStore` with `recordPath()`, `read()`, `list()`, and `reconcile()`.

- [ ] **Step 1: Write the failing link-store test**

Create `test/unit/link-store.test.ts`:

```ts
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
import type { StorageLayout } from '../../dist/storage/types.js'
import { createTempDir } from '../helpers/files.js'
import { createStorage } from '../helpers/storage.js'

function capableStorage(): ReturnType<typeof createStorage> & {
  symlink(target: string, linkPath: string): Promise<void>
  readlink(linkPath: string): Promise<string>
} {
  return {
    ...createStorage(),
    symlink: (target: string, linkPath: string) => fs.promises.symlink(target, linkPath),
    readlink: (linkPath: string) => fs.promises.readlink(linkPath)
  }
}

async function createStore(
  t: Parameters<Parameters<typeof test>[1]>[0]
): Promise<{ links: LinkStore; layout: StorageLayout }> {
  const layout = initLayout(await createTempDir(t))
  return { links: new LinkStore({ layout, storage: capableStorage() }), layout }
}

function desired(name: string, target: string, transferId: string): DesiredLink {
  return { name, target, transferId, targetKind: 'directory' }
}

async function mkdirs(layout: StorageLayout, names: string[]): Promise<void> {
  for (const name of names) await fs.promises.mkdir(path.join(layout.root, name))
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
  t.is(
    links.recordPath('latest'),
    path.join(layout.links, `${b4a.toString(sodiumSha256(b4a.from('latest')), 'hex')}.json`)
  )

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
    JSON.stringify({ version: 1, name: 'latest', target: '0.18.1', transferId: '1'.repeat(64), targetKind: 'directory' })
  )
  await t.exception(() => links.reconcile([], new Set()), { code: ERRORS.LINK_FAILED })

  t.exception(() => new LinkStore({ layout, storage: createStorage() }), {
    code: ERRORS.UNSUPPORTED_STORAGE
  })
})

test('a temporary link is cleaned up when the rename fails', async (t) => {
  const layout = initLayout(await createTempDir(t))
  await fs.promises.mkdir(path.join(layout.root, '0.18.0'))
  await fs.promises.mkdir(path.join(layout.root, '0.18.1'))
  let failRename = false
  const storage = {
    ...capableStorage(),
    rename: async (source: string, destination: string): Promise<void> => {
      if (failRename && source.includes('publications')) throw new Error('injected rename failure')
      await fs.promises.rename(source, destination)
    }
  }
  const links = new LinkStore({ layout, storage })
  await links.reconcile([desired('latest', '0.18.0', '1'.repeat(64))], new Set(['latest']))
  failRename = true
  await t.exception(() =>
    links.reconcile([desired('latest', '0.18.1', '2'.repeat(64))], new Set(['latest']))
  )
  t.alike(await fs.promises.readdir(layout.publications), [])
  t.is(await fs.promises.readlink(path.join(layout.root, 'latest')), '0.18.0')
  t.is((await links.read('latest'))?.target, '0.18.0')
})
```

- [ ] **Step 2: Register the test and run it to verify red**

Add `"test/unit/link-store.test.ts"` to `tsconfig.test.json` and `require('./unit/link-store.test.js')` to `test/run.ts` after the symlink-rules require.

Run:

```bash
npm run build && npm run build:test
```

Expected: FAIL — `Cannot find module '../../dist/storage/link-store.js'`.

- [ ] **Step 3: Implement the ownership ledger and link transaction**

Create `src/storage/link-store.ts`:

```ts
import b4a from 'b4a'
import { isMissing } from '../error-code.js'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { sodiumSha256 } from '../tar-protocol/hash.js'
import type { DesiredLink } from '../symlinks.js'
import type { ArtifactKind } from '../types.js'
import { MetadataFormatError, readJson, writeAtomic } from './atomic-file.js'
import { withSafeDirectoryIdentity } from './layout.js'
import { assertSymlinkCapable } from './tree-fs.js'
import type { StorageLayout, StorageStats, SymlinkCapableStorage } from './types.js'

const MAX_LINK_RECORD_BYTES = 4 * 1024

export interface ManagedSymlinkRecord {
  version: 1
  name: string
  target: string
  transferId: string
  targetKind: ArtifactKind
}

export interface LinkReconcileResult {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: string[]
}

interface Logger {
  warn?: (message: string, details: Record<string, unknown>) => void
}

export interface LinkStoreOptions {
  layout: StorageLayout
  storage?: SymlinkCapableStorage
  logger?: Logger | null
}

type Destination =
  | { state: 'MISSING' }
  | { state: 'SYMLINK'; target: string }
  | { state: 'UNMANAGED' }

function conflict(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.LINK_CONFLICT, message)
}

function failure(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.LINK_FAILED, message, cause)
}

function assertSafeTarget(target: unknown): string {
  if (typeof target !== 'string') throw failure('Invalid managed link target')
  if (
    target.includes('/') ||
    target.includes('\\') ||
    target.includes('\u0000') ||
    target === '.' ||
    target === '..'
  ) {
    throw failure('Invalid managed link target')
  }
  const name = validateBasename(target)
  if (isReservedHistoryName(name) || name === '.swarm-deploy') {
    throw failure('Invalid managed link target')
  }
  return name
}

function assertRecord(value: unknown, expectedName: string): ManagedSymlinkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('Invalid managed link record')
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (
    keys.length !== 5 ||
    keys.join(',') !== 'name,target,targetKind,transferId,version' ||
    candidate.version !== 1 ||
    candidate.name !== expectedName ||
    (candidate.targetKind !== 'file' && candidate.targetKind !== 'directory') ||
    typeof candidate.transferId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.transferId)
  ) {
    throw failure('Invalid managed link record')
  }
  assertSafeTarget(candidate.target)
  return candidate as unknown as ManagedSymlinkRecord
}

function randomSuffix(): string {
  const bytes = b4a.allocUnsafe(16)
  sodium.randombytes_buf(bytes)
  return b4a.toString(bytes, 'hex')
}

async function syncDirectory(directory: string, storage: SymlinkCapableStorage): Promise<void> {
  const handle = await storage.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Owns every server-managed symlink in the storage root.
 *
 * A destination is replaceable only when a valid ownership record exists, the
 * visible destination is a symbolic link, and `readlink()` returns either the
 * recorded target or the desired target. Anything else is unmanaged: it is left
 * untouched and the operation fails closed.
 */
export class LinkStore {
  readonly layout: StorageLayout
  readonly storage: SymlinkCapableStorage
  readonly logger: Logger | null

  constructor({ layout, storage = fs.promises as SymlinkCapableStorage, logger = null }: LinkStoreOptions) {
    if (!layout || typeof layout !== 'object') throw failure('Invalid storage layout')
    assertSymlinkCapable(storage)
    this.layout = layout
    this.storage = storage
    this.logger = logger
  }

  recordPath(name: string): string {
    return path.join(this.layout.links, `${b4a.toString(sodiumSha256(b4a.from(name)), 'hex')}.json`)
  }

  private finalPath(name: string): string {
    return path.join(this.layout.root, name)
  }

  async read(name: string): Promise<ManagedSymlinkRecord | null> {
    validateBasename(name)
    try {
      return assertRecord(
        await readJson(this.recordPath(name), this.storage, MAX_LINK_RECORD_BYTES),
        name
      )
    } catch (error: unknown) {
      if (isMissing(error)) return null
      if (error instanceof MetadataFormatError) throw failure('Malformed managed link record', error)
      throw error
    }
  }

  /** Every persisted ownership record, keyed by its proven link name. */
  async list(): Promise<ManagedSymlinkRecord[]> {
    const names = await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      this.storage.readdir(this.layout.links)
    )
    const records: ManagedSymlinkRecord[] = []
    for (const filename of names.sort()) {
      if (!/^[0-9a-f]{64}\.json$/.test(filename)) continue
      const parsed = await readJson(
        path.join(this.layout.links, filename),
        this.storage,
        MAX_LINK_RECORD_BYTES
      ).catch((error: unknown) => {
        throw failure('Malformed managed link record', error)
      })
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      const record = assertRecord(parsed, name)
      if (path.basename(this.recordPath(record.name)) !== filename) {
        throw failure('Foreign managed link record')
      }
      records.push(record)
    }
    return records
  }

  private classify(name: string): Promise<Destination> {
    const finalPath = this.finalPath(name)
    return withSafeDirectoryIdentity(this.layout.root, this.storage, async () => {
      let stat: StorageStats
      try {
        stat = await this.storage.lstat(finalPath)
      } catch (error: unknown) {
        if (isMissing(error)) return { state: 'MISSING' as const }
        throw error
      }
      if (!stat.isSymbolicLink()) return { state: 'UNMANAGED' as const }
      return { state: 'SYMLINK' as const, target: await this.storage.readlink(finalPath) }
    })
  }

  private async writeRecord(link: DesiredLink): Promise<void> {
    const record: ManagedSymlinkRecord = {
      version: 1,
      name: link.name,
      target: assertSafeTarget(link.target),
      transferId: link.transferId,
      targetKind: link.targetKind
    }
    assertRecord(record, link.name)
    await writeAtomic(this.recordPath(link.name), b4a.from(JSON.stringify(record)), this.storage)
  }

  private async createLink(link: DesiredLink): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      this.storage.symlink(assertSafeTarget(link.target), this.finalPath(link.name))
    )
    await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
      syncDirectory(this.layout.root, this.storage)
    )
    await this.writeRecord(link)
  }

  /** Removes a temporary symlink with `lstat`/`unlink`, never a regular-file helper. */
  private async removeTemporary(temporary: string): Promise<void> {
    await withSafeDirectoryIdentity(this.layout.publications, this.storage, async () => {
      try {
        await this.storage.lstat(temporary)
      } catch (error: unknown) {
        if (isMissing(error)) return
        throw error
      }
      await this.storage.unlink(temporary)
    }).catch(() => {})
  }

  private async replaceLink(link: DesiredLink): Promise<void> {
    const target = assertSafeTarget(link.target)
    const temporary = path.join(this.layout.publications, `.link-${randomSuffix()}`)
    try {
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        this.storage.symlink(target, temporary)
      )
      await withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
        syncDirectory(this.layout.publications, this.storage)
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        withSafeDirectoryIdentity(this.layout.publications, this.storage, () =>
          this.storage.rename(temporary, this.finalPath(link.name))
        )
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
      await this.writeRecord(link)
    } finally {
      await this.removeTemporary(temporary)
    }
  }

  private async removeLink(record: ManagedSymlinkRecord): Promise<void> {
    const destination = await this.classify(record.name)
    if (destination.state === 'SYMLINK' && destination.target === record.target) {
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        this.storage.unlink(this.finalPath(record.name))
      )
      await withSafeDirectoryIdentity(this.layout.root, this.storage, () =>
        syncDirectory(this.layout.root, this.storage)
      )
    } else if (destination.state !== 'MISSING') {
      throw conflict('Unmanaged path at a removed managed link name')
    }
    await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      this.storage.unlink(this.recordPath(record.name))
    )
    await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
      syncDirectory(this.layout.links, this.storage)
    )
  }

  /**
   * Converges every desired link and removes the record and visible link of
   * every name no rule owns. Level-triggered: the same input always produces
   * the same output, whatever the previous attempt's crash point.
   */
  async reconcile(
    desired: readonly DesiredLink[],
    ruleNames: ReadonlySet<string>
  ): Promise<LinkReconcileResult> {
    const result: LinkReconcileResult = { created: [], updated: [], removed: [], unchanged: [] }
    const stored = await this.list()
    for (const record of stored) {
      if (ruleNames.has(record.name)) continue
      await this.removeLink(record)
      result.removed.push(record.name)
    }
    for (const link of desired) {
      if (!ruleNames.has(link.name)) throw failure('Desired link is not a configured rule')
      const target = assertSafeTarget(link.target)
      if (target === link.name) throw failure('Managed link cannot target itself')
      const record = await this.read(link.name)
      const destination = await this.classify(link.name)
      if (destination.state === 'UNMANAGED') {
        throw conflict('Unmanaged path at a configured managed link name')
      }
      if (destination.state === 'MISSING') {
        if (record) {
          await withSafeDirectoryIdentity(this.layout.links, this.storage, () =>
            this.storage.unlink(this.recordPath(link.name))
          )
        }
        await this.createLink(link)
        result.created.push(link.name)
        continue
      }
      if (record === null) throw conflict('Unrecorded symlink at a configured managed link name')
      if (destination.target === target) {
        if (record.target === target && record.transferId === link.transferId) {
          result.unchanged.push(link.name)
          continue
        }
        // Converges a crash between the visible replacement and the record.
        if (record.target !== target && record.target !== destination.target) {
          throw conflict('Managed link does not match its ownership record')
        }
        await this.writeRecord(link)
        result.updated.push(link.name)
        continue
      }
      if (destination.target !== record.target) {
        throw conflict('Managed link does not match its ownership record')
      }
      await this.replaceLink(link)
      result.updated.push(link.name)
    }
    return result
  }
}
```

- [ ] **Step 4: Run the focused suite on Node and Bare to verify green**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/link-store.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/link-store.test.js
```

Expected: both pass.

- [ ] **Step 5: Self-review and commit**

Confirm no path in `link-store.ts` calls `assertSafeFile` or `openSafeRegularFile` on a symlink, that `readlink()` output is never joined to a path, and that every failure branch leaves the destination untouched.

```bash
rg -n 'assertSafeFile|openSafeRegularFile|path.join\(.*readlink' src/storage/link-store.ts
git add src/storage/link-store.ts test/unit/link-store.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: own managed symlinks with a durable ledger"
```

Expected: the `rg` command prints nothing.

---

### Task 12: Server, hook, and CLI integration

**Files:**

- Modify: `src/server.ts`
- Modify: `src/hooks.ts`
- Modify: `src/types.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Modify: `test/unit/direct-behavior.test.ts`
- Modify: `test/unit/cli.test.ts`
- Modify: `test/integration/direct-upload.test.ts`
- Modify: `test/integration/behavior-observability.test.ts`

This is the first task in which a server can accept a directory offer, so it is also the first task that can host a real client-to-server directory integration test. Both integration tests are written here, fail here, and go green here.

**Interfaces:**

- Consumes: everything Tasks 1–11 produce.
- Produces: `ServerOptions.symlinks?: Iterable<SymlinkRule>`, `Server.symlinks`, `Server.linkNames`.
- Produces: `HookArtifact.kind: ArtifactKind` and `HookArtifact.entryCount?: number`.
- Produces: `TransferEvent.kind: ArtifactKind`.
- Produces: the repeatable two-value CLI option `--symlink <selector> <link-name>` and `parseOptions`' new `pairs` parameter returning `pairOptions`.

- [ ] **Step 1: Write the failing server behavior test**

Append to `test/unit/direct-behavior.test.ts`:

```ts
async function treeManifest(
  t: Assert,
  name: string,
  spec: Record<string, string>
): Promise<{ manifest: TreeManifest; tar: Buffer }> {
  const source = path.join(await createTempDir(t), name)
  await writeTree(source, spec)
  const built = await buildTreeManifest(source, CLIENT_KEY)
  const chunks: Buffer[] = []
  await regenerateTreeTarSuffix(built, 0, (chunk) => {
    chunks.push(b4a.from(chunk))
  })
  return { manifest: built, tar: b4a.concat(chunks) }
}

function treeMetadataFrame(value: TreeManifest, reset = false): Buffer {
  return encodeControlFrame(encodeTreeMetadataRecord(treeMetadataFromManifest(value, reset)))
}

test('a directory upload commits, reconciles its link, and reports kind to hooks', async (t) => {
  const contexts: Array<{ phase: string; kind: string; path: string; entryCount?: number }> = []
  const hooks: ServerHooks = {
    beforeCommit: (context) =>
      void contexts.push({
        phase: 'beforeCommit',
        kind: context.artifact.kind,
        path: context.path,
        entryCount: context.artifact.entryCount
      }),
    afterCommit: (context) =>
      void contexts.push({
        phase: 'afterCommit',
        kind: context.artifact.kind,
        path: context.path,
        entryCount: context.artifact.entryCount
      })
  }
  const { server, node } = await createServer(t, {
    hooks,
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const built = await treeManifest(t, '0.18.1', { 'a/b.bin': 'bb', 'a/empty/': '', 'z.bin': 'z' })
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(treeMetadataFrame(built.manifest))
  socket.feed(built.tar)
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('COMMITTED'))

  const root = server.storageDir
  t.ok((await fs.promises.lstat(path.join(root, '0.18.1'))).isDirectory())
  t.alike((await fs.promises.readdir(path.join(root, '0.18.1'))).sort(), ['a', 'z.bin'])
  t.is(await fs.promises.readlink(path.join(root, 'latest')), '0.18.1')
  t.alike(
    contexts.map((context) => `${context.phase}:${context.kind}:${context.entryCount}`),
    ['beforeCommit:directory:4', 'afterCommit:directory:4']
  )
  t.ok(contexts[0].path.endsWith(`${built.manifest.transferId.toString('hex')}.tree`))
  t.is(contexts[1].path, path.join(root, '0.18.1'))
})

test('a configured link name cannot be uploaded as an artifact', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const built = await manifest(t, 'latest', 'payload')
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(metadataFrame(built.manifest))
  await waitFor(() => statuses(socket).includes('REJECTED'))
  const rejection = JSON.parse(b4a.toString(socket.writes[0].subarray(4))) as { code: string }
  t.is(rejection.code, ERRORS.INVALID_FILENAME)
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, 'latest')))
})

test('a link is repointed to the newest match before the old target is rotated', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }],
    artifactPatterns: ['{version}'],
    maxCount: 1
  })
  for (const name of ['0.18.0', '0.18.1']) {
    const built = await treeManifest(t, name, { 'a.bin': name })
    const socket = new FakeSocket(CLIENT_KEY)
    node.accept(socket)
    socket.feed(treeMetadataFrame(built.manifest))
    socket.feed(built.tar)
    socket.finishInput()
    await waitFor(() => statuses(socket).includes('COMMITTED'))
  }
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'latest')), '0.18.1')
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())
  await t.exception(() => fs.promises.lstat(path.join(server.storageDir, '0.18.0')))
})

test('an unrecorded directory and an operator file leave a rule dormant at startup', async (t) => {
  const storageDir = await createTempDir(t)
  await fs.promises.mkdir(path.join(storageDir, '0.18.1'))
  await fs.promises.writeFile(path.join(storageDir, 'latest'), 'operator file')
  const node = new FakeServerNode()
  const server = new Server({
    seed: SERVER_SEED,
    storageDir,
    allowedKeys: [CLIENT_KEY],
    maxFileBytes: 16 * 1024,
    maxStagingBytes: 64 * 1024,
    minFreeBytes: 0,
    dht: node,
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  t.teardown(() => server.close())
  // There is no managed commit record for 0.18.1, so the rule has no candidate,
  // the desired set is empty, and startup succeeds without touching the root.
  await server.listen()
  t.is(await fs.promises.readFile(path.join(storageDir, 'latest'), 'utf8'), 'operator file')
  t.ok((await fs.promises.lstat(path.join(storageDir, '0.18.1'))).isDirectory())
})

test('an unmanaged path at a configured link name fails the link closed', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  // An operator drops a plain file at the link name after startup; it is not ours.
  await fs.promises.writeFile(path.join(server.storageDir, 'latest'), 'operator file')
  const built = await treeManifest(t, '0.18.1', { 'a.bin': 'a' })
  const socket = new FakeSocket(CLIENT_KEY)
  node.accept(socket)
  socket.feed(treeMetadataFrame(built.manifest))
  socket.feed(built.tar)
  socket.finishInput()
  await waitFor(() => statuses(socket).includes('FAILED'))
  const failure = JSON.parse(
    b4a.toString(socket.writes[socket.writes.length - 1].subarray(4))
  ) as { code: string }
  t.is(failure.code, ERRORS.LINK_CONFLICT)
  // The commit is durable and the operator's file is untouched.
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())
  t.is(await fs.promises.readFile(path.join(server.storageDir, 'latest'), 'utf8'), 'operator file')
})

test('configuring symlinks requires a symlink-capable storage adapter', async (t) => {
  const { createStorage } = require('../helpers/storage.js') as typeof import('../helpers/storage.js')
  t.exception(
    () =>
      new Server({
        seed: SERVER_SEED,
        storageDir: '/srv/swarm-deploy',
        allowedKeys: [CLIENT_KEY],
        maxFileBytes: 1024,
        maxStagingBytes: 4096,
        storage: createStorage(),
        symlinks: [{ selector: 'release.tar.gz', name: 'current.tar.gz' }]
      }),
    { code: ERRORS.UNSUPPORTED_STORAGE }
  )
  t.execution(
    () =>
      new Server({
        seed: SERVER_SEED,
        storageDir: '/srv/swarm-deploy',
        allowedKeys: [CLIENT_KEY],
        maxFileBytes: 1024,
        maxStagingBytes: 4096,
        storage: createStorage()
      })
  )
})

test('a link reconciliation failure after a durable commit is retried as already committed', async (t) => {
  const { server, node } = await createServer(t, {
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const links = (server as unknown as { links: { reconcile: unknown } }).links
  const original = links.reconcile
  let failures = 0
  ;(links as { reconcile: unknown }).reconcile = function (...args: unknown[]) {
    if (failures++ === 0) return Promise.reject(new Error('injected link failure'))
    return (original as (...rest: unknown[]) => unknown).apply(links, args)
  }
  const built = await treeManifest(t, '0.18.1', { 'a.bin': 'a' })
  const first = new FakeSocket(CLIENT_KEY)
  node.accept(first)
  first.feed(treeMetadataFrame(built.manifest))
  first.feed(built.tar)
  first.finishInput()
  await waitFor(() => statuses(first).includes('FAILED'))
  t.ok((await fs.promises.lstat(path.join(server.storageDir, '0.18.1'))).isDirectory())

  const retry = new FakeSocket(CLIENT_KEY)
  node.accept(retry)
  retry.feed(treeMetadataFrame(built.manifest))
  await waitFor(() => statuses(retry).includes('ALREADY_COMMITTED'))
  t.is(await fs.promises.readlink(path.join(server.storageDir, 'latest')), '0.18.1')
})
```

Add to the file's imports:

```ts
import {
  buildTreeManifest,
  regenerateTreeTarSuffix,
  treeMetadataFromManifest,
  type TreeManifest
} from '../../dist/tar-protocol/tree-manifest.js'
import { encodeTreeMetadataRecord } from '../../dist/tar-protocol/controls.js'
import { writeTree } from '../helpers/trees.js'
```

- [ ] **Step 2: Write the failing CLI test**

Append to `test/unit/cli.test.ts`, using its existing `runServerCli(root, extra, io)` fake-server harness and its `output()` stream helper:

```ts
test('--symlink is a repeatable two-value option passed through as rules', async (t) => {
  const run = await runServerCli(await createTempDir(t), [
    '--symlink',
    '/^\\d+\\.\\d+\\.\\d+$/',
    'latest',
    '--symlink',
    'release.tar.gz',
    'current.tar.gz'
  ])
  t.is(run.code, 0)
  t.alike(
    [...((run.options as ServerOptions).symlinks as Iterable<unknown>)],
    [
      { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
      { selector: 'release.tar.gz', name: 'current.tar.gz' }
    ]
  )
})

test('a server without --symlink passes no symlinks option', async (t) => {
  const run = await runServerCli(await createTempDir(t), [])
  t.is(run.code, 0)
  t.absent('symlinks' in (run.options as ServerOptions))
})

test('--symlink rejects a missing second value and an invalid rule with exit code 2', async (t) => {
  const root = await createTempDir(t)
  for (const extra of [
    ['--symlink', 'release.tar.gz'],
    ['--symlink'],
    ['--symlink', 'release.tar.gz', '--hooks', './hooks.mjs'],
    ['--symlink', 'release.tar.gz', 'release.tar.gz'],
    ['--symlink', '/[unclosed/', 'latest'],
    ['--symlink', 'one.bin', 'latest', '--symlink', 'two.bin', 'latest'],
    ['--symlink', 'release.tar.gz', 'history-latest'],
    ['--symlink', 'release.tar.gz', '../escape']
  ]) {
    const run = await runServerCli(root, extra)
    t.is(run.code, 2, extra.join(' '))
    t.is(run.constructed, 0, extra.join(' '))
  }
})

test('the usage text documents the repeatable two-value symlink option', async (t) => {
  const stdout = output()
  t.is(await main(['--help'], {}, { stdout: stdout.stream }), 0)
  t.ok(stdout.text().includes('[--symlink <selector> <link-name>]...'))
})

test('upload output names the artifact kind', async (t) => {
  const artifact = path.join(await createTempDir(t), 'payload.bin')
  await fs.promises.writeFile(artifact, 'payload')
  class Client {
    constructor(_options: ClientOptions) {}
    upload() {
      return Promise.resolve({
        status: 'COMMITTED' as const,
        kind: 'file' as const,
        name: 'payload.bin',
        size: 7,
        digest: b4a.alloc(32, 1),
        transferId: b4a.alloc(32, 2)
      })
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  t.is(
    await main(
      ['upload', '--seed', b4a.toString(CLIENT_SEED, 'hex'), '--server-key', b4a.toString(SERVER_KEY, 'hex'), artifact],
      {},
      {
        Client: Client as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stdout: stdout.stream
      }
    ),
    0
  )
  t.is(stdout.text(), 'payload.bin file COMMITTED\n')
})
```

`runServerCli` already returns `{ code, options, constructed, listened, stdout, stderr }` (`test/unit/cli.test.ts:752`), so it needs no change; `options` is typed `ServerOptions | null`, hence the cast at each use.

The existing `'artifact.txt COMMITTED\n'` assertion at `test/unit/cli.test.ts:106` becomes `'artifact.txt file COMMITTED\n'`, and its inline fake `Client.upload` gains `kind: 'file' as const`. Do the same for the second inline fake at `test/unit/cli.test.ts:193`.

- [ ] **Step 3: Write the failing client-to-server directory integration tests**

These are the real end-to-end directory tests. They are written here because this is the first task in which a server can accept a directory offer.

In `test/integration/behavior-observability.test.ts`, append (the obsolete batch test was deleted in Task 5 Step 3):

```ts
test('a directory upload commits one recursive artifact and one final result', async (t) => {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true })
  await fs.promises.writeFile(path.join(source, 'b.txt'), 'b')
  await fs.promises.writeFile(path.join(source, 'nested', 'a.txt'), 'a')
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  const clientResults: Array<Record<string, unknown>> = []
  const serverCommits: Array<Record<string, unknown>> = []
  client.on('result', (event) => clientResults.push(event as unknown as Record<string, unknown>))
  server.on('commit', (event) => serverCommits.push(event as unknown as Record<string, unknown>))
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  const result = await client.upload(source)
  t.is(result.status, 'COMMITTED')
  t.is(result.kind, 'directory')
  t.is(result.name, '0.18.1')
  t.is(result.entryCount, 3)
  t.is(result.size, 2)
  t.is(clientResults.length, 1)
  t.alike(clientResults[0], {
    name: '0.18.1',
    kind: 'directory',
    status: 'COMMITTED',
    final: true
  })
  t.ok(serverCommits.every((event) => event.kind === 'directory'))
  t.alike((await fs.promises.readdir(path.join(storage, '0.18.1'))).sort(), ['b.txt', 'nested'])
  t.alike(await fs.promises.readdir(path.join(storage, '0.18.1', 'nested')), ['a.txt'])
  t.ok((await fs.promises.lstat(path.join(storage, '0.18.1'))).isDirectory())
  t.is(await fs.promises.readFile(path.join(storage, '0.18.1', 'nested', 'a.txt'), 'utf8'), 'a')
})

test('a configured symlink follows the newest committed directory end to end', async (t) => {
  const testnet = await createLocalTestnet(t)
  const storage = await createTempDir(t)
  const sourceRoot = await createTempDir(t)
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(CLIENT_SEED).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode(),
    symlinks: [{ selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' }]
  })
  const client = new Client({
    seed: CLIENT_SEED,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))
  await server.listen()

  for (const version of ['0.18.0', '0.18.1']) {
    const source = path.join(sourceRoot, version)
    await fs.promises.mkdir(source)
    await fs.promises.writeFile(path.join(source, 'a.bin'), version)
    t.is((await client.upload(source)).status, 'COMMITTED')
    t.is(await fs.promises.readlink(path.join(storage, 'latest')), version)
  }
  t.is(await fs.promises.readFile(path.join(storage, 'latest', 'a.bin'), 'utf8'), '0.18.1')
})
```

In `test/integration/direct-upload.test.ts`, append, matching that file's inline-setup style:

```ts
test('re-uploading an unchanged directory is already committed and never replaced', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverSeed = b4a.alloc(32, 71)
  const clientSeed = b4a.alloc(32, 72)
  const storage = await createTempDir(t)
  const source = path.join(await createTempDir(t), '0.18.1')
  await fs.promises.mkdir(source)
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'a')
  const server = new Server({
    seed: serverSeed,
    storageDir: storage,
    allowedKeys: [keyPairFromSeed(clientSeed).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 16 * 1024,
    minFreeBytes: 0,
    dht: testnet.createNode()
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey,
    connectTimeout: 5_000,
    dht: testnet.createNode()
  })
  t.teardown(async () => {
    await client.close()
    await server.close()
  })

  await server.listen()
  t.is((await client.upload(source)).status, 'COMMITTED')
  t.is((await client.upload(source)).status, 'ALREADY_COMMITTED')
  await fs.promises.writeFile(path.join(source, 'a.bin'), 'b')
  await t.exception(client.upload(source), { code: ERRORS.FILE_EXISTS })
  t.is(await fs.promises.readFile(path.join(storage, '0.18.1', 'a.bin'), 'utf8'), 'a')
})
```

Add `ERRORS` to that file's existing `../../dist/index.js` import list.

- [ ] **Step 4: Run the focused suites to verify red**

Run the unit suites in the sandbox and the integration suites outside it:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/integration/direct-upload.test.js
```

Expected: FAIL — `tsc -p tsconfig.test.json` reports that `symlinks` is not a valid `ServerOptions` property and that `kind` does not exist on `HookArtifact` or on the server `commit` event; once that compiles, the server rejects the directory offer because `receive()` cannot decode directory metadata.

- [ ] **Step 5: Add kind to events and hook artifacts**

In `src/types.ts`:

```ts
export interface TransferEvent {
  /** A 12-character SHA-256 fingerprint of the transfer ID. */
  transfer: string
  name: string
  kind: ArtifactKind
  /** Payload bytes: the file size, or the aggregate tree payload size. */
  size: number
}
```

`TransferEvent` keeps its existing standalone shape (it does not extend `FingerprintEvent`); the only addition is the required `kind` field, which `TransferLifecycleEvent` inherits.

In `src/hooks.ts`:

```ts
export interface HookArtifact {
  name: string
  kind: ArtifactKind
  size: number
  /** The file digest, or the canonical tree digest. */
  sha256: string
  transferId: string
  /** Present only for a directory artifact. */
  entryCount?: number
  sourceParent?: string
  release?: ReleaseCoordinates
}
```

with `import type { ArtifactKind } from './types.js'`.

- [ ] **Step 6: Integrate symlinks and directory lifecycle into the server**

In `src/server.ts`, add imports:

```ts
import {
  compileSymlinkRules,
  selectDesiredLinks,
  symlinkRuleNames,
  type CompiledSymlinkRule,
  type SymlinkRule
} from './symlinks.js'
import { LinkStore } from './storage/link-store.js'
import { assertSymlinkCapable } from './storage/tree-fs.js'
import { isTreeMetadata, type AnyMetadataRecord } from './tar-protocol/controls.js'
import { assertTreeMetadataTransferId } from './tar-protocol/tree-manifest.js'
import { withRootLease } from './storage/root-coordinator.js'
import type { SymlinkCapableStorage } from './storage/types.js'
import type { ArtifactKind } from './types.js'
```

Add the option and fields:

```ts
  /** Repeatable managed-symlink rules; snapshotted and validated at construction. */
  symlinks?: Iterable<SymlinkRule>
```

```ts
  readonly symlinks: readonly CompiledSymlinkRule[]
  readonly linkNames: ReadonlySet<string>
  private links: LinkStore | null = null
```

In the constructor, after `this.storage = options.storage || fs.promises`:

```ts
    this.symlinks = compileSymlinkRules(options.symlinks)
    this.linkNames = symlinkRuleNames(this.symlinks)
    if (this.symlinks.length > 0) assertSymlinkCapable(this.storage)
```

Add the artifact-shape helpers:

```ts
  private artifactKind(metadata: AnyMetadataRecord): ArtifactKind {
    return isTreeMetadata(metadata) ? 'directory' : 'file'
  }
  private payloadBytes(metadata: AnyMetadataRecord): number {
    return isTreeMetadata(metadata) ? metadata.payloadBytes : metadata.fileSize
  }
  private payloadDigest(metadata: AnyMetadataRecord): string {
    return isTreeMetadata(metadata) ? metadata.treeSha256 : metadata.fileSha256
  }
```

Make `transfer()` and `hookArtifact()` kind aware:

```ts
  private transfer(metadata: AnyMetadataRecord) {
    return {
      transfer: fingerprint(b4a.from(metadata.transferId, 'hex')),
      name: metadata.name,
      kind: this.artifactKind(metadata),
      size: this.payloadBytes(metadata)
    }
  }

  private hookArtifact(metadata: AnyMetadataRecord, release: ReleaseCoordinates | null): HookArtifact {
    return Object.freeze({
      name: metadata.name,
      kind: this.artifactKind(metadata),
      size: this.payloadBytes(metadata),
      sha256: this.payloadDigest(metadata),
      transferId: metadata.transferId,
      ...(isTreeMetadata(metadata) ? { entryCount: metadata.entryCount } : {}),
      ...(metadata.sourceParent === undefined ? {} : { sourceParent: metadata.sourceParent }),
      ...(release === null
        ? {}
        : {
            release: Object.freeze({
              series: release.series,
              ...(release.version === undefined ? {} : { version: release.version })
            })
          })
    })
  }
```

Add reconciliation:

```ts
  /**
   * Computes and converges the desired links from durable commit records.
   * Called with the root lease already held.
   */
  private async reconcileLinksUnlocked(records: CommitRecord[]): Promise<ReadonlySet<string>> {
    if (this.symlinks.length === 0 || !this.links) return new Set()
    const desired = selectDesiredLinks(this.symlinks, records)
    await this.links.reconcile(desired, this.linkNames)
    return new Set(desired.map((link) => link.transferId))
  }

  /** Reconciles after a durable commit; this is the only caller that leases the root. */
  private async reconcileAfterCommit(): Promise<void> {
    if (this.symlinks.length === 0 || !this.links || !this.commits) return
    try {
      await withRootLease(this.layout!.root, async () =>
        this.reconcileLinksUnlocked(await this.commits!.list())
      )
    } catch (error) {
      if (error instanceof SwarmDeployError && error.code === ERRORS.LINK_CONFLICT) throw error
      throw new SwarmDeployError(ERRORS.LINK_FAILED, 'Unable to reconcile managed symlinks', error)
    }
  }
```

In `receive()`, authenticate the offer by kind and reject a configured link name before admission:

```ts
      if (isTreeMetadata(metadata)) assertTreeMetadataTransferId(owner, metadata)
      else assertMetadataTransferId(owner, metadata)
```

and immediately after the release-matching block:

```ts
      if (this.linkNames.has(metadata.name)) {
        await rejectEarly(ERRORS.INVALID_FILENAME, 'Artifact name is a configured symlink name')
        return
      }
```

Change the size gate and staging path to use `this.payloadBytes(metadata)` and a kind-aware hook path:

```ts
      const stagingHookPath = isTreeMetadata(metadata)
        ? path.join(this.layout!.staging, `${metadata.transferId}.tree`)
        : path.join(this.layout!.staging, `${metadata.transferId}.part`)
```

Use `stagingHookPath` for the `beforeCommit` and `VERIFIED` hook paths, and keep `${metadata.transferId}.tar.part` for the transfer phase.

Pass the kind through inspection:

```ts
      const inspected = await this.commits.inspect(
        metadata.name,
        {
          name: metadata.name,
          kind: this.artifactKind(metadata),
          size: this.payloadBytes(metadata),
          digest: b4a.from(this.payloadDigest(metadata), 'hex'),
          ...(isTreeMetadata(metadata) ? { entryCount: metadata.entryCount } : {}),
          transferId: b4a.from(metadata.transferId, 'hex'),
          release
        },
        { replaceNames: this.replaceNames }
      )
```

In `finish()`, reconcile between the commit and `afterCommit`:

```ts
        commitSucceeded = true
        hookPath = path.join(this.layout!.root, metadata.name)
        await this.retireQuietly(verified.transferId, owner)
        await this.reconcileAfterCommit()
        phase = 'afterCommit'
```

In the `ALREADY_COMMITTED` branch, reconcile before `afterCommit`:

```ts
        alreadyCommitted = true
        hookPath = path.join(this.layout!.root, metadata.name)
        await this.reconcileAfterCommit()
        phase = 'afterCommit'
```

In `start()`, construct the link store before recovery and wire retention:

```ts
      if (this.symlinks.length > 0) {
        this.links = new LinkStore({
          layout: this.layout,
          storage: this.storage as SymlinkCapableStorage,
          logger: this.logger
        })
      }
```

```ts
        isPinned: (record) => this.replaceNames.has(record.name),
        managedLinkNames: () => this.linkNames,
        reconcileLinks: (records) => this.reconcileLinksUnlocked(records),
```

In `dispose()`, add `this.links = null` next to `this.retention = null`.

- [ ] **Step 7: Add the repeatable two-value CLI option**

In `src/cli.ts`, extend `parseOptions` with a `pairs` set:

```ts
function parseOptions(
  args: string[],
  allowed: ReadonlySet<string>,
  repeatable: ReadonlySet<string> = new Set(),
  keyValues: ReadonlySet<string> = new Set(),
  flags: ReadonlySet<string> = new Set(),
  pairs: ReadonlySet<string> = new Set()
): {
  options: Record<string, string | undefined>
  repeatedOptions: Record<string, string[] | undefined>
  pairOptions: Record<string, Array<[string, string]> | undefined>
  flagOptions: Record<string, true | undefined>
  positionals: string[]
}
```

Inside the option branch, immediately after the `flags.has(arg)` block and before `const value = args[i + 1]`:

```ts
      if (pairs.has(arg)) {
        const first = args[i + 1]
        const second = args[i + 2]
        if (
          first === undefined ||
          first.startsWith('-') ||
          second === undefined ||
          second.startsWith('-')
        ) {
          throw usageError('Missing option value')
        }
        if (isCanonicalHexToken(second) && !keyValues.has(arg)) rejectUnexpectedSeed()
        const values = pairOptions[arg] || []
        values.push([first, second])
        pairOptions[arg] = values
        i += 2
        continue
      }
```

Initialize `pairOptions` alongside the other accumulators and add it to the return value. Destructuring is by name, so the three call sites at `src/cli.ts:506`, `516`, and `697` need no change. Only `runServer` (`src/cli.ts:532`) changes: destructure `pairOptions`, and because `pairs` is the sixth parameter, pass an explicit `new Set()` for `flags` before it.

Add `--symlink` to the server allowlist, repeatable set, and pair set, and parse it:

```ts
  const symlinkPairs = pairOptions['--symlink'] || []
  const symlinks = symlinkPairs.map(([selector, name]) => ({ selector, name }))
  try {
    compileSymlinkRules(symlinks)
  } catch (err) {
    throw usageError('Invalid --symlink')
  }
```

with `import { compileSymlinkRules } from './symlinks.js'`, and pass `symlinks: symlinks.length > 0 ? symlinks : undefined` into the `ServerOptions` literal.

Update `USAGE`'s server line to end with:

```text
[--symlink <selector> <link-name>]... [--hooks <module>]
```

In `src/index.ts`, add:

```ts
export type { SymlinkRule } from './symlinks.js'
```

- [ ] **Step 8: Run every affected suite on Node and Bare to verify green**

Run the unit suites in the sandbox, and the integration suites outside it because HyperDHT network-interface discovery needs local OS access:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/direct-behavior.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/direct-behavior.test.js
./node_modules/.bin/brittle-node .test-dist/unit/cli.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/cli.test.js
./node_modules/.bin/brittle-node .test-dist/unit/hooks.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/hooks.test.js
./node_modules/.bin/brittle-node .test-dist/integration/direct-upload.test.js
./node_modules/.bin/brittle-node .test-dist/integration/behavior-observability.test.js
./node_modules/.bin/brittle-bare .test-dist/integration/direct-upload.test.js
./node_modules/.bin/brittle-bare .test-dist/integration/behavior-observability.test.js
```

Expected: all pass on both runtimes, including the three directory integration tests written in Step 3 of this task.

- [ ] **Step 9: Self-review and commit**

Confirm `reconcileLinksUnlocked` never calls `withRootLease`, that `reconcileAfterCommit` is the only lease acquirer, that the link-name rejection happens before `sessions.admit`, and that no test anywhere is skipped.

```bash
rg -n 'withRootLease|reconcileLinksUnlocked|reconcileAfterCommit|sessions.admit' src/server.ts
rg -n 'test\.skip|t\.skip' test
npm run format && npm run lint
git add src/server.ts src/hooks.ts src/types.ts src/cli.ts src/index.ts \
  test/unit/direct-behavior.test.ts test/unit/cli.test.ts \
  test/integration/direct-upload.test.ts test/integration/behavior-observability.test.ts
git commit -m "feat: maintain managed symlinks from server configuration"
```

Expected: exactly one `withRootLease` call, inside `reconcileAfterCommit`; the link-name check precedes `sessions.admit`; the skip search prints nothing.

---

### Task 13: Public types, documentation, and compatibility coverage

**Files:**

- Modify: `test/types/public-api.ts`
- Modify: `README.md`
- Modify: `docs/spec/swarm-deploy.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Documents and type-pins every public surface Tasks 1–12 produce. The integration suites are not edited here; they were written and made green in Task 12 and are only re-run as a regression gate.

- [ ] **Step 1: Write the failing public type assertions**

In `test/types/public-api.ts`, extend the imports with `type ArtifactKind`, `type SymlinkRule`, and `type UploadTarget`, remove `SkippedUploadReason`-era imports, and add:

```ts
const kinds: ArtifactKind[] = ['file', 'directory']
const symlinkRules: SymlinkRule[] = [
  { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
  { selector: 'release.tar.gz', name: 'current.tar.gz' }
]
const symlinkServerOptions = {
  seed: serverSeed,
  storageDir: '/srv/swarm-deploy',
  allowedKeys: parseAllowlist('00'.repeat(32)),
  maxFileBytes: 1024,
  maxStagingBytes: 4096,
  symlinks: symlinkRules
} satisfies ServerOptions
const target: UploadTarget = { kind: 'directory', name: '0.18.1', path: '/srv/build/0.18.1' }
void [kinds, symlinkServerOptions, target]

function readDirectoryArtifact(artifact: HookArtifact): void {
  const kind: ArtifactKind = artifact.kind
  const entryCount: number | undefined = artifact.entryCount
  void [kind, entryCount]
}
void readDirectoryArtifact

const directoryResult: UploadResult = {
  status: 'COMMITTED',
  kind: 'directory',
  name: '0.18.1',
  size: 10,
  digest: Buffer.alloc(32),
  transferId: Buffer.alloc(32),
  entryCount: 4
}
void directoryResult

// @ts-expect-error Artifact kinds are a closed set.
const badKind: ArtifactKind = 'symlink'
void badKind
// @ts-expect-error A symlink rule needs both a selector and a name.
const badRule: SymlinkRule = { selector: 'release.tar.gz' }
void badRule
// @ts-expect-error Symlink rules are two-string records, not regular expressions.
const badRules: ServerOptions['symlinks'] = [/^\d+$/]
void badRules
// @ts-expect-error Directory batch upload results were removed.
const batch = ({} as UploadResult).results
void batch
// @ts-expect-error The client no longer reports skipped directory members.
const skippedEvent: keyof ClientEventMap = 'skipped'
void skippedEvent
// @ts-expect-error There is no user-facing atomic-directory option.
const atomicOptions: ServerOptions = { ...symlinkServerOptions, atomicDirectory: true }
void atomicOptions
```

Add `type ClientEventMap` to the import list.

- [ ] **Step 2: Run the type test to verify red**

Run:

```bash
npm run build
npm run test:types
```

Expected: FAIL — `ArtifactKind`, `SymlinkRule`, and `UploadTarget` are not exported from `./dist/index.js`, and `kind` is missing on `UploadResult`.

- [ ] **Step 3: Confirm the exports and re-run the type test**

Verify `src/index.ts` exports `ArtifactKind`, `SymlinkRule`, and `UploadTarget` (added in Tasks 5 and 12) and that no removed type is still exported.

Run:

```bash
npm run build
npm run test:types
rg -n 'SkippedUploadReason|BatchUploadResult|SkippedUploadEntry|BatchUploadFailure' src test
```

Expected: `test:types` passes and the `rg` command prints nothing.

- [ ] **Step 4: Verify the runtime export surface is unchanged**

The new exports are all types, so `scripts/package-smoke.mjs`'s `expectedRuntimeExports` must not change.

Run:

```bash
node -e "const api = require('./dist/index.js'); console.log(JSON.stringify(Object.keys(api).sort()))"
```

Expected output exactly:

```text
["Client","ERRORS","Server","SwarmDeployError","fixedSeriesKey","generateSeed","keyPairFromSeed","parseAllowlist","parsePublicKey","parseSeed","publicKeyFromSeed"]
```

If the list differs, remove the accidental runtime export rather than editing `scripts/package-smoke.mjs`.

- [ ] **Step 5: Document the operator surface in the README**

Edit `README.md`:

- In `### server`, add `[--symlink <selector> <link-name>]...` to the synopsis and a parameter entry describing the exact and `/regex/` selector forms, the safe link basename, and repeatability.
- In `### upload`, replace the directory-batch paragraph (around the current line 277) with: a directory input commits exactly one recursive managed directory artifact named after the input basename; every member must be a safe regular file or directory; any symlink, hardlink, device, socket, FIFO, unsafe name, over-depth, over-count, or over-length member rejects the whole upload; nothing is silently skipped.
- In `## Storage, replacement, and retention`, document that directory artifacts are create-only, deleted by renaming into `.swarm-deploy/trash` before recursive removal, and that startup recursively verifies their canonical tree digest while scheduled passes only check type and sidecar.
- Add a new `## Managed symlinks` section after `## Artifact patterns and rotation` containing:
  - the exact CLI example

    ```sh
    swarm-deploy server \
      --seed-file ./server.seed \
      --storage /srv/artifacts \
      --allow-key <64-lower-hex> \
      --max-file-bytes 1073741824 \
      --max-staging-bytes 4294967296 \
      --symlink '/^\d+\.\d+\.\d+$/' latest \
      --symlink release.tar.gz current.tar.gz
    ```

  - the resulting layout

    ```text
    /srv/artifacts/
    ├── 0.18.0/
    ├── 0.18.1/
    └── latest -> 0.18.1
    ```

  - the runtime equivalent

    ```js
    const server = new Server({
      seed,
      storageDir: '/srv/artifacts',
      allowedKeys,
      maxFileBytes: 1024 ** 3,
      maxStagingBytes: 4 * 1024 ** 3,
      symlinks: [
        { selector: '/^\\d+\\.\\d+\\.\\d+$/', name: 'latest' },
        { selector: 'release.tar.gz', name: 'current.tar.gz' }
      ]
    })
    ```

  - selection rules: only validated managed commit records are candidates; the newest `committedAt` wins, tie-broken by transfer ID then name; replacement history names never match; a rule is dormant until its target exists;
  - safety rules: an unmanaged file, directory, unrecorded symlink, changed symlink, or foreign ownership record is never replaced, moved, or deleted and causes a fail-closed error; an upload whose name equals a configured link name is rejected before admission;
  - retention: every selected target is pinned against age, count, SemVer, and quota deletion, still counts toward the quota, and is repointed before the old target becomes eligible;
  - adapter requirement: `symlinks` requires `StorageAdapter.symlink` and `readlink`; the Node and Bare default adapters provide them; a custom adapter without symlink rules is unaffected;
  - the new `LINK_CONFLICT`, `LINK_FAILED`, and `UNSUPPORTED_STORAGE` error codes in `## Errors`.
- In `### Lifecycle points`, document `HookArtifact.kind`, `entryCount`, that `beforeCommit.path` is the verified `.tree` staging directory, that `afterCommit.path` is the final committed directory, and that configured links are reconciled before `afterCommit`.
- In `### Upload results`, replace `BatchUploadResult` with the single `UploadResult` shape including `kind` and `entryCount`.
- In `### Events`, remove `skipped` and document the `kind` field on server transfer events and the client `result` event.

- [ ] **Step 6: Document the protocol in the specification**

Edit `docs/spec/swarm-deploy.md`:

- Under `### Deterministic one-entry TAR`, add a sibling `### Deterministic recursive tree TAR` giving the entry ordering, normalized header fields, directory typeflag and trailing slash, per-component and whole-name byte limits, depth 32, count 10,000, and the exact `swarm-deploy/tree/v1` digest framing.
- Add `### Directory offer metadata` listing the exact key set, the `swarm-deploy/direct-tree/v1` transfer-ID domain and its committed fields, and the rule that an old server rejects the shape through its exact-key check without mutating storage.
- Under `### Resume state`, document session version 4 and that file sessions remain versions 2 and 3.
- Under `## Commit, replacement, and recovery`, document commit record version 3, directory journal version 3 and its `journaled → renamed → sidecar → cleanup` phases, the publish-by-rename order, the four recovery crash boundaries, create-only enforcement, and the trash-rename deletion with startup sweeping.
- Add `## Managed symlinks` documenting the ownership record path `.swarm-deploy/links/<sha256(link-name)>.json`, its exact fields, the four-condition replaceability test, the six-step update transaction, level-triggered recovery, and retention pinning.
- Under `### Rollout compatibility`, state that direct file TAR bytes, transfer IDs, sessions, records, commit, replacement, hooks, and retention are unchanged, and that directory metadata, session v4, record v3, directory journals, and directory trash are not downgrade-compatible.

- [ ] **Step 7: Record the changelog entries**

Add to the top of the `## Unreleased` list in `CHANGELOG.md`:

```markdown
- **Behavior change.** A directory upload now commits exactly one recursive managed directory artifact instead of a batch of immediate-child file uploads. `BatchUploadResult`, `BatchUploadFailure`, `SkippedUploadEntry`, `SkippedUploadReason`, and the client `skipped` event are removed, `ClientUploadResult` is now `UploadResult`, and `UploadResult` gains `kind` and, for a directory, `entryCount`. Direct file upload stays byte-compatible. Automation that relied on per-child results must now treat the directory as one artifact.
- Add recursive directory artifacts: a canonical deterministic multi-entry USTAR archive with normalized file mode `0644`, directory mode `0755`, fixed uid, gid, mtime, uname, and gname; bytewise entry ordering with parents before children; empty directories preserved; and symlinks, hardlinks, devices, sockets, FIFOs, cycles, traversal, duplicate, and case-fold-colliding paths rejected. Limits are 100 UTF-8 bytes per component, 100 UTF-8 bytes per stored TAR name, depth 32, 10,000 entries, `maxFileBytes` aggregate payload, and `maxStagingBytes` aggregate staging.
- Add directory offer metadata with `kind: 'directory'`, `entryCount`, `payloadBytes`, and a canonical `treeSha256`, and the `swarm-deploy/direct-tree/v1` transfer-ID domain. The key set is disjoint from the file record's, so an older server rejects it without mutating storage. Upgrade servers before clients.
- Add directory sessions at persisted version 4, verified into `.swarm-deploy/staging/<transfer-id>.tree/` by rebuilding and byte-comparing every canonical header and independently recomputing the tree digest. File sessions keep versions 2 and 3.
- Add directory commit records at version 3 and directory journals at version 3. A directory is published by renaming its verified staging tree under the name and root leases, with explicit recovery for crashes before the rename, after the rename, after the sidecar, and during symlink reconciliation.
- Directory artifacts are create-only. A directory offer for a configured `replaceNames` entry, a file-to-directory kind change, and a directory-to-file kind change are all rejected. Directory replacement and history are deferred because a directory cannot use the file hardlink replacement transaction safely.
- Delete a managed directory by renaming it into `.swarm-deploy/trash/<transfer-id>.tree` and then removing it recursively with `lstat`, `unlink`, and `rmdir` without following symlinks. Startup sweeps proven trash residue.
- Make storage scrubbing kind aware: scheduled and pre-commit passes validate type, sidecar, and root identity, while startup recovery recursively hashes a directory artifact and verifies its canonical tree digest. A mutated managed directory is preserved as unknown and its invalid metadata removed.
- Add server-managed symlinks: `ServerOptions.symlinks` and the repeatable two-value CLI option `--symlink <selector> <link-name>`. A selector that begins and ends with `/` is an unflagged regular expression matched against managed artifact basenames; anything else is an exact managed basename. Selection uses only validated commit records and picks the newest `committedAt`, tie-broken by transfer ID then name. A rule is dormant until its target exists and replacement history names never match.
- Persist managed-link ownership in `.swarm-deploy/links/<sha256(link-name)>.json`. A destination is replaced only when a valid record exists, the destination is a symbolic link, and `readlink()` returns the recorded or desired target. A pre-existing file, directory, unrecorded symlink, changed symlink, or foreign ownership record is unmanaged: it is never replaced, moved, or deleted, and the server fails closed. Reconciliation is level-triggered from startup, commit, already-committed retry, recovery, and retention.
- Reject an upload whose artifact name equals a configured symlink name before session admission, so a configured link never masks a managed artifact.
- Pin every selected symlink target against age, count, SemVer, and quota retention. Pinned targets still count toward the quota, and the desired-link set is recomputed under the root lease before any deletion, so a repoint always precedes the old target becoming eligible. Removing a rule removes its ownership record and visible link only while ownership is still proven.
- Add optional `StorageAdapter.symlink` and `readlink`. Configuring symlink rules requires both; the Node and Bare default adapters provide them, and a custom adapter without symlink rules stays source-compatible.
- Add `HookArtifact.kind` and optional `entryCount`, and the artifact kind to server transfer, offer, progress, and client result events. For a directory, `beforeCommit.path` is the verified `.tree` staging directory and `afterCommit.path` is the final committed directory; configured links are reconciled before `afterCommit`, so a hook observes the new link.
- Add the `LINK_CONFLICT`, `LINK_FAILED`, and `UNSUPPORTED_STORAGE` error codes. A link reconciliation failure after a durable commit behaves like other post-commit deployment failures: the artifact stays committed, the client receives a stable failure, and an already-committed retry reruns reconciliation before succeeding.
- Add the private `.swarm-deploy/links` and `.swarm-deploy/trash` directories, protected, identity-checked, and synchronized like the existing internal directories.
- Directory metadata, session version 4, commit record version 3, directory journals, and directory trash are not downgrade-compatible. Drain uploads before upgrading and do not roll back after committing a directory artifact without restoring from backup.
- The package exposes no user-facing "atomic directory" term or option; atomicity is an internal commit and recovery guarantee.
```

- [ ] **Step 8: Run the end-to-end integration suites to verify green**

Run outside the sandbox because HyperDHT network-interface discovery needs local OS access:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/integration/direct-upload.test.js
./node_modules/.bin/brittle-node .test-dist/integration/behavior-observability.test.js
./node_modules/.bin/brittle-bare .test-dist/integration/direct-upload.test.js
./node_modules/.bin/brittle-bare .test-dist/integration/behavior-observability.test.js
npm run test:types
```

Expected: all pass, including the directory integration assertions written in Task 12.

- [ ] **Step 9: Commit**

```bash
npm run format
git add test/types/public-api.ts README.md docs/spec/swarm-deploy.md CHANGELOG.md
git commit -m "docs: explain directory artifacts and managed symlinks"
```

---

### Task 14: Full verification and pull-request update

**Files:**

- Modify only the files required to fix failures introduced by Tasks 1–13.

**Interfaces:**

- Verifies the complete feature, packaging, and release matrix and updates PR #9.

- [ ] **Step 1: Run repository quality checks**

Run:

```bash
npm run format:check
npm run lint
npm run test:property
npm run test:release-tag
```

Expected: every command exits 0 with no formatting, lint, or type errors.

- [ ] **Step 2: Run the full Node and Bare suites**

Run outside the sandbox because native HyperDHT network-interface discovery requires local OS access:

```bash
npm test
```

Expected: the build succeeds and every Brittle test passes on Node and Bare.

- [ ] **Step 3: Run package validation**

Run:

```bash
npm run prepack
npm run test:package
git diff --check
git status --short
```

Expected: package validation and the smoke test pass, the diff check is clean, and only intentional tracked changes remain.

- [ ] **Step 4: Verify the design's testing checklist**

Confirm a passing test exists for each item and record the file and test name for any gap:

- exact and regex rule parsing, repeatability, newest selection, malformed regexes, duplicate names, 64-hex selectors — `test/unit/symlink-rules.test.ts`;
- link creation, replacement, restart reconciliation, removed rules, ownership conflicts, temporary-link crashes — `test/unit/link-store.test.ts`;
- absolute paths, traversal, root and internal targets, link-name collisions, foreign symlinks, unmanaged overwrite — `test/unit/link-store.test.ts` and `test/unit/direct-behavior.test.ts`;
- pinning through every retention policy and repoint-before-delete ordering — `test/unit/retention.test.ts` and `test/unit/direct-behavior.test.ts`;
- recursive deterministic TAR equality on Node and Bare — `test/unit/tree-canonical.test.ts`, `test/unit/tree-manifest.test.ts`, `test/unit/tar-property.test.ts`;
- empty and nested directory preservation and resume at arbitrary offsets — `test/unit/tree-manifest.test.ts`, `test/unit/tar-property.test.ts`;
- mutated source files and listings and prefix-reset behavior — `test/unit/tree-manifest.test.ts`;
- malicious TAR traversal, links, devices, duplicates, case collisions, ordering, depth, count, size bombs, padding, digest, and trailing data — `test/unit/tree-extract.test.ts`;
- session version 4 restart, stray tree staging, safe recursive cleanup — `test/unit/tar-session-store.test.ts`;
- directory record and journal schema validation, phase round-trips, and commit ordering — `test/unit/commit-journal.test.ts`;
- directory commit crash boundaries and startup recovery — `test/unit/commit-recovery.test.ts`;
- create-only enforcement and file/directory kind conflicts — `test/unit/commit-recovery.test.ts`;
- trash-rename deletion crashes and startup sweeping — `test/unit/retention.test.ts`;
- client-side single directory offer, canonical archive bytes, and one final result — `test/unit/direct-behavior.test.ts`;
- hook paths, kinds, alias visibility, already-committed retry, close, and failure contexts — `test/unit/direct-behavior.test.ts`;
- end-to-end directory commit, symlink repointing, and unchanged-directory retry — `test/integration/behavior-observability.test.ts` and `test/integration/direct-upload.test.ts`;
- old file compatibility and package and public-type coverage — `test/unit/tar-protocol.test.ts`, `test/types/public-api.ts`, `scripts/package-smoke.mjs`.

Also confirm the repository has no skipped test and every suite is registered:

```bash
rg -n 'test\.skip|t\.skip|solo' test
rg -c 'require\(' test/run.ts
```

Expected: the skip search prints nothing, and `test/run.ts` registers every file under `test/unit` and `test/integration`.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add -u
git commit -m "test: complete directory artifact and symlink coverage"
```

Skip this commit when verification required no corrections.

- [ ] **Step 6: Push and update pull request #9**

```bash
git push origin feat/artifact-rotation-hooks
cat > /tmp/swarm-deploy-pr-9-body.md <<'EOF'
## Summary
- add count and SemVer major/minor artifact rotation with persisted release identity
- authenticate immediate source-parent folder metadata for configured patterns
- add retry-safe JavaScript beforeCommit, afterCommit, and onFailure hooks
- commit a directory input as one recursive managed directory artifact with a
  canonical deterministic multi-entry archive, session v4, record v3, directory
  journals, and trash-rename deletion
- maintain server-managed symlinks from repeatable `--symlink <selector> <link-name>`
  rules that always point at the newest matching managed artifact

## Behavior changes
- A directory upload is now one recursive artifact. `BatchUploadResult`,
  `BatchUploadFailure`, `SkippedUploadEntry`, `SkippedUploadReason`, and the
  client `skipped` event are removed; `UploadResult` gains `kind` and
  `entryCount`. Direct file upload is byte-compatible.
- Directory metadata, session v4, record v3, directory journals, and directory
  trash are not downgrade-compatible. Drain uploads before upgrading.
- Directory artifacts are create-only; directory replacement and history are
  deferred.

## Verification
- npm run format:check
- npm run lint
- npm run test:property
- npm run test:release-tag
- npm test
- npm run prepack
- npm run test:package

Closes #6
EOF
gh pr edit 9 \
  --repo tetherto/swarm-deploy \
  --title "feat: add artifact rotation, hooks, directory artifacts, and managed symlinks" \
  --body-file /tmp/swarm-deploy-pr-9-body.md
```

The PR body must keep `Closes #6` so GitHub closes the issue on merge. Do not close the issue manually while the PR is open.

- [ ] **Step 7: Confirm continuous integration**

```bash
gh pr checks 9 --repo tetherto/swarm-deploy --watch
```

Expected: every required check passes. Fix any failure by repeating the relevant task's red-green cycle rather than by weakening a test.
