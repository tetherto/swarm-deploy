# Swarm Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, resumable Hyperswarm artifact uploader with persistent identities, client allowlisting, atomic file commits, retention, Node/Bare support, CLI commands, and CI.

**Architecture:** Separate identity/topic derivation, file manifesting, protocol framing, persistent upload sessions, commit/recovery, retention, and networking into focused CommonJS modules. The server authenticates clients in the Hyperswarm firewall; the client pins the server Noise public key before opening a Protomux channel. Fixed 1 MiB SHA-256 chunks are staged and checkpointed, then the full file is verified and atomically linked into its create-only final path.

**Tech Stack:** CommonJS JavaScript, npm, Hyperswarm, HyperDHT, Protomux, compact-encoding, b4a, Bare compatibility modules, Brittle, Lunte, Prettier, GitHub Actions.

## Global Constraints

- Support Node.js and Bare on Linux and macOS.
- Use separate persistent 32-byte server and client seeds represented by 64 lowercase hexadecimal characters in files and environment variables.
- Derive the 32-byte topic as SHA-256 of `"swarm-deploy/topic/v1\0"` concatenated with the raw server public key.
- Treat the topic as discovery-only; authenticate the client in the server firewall and pin the server public key client-side.
- Use SHA-256 for whole-file and fixed 1 MiB chunk digests.
- Preserve only safe original top-level basenames matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`.
- Never replace an existing committed filename.
- Retain disconnected resumable sessions for seven days by default.
- Require explicit `maxFileBytes` and `maxStagingBytes`.
- Never execute, unpack, install, or serve uploaded files.
- Generate all binary test data in temporary directories; commit no binary fixtures.
- Do not create git commits unless the user separately authorizes them.
- The server OS account and protected storage root are trusted against concurrent local tampering;
  existing or detected symlinks and parent-directory identity changes fail closed; native
  `openat`-style hardening against a malicious local writer is out of version 1 scope.

---

## File Map

- `package.json`: package metadata, conditional Node/Bare imports, scripts, and CLI entry.
- `package-lock.json`: reproducible dependency graph.
- `.gitignore`, `.gitattributes`, `.prettierrc`: repository hygiene and formatting.
- `index.js`, `index.d.ts`: public JavaScript and declaration entrypoints.
- `lib/errors.js`: stable error codes and `SwarmDeployError`.
- `lib/identity.js`: seed/public-key parsing, generation, and key derivation.
- `lib/topic.js`: deterministic topic derivation.
- `lib/files.js`: safe basename checks, directory selection, and file manifests.
- `lib/protocol/constants.js`: wire constants, message indexes, states, and status codes.
- `lib/protocol/codecs.js`: bounded compact-encoding records and bitmap paging.
- `lib/protocol/transfer-id.js`: deterministic transfer ID derivation.
- `lib/protocol/client-session.js`: client-side Protomux transfer state machine.
- `lib/protocol/server-session.js`: server-side Protomux transfer state machine.
- `lib/storage/layout.js`: protected internal paths and storage-root initialization.
- `lib/storage/atomic-file.js`: atomic internal metadata writes and reads.
- `lib/storage/session-store.js`: staging files, verified chunks, checkpoints, resume, and reservations.
- `lib/storage/commit-store.js`: final no-replace commit records and destination inspection.
- `lib/storage/recovery.js`: journal reconciliation and startup scrub.
- `lib/storage/retention.js`: resume expiry, age retention, and storage rotation.
- `lib/allowlist.js`: strict parsing, atomic reload, and polling.
- `lib/server.js`: Hyperswarm server lifecycle and authenticated connection dispatch.
- `lib/client.js`: Hyperswarm discovery, server pinning, upload batching, and reconnect.
- `lib/cli.js`, `bin/swarm-deploy.js`: command parsing and process behavior.
- `test/helpers/`: temporary files, deterministic binary generation, clocks, storage fault injection, and DHT testnet.
- `test/unit/`: deterministic module tests.
- `test/integration/`: real local-DHT transfer and recovery tests.
- `.github/workflows/ci.yml`: lint, Node, Bare, and parser/property jobs.
- `README.md`, `LICENSE.md`, `NOTICE.md`, `SECURITY.md`: user and policy documentation.

---

### Task 1: Package Foundation, Errors, Identity, and Topic

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `.gitignore`
- Create: `.gitattributes`
- Create: `.prettierrc`
- Create: `index.js`
- Create: `lib/errors.js`
- Create: `lib/identity.js`
- Create: `lib/topic.js`
- Create: `test/run.js`
- Create: `test/unit/identity.test.js`

**Interfaces:**

- Produces `SwarmDeployError`, `ERRORS`, `parseSeed`, `parsePublicKey`, `generateSeed`, `keyPairFromSeed`, `publicKeyFromSeed`, and `topicFromServerPublicKey`.
- All binary-returning functions return `Buffer`-compatible b4a values.

- [ ] **Step 1: Create package metadata and install current dependencies**

Create `package.json` with:

```json
{
  "name": "@tetherto/swarm-deploy",
  "version": "0.0.0",
  "private": true,
  "description": "Secure resumable artifact uploads over Hyperswarm",
  "main": "index.js",
  "types": "index.d.ts",
  "bin": {
    "swarm-deploy": "bin/swarm-deploy.js"
  },
  "scripts": {
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "lint": "prettier . --check && lunte && tsc --noEmit --strict index.d.ts",
    "test:node": "brittle test/run.js",
    "test:bare": "bare test/run.js",
    "test": "npm run test:node && npm run test:bare"
  },
  "imports": {
    "#crypto": {
      "bare": "bare-crypto",
      "default": "crypto"
    },
    "#events": {
      "bare": "bare-events",
      "default": "events"
    },
    "#fs": {
      "bare": "bare-fs",
      "default": "fs"
    },
    "#path": {
      "bare": "bare-path",
      "default": "path"
    }
  },
  "files": [
    "bin",
    "lib",
    "index.js",
    "index.d.ts",
    "README.md",
    "LICENSE.md",
    "NOTICE.md",
    "SECURITY.md"
  ],
  "license": "Apache-2.0"
}
```

Run:

```bash
npm install hyperswarm hyperdht protomux compact-encoding b4a bare-crypto bare-events bare-fs bare-path
npm install --save-dev @types/node brittle bare-runtime lunte prettier prettier-config-holepunch typescript
```

Expected: `package-lock.json` is created and `npm ls --depth=0` exits 0.

Create `.prettierrc` as:

```json
"prettier-config-holepunch"
```

Create `.gitignore` with:

```text
node_modules/
coverage/
*.seed
.swarm-deploy/
```

Create `.gitattributes` with:

```text
* text=auto eol=lf
```

- [ ] **Step 2: Write failing identity/topic tests**

`test/unit/identity.test.js` must assert:

```js
'use strict'

