import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import sodium from 'sodium-native'
import { pack, type Header } from 'tar-stream'
import { throwIfAborted, type AbortSignalLike } from '../abort.js'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import { safeFileOpenFlags } from '../storage/layout.js'
import {
  CONTROL_VERSION,
  decodeMetadataRecord,
  encodeMetadataRecord,
  type MetadataRecord
} from './controls.js'
import { digestMatches, SodiumSha256 } from './hash.js'
import { assertUstarFileSize, deterministicTarSize } from './ustar.js'

export { deterministicTarSize, TAR_BLOCK_BYTES } from './ustar.js'
export const TAR_MODE = 0o644
export const TAR_UID = 0
export const TAR_GID = 0
export const TAR_MTIME_MS = 0
export const TAR_UNAME = ''
export const TAR_GNAME = ''
export const TAR_TRANSFER_DOMAIN = 'swarm-deploy/direct-tar/v1'
const READ_BYTES = 64 * 1024

export interface TarSourceIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs: number
}

export interface TarManifest {
  path: string
  name: string
  fileSize: number
  fileSha256: Buffer
  tarSize: number
  tarSha256: Buffer
  transferId: Buffer
  source: TarSourceIdentity
}

export interface TarOperationOptions {
  signal?: AbortSignalLike | null
}

export interface TarResumeOptions extends TarOperationOptions {
  expectedPrefixSha256?: Uint8Array | null
}

export type TarResumeResult =
  | { status: 'MATCH'; prefixSha256: Buffer; bytesSent: number }
  | { status: 'RESET_REQUIRED'; prefixSha256: Buffer; bytesSent: 0 }

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertSafeSize(size: unknown): asserts size is number {
  assertUstarFileSize(size)
}

function assertClientKey(key: Uint8Array): void {
  if (!b4a.isBuffer(key) || key.byteLength !== 32) throw invalid('Invalid client public key')
}

function canonicalName(filePath: string): string {
  const name = validateBasename(path.basename(filePath))
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Filename cannot be encoded as USTAR')
  }
  return name
}

function identity(stat: fs.Stats): TarSourceIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameIdentity(expected: TarSourceIdentity, actual: fs.Stats): boolean {
  return (
    actual.isFile() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  )
}

function assertIdentity(expected: TarSourceIdentity, actual: fs.Stats, message: string): void {
  if (!sameIdentity(expected, actual)) throw new SwarmDeployError(ERRORS.FILE_BUSY, message)
}

async function openStableSource(
  filePath: string,
  expected: TarSourceIdentity | null,
  signal: AbortSignalLike | null | undefined
): Promise<{ handle: fs.promises.FileHandle; source: TarSourceIdentity }> {
  throwIfAborted(signal)
  const pathStat = await fs.promises.lstat(filePath)
  throwIfAborted(signal)
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Path must be a regular file')
  }
  const observed = identity(pathStat)
  if (expected) assertIdentity(expected, pathStat, 'Source file changed before TAR generation')

  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, safeFileOpenFlags('read'))
    const opened = await handle.stat()
    assertIdentity(expected || observed, opened, 'Source identity changed while opening')
    return { handle, source: expected || observed }
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    if (error instanceof SwarmDeployError) throw error
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Unable to safely open source file', error)
  }
}

function canonicalHeader(name: string, size: number): Partial<Header> & Pick<Header, 'name'> {
  return {
    name,
    type: 'file',
    size,
    mode: TAR_MODE,
    uid: TAR_UID,
    gid: TAR_GID,
    mtime: new Date(TAR_MTIME_MS),
    uname: TAR_UNAME,
    gname: TAR_GNAME,
    linkname: '',
    devmajor: 0,
    devminor: 0,
    pax: null
  }
}

function waitForDrain(stream: {
  once(event: 'drain', listener: () => void): unknown
}): Promise<void> {
  return new Promise((resolve) => stream.once('drain', resolve))
}

