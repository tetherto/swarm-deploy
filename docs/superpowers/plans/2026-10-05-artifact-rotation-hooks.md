# Artifact Rotation and Custom Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic count/SemVer artifact rotation and retry-safe JavaScript deployment hooks to the server API and CLI.

**Architecture:** The client authenticates an optional immediate source-parent basename as part of direct-TAR metadata. The server matches ordered literal-safe templates and persists normalized release coordinates in commit sidecars; retention uses only those persisted coordinates. Hook callbacks are snapshotted in `ServerOptions`, while the CLI dynamically loads a JavaScript module and passes the resulting object into the same runtime API.

**Tech Stack:** TypeScript 7, Node.js 22–24, Bare, Brittle, `semver` 7.8.x with `@types/semver` 7.8.x, direct HyperDHT, durable JSON sidecars.

## Global Constraints

- Existing clients that omit `sourceParent` and existing v2 TAR sessions remain readable.
- Absolute source paths and higher parent components never cross the protocol.
- Count rotation uses commit order; version rotation uses strict SemVer precedence.
- Legacy and unmatched commit records are not selected by count/version rotation.
- Current replaceable artifacts remain pinned.
- Hook callbacks receive no seeds, secret keys, TAR bytes, or unrelated session state.
- `beforeCommit` and `afterCommit` may be invoked repeatedly and are documented as idempotent.
- New behavior must pass Node.js and Bare test suites.

---

## File Structure

- `src/release.ts`: template validation/matching, normalized release coordinates, and SemVer grouping/comparison.
- `src/hooks.ts`: public hook types, callback snapshot validation, context types, and `HOOK_FAILED` wrapping.
- `src/hooks-module.ts`: CLI-only dynamic JavaScript module loading and export normalization.
- `src/tar-protocol/{manifest,controls}.ts`: authenticated `sourceParent` metadata.
- `src/storage/{tar-session-store,commit-journal,commit-store,retention}.ts`: durable parent/session compatibility, persisted release coordinates, and rotation.
- `src/{server,cli,index,errors}.ts`: public options, lifecycle invocation, module selection, exports, and stable error.
- `test/unit/{release,hooks,tar-protocol,tar-session-store,commit-recovery,retention,direct-behavior,cli}.test.ts`: focused behavior.
- `test/types/public-api.ts`: exported API contracts.
- `README.md`, `docs/spec/swarm-deploy.md`, `CHANGELOG.md`: operator and retry semantics.

---

### Task 1: Release pattern and SemVer primitives

**Files:**
- Create: `src/release.ts`
- Create: `test/unit/release.test.ts`
- Modify: `package.json`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**
- Produces: `ReleaseCoordinates`, `VersionGranularity`, `ReleaseMatcher`, `compareReleaseVersions()`, and `releaseVersionGroup()`.
- Consumes: strict parsing/comparison from `semver`.

- [ ] **Step 1: Add a failing release-template test**

```ts
import test from 'brittle'
import {
  ReleaseMatcher,
  compareReleaseVersions,
  releaseVersionGroup
} from '../../dist/release.js'

test('release templates match basenames and immediate source parents in order', (t) => {
  const matcher = new ReleaseMatcher([
    'releases/{series}-{version}.tar.gz',
    '{version}/{series}.tar.gz',
    '{series}-{version}.tar.gz'
  ])
  t.alike(matcher.match('api.tar.gz', '2.4.1'), { series: 'api', version: '2.4.1' })
  t.alike(matcher.match('worker-1.3.0-rc.1.tar.gz', 'releases'), {
    series: 'worker',
    version: '1.3.0-rc.1'
  })
  t.alike(matcher.match('web-3.0.0.tar.gz'), { series: 'web', version: '3.0.0' })
  t.is(matcher.match('notes.txt'), null)
})

test('release versions use SemVer precedence and major/minor groups', (t) => {
  t.is(compareReleaseVersions('2.0.0-rc.1', '1.9.9') > 0, true)
  t.is(compareReleaseVersions('1.2.3+build.2', '1.2.3+build.1'), 0)
  t.is(releaseVersionGroup('1.2.3-rc.1', 'major'), '1')
  t.is(releaseVersionGroup('1.2.3-rc.1', 'minor'), '1.2')
})
```