const test = require('brittle')
const b4a = require('b4a')
const {
  parseSeed,
  parsePublicKey,
  keyPairFromSeed,
  publicKeyFromSeed,
  topicFromServerPublicKey
} = require('../..')

test('identity derives stable and separate key pairs', (t) => {
  const first = b4a.alloc(32, 1)
  const second = b4a.alloc(32, 2)
  t.alike(keyPairFromSeed(first), keyPairFromSeed(first))
  t.unlike(publicKeyFromSeed(first), publicKeyFromSeed(second))
})

test('seed and public key parsers reject non-canonical values', (t) => {
  t.is(parseSeed('01'.repeat(32)).byteLength, 32)
  t.is(parsePublicKey('02'.repeat(32)).byteLength, 32)
  t.exception(() => parseSeed('01'))
  t.exception(() => parseSeed('AA'.repeat(32)))
  t.exception(() => parsePublicKey('not-hex'))
})

test('topic is stable, domain-separated, and 32 bytes', (t) => {
  const publicKey = publicKeyFromSeed(b4a.alloc(32, 3))
  const topic = topicFromServerPublicKey(publicKey)
  t.is(topic.byteLength, 32)
  t.alike(topic, topicFromServerPublicKey(publicKey))
  t.unlike(topic, publicKey)
})
```

Create `test/run.js` so the same entrypoint runs under Node and Bare:

```js
'use strict'

require('./unit/identity.test')
```

Later tasks append their test modules to this file.

- [ ] **Step 3: Run tests and confirm the red state**

Run: `npm run test:node`

Expected: FAIL because the public identity exports do not exist.

- [ ] **Step 4: Implement errors, identity, topic, and exports**

`lib/errors.js` defines:

```js
class SwarmDeployError extends Error {
  constructor(code, message, cause = null) {
    super(message)
    this.name = 'SwarmDeployError'
    this.code = code
    this.cause = cause
  }
}
```

Define every initial error code:

```js
const ERRORS = {
  AUTH_REJECTED: 'AUTH_REJECTED',
  SERVER_KEY_MISMATCH: 'SERVER_KEY_MISMATCH',
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  PROTOCOL_INVALID: 'PROTOCOL_INVALID',
  INVALID_FILENAME: 'INVALID_FILENAME',
  INVALID_SEED: 'INVALID_SEED',
  INVALID_PUBLIC_KEY: 'INVALID_PUBLIC_KEY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  STAGING_LIMIT: 'STAGING_LIMIT',
  DISK_RESERVE: 'DISK_RESERVE',
  FILE_EXISTS: 'FILE_EXISTS',
  FILE_BUSY: 'FILE_BUSY',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  UPLOAD_IDLE_TIMEOUT: 'UPLOAD_IDLE_TIMEOUT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REVOKED: 'REVOKED',
  COMMIT_FAILED: 'COMMIT_FAILED',
  CLEANUP_FAILED: 'CLEANUP_FAILED'
}
```

`lib/identity.js`:

- Accepts binary 32-byte seeds for library APIs.
- Accepts only lowercase 64-character hex for textual seed/public-key parsers.
- Calls `DHT.keyPair(seed)` from the direct `hyperdht` dependency.
- Generates exactly 32 random bytes with `#crypto`.