async function* generateTar(
  handle: fs.promises.FileHandle,
  name: string,
  size: number,
  fileHash: SodiumSha256,
  signal: AbortSignalLike | null | undefined
): AsyncGenerator<Buffer> {
  const archive = pack()
  let entryDoneResolve: () => void = () => {}
  let entryDoneReject: (error: unknown) => void = () => {}
  const entryDone = new Promise<void>((resolve, reject) => {
    entryDoneResolve = resolve
    entryDoneReject = reject
  })
  const entry = archive.entry(canonicalHeader(name, size), (error) => {
    if (error) entryDoneReject(error)
    else entryDoneResolve()
  })
  const producer = (async () => {
    try {
      let position = 0
      while (position < size) {
        throwIfAborted(signal)
        const chunk = b4a.alloc(Math.min(READ_BYTES, size - position))
        const read = await handle.read(chunk, 0, chunk.byteLength, position)
        const count = typeof read === 'number' ? read : read.bytesRead
        if (count !== chunk.byteLength) {
          throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Source file was truncated')
        }
        fileHash.update(chunk)
        position += count
        if (!entry.write(chunk)) await waitForDrain(entry)
      }
      entry.end(b4a.alloc(0))
      await entryDone
      archive.finalize()
    } catch (error) {
      archive.destroy(error instanceof Error ? error : invalid('TAR generation failed', error))
      throw error
    }
  })()

  let completed = false
  try {
    for await (const value of archive) {
      if (!b4a.isBuffer(value)) throw invalid('Invalid TAR stream chunk')
      yield b4a.from(value)
    }
    await producer
    completed = true
  } finally {
    if (!completed) archive.destroy()
    await producer.catch(() => {})
  }
}

async function assertSourceFinal(
  filePath: string,
  handle: fs.promises.FileHandle,
  expected: TarSourceIdentity,
  signal: AbortSignalLike | null | undefined
): Promise<void> {
  throwIfAborted(signal)
  assertIdentity(expected, await handle.stat(), 'Source file changed during TAR generation')
  assertIdentity(
    expected,
    await fs.promises.lstat(filePath),
    'Source path changed during TAR generation'
  )
  throwIfAborted(signal)
}

function transferField(
  hash: SodiumSha256,
  label: string,
  value: Uint8Array | string | number
): void {
  const labelBytes = b4a.from(`${label}\u0000`)
  const valueBytes = typeof value === 'number' ? b4a.from(String(value)) : b4a.from(value)
  hash
    .update(labelBytes)
    .update(b4a.from(`${valueBytes.byteLength}:`))
    .update(valueBytes)
}

export function computeTarTransferId(
  clientPublicKey: Uint8Array,
  immutable: {
    name: string
    fileSize: number
    fileSha256: Uint8Array
    tarSize: number
    tarSha256: Uint8Array
  }
): Buffer {
  assertClientKey(clientPublicKey)
  assertSafeSize(immutable.fileSize)
  if (!b4a.isBuffer(immutable.fileSha256) || immutable.fileSha256.byteLength !== 32) {
    throw invalid('Invalid file digest')
  }
  if (!b4a.isBuffer(immutable.tarSha256) || immutable.tarSha256.byteLength !== 32) {
    throw invalid('Invalid TAR digest')
  }
  const hash = new SodiumSha256()
  transferField(hash, 'domain', TAR_TRANSFER_DOMAIN)
  transferField(hash, 'clientPublicKey', clientPublicKey)
  transferField(hash, 'name', immutable.name)
  transferField(hash, 'fileSize', immutable.fileSize)
  transferField(hash, 'fileSha256', immutable.fileSha256)
  transferField(hash, 'tarSize', immutable.tarSize)
  transferField(hash, 'tarSha256', immutable.tarSha256)
  transferField(hash, 'type', 'file')
  transferField(hash, 'mode', TAR_MODE)
  transferField(hash, 'uid', TAR_UID)
  transferField(hash, 'gid', TAR_GID)
  transferField(hash, 'mtimeMs', TAR_MTIME_MS)
  transferField(hash, 'uname', TAR_UNAME)
  transferField(hash, 'gname', TAR_GNAME)
  transferField(hash, 'pax', 'none')
  return hash.digest()
}