Also assert constructor rejection for duplicate templates, repeated placeholders,
templates without placeholders, path separators outside the optional single
parent boundary, and malformed empty captures.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
npm run build && npm run build:test
```

Expected: TypeScript reports that `../../dist/release.js` does not exist.

- [ ] **Step 3: Install SemVer and implement the matcher**

Run:

```bash
npm install semver@^7.8.5
npm install --save-dev @types/semver@^7.8.0
```

Implement these exact public shapes:

```ts
export type VersionGranularity = 'major' | 'minor'

export interface ReleaseCoordinates {
  series: string
  version?: string
}

export class ReleaseMatcher {
  constructor(patterns: Iterable<string>)
  get size(): number
  get hasVersionPattern(): boolean
  match(name: string, sourceParent?: string): ReleaseCoordinates | null
}

export function compareReleaseVersions(left: string, right: string): number
export function releaseVersionGroup(
  version: string,
  granularity: VersionGranularity
): string
```

Compile templates by escaping literal text, replacing `{series}` with a named
safe-text capture and `{version}` with a named non-separator capture, then
strictly parse and normalize the latter with `new SemVer(value).version`.
Try `name` first and `sourceParent/name` second for every configured pattern.
For templates without `{series}`, use the template text as the fixed series key.
Snapshot the iterable and reject duplicates.

- [ ] **Step 4: Register and run focused tests**

Add `test/unit/release.test.ts` to `tsconfig.test.json` and require its compiled
file from `test/run.ts`.

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/release.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/release.test.js
```

Expected: both focused suites pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add package.json src/release.ts test/unit/release.test.ts test/run.ts tsconfig.test.json
git commit -m "feat: add release pattern matching"
```

---

### Task 2: Authenticate source-parent metadata and persist release identity

**Files:**
- Modify: `src/tar-protocol/controls.ts`
- Modify: `src/tar-protocol/manifest.ts`
- Modify: `src/storage/tar-session-store.ts`
- Modify: `src/storage/commit-journal.ts`
- Modify: `src/storage/commit-store.ts`
- Modify: `test/unit/tar-protocol.test.ts`
- Modify: `test/unit/tar-session-store.test.ts`
- Modify: `test/unit/commit-recovery.test.ts`

**Interfaces:**
- Consumes: `ReleaseCoordinates` from Task 1.
- Produces: optional `MetadataRecord.sourceParent`, `TarManifest.sourceParent`,
  `TarSession.sourceParent`, and `CommitRecord.release`.
- Produces: `CommitStore.commit(..., { release })`.

- [ ] **Step 1: Write failing protocol and persistence tests**

Add tests asserting:

```ts
const manifest = await buildTarManifest('/tmp/releases/2.4.1/api.tar.gz', OWNER)
t.is(manifest.sourceParent, '2.4.1')
t.is(metadataFromManifest(manifest).sourceParent, '2.4.1')
```

Clone that metadata, change only `sourceParent`, and assert
`assertMetadataTransferId()` rejects it. Encode/decode metadata without
`sourceParent` and assert the old exact-key record remains valid.

In `tar-session-store.test.ts`, persist a session with `sourceParent`, restart
the store, and assert it is restored. Write a valid legacy version-2 session
without the field and assert it is restored with `sourceParent === undefined`.

In `commit-recovery.test.ts`, commit with:

```ts
const release = { series: 'api', version: '2.4.1' }
```

and assert create, replacement history, journal recovery, and sidecar
round-trips retain exactly those coordinates.

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tar-protocol.test.js
./node_modules/.bin/brittle-node .test-dist/unit/tar-session-store.test.js
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
```

Expected: assertions fail because source-parent and release fields are absent.

- [ ] **Step 3: Extend direct-TAR metadata compatibly**

Add `sourceParent?: string` to `MetadataRecord` and `TarManifest`. Validate it
with the same safe basename rules as artifact names but permit no
`history-` special case. `validateMetadata()` must accept exactly either the
old key set or the new key set.