`lib/topic.js` computes:

```js
createHash('sha256').update('swarm-deploy/topic/v1\0').update(serverPublicKey).digest()
```

`index.js` exports the implemented functions and error types.

- [ ] **Step 5: Verify the foundation**

Run:

```bash
npm run format
npm run test:node
npm ls --depth=0
```

Expected: identity tests PASS and dependency listing exits 0.

---

### Task 2: Safe File Selection and Hash Manifests

**Files:**

- Create: `lib/files.js`
- Create: `test/helpers/files.js`
- Create: `test/unit/files.test.js`
- Modify: `index.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces `validateBasename(name)`, `selectUploadPaths(path)`, and `buildFileManifest(path, { chunkSize })`.
- Manifest shape is `{ path, name, size, digest, chunkDigests, chunkCount, chunkSize, stat }`.

- [ ] **Step 1: Write failing filename and manifest tests**

Cover:

```js
t.is(validateBasename('artifact-linux-x64.tar.gz'), 'artifact-linux-x64.tar.gz')
t.exception(() => validateBasename('../artifact'))
t.exception(() => validateBasename('.swarm-deploy'))
t.exception(() => validateBasename('artifact name'))
t.exception(() => validateBasename('é'))
```

Generate deterministic bytes in a temporary directory and assert manifests for sizes:

```text
0, 1, 1 MiB - 1, 1 MiB, 1 MiB + 1, and 3 MiB + 17
```

Assert a directory selection returns sorted immediate regular files and reports subdirectories and symlinks as skipped.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx brittle test/unit/files.test.js`

Expected: FAIL because `lib/files.js` does not exist.

- [ ] **Step 3: Implement safe selection and streaming hashes**

Implement:

```js
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DEFAULT_CHUNK_SIZE = 1024 * 1024
```

Use `lstat`, never `stat`, before opening a path. Reject a file argument unless it is a regular file. For directory batches, sort names lexically and classify non-regular entries without following them.

`buildFileManifest` must:

1. Capture initial `lstat`.
2. Stream the file without loading it whole.
3. Feed every byte to the whole-file SHA-256.
4. Assemble exact 1 MiB logical chunks independent of source stream chunking.
5. Hash each logical chunk.
6. Capture final `lstat`.
7. Reject when size, `mtimeMs`, or inode changed.

- [ ] **Step 4: Run boundary and symlink tests**

Run: `npx brittle test/unit/files.test.js`

Expected: all file tests PASS without files outside the temporary directory.

- [ ] **Step 5: Run the Node suite**

Run: `npm run test:node`

Expected: identity and file tests PASS.

---

### Task 3: Bounded Wire Codecs, Bitmap Pages, and Transfer IDs

**Files:**

