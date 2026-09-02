import b4a from 'b4a'
import crypto from '#crypto'
import fs from '#fs'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { assertSafeDirectory, withSafeDirectoryIdentity } from './layout.js'
import { CorruptJournalError } from './commit-store.js'
import { RetentionManager } from './retention.js'
import type { CommitRecord } from './commit-journal.js'
import type { StorageAdapter, StorageLayout } from './types.js'

interface Logger {
  info?: (message: string, details: Record<string, unknown>) => void
  warn?: (message: string, details: Record<string, unknown>) => void
}

interface SessionStore {
  initialized?: boolean
  closed?: boolean
  readVerified(transferId: Uint8Array): Promise<{
    id: string
    transferId: Uint8Array
    ownerKey: Uint8Array
    name: string
    size: number
    digest: Uint8Array
    chunkSize: number
    state: string
  }>
  expire(ttl: number, shouldExpire: (session: { state: string }) => boolean): Promise<number>
  delete?(transferId: Uint8Array): Promise<boolean>
}

interface RecoveryResult {
  status: 'MISSING' | 'FILE_EXISTS' | 'COMMITTED' | 'ABORTED' | 'RESUMABLE' | 'CORRUPT'
  record?: CommitRecord
  reason?: string
}

interface CommitStore {
  storage?: StorageAdapter
  _readJournal(id: string): Promise<unknown>
  retireCorruptAttempt(id: string): Promise<{ retired: boolean; removedStaging: boolean }>
  recoverJournal(
    id: string,
    sessionStore: SessionStore,
    options: { isAuthorized: ((ownerKey: Uint8Array) => boolean) | null }
  ): Promise<RecoveryResult>
  list(): Promise<CommitRecord[]>
  delete(record: CommitRecord): Promise<boolean>
  purge(record: CommitRecord): Promise<false | { purged: true; preservedPath: boolean }>
}

type RecoveryEvent =
  | { type: 'recovery'; status: 'CORRUPT'; phase: 'classification'; transfer: string }
  | {
      type: 'recovery'
      status: 'failed'
      phase: 'classification' | 'journal'
      transfer?: string
      reason: string
    }
  | {
      type: 'recovery'
      status: 'MISSING' | 'FILE_EXISTS' | 'COMMITTED' | 'ABORTED' | 'RESUMABLE' | 'CORRUPT'
      transfer: string
    }
  | { type: 'cleanup'; transfer: string; name: null; reason: 'corrupt-journal' }
  | { type: 'scrub'; status: 'started' }
  | { type: 'scrub'; status: 'completed'; deleted: number; unknownCount: number }
  | { type: 'scrub'; status: 'failed'; reason: string }

interface PrepareStorageRecoveryOptions {
  layout: StorageLayout
  commitStore: CommitStore
  logger?: Logger | null
  onEvent?: ((event: RecoveryEvent) => void) | null
}

interface RecoverStorageOptions extends PrepareStorageRecoveryOptions {
  sessionStore: SessionStore
  isAuthorized?: ((ownerKey: Uint8Array) => boolean) | null
}

function storageError(message: string, cause: unknown | null = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function isJournalName(name: string): boolean {
  return typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name)
}

function transferFingerprint(id: string): string {
  return b4a
    .toString(crypto.createHash('sha256').update(b4a.from(id, 'hex')).digest(), 'hex')
    .slice(0, 12)
}

function report(
  logger: Logger | null,
  level: keyof Logger,
  message: string,
  details: Record<string, unknown>
): void {
  if (!logger || typeof logger[level] !== 'function') return
  try {
    logger[level]?.(message, details)
  } catch {}
}

function emit(onEvent: ((event: RecoveryEvent) => void) | null, payload: RecoveryEvent): void {
  if (!onEvent) return
  try {
    onEvent(payload)
  } catch {}
}

function failureReason(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return ERRORS.PROTOCOL_INVALID
  }
  return typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : ERRORS.PROTOCOL_INVALID
}

async function assertRecoveryLayout(layout: StorageLayout, storage: StorageAdapter): Promise<void> {
  for (const directory of [
    layout.root,
    layout.internal,
    layout.staging,
    layout.sessions,
    layout.commits,
    layout.journals
  ]) {
    await assertSafeDirectory(directory, storage)
  }
}