Derive the immediate parent from `path.resolve(filePath)`. Include it only when
it is one valid 100-byte metadata component; otherwise omit it so ordinary
uploads remain valid when no server patterns are configured. Explicit unsafe
wire metadata still fails strict decoding. Include a present parent in
`computeTarTransferId()` and pass it through `metadataFromManifest()` and
`assertMetadataTransferId()`. This conditional field preserves old transfer
IDs for old or omitted metadata.

- [ ] **Step 4: Persist source-parent sessions with backward compatibility**

Bump new session serialization to version 3. `fromDisk()` must accept versions
2 and 3, reject `sourceParent` on v2, validate it on v3, and copy it into
`TarSession`. Include it in `sameMetadata()` so a resume cannot change the
authenticated parent.

- [ ] **Step 5: Persist release coordinates in commit records**

Add:

```ts
export interface CommitRelease {
  series: string
  version?: string
}

export interface CommitRecord {
  // existing fields
  release?: CommitRelease
}
```

Validate safe non-empty `series` and normalized strict SemVer `version`.
`recordsEqual()`, `_recordFromSession()`, journal validation/serialization,
replacement deduplication, and `historyRecord()` must preserve and compare the
field. Extend `CommitStore.commit()` with
`release?: ReleaseCoordinates | null`; snapshot and validate before entering
leases.

- [ ] **Step 6: Run focused Node and Bare tests**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/tar-protocol.test.js
./node_modules/.bin/brittle-node .test-dist/unit/tar-session-store.test.js
./node_modules/.bin/brittle-node .test-dist/unit/commit-recovery.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tar-protocol.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/tar-session-store.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/commit-recovery.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tar-protocol/controls.ts src/tar-protocol/manifest.ts \
  src/storage/tar-session-store.ts src/storage/commit-journal.ts \
  src/storage/commit-store.ts test/unit/tar-protocol.test.ts \
  test/unit/tar-session-store.test.ts test/unit/commit-recovery.test.ts
git commit -m "feat: persist artifact release identity"
```

---

### Task 3: Add count and SemVer retention

**Files:**
- Modify: `src/storage/retention.ts`
- Modify: `src/server.ts`
- Modify: `test/unit/retention.test.ts`
- Modify: `test/integration/behavior-observability.test.ts`

**Interfaces:**
- Consumes: `CommitRecord.release`, `compareReleaseVersions()`, and
  `releaseVersionGroup()`.
- Produces: `RetentionManagerOptions.maxCount`, `maxVersions`,
  `versionGranularity`.
- Produces: result/event fields `countDeleted` and `versionDeleted`.

- [ ] **Step 1: Add failing retention selection tests**

Extend the retention harness so `publish()` can pass release coordinates into
`CommitStore.commit()`. Add focused cases:

```ts
test('count rotation keeps newest commits per series including history', async (t) => {
  const harness = await createHarness(t)
  const first = await harness.publish(
    MUTABLE,
    b4a.from('1.0.0'),
    true,
    { series: 'api', version: '1.0.0' }
  )
  harness.clock.advance(1)
  const second = await harness.publish(
    MUTABLE,
    b4a.from('1.1.0'),
    true,
    { series: 'api', version: '1.1.0' }
  )
  harness.clock.advance(1)
  const third = await harness.publish(
    MUTABLE,
    b4a.from('1.2.0'),
    true,
    { series: 'api', version: '1.2.0' }
  )
  const result = await harness.manager({
    maxCount: 2,
    isPinned: (record) => record.name === MUTABLE
  }).run()

  t.is(result.countDeleted, 1)
  t.alike(
    (await harness.commits.list()).map((record) => record.transferId).sort(),
    [second.transferId, third.transferId].sort()
  )
  t.is(await exists(path.join(harness.layout.root, historyName(first.transferId))), false)
})