- Create: `lib/protocol/constants.js`
- Create: `lib/protocol/codecs.js`
- Create: `lib/protocol/transfer-id.js`
- Create: `test/unit/protocol.test.js`
- Modify: `index.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces message index constants `OFFER`, `STATUS`, `BITMAP_PAGE`, `READY`, `CHUNK`, `CHUNK_ACK`, `FINISH`, and `RESULT`.
- Produces `encodeBounded`, `decodeBounded`, `offer`, `status`, `bitmapPage`, `chunk`, `chunkAck`, `finish`, and `result` codecs.
- Produces `transferId({ clientPublicKey, name, size, digest, chunkSize })`.

- [ ] **Step 1: Write failing codec and transfer-ID tests**

Tests must prove:

- Every codec round-trips representative data.
- Digests, public keys, and transfer IDs must be exactly 32 bytes.
- Control messages larger than 16 KiB are rejected.
- File size and chunk indexes must be safe non-negative integers.
- Bitmap pages cover at most 65,536 chunk bits and reconstruct arbitrarily fragmented state.
- CHUNK_ACK validates a 32-byte transfer ID and safe chunk index.
- Transfer IDs change when identity, name, size, digest, or chunk size changes.

- [ ] **Step 2: Confirm the protocol tests fail**

Run: `npx brittle test/unit/protocol.test.js`

Expected: FAIL on missing protocol modules.

- [ ] **Step 3: Implement compact encodings and validation**

Use `compact-encoding` records containing buffers, strings, booleans, and unsigned safe integers. Keep semantic validation outside the raw codec so malformed decoded values always become `PROTOCOL_INVALID`.

Define statuses:

```js
const STATUS = {
  ACCEPT: 0,
  ALREADY_COMMITTED: 1,
  FILE_EXISTS: 2,
  FILE_BUSY: 3,
  REJECTED: 4
}
```

`encodeBounded(codec, value, max = 16 * 1024)` checks the encoded byte length. `decodeBounded` checks input length before decoding and rejects trailing bytes.

Bitmap pages use `{ start, count, bits }`, where `bits` is a little-endian bitset for a bounded chunk-index interval.

- [ ] **Step 4: Implement canonical transfer IDs**

Hash a canonical compact-encoded tuple containing:

```text
"swarm-deploy/transfer/v1"
clientPublicKey
name
size
digest
chunkSize
```

Do not hash JSON or platform-dependent number/string formatting.

- [ ] **Step 5: Verify protocol modules**

Run:

```bash
npx brittle test/unit/protocol.test.js
npm run test:node
```

Expected: all protocol and earlier tests PASS.

---

### Task 4: Storage Layout, Atomic Metadata, Sessions, and Reservations

**Files:**

- Create: `lib/storage/layout.js`
- Create: `lib/storage/atomic-file.js`
- Create: `lib/storage/session-store.js`
- Create: `test/helpers/clock.js`
- Create: `test/helpers/storage.js`
- Create: `test/unit/session-store.test.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces `initLayout(storageDir)`.
- Produces `acquireStorageLock(layout, { pid, isProcessAlive })`, returning an ownership-token-checked async release function.
- Produces `writeAtomic(path, bytes)` and `readJson(path)`.
- Produces `SessionStore` with `init`, `offer`, `writeChunk`, `checkpoint`, `finish`, `delete`, `deleteByOwner`, `expire`, and `close`.

- [ ] **Step 1: Write failing session-store tests**

Test the following transition sequence:

```text
new OFFER -> receiving session and full logical reservation
verified CHUNK -> staging bytes written and bit set
checkpoint -> persisted session metadata
disconnect/reopen -> verified bitmap restored
same OFFER -> resumable session
different metadata/same name -> FILE_BUSY
invalid digest -> session deleted
expiry -> staging, session metadata, and reservation deleted
```

Also assert:

- Reservations cannot exceed `maxStagingBytes`.
- Duplicate chunks with the same digest are idempotent.
- Duplicate indexes with different digests fail.
- Chunk length is exact, including the final chunk.
- A failed write never marks the chunk verified.
- Internal paths cannot be symlinks.
- A second live process cannot acquire the storage lock.
- A dead process lock is recovered, while releasing an old token cannot remove a newer owner's lock.

- [ ] **Step 2: Confirm storage tests fail**

Run: `npx brittle test/unit/session-store.test.js`

Expected: FAIL on missing storage modules.

- [ ] **Step 3: Implement the protected layout and atomic metadata writes**

`initLayout` creates:

```text
.swarm-deploy/staging
.swarm-deploy/sessions
.swarm-deploy/commits
.swarm-deploy/journals
```

Use `lstat` to reject symlinked internal directories. Acquire ownership with an atomically created lock directory containing PID, start time, and a random token. An existing live PID fails startup; an injected dead-PID check permits stale-lock recovery. Release removes the lock only when its token still matches.

`writeAtomic` writes a uniquely named sibling temporary file, synchronizes it, renames it over internal metadata only, and synchronizes the parent directory.

- [ ] **Step 4: Implement session persistence and reservation accounting**

Session metadata stores hex digests, a base64 bitmap, per-chunk digest slots, timestamps, owner key, and state. Staging uses random-access writes at `index * chunkSize`.

The persisted checkpoint order is:

1. Write and verify chunk bytes.
2. Synchronize the staging file for the checkpoint batch.
3. Atomically persist bitmap and chunk digests.

Use an injected clock and storage adapter in tests. Default checkpoint batching is 16 chunks; `finish()` forces a checkpoint.

- [ ] **Step 5: Verify restart and capacity behavior**

Run:

```bash
npx brittle test/unit/session-store.test.js
npm run test:node
```

Expected: all session tests PASS, including restart reconstruction and reservation release.

---

### Task 5: No-Replace Commit, Idempotency, and Crash Recovery

**Files:**

