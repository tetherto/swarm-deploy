import fs from '#fs'
import os from '#os'
import { ERRORS, SwarmDeployError } from '../errors.js'
import type { StorageAdapter } from './types.js'

/**
 * The atomic exchange primitive of the default storage adapter.
 *
 * It comes from `fs-native-extensions`, a native addon, and nothing here loads it until a
 * directory replacement actually needs it: importing the package, a client, or a server that never
 * replaces a directory does not touch the addon, so a platform without a prebuilt binary keeps
 * working for everything else. A platform whose exchange is not atomic (Windows) never gets the
 * capability at all; there is no emulation by renames anywhere.
 */

type SwapFunction = (first: string, second: string) => unknown

interface NativeModule {
  swap?: unknown
  default?: { swap?: unknown }
}

let nativeSwap: Promise<SwapFunction | null> | null = null

/** Whether this platform's native exchange is atomic. Anything else is refused outright. */
export function platformHasAtomicExchange(platform: string = os.platform()): boolean {
  return platform === 'linux' || platform === 'darwin'
}

function unsupported(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.UNSUPPORTED_STORAGE, message, cause)
}

async function loadNative(): Promise<SwapFunction | null> {
  if (!platformHasAtomicExchange()) return null
  try {
    const loaded = (await import('fs-native-extensions')) as unknown as NativeModule
    const candidate = typeof loaded.swap === 'function' ? loaded.swap : loaded.default?.swap
    if (typeof candidate !== 'function') return null
    const owner = typeof loaded.swap === 'function' ? loaded : loaded.default
    return (first: string, second: string) => (candidate as SwapFunction).call(owner, first, second)
  } catch {
    return null
  }
}

/** Loads the addon once, on first use. A load failure is remembered: the platform is unsupported. */
function native(): Promise<SwapFunction | null> {
  if (nativeSwap === null) nativeSwap = loadNative()
  return nativeSwap
}

/** Exchanges two existing paths atomically, or throws `UNSUPPORTED_STORAGE` having changed nothing. */
export async function nativeAtomicSwap(first: string, second: string): Promise<void> {
  const swap = await native()
  if (swap === null) throw unsupported('Atomic directory exchange is unavailable on this platform')
  // The addon may report completion by return value or by promise; both are awaited, and a
  // throw in either shape reaches the caller unchanged.
  await swap(first, second)
}

/**
 * The default storage adapter: the runtime's promise filesystem plus, where the platform
 * supports it, a lazily loaded `atomicSwap`. Every other member is the runtime's own, called with
 * the runtime object as its receiver.
 */
export function createDefaultStorage(): StorageAdapter {
  const base = fs.promises as unknown as StorageAdapter
  const withSwap = platformHasAtomicExchange()
  return new Proxy({} as StorageAdapter, {
    get(_target, property) {
      if (property === 'atomicSwap') return withSwap ? nativeAtomicSwap : undefined
      const value: unknown = Reflect.get(base, property, base)
      return typeof value === 'function' ? value.bind(base) : value
    },
    has: (_target, property) => (property === 'atomicSwap' ? withSwap : property in base)
  })
}

/** Test seam: forget a remembered load result so a test can observe a fresh load. */
export function resetNativeAtomicSwapForTests(): void {
  nativeSwap = null
}