test('version rotation keeps newest distinct SemVer minor groups', async (t) => {
  const harness = await createHarness(t)
  const releases = ['1.9.9', '2.0.0-rc.1', '2.0.0', '2.1.0+build.1', '2.1.1']
  for (const version of releases) {
    await harness.publish(
      `api-${version}.bin`,
      b4a.from(version),
      false,
      { series: 'api', version }
    )
    harness.clock.advance(1)
  }
  const result = await harness.manager({
    maxVersions: 2,
    versionGranularity: 'minor'
  }).run()

  t.is(result.versionDeleted, 1)
  t.alike(
    (await harness.commits.list()).map((record) => record.release?.version).sort(),
    ['2.0.0-rc.1', '2.0.0', '2.1.0+build.1', '2.1.1'].sort()
  )
})
```

Extend the same file with table-driven assertions using these exact inputs:

```ts
const cases = [
  { name: 'equal-time count ties', versions: ['1.0.0', '1.0.1', '1.0.2'], maxCount: 2 },
  { name: 'major groups', versions: ['1.9.9', '2.0.0-rc.1', '2.1.0', '3.0.0'], maxVersions: 2 },
  { name: 'count and version intersection', versions: ['1.0.0', '2.0.0', '2.0.1'], maxCount: 1, maxVersions: 1 }
]
```

For each case assert exact surviving transfer IDs after deterministic sorting.
Add one record without `release`, one with a different series, and a pinned
current record; assert the legacy/different-series records are untouched and
the pinned current survives even when outside the calculated keep set.

Add server/commit tests proving:

- with no `artifactPatterns`, an unmatched upload follows existing behavior;
- with patterns configured, an unmatched filename or required-parent mismatch
  is rejected with `INVALID_FILENAME` before session admission;
- matching filename-only and parent/name offers pass normalized release
  coordinates into inspection and commit;
- `CommitStore.inspect()` returns `ALREADY_COMMITTED` only when transfer and
  release identity agree;
- same content under a different matched release is replaceable for mutable
  names and is not silently collapsed into the prior release.

- [ ] **Step 2: Run retention tests and verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
```

Expected: constructor/result assertions fail because rotation options and
counters do not exist.

- [ ] **Step 3: Implement selectors and deletion stages**

Add validated constructor fields:

```ts
maxCount?: number
maxVersions?: number
versionGranularity?: 'major' | 'minor'
```

Implement pure keep-set helpers:

```ts
function countKeepSet(records: CommitRecord[], maxCount: number): Set<string>
function versionKeepSet(
  records: CommitRecord[],
  maxVersions: number,
  granularity: VersionGranularity
): Set<string>
```

Use transfer ID as the set key. Count sorting is descending `committedAt`,
then transfer ID, then name. Version selection sorts normalized versions by
SemVer precedence, groups by major or `major.minor`, and keeps every record in
selected groups. Apply age, count, version, and quota stages in that order.
Skip pinned records during deletion without backfilling a newer keep slot.
Add deletion reasons `MAX_COUNT` and `MAX_VERSIONS`.

- [ ] **Step 4: Wire server options and observability**

Validate `ServerOptions.maxCount`, `maxVersions`, and `versionGranularity`.
Construct a `ReleaseMatcher` from a snapshotted `artifactPatterns` iterable.
Reject invalid option combinations described in the spec. Pass matcher output
to `CommitStore.inspect()` and each commit, and pass rotation values to
`RetentionManager`. When matcher size is nonzero, reject a null match with
`ERRORS.INVALID_FILENAME` before session admission. Extend `CommitOffer` with
the matched release so idempotent and replacement inspection compares release
identity rather than digest alone.

Extend `RetentionEvent` and behavior-observability assertions with
`countDeleted` and `versionDeleted`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/retention.test.js
./node_modules/.bin/brittle-node .test-dist/integration/behavior-observability.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/retention.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/storage/retention.ts src/server.ts \
  test/unit/retention.test.ts test/integration/behavior-observability.test.ts