- Create: `lib/storage/commit-store.js`
- Create: `lib/storage/recovery.js`
- Create: `test/unit/commit-store.test.js`
- Create: `test/unit/recovery.test.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces `CommitStore.inspect(name, offer)`, `CommitStore.commit(session)`, and `CommitStore.delete(record)`.
- Produces `recoverStorage({ layout, sessionStore, commitStore, logger })`.

- [ ] **Step 1: Write failing atomic-commit tests**

Assert:

- A verified staging inode becomes visible only as a complete final file.
- Existing final files are never replaced.
- Matching managed filename, size, digest, and transfer ID returns `ALREADY_COMMITTED`.
- Different metadata returns `FILE_EXISTS`.
- Link failure retains verified staging state.
- Successful commit writes a sidecar and removes staging/journal state.

- [ ] **Step 2: Write failing crash-point recovery tests**

Inject failure after each step:

```text
journal persisted
final hard link created
storage directory synchronized
commit sidecar persisted
staging link removed
journal removed
```

For each restart, assert recovery converges to exactly one of:

- One valid managed committed file and sidecar.
- One valid verified resumable staging session.

No state may produce a partial final file or overwrite an existing destination.

- [ ] **Step 3: Confirm commit/recovery tests fail**

Run:

```bash
npx brittle test/unit/commit-store.test.js
npx brittle test/unit/recovery.test.js
```

Expected: FAIL because commit and recovery modules are missing.

- [ ] **Step 4: Implement journaled hard-link commit**

`commit(session)` must:

1. Close and sync the staging descriptor.
2. Re-read and verify exact size and SHA-256.
3. Atomically write state `committing` to a journal.
4. Call `link(staging, final)` and treat `EEXIST` as create-only conflict.
5. Sync the storage root.
6. Atomically write the commit sidecar.
7. Unlink staging and session metadata.
8. Remove the journal.

Sidecars contain filename, size, SHA-256, commit time, uploader fingerprint, and transfer ID.

- [ ] **Step 5: Implement deterministic recovery and verify**

Recovery checks every journal against final, staging, and sidecar state. It verifies bytes before finalizing a sidecar and never modifies unknown top-level paths.

Run:

```bash
npx brittle test/unit/commit-store.test.js
npx brittle test/unit/recovery.test.js
npm run test:node
```

Expected: all commit, crash, and earlier tests PASS.

---

### Task 6: Startup Scrub and Retention

**Files:**

- Create: `lib/storage/retention.js`
- Create: `test/unit/retention.test.js`
- Create: `test/unit/scrub.test.js`
- Modify: `lib/storage/recovery.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces `RetentionManager.run({ incomingBytes })`, `RetentionManager.expireSessions()`, and `scrubCommitted()`.

- [ ] **Step 1: Write failing retention tests**

Use an injected clock and managed commit records to assert:

- With no retention options, committed files remain.
- `maxAge` uses server commit time.
- `maxStorageBytes` removes oldest commits first and uses filename as a tie-breaker.
- Age deletion runs before size rotation.
- `incomingBytes` reserves final capacity before commit.
- A single file larger than `maxStorageBytes` is rejected.
- Deletion failure blocks a capacity-dependent commit.
- Unknown files and active staging are never removed.
- Expired disconnected sessions are removed; active sessions are not.

- [ ] **Step 2: Write failing startup scrub tests**

Assert startup scrub:

- Re-hashes every managed final file.
- Deletes managed missing, truncated, symlinked, or digest-invalid files and sidecars.
- Preserves valid files.
- Reports but preserves unknown top-level paths.

- [ ] **Step 3: Confirm lifecycle tests fail**

Run:

```bash
npx brittle test/unit/retention.test.js
npx brittle test/unit/scrub.test.js
```

Expected: FAIL on missing retention/scrub behavior.

- [ ] **Step 4: Implement retention and startup scrub**

Retention runs:

1. At startup.
2. Before a verified upload needs final capacity.
3. After successful commit.
4. Every 15 minutes by default.

Full SHA-256 scrub runs only at startup. Scheduled passes use `lstat`, exact size, records, and timestamps without re-hashing healthy committed files.

- [ ] **Step 5: Verify lifecycle behavior**

Run:

```bash
npx brittle test/unit/retention.test.js
npx brittle test/unit/scrub.test.js
npm run test:node
```

Expected: retention and scrub tests PASS.

---

### Task 7: Allowlist Reload and Authenticated Server Transport

**Files:**