async function prepareStorageRecovery({
  layout,
  commitStore,
  logger = null,
  onEvent = null
}: PrepareStorageRecoveryOptions): Promise<number> {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  if (!commitStore || typeof commitStore._readJournal !== 'function') {
    throw storageError('Invalid commit store')
  }
  if (typeof commitStore.retireCorruptAttempt !== 'function') {
    throw storageError('Commit store cannot retire corrupt attempts')
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw storageError('Invalid recovery event callback')
  }

  const storage = commitStore.storage || fs.promises
  let retired = 0
  let activeTransfer = null
  try {
    await assertRecoveryLayout(layout, storage)
    const names = await withSafeDirectoryIdentity(layout.journals, storage, () =>
      storage.readdir(layout.journals)
    )
    for (const name of names.sort()) {
      if (!isJournalName(name)) continue
      const id = name.slice(0, -'.json'.length)
      activeTransfer = transferFingerprint(id)
      try {
        await commitStore._readJournal(id)
      } catch (err) {
        if (!(err instanceof CorruptJournalError)) throw err
        const result = await commitStore.retireCorruptAttempt(id)
        retired++
        report(logger, 'warn', 'Retired corrupt commit attempt before session recovery', {
          transferId: id
        })
        emit(onEvent, {
          type: 'recovery',
          status: 'CORRUPT',
          phase: 'classification',
          transfer: activeTransfer
        })
        if (result.removedStaging) {
          emit(onEvent, {
            type: 'cleanup',
            transfer: activeTransfer,
            name: null,
            reason: 'corrupt-journal'
          })
        }
      }
      activeTransfer = null
    }
  } catch (err) {
    emit(onEvent, {
      type: 'recovery',
      status: 'failed',
      phase: 'classification',
      ...(activeTransfer ? { transfer: activeTransfer } : {}),
      reason: failureReason(err)
    })
    throw err
  }
  return retired
}

async function recoverStorage({
  layout,
  sessionStore,
  commitStore,
  logger = null,
  isAuthorized = null,
  onEvent = null
}: RecoverStorageOptions): Promise<RecoveryResult[]> {
  if (!layout || typeof layout !== 'object') throw storageError('Invalid storage layout')
  if (!sessionStore || typeof sessionStore !== 'object') throw storageError('Invalid session store')
  if (!commitStore || typeof commitStore.recoverJournal !== 'function') {
    throw storageError('Invalid commit store')
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw storageError('Invalid recovery event callback')
  }

  const storage = commitStore.storage || fs.promises
  let names
  try {
    await assertRecoveryLayout(layout, storage)
    names = await withSafeDirectoryIdentity(layout.journals, storage, () =>
      storage.readdir(layout.journals)
    )
  } catch (err) {
    emit(onEvent, {
      type: 'recovery',
      status: 'failed',
      phase: 'journal',
      reason: failureReason(err)
    })
    throw err
  }
  const results: RecoveryResult[] = []
  for (const name of names.sort()) {
    if (!isJournalName(name)) {
      report(logger, 'warn', 'Ignoring unknown journal path', { name })
      continue
    }
    const id = name.slice(0, -'.json'.length)
    let result: RecoveryResult
    try {
      result = await commitStore.recoverJournal(id, sessionStore, { isAuthorized })
    } catch (err) {
      if (!(err instanceof CorruptJournalError)) {
        emit(onEvent, {
          type: 'recovery',
          status: 'failed',
          phase: 'journal',
          transfer: transferFingerprint(id),
          reason: failureReason(err)
        })
        throw err
      }
      if (typeof commitStore.retireCorruptAttempt !== 'function') {
        throw storageError('Commit store cannot retire corrupt attempts')
      }
      let retired
      try {
        retired = await commitStore.retireCorruptAttempt(id)
      } catch (retireError) {
        emit(onEvent, {
          type: 'recovery',
          status: 'failed',
          phase: 'journal',
          transfer: transferFingerprint(id),
          reason: failureReason(retireError)
        })
        throw retireError
      }
      result = { status: 'CORRUPT', reason: err.message }
      report(logger, 'warn', 'Skipping corrupt commit journal', {
        transferId: id,
        reason: err.message
      })
      if (retired.removedStaging) {
        emit(onEvent, {
          type: 'cleanup',
          transfer: transferFingerprint(id),
          name: null,
          reason: 'corrupt-journal'
        })
      }
    }
    results.push(result)
    report(logger, 'info', 'Recovered commit journal', { transferId: id, status: result.status })
    emit(onEvent, {
      type: 'recovery',
      status: result.status,
      transfer: transferFingerprint(id)
    })

    if (
      (result.status === 'COMMITTED' || result.status === 'ABORTED') &&
      sessionStore.initialized &&
      !sessionStore.closed &&
      typeof sessionStore.delete === 'function'
    ) {
      await sessionStore.delete(b4a.from(id, 'hex'))
    }
  }
  const retention = new RetentionManager({
    layout,
    sessionStore,
    commitStore,
    storage,
    isSessionActive: () => false,
    logger
  })
  emit(onEvent, { type: 'scrub', status: 'started' })
  try {
    const scrub = await retention.scrubCommitted()
    emit(onEvent, {
      type: 'scrub',
      status: 'completed',
      deleted: scrub.deleted,
      unknownCount: scrub.unknown.length
    })
  } catch (err) {
    emit(onEvent, {
      type: 'scrub',
      status: 'failed',
      reason: failureReason(err)
    })
    throw err
  }
  return results
}

export { prepareStorageRecovery, recoverStorage }