git commit -m "feat: rotate artifacts by count and version"
```

---

### Task 4: Add typed hook lifecycle behavior

**Files:**
- Create: `src/hooks.ts`
- Create: `test/unit/hooks.test.ts`
- Modify: `src/errors.ts`
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Modify: `test/unit/direct-behavior.test.ts`
- Modify: `test/types/public-api.ts`
- Modify: `test/run.ts`
- Modify: `tsconfig.test.json`

**Interfaces:**
- Produces: `ServerHooks`, `HookArtifact`, `BeforeCommitContext`,
  `AfterCommitContext`, `HookFailureContext`, `HookFailurePhase`.
- Produces: `snapshotHooks()` and `hookError()`.
- Produces: stable `ERRORS.HOOK_FAILED`.

- [ ] **Step 1: Write failing hook validation and public-type tests**

Use these public shapes:

```ts
export type HookFailurePhase =
  | 'offer'
  | 'transfer'
  | 'verification'
  | 'beforeCommit'
  | 'commit'
  | 'afterCommit'

export interface HookArtifact {
  name: string
  size: number
  sha256: string
  transferId: string
  sourceParent?: string
  release?: ReleaseCoordinates
}

export interface BeforeCommitContext {
  artifact: HookArtifact
  path: string
  resumed: boolean
  alreadyCommitted: false
}

export interface AfterCommitContext {
  artifact: HookArtifact
  path: string
  resumed: boolean
  alreadyCommitted: boolean
}

export interface HookFailureContext {
  artifact: HookArtifact
  path: string | null
  phase: HookFailurePhase
  resumed: boolean
  alreadyCommitted: boolean
  error: unknown
}

export interface ServerHooks {
  beforeCommit?(context: BeforeCommitContext): void | Promise<void>
  afterCommit?(context: AfterCommitContext): void | Promise<void>
  onFailure?(context: HookFailureContext): void | Promise<void>
}
```

Assert `snapshotHooks()` rejects non-functions and snapshots function
references so later caller mutation does not change callbacks. Add
`ServerOptions` type coverage in `test/types/public-api.ts`.

- [ ] **Step 2: Add failing direct lifecycle tests**

Drive fake sockets through:

1. fresh upload: `beforeCommit`, durable commit, `afterCommit`;
2. partial resume: both callbacks receive `resumed: true`;
3. verified reconnect: `beforeCommit` runs again with `resumed: true`;
4. already committed: only `afterCommit` runs with
   `alreadyCommitted: true`, before the admission response;
5. `beforeCommit` failure: `HOOK_FAILED`, verified session remains;
6. `afterCommit` failure: `HOOK_FAILED`, artifact remains committed, retry
   invokes `afterCommit` through already-committed handling;
7. ordinary verification/commit failures invoke `onFailure` once with the
   original error;
8. `onFailure` rejection is logged and does not replace the original code.

Also assert offer-inspection failures report phase `offer` and truncated upload
failures report phase `transfer`.

- [ ] **Step 3: Run focused tests and verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/hooks.test.js
./node_modules/.bin/brittle-node .test-dist/unit/direct-behavior.test.js
npm run test:types
```

Expected: missing exports/options and lifecycle assertions fail.

- [ ] **Step 4: Implement hook validation and error wrapping**

Add `HOOK_FAILED` to `ERRORS`. `snapshotHooks()` accepts `null`/`undefined` as
no hooks, rejects unknown callback values, binds no receiver, and returns a
frozen snapshot. `hookError(phase, cause)` returns a
`SwarmDeployError(ERRORS.HOOK_FAILED, ...)`.

- [ ] **Step 5: Refactor the server receive lifecycle**

Snapshot hooks in the constructor. After metadata decode, create one artifact
context and track `phase`, `path`, `resumed`, `alreadyCommitted`, and whether
`onFailure` was attempted. Initialize phase to `offer`, set it to `transfer`
after admission, and advance it at verification, callback, and commit
boundaries.

For verified work:

```ts
await hooks.beforeCommit?.(beforeContext)
const record = await commits.commit(verified, { release, retentionManager, signal, replaceNames })
await hooks.afterCommit?.(afterContext)
```

Wrap only callback exceptions as `HOOK_FAILED`. Set the staging path before
`beforeCommit` and final path before `afterCommit`. Run already-committed
`afterCommit` before writing the `ALREADY_COMMITTED` admission record. Ensure
an `afterCommit` failure after a durable commit still writes a `FAILED` final
record for admitted uploads, while already-committed failures write a rejected
admission.