- Create: `lib/allowlist.js`
- Create: `lib/protocol/server-session.js`
- Create: `lib/server.js`
- Create: `test/unit/allowlist.test.js`
- Create: `test/unit/server-session.test.js`
- Create: `test/helpers/testnet.js`
- Create: `test/integration/server-auth.test.js`
- Modify: `index.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces `parseAllowlist(text)`, `AllowlistWatcher`, and public `Server`.
- `Server` exposes `publicKey`, `topic`, `listen()`, `reloadAllowlist(keys)`, and `close()`.

- [ ] **Step 1: Write failing allowlist tests**

Assert:

- Blank lines and `#` comments are ignored.
- Only canonical lowercase 64-character hex keys are accepted.
- Reload is all-or-nothing.
- A failed poll retains the old set.
- Removing a key emits the removed key exactly once.

- [ ] **Step 2: Write failing server protocol and auth tests**

Use an in-memory Protomux pair for state-machine tests and `hyperdht/testnet` for transport tests.

Assert:

- Unknown client keys are rejected in the synchronous firewall.
- Allowed keys reach `server-session`.
- The connection handler repeats the allowlist check.
- Removing a key closes its sockets and calls `sessionStore.deleteByOwner`.
- OFFER statuses correctly expose accept, already committed, exists, busy, and capacity rejection.
- No CHUNK is accepted before OFFER/ACCEPT/READY.
- CHUNK_ACK is sent only after storage write and digest verification resolve.
- Required limits reject missing, unsafe, or non-integer values.
- Idle connections close after 60 seconds by default.
- Structured events contain only short key fingerprints and never seed/full-key values.

- [ ] **Step 3: Confirm server tests fail**

Run:

```bash
npx brittle test/unit/allowlist.test.js
npx brittle test/unit/server-session.test.js
npx brittle test/integration/server-auth.test.js
```

Expected: FAIL on missing server modules.

- [ ] **Step 4: Implement server-side Protomux and Hyperswarm**

Before constructing the swarm:

1. Validate every option and limit.
2. Initialize the protected layout and acquire its process lock.
3. Restore session reservations.
4. Reconcile commit journals.
5. Scrub committed files.
6. Run initial retention.

Only after those steps succeed, create the server swarm with its seed and synchronous firewall and join as server on the derived topic.

For every authenticated connection:

1. Re-check the key.
2. Create `Protomux.from(socket)`.
3. Register `mux.pair({ protocol: 'swarm-deploy/upload/1' }, onpair)`.
4. Create the paired channel using the supplied ID.
5. Add message definitions in the shared constant order.
6. Route messages through one `ServerSession`.

Every async message handler is awaited and server-side chunk writes are serialized. Errors become reason-coded terminal results when safe; malformed framing destroys the connection. Limit active sessions and open connections before allocating staging. Refresh the 60-second idle timer on valid protocol progress. Start the retention timer only after startup recovery succeeds. `close()` clears timers/watchers, destroys sockets and swarm, closes storage handles, and releases the ownership lock.

- [ ] **Step 5: Implement polling reload and revocation**

Poll every five seconds by default. Swap only fully valid sets. Track sockets and sessions by canonical full public key internally, while logs receive only a fingerprint.

- [ ] **Step 6: Verify server behavior**

Run:

```bash
npx brittle test/unit/allowlist.test.js
npx brittle test/unit/server-session.test.js
npx brittle test/integration/server-auth.test.js
npm run test:node
```

Expected: all server auth and state-machine tests PASS.

---

### Task 8: Pinned Client, Backpressure, Reconnect, and Resume

**Files:**

- Create: `lib/protocol/client-session.js`
- Create: `lib/client.js`
- Create: `test/unit/client-session.test.js`
- Create: `test/integration/upload.test.js`
- Create: `test/integration/resume.test.js`
- Modify: `index.js`
- Modify: `test/run.js`

**Interfaces:**

- Produces public `Client` with `upload(path)` and `close()`.
- `ClientSession.upload(manifest)` returns `{ status, name, size, digest, transferId }`.

- [ ] **Step 1: Write failing client-session tests**

Using an in-memory Protomux pair, assert:

- The client sends no OFFER before the channel opens.
- `ACCEPT` is followed by bounded bitmap pages and `READY`.
- The client sends only missing chunks.
- The client keeps at most four unacknowledged chunks in flight.
- FINISH is not sent until every CHUNK_ACK is received.
- It validates every server response transfer ID and state.
- `message.send()` false pauses chunk production until Protomux drain.
- `COMMITTED` and `ALREADY_COMMITTED` both resolve successfully.
- FILE_EXISTS, FILE_BUSY, timeout, protocol failure, and checksum rejection become typed errors.

- [ ] **Step 2: Write failing end-to-end and resume tests**

On a local DHT testnet:

- Upload an empty file and a multi-chunk file.
- Verify exact final bytes, sidecar digest, and no staging remainder.
- Destroy the connection after selected chunks, reconnect, and assert only missing chunks are resent.
- Destroy the final response, retry, and assert `ALREADY_COMMITTED`.
- Announce a rogue server on the same topic and assert it receives no application metadata.
- Start two different allowed identities and assert concurrent success.
- Start two swarms with one shared seed and document/assert Hyperswarm duplicate-connection behavior.