export async function buildTarManifest(
  filePath: string,
  clientPublicKey: Uint8Array,
  { signal = null }: TarOperationOptions = {}
): Promise<TarManifest> {
  assertClientKey(clientPublicKey)
  const name = canonicalName(filePath)
  const opened = await openStableSource(filePath, null, signal)
  assertSafeSize(opened.source.size)
  const fileHash = new SodiumSha256()
  const tarHash = new SodiumSha256()
  let tarSize = 0
  try {
    for await (const chunk of generateTar(
      opened.handle,
      name,
      opened.source.size,
      fileHash,
      signal
    )) {
      tarHash.update(chunk)
      tarSize += chunk.byteLength
    }
    await assertSourceFinal(filePath, opened.handle, opened.source, signal)
  } finally {
    await opened.handle.close().catch(() => {})
  }
  if (tarSize !== deterministicTarSize(opened.source.size)) {
    throw invalid('Noncanonical deterministic TAR length')
  }
  const fileSha256 = fileHash.digest()
  const tarSha256 = tarHash.digest()
  const transferId = computeTarTransferId(clientPublicKey, {
    name,
    fileSize: opened.source.size,
    fileSha256,
    tarSize,
    tarSha256
  })
  return {
    path: filePath,
    name,
    fileSize: opened.source.size,
    fileSha256,
    tarSize,
    tarSha256,
    transferId,
    source: opened.source
  }
}

export async function regenerateTarSuffix(
  manifest: TarManifest,
  offset: number,
  write: (chunk: Buffer) => void | Promise<void>,
  { signal = null, expectedPrefixSha256 = null }: TarResumeOptions = {}
): Promise<TarResumeResult> {
  if (!manifest || typeof manifest !== 'object') throw invalid('Invalid TAR manifest')
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

  const opened = await openStableSource(manifest.path, manifest.source, signal)
  const fileHash = new SodiumSha256()
  const tarHash = new SodiumSha256()
  const prefixHash = new SodiumSha256()
  let position = 0
  let bytesSent = 0
  let prefixSha256: Buffer | null = offset === 0 ? prefixHash.digest() : null
  let resetRequired =
    prefixSha256 !== null &&
    expectedPrefixSha256 !== null &&
    !sodium.sodium_memcmp(prefixSha256, expectedPrefixSha256)
  try {
    for await (const chunk of generateTar(
      opened.handle,
      manifest.name,
      manifest.fileSize,
      fileHash,
      signal
    )) {
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
    await assertSourceFinal(manifest.path, opened.handle, manifest.source, signal)
  } finally {
    await opened.handle.close().catch(() => {})
  }

  if (
    position !== manifest.tarSize ||
    (!resetRequired && bytesSent !== manifest.tarSize - offset)
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Regenerated TAR length changed')
  }
  const regeneratedFile = fileHash.digest()
  const regeneratedTar = tarHash.digest()
  if (
    !digestMatches(regeneratedFile, manifest.fileSha256) ||
    !digestMatches(regeneratedTar, manifest.tarSha256)
  ) {
    throw new SwarmDeployError(ERRORS.FILE_BUSY, 'Source file changed during TAR regeneration')
  }
  if (prefixSha256 === null) throw invalid('Unable to hash TAR prefix')
  if (resetRequired) return { status: 'RESET_REQUIRED', prefixSha256, bytesSent: 0 }
  return { status: 'MATCH', prefixSha256, bytesSent }
}

export function metadataFromManifest(manifest: TarManifest, reset = false): MetadataRecord {
  return {
    v: CONTROL_VERSION,
    name: manifest.name,
    fileSize: manifest.fileSize,
    fileSha256: b4a.toString(manifest.fileSha256, 'hex'),
    tarSize: manifest.tarSize,
    tarSha256: b4a.toString(manifest.tarSha256, 'hex'),
    transferId: b4a.toString(manifest.transferId, 'hex'),
    reset
  }
}

export function assertMetadataTransferId(
  clientPublicKey: Uint8Array,
  offeredMetadata: MetadataRecord
): void {
  const metadata = decodeMetadataRecord(encodeMetadataRecord(offeredMetadata))
  const expected = computeTarTransferId(clientPublicKey, {
    name: metadata.name,
    fileSize: metadata.fileSize,
    fileSha256: b4a.from(metadata.fileSha256, 'hex'),
    tarSize: metadata.tarSize,
    tarSha256: b4a.from(metadata.tarSha256, 'hex')
  })
  const offered = b4a.from(metadata.transferId, 'hex')
  if (!sodium.sodium_memcmp(expected, offered)) throw invalid('Noncanonical TAR transfer ID')
}