In the catch path invoke `onFailure` once after metadata exists. Log a
secondary callback failure with transfer fingerprint and phase, then preserve
the original protocol error.

- [ ] **Step 6: Export types and run focused Node/Bare tests**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/hooks.test.js
./node_modules/.bin/brittle-node .test-dist/unit/direct-behavior.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/hooks.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/direct-behavior.test.js
npm run test:types
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/hooks.ts src/errors.ts src/server.ts src/index.ts \
  test/unit/hooks.test.ts test/unit/direct-behavior.test.ts \
  test/types/public-api.ts test/run.ts tsconfig.test.json
git commit -m "feat: invoke deployment lifecycle hooks"
```

---

### Task 5: Load hook modules and expose CLI rotation options

**Files:**
- Create: `src/hooks-module.ts`
- Modify: `src/cli.ts`
- Modify: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: `ServerHooks`, `snapshotHooks()`, and new `ServerOptions`.
- Produces: `loadHooksModule(modulePath, cwd): Promise<ServerHooks>`.

- [ ] **Step 1: Write failing CLI tests**

Create temporary modules during the test:

```js
// hooks.cjs
module.exports = {
  beforeCommit: async () => {},
  afterCommit: async () => {},
  onFailure: async () => {}
}
```

```js
// hooks.mjs
export async function beforeCommit () {}
export default { afterCommit: async () => {} }
```

Assert `--hooks` resolves relative to an injected/current working directory,
accepts CommonJS, named ESM, and default ESM exports, and passes the snapshot to
the fake server. Assert missing modules, throwing modules, invalid exports, and
duplicate `--hooks` produce exit code 2 before construction.

Add CLI option tests that pass:

```text
--artifact-pattern {version}/{series}.tar.gz
--artifact-pattern {series}-{version}.tar.gz
--max-count 20
--max-versions 10
--version-granularity minor
```

and assert the exact `ServerOptions` values. Add invalid-combination tests for
missing patterns, missing version placeholders, orphan granularity, malformed
templates, and non-positive counts.

- [ ] **Step 2: Run CLI tests and verify red**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/cli.test.js
```

Expected: `Unknown option` and missing module-loader assertions fail.

- [ ] **Step 3: Implement dynamic module loading**

Implement:

```ts
export async function loadHooksModule(modulePath: string, cwd: string): Promise<ServerHooks>
```

Require a non-empty string, resolve it with `path.resolve(cwd, modulePath)`,
and use dynamic `import()` so `.mjs`, `.js`, and `.cjs` work. If the namespace
has a default object, merge its optional callbacks with named callback exports,
with named exports taking precedence. Pass the result through
`snapshotHooks()`. Wrap resolution/evaluation/shape errors in a configuration
error message that contains the module basename but not arbitrary module
contents.

- [ ] **Step 4: Parse and validate all new server options**

Extend `USAGE`, the server allowlist/repeatable sets, and `runServer()`. Load
hooks before constructing the server. Add optional `cwd?: string` to `CliIo`
for deterministic tests; default to `process.cwd()`. Pass exact values to
`ServerOptions`.

- [ ] **Step 5: Run CLI tests on Node and Bare**

Run:

```bash
npm run build && npm run build:test
./node_modules/.bin/brittle-node .test-dist/unit/cli.test.js
./node_modules/.bin/brittle-bare .test-dist/unit/cli.test.js
```

Expected: all pass. If Bare cannot import a Node-targeted temporary module,
the test fails and the loader must be corrected without reducing the documented
`.js`, `.mjs`, and `.cjs` support.

- [ ] **Step 6: Commit**

```bash
git add src/hooks-module.ts src/cli.ts test/unit/cli.test.ts
git commit -m "feat: configure rotation and hooks from CLI"
```

---

### Task 6: Document behavior and complete compatibility coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/spec/swarm-deploy.md`
- Modify: `CHANGELOG.md`
- Modify: `test/types/public-api.ts`
- Modify: `scripts/package-smoke.mjs` if exported runtime checks require it