- [ ] **Step 3: Confirm client tests fail**

Run:

```bash
npx brittle test/unit/client-session.test.js
npx brittle test/integration/upload.test.js
npx brittle test/integration/resume.test.js
```

Expected: FAIL on missing client modules.

- [ ] **Step 4: Implement pinned discovery and session startup**

Create a client-only Hyperswarm with the client seed and derived topic. On `connection`, compare `peerInfo.publicKey` with the configured server public key using constant-time byte comparison before constructing Protomux. Destroy mismatches immediately.

Apply a 30-second default connect timeout. Do not send metadata until the expected server channel is open.

- [ ] **Step 5: Implement bounded chunk flow and reconnect**

The client:

1. Builds the manifest before OFFER.
2. Processes verified bitmap pages into a local missing-index set.
3. Reads and sends missing chunks in index order with at most four unacknowledged chunks.
4. Stops producing chunks when `send()` reports backpressure and resumes on drain.
5. Removes a chunk from the in-flight window only after a matching CHUNK_ACK.
6. Sends FINISH only after all missing chunks are acknowledged and the mux is drained.
7. Reconnects after transport loss and repeats OFFER with the same transfer ID.
8. Reports success only for COMMITTED or ALREADY_COMMITTED.

Directory uploads reuse one connection sequentially, continue collecting per-file results, and produce a failed batch result if any selected file fails.

- [ ] **Step 6: Verify upload and resume**

Run:

```bash
npx brittle test/unit/client-session.test.js
npx brittle test/integration/upload.test.js
npx brittle test/integration/resume.test.js
npm run test:node
```

Expected: all client and end-to-end Node tests PASS.

---

### Task 9: CLI and Seed-Safe CI Usage

**Files:**

- Create: `lib/cli.js`
- Create: `bin/swarm-deploy.js`
- Create: `test/unit/cli.test.js`
- Create: `test/integration/cli.test.js`
- Modify: `package.json`
- Modify: `test/run.js`

**Interfaces:**

- Produces `main(argv, env, io)` for deterministic tests.
- Installs the `swarm-deploy` executable.

- [ ] **Step 1: Write failing command tests**

Cover:

```text
keygen --out
public-key --seed-file
server required options and server seed source
upload required options and client seed source
file/env seed conflict
refusal to accept raw seed arguments
refusal to overwrite a seed file
directory batch exit code
SIGINT/SIGTERM graceful close
```

Assert seed output files contain canonical lowercase hex plus newline and owner-only mode. Assert stdout prints public keys but never seeds.

- [ ] **Step 2: Confirm CLI tests fail**

Run:

```bash
npx brittle test/unit/cli.test.js
npx brittle test/integration/cli.test.js
```

Expected: FAIL because the CLI is missing.

- [ ] **Step 3: Implement strict command parsing**

Use a small internal parser instead of adding a broad CLI framework. Reject unknown commands/options and ambiguous seed sources.

Implement:

```text
swarm-deploy keygen --out <seed-file>
swarm-deploy public-key --seed-file <seed-file>
swarm-deploy server --seed-file ... --storage ... --allowlist ...
swarm-deploy upload --seed-file ... --server-key ... <path>
```

Support `SWARM_DEPLOY_SERVER_SEED` only for `server` and `SWARM_DEPLOY_CLIENT_SEED` only for `upload`.

- [ ] **Step 4: Implement lifecycle and exit behavior**

The server prints public key and topic fingerprint, waits until startup recovery completes, then reports ready. Signals await `close()`.

Upload prints per-file results and exits:

```text
0: every selected file committed or already committed
1: one or more upload failures
2: configuration or usage error
```

- [ ] **Step 5: Verify the CLI**

Run:

```bash
npx brittle test/unit/cli.test.js
npx brittle test/integration/cli.test.js
npm link
swarm-deploy --help
npm run test:node
```

Expected: CLI tests PASS, help exits 0, and no seed appears in captured logs.

---

### Task 10: Adversarial, Failure, and Bare Compatibility Tests

**Files:**

- Create: `test/integration/adversarial.test.js`
- Create: `test/integration/revocation.test.js`
- Create: `test/integration/retention.test.js`
- Create: `test/unit/protocol-property.test.js`
- Modify: `test/run.js`
- Modify production modules only for defects exposed by these tests.

**Interfaces:**

- Consumes the complete public and internal APIs.
- Produces evidence for protocol, storage, and cleanup invariants under both runtimes.

- [ ] **Step 1: Add deterministic malformed-frame property cases**

