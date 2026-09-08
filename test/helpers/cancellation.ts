/// <reference path="../types/brittle.d.ts" />

import type { Assert } from 'brittle'
import fs from '#fs'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

/**
 * The subset of a file handle the manifest blocker observes or replaces. `stat`
 * is optional because the replacement handed to production code exposes only
 * `fd` and `close`, while the retained real descriptor supports it.
 */
export interface BlockedDescriptor {
  fd: number
  close(): Promise<void>
  stat?(): Promise<unknown>
}

interface BlockedReadStream {
  once(event: 'data' | 'close', listener: () => void): unknown
  pause(): unknown
}

/**
 * A mutable view of the runtime filesystem module. `#fs` is patched in place so
 * production code observes the injected behaviour; only the three members the
 * blocker replaces are described here.
 */
interface PatchableFs {
  promises: {
    lstat(lstatPath: string, ...rest: unknown[]): Promise<unknown>
    open(openPath: string, ...rest: unknown[]): Promise<BlockedDescriptor>
  }
  createReadStream(streamPath: string, options?: unknown): BlockedReadStream
}

export interface BlockedManifestState {
  descriptor: BlockedDescriptor | null
  descriptorCloseAttempted: boolean
  lstatPaths: string[]
  openPaths: string[]
  readPaths: string[]
  reads: number
  streamClosed: boolean
}

export interface BlockedManifest {
  started: Promise<void>
  streamClosed: Promise<void>
  state: BlockedManifestState
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

export function blockManifestAfterFirstRead(t: Assert, filePath: string): BlockedManifest {
  const started = deferred()
  const streamClosed = deferred()
  const state: BlockedManifestState = {
    descriptor: null,
    descriptorCloseAttempted: false,
    lstatPaths: [],
    openPaths: [],
    readPaths: [],
    reads: 0,
    streamClosed: false
  }
  const patchable = fs as unknown as PatchableFs
  const originalLstat = patchable.promises.lstat
  const originalOpen = patchable.promises.open
  const originalCreateReadStream = patchable.createReadStream

  patchable.promises.lstat = function patchedLstat(
    this: unknown,
    lstatPath: string,
    ...args: unknown[]
  ): Promise<unknown> {
    state.lstatPaths.push(lstatPath)
    return originalLstat.call(this, lstatPath, ...args)
  }
  patchable.promises.open = async function patchedOpen(
    this: unknown,
    openPath: string,
    ...args: unknown[]
  ): Promise<BlockedDescriptor> {
    state.openPaths.push(openPath)
    const handle = await originalOpen.call(this, openPath, ...args)
    if (openPath !== filePath) return handle
    state.descriptor = handle
    return {
      fd: handle.fd,
      close: () => {
        state.descriptorCloseAttempted = true
        return handle.close()
      }
    }
  }
  patchable.createReadStream = function patchedCreateReadStream(
    this: unknown,
    streamPath: string,
    opts?: unknown
  ): BlockedReadStream {
    state.readPaths.push(streamPath)
    const stream = originalCreateReadStream.call(this, streamPath, opts)
    if (streamPath !== filePath) return stream
    stream.once('data', () => {
      state.reads++
      stream.pause()
      started.resolve()
    })
    stream.once('close', () => {
      state.streamClosed = true
      streamClosed.resolve()
    })
    return stream
  }
  t.teardown(() => {
    patchable.promises.lstat = originalLstat
    patchable.promises.open = originalOpen
    patchable.createReadStream = originalCreateReadStream
  })

  return { started: started.promise, streamClosed: streamClosed.promise, state }
}

/** The inspected fields of a rejection captured by {@link settlePromptly}. */
export interface SettledFailure {
  name?: unknown
  code?: unknown
  message?: unknown
  status?: unknown
}

export function settledError(result: PromiseSettledResult<unknown>): SettledFailure {
  return result.status === 'rejected' ? (result.reason as SettledFailure) : {}
}

export async function settlePromptly(
  promises: ReadonlyArray<Promise<unknown>>,
  timeout = 1_000
): Promise<Array<PromiseSettledResult<unknown>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(promises),
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Operation did not settle promptly')), timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