**Interfaces:**
- Documents every public option, pattern rule, lifecycle point, retry flag, and
  retention interaction from the approved design.

- [ ] **Step 1: Add final public API type assertions**

Add a `ServerOptions` fixture containing all new options and a `ServerHooks`
fixture whose callbacks access every context field. Add `@ts-expect-error`
assertions for an invalid granularity and invalid callback signature.

- [ ] **Step 2: Run type tests and verify any missing public exports fail**

Run:

```bash
npm run build
npm run test:types
```

Expected before final export fixes: missing or incompatible public types fail;
after export fixes: pass.

- [ ] **Step 3: Update operator and protocol documentation**

README sections must include:

- full CLI synopsis with all five new options;
- template examples for filename and source-parent folder versions;
- count versus major/minor SemVer selection;
- unmatched legacy behavior and pinned mutable limits;
- mandatory matching for new uploads when artifact patterns are configured;
- CommonJS and ESM hook module examples;
- exact fresh, verified-resumed, and already-committed invocation sequences;
- explicit idempotency guidance using transfer ID;
- the durable-commit caveat when `afterCommit` fails.

Update the protocol specification with optional authenticated `sourceParent`,
session version compatibility, persisted release coordinates, cleanup order,
hook observability, and the rollout rule that servers must be upgraded before
clients because old exact-key decoders reject the new metadata field. Add an
unreleased changelog section summarizing issue #6.

- [ ] **Step 4: Run formatting and focused package checks**

Run:

```bash
npm run format
npm run build
npm run test:types
npm run test:package
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/spec/swarm-deploy.md CHANGELOG.md \
  test/types/public-api.ts scripts/package-smoke.mjs
git commit -m "docs: explain rotation and hook retries"
```

---

### Task 7: Full verification and pull-request readiness

**Files:**
- Modify only files required to fix failures introduced by Tasks 1–6.

**Interfaces:**
- Verifies the complete feature and packaging matrix.

- [ ] **Step 1: Run repository quality checks**

Run:

```bash
npm run format:check
npm run lint
npm run test:property
npm run test:release-tag
```

Expected: all commands exit 0 with no formatting or type errors.

- [ ] **Step 2: Run full Node and Bare suites**

Run outside the sandbox because native HyperDHT network-interface discovery
requires local OS access:

```bash
npm test
```

Expected: build succeeds and every Brittle test passes on Node and Bare.

- [ ] **Step 3: Run package validation**

Run:

```bash
npm run prepack
npm run test:package
git diff --check
git status --short
```

Expected: package validation and smoke tests pass, diff check is clean, and
only intentional tracked changes are present.

- [ ] **Step 4: Review issue coverage**

Check every acceptance point in issue #6 against tests and documentation:
count-only rotation, SemVer major/minor groups, replacement history, no required
age limit, CLI/API hooks, JavaScript module loading, lifecycle callback
contexts, and resumed/already-committed retry semantics.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git add -u
git commit -m "test: complete rotation and hooks coverage"
```

Skip this commit when verification required no corrections.

- [ ] **Step 6: Push and open the pull request**

```bash
cat > /tmp/swarm-deploy-pr-body.md <<'EOF'
## Summary
- add count and SemVer major/minor artifact rotation with persisted release identity
- authenticate immediate source-parent folder metadata for configured patterns
- add retry-safe JavaScript beforeCommit, afterCommit, and onFailure hooks

## Verification
- npm run lint
- npm run test:property
- npm run test:release-tag
- npm test
- npm run prepack
- npm run test:package

Closes #6
EOF
git push -u origin feat/artifact-rotation-hooks
gh pr create \
  --repo tetherto/swarm-deploy \
  --base main \
  --head feat/artifact-rotation-hooks \
  --title "feat: add artifact rotation and custom hooks" \
  --body-file /tmp/swarm-deploy-pr-body.md
```

The PR body must summarize rotation, authenticated folder metadata, hook retry
semantics, and verification commands, and include `Closes #6` so GitHub closes
the issue when the PR is merged. Do not manually close the issue while the PR
is still open.