Generate bounded deterministic mutations:

- Truncated encoding at every byte offset.
- One-bit changes to length fields and digests.
- Oversized buffer/string declarations.
- Unknown status and state values.
- Reordered and repeated message types.
- Trailing bytes.
- Invalid bitmap page overlaps and ranges.

Every case must either produce a typed protocol error or destroy the test connection without uncaught process errors.

- [ ] **Step 2: Add adversarial storage/network cases**

Test:

- Path traversal, separator, leading-dot, Unicode, symlink, and hardlink attempts.
- Wrong declared length and excess chunk bytes.
- Disconnect before/after each state transition.
- Disk-full/write/sync/link/unlink failures.
- Same-name races.
- Cleanup and revocation during an active transfer.
- Startup around every commit journal point.
- Minimum free-disk and staging reservation rejection.

- [ ] **Step 3: Run Node adversarial suites**

Run:

```bash
npx brittle test/unit/protocol-property.test.js
npx brittle test/integration/adversarial.test.js
npx brittle test/integration/revocation.test.js
npx brittle test/integration/retention.test.js
```

Expected: all tests PASS and leave no temporary processes or files.

- [ ] **Step 4: Run the complete Bare suite and fix compatibility defects**

Run: `npm run test:bare`

Expected: the same compatible suite passes under Bare. Any Node-only API found must move behind package imports or a focused adapter.

- [ ] **Step 5: Run leak/lifecycle checks**

Run Node and Bare suites with existing handle/resource diagnostics enabled by Brittle and verify `server.close()`/`client.close()` release swarms, timers, watchers, descriptors, and testnet nodes.

Expected: clean process exit with no hanging handles.

---

### Task 11: Types, Documentation, License, and CI

**Files:**

- Create: `index.d.ts`
- Replace: `README.md`
- Create: `LICENSE.md`
- Create: `NOTICE.md`
- Create: `SECURITY.md`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Interfaces:**

- Documents and types every public export, option, result, event, error code, and CLI command.

- [ ] **Step 1: Write declarations and validate public examples**

`index.d.ts` declares:

```ts
export class Server {
  constructor(options: ServerOptions)
  readonly publicKey: Buffer
  readonly topic: Buffer
  listen(): Promise<void>
  reloadAllowlist(keys: Iterable<Buffer | string>): Promise<void>
  close(): Promise<void>
}

export class Client {
  constructor(options: ClientOptions)
  upload(path: string): Promise<UploadResult | BatchUploadResult>
  close(): Promise<void>
}
```

Include all required limits, optional retention/timeouts, error codes, event data, and binary seed/public-key types.

- [ ] **Step 2: Write operational README**

README order:

1. Security boundary and key/topic glossary.
2. Install and runtime requirements.
3. Generate separate server/client seeds.
4. Add client public key to allowlist.
5. Start server.
6. Upload from local shell and CI secret variable.
7. JavaScript API.
8. Resume, idempotency, naming, limits, retention, and cleanup.
9. Shared-identity single-connection limitation.
10. Testing and threat-model non-goals.

Every example must use distinct server/client seeds and must never print a secret.

- [ ] **Step 3: Add policy files**

Use the Apache-2.0 text in `LICENSE.md`. Use `Copyright 2026 Tether Inc` and the Apache notice in `NOTICE.md`. `SECURITY.md` instructs reporters to email `security-oss@tether.io`, promises a response within five working days, and states that coordination/disclosure uses GitHub Security Advisories.

- [ ] **Step 4: Add GitHub Actions**

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

```text
lint: Ubuntu, npm ci, npm run lint
node: Ubuntu + macOS, Node lts/*, npm ci, npm run test:node
bare: Ubuntu + macOS, latest supported Bare, npm ci, npm run test:bare
property: Ubuntu, npm ci, focused protocol-property test
```

Use Holepunch setup actions where they match the Barevisor reference. Do not add KVM/VM or publish jobs.

- [ ] **Step 5: Run final local verification**

Run:

```bash
npm ci
npm run format:check
npm run lint
npm run test:node
npm run test:bare
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Inspect the final repository state**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intentional project/spec/plan files are present; no seeds, temporary binaries, storage directories, logs, or credentials are tracked.

---

## Completion Criteria

Implementation is complete only when:

- All Task 1–11 focused tests pass.
- Full Node and Bare suites pass locally.
- Format, lint, declaration validation, and `git diff --check` pass.
- A local DHT test transfers and resumes generated multi-chunk artifacts.
- Unknown clients and rogue servers receive no upload metadata.
- Existing final files survive conflicting uploads and injected failures.
- Startup recovery and retention preserve all documented invariants.
- README commands match the implemented CLI exactly.
- No commit or push occurs without explicit user authorization.
