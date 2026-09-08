import { ERRORS, SwarmDeployError } from './errors.js'

export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener(event: 'abort', callback: () => void, options?: { once?: boolean }): void
  removeEventListener(event: 'abort', callback: () => void): void
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike
  abort(): void
}

export function abortError(): SwarmDeployError {
  return new SwarmDeployError(ERRORS.ABORTED, 'Operation aborted')
}

export function throwIfAborted(signal: Pick<AbortSignalLike, 'aborted'> | null | undefined): void {
  if (signal?.aborted) throw abortError()
}

export function onAbort(
  signal: AbortSignalLike | null | undefined,
  callback: () => void
): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    callback()
    return () => {}
  }
  signal.addEventListener('abort', callback, { once: true })
  return () => signal.removeEventListener('abort', callback)
}

export function createAbortController(): AbortControllerLike {
  if (typeof globalThis.AbortController === 'function') return new globalThis.AbortController()
  const listeners = new Set<() => void>()
  const signal: AbortSignalLike & { aborted: boolean } = {
    aborted: false,
    addEventListener(event: 'abort', callback: () => void) {
      if (event === 'abort') listeners.add(callback)
    },
    removeEventListener(event: 'abort', callback: () => void) {
      if (event === 'abort') listeners.delete(callback)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const callback of listeners) callback()
      listeners.clear()
    }
  }
}
