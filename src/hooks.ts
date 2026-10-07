import { onAbort, type AbortSignalLike } from './abort.js'
import { ERRORS, SwarmDeployError } from './errors.js'
import type { ReleaseCoordinates } from './release.js'
import type { ArtifactKind } from './types.js'

export type HookFailurePhase =
  'offer' | 'transfer' | 'verification' | 'beforeCommit' | 'commit' | 'afterCommit'

/** Immutable, secret-free description of the artifact a hook is observing. */
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

export interface BeforeCommitContext {
  artifact: HookArtifact
  /** Absolute path of the verified staging file. */
  path: string
  resumed: boolean
  alreadyCommitted: false
}

export interface AfterCommitContext {
  artifact: HookArtifact
  /** Absolute path of the durably committed artifact. */
  path: string
  resumed: boolean
  alreadyCommitted: boolean
}

export interface HookFailureContext {
  artifact: HookArtifact
  /** The best known absolute path, or `null` before one exists. */
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

const WRAPPED_CALLBACK_ERRORS = new WeakMap<SwarmDeployError, unknown>()
const HOOK_NAMES = ['beforeCommit', 'afterCommit', 'onFailure'] as const

/**
 * Validates and freezes caller hooks. Each property is read exactly once and no
 * receiver is bound, so later mutation of the caller's object cannot change the
 * callbacks a running server invokes.
 */
export function snapshotHooks(hooks: ServerHooks | null | undefined): Readonly<ServerHooks> {
  if (hooks === null || hooks === undefined) return Object.freeze({})
  if (typeof hooks !== 'object') {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid hooks')
  }
  for (const name of Reflect.ownKeys(hooks)) {
    if (!(HOOK_NAMES as readonly (string | symbol)[]).includes(name)) {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Unknown hook')
    }
  }
  const snapshot: ServerHooks = {}
  for (const name of HOOK_NAMES) {
    const callback: unknown = hooks[name]
    if (callback === undefined) continue
    if (typeof callback !== 'function') {
      throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, `Invalid ${name} hook`)
    }
    Object.defineProperty(snapshot, name, {
      value: callback,
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return Object.freeze(snapshot)
}

/**
 * Wraps a failed callback. The message is fixed so callback text (which may
 * carry secrets) never reaches the wire; the original error stays on `cause`.
 */
export function hookError(phase: HookFailurePhase, cause: unknown): SwarmDeployError {
  const error = new SwarmDeployError(
    ERRORS.HOOK_FAILED,
    `Deployment hook failed during ${phase}`,
    cause
  )
  WRAPPED_CALLBACK_ERRORS.set(error, cause)
  return error
}

/**
 * The error an `onFailure` hook should see: the raw exception for failures this
 * module wrapped, otherwise the error unchanged. Only identity-tracked wrappers
 * unwrap, so a forged `HOOK_FAILED` error cannot masquerade as one.
 */
export function callbackError(error: unknown): unknown {
  return error instanceof SwarmDeployError && WRAPPED_CALLBACK_ERRORS.has(error)
    ? WRAPPED_CALLBACK_ERRORS.get(error)
    : error
}

/**
 * Calls a callback with no receiver and settles when it does or when the
 * server aborts, whichever is first. A callback that outlives an abort keeps
 * running detached; its later rejection is swallowed.
 */
export async function invokeHook<Context>(
  callback: (context: Context) => void | Promise<void>,
  context: Context,
  signal: AbortSignalLike
): Promise<'completed' | 'aborted'> {
  let pending: Promise<void>
  try {
    pending = Promise.resolve(callback(context))
  } catch (cause) {
    pending = Promise.reject(cause)
  }
  pending.catch(() => {})
  let release = (): void => {}
  const aborted = new Promise<'aborted'>((resolve) => {
    release = onAbort(signal, () => resolve('aborted'))
  })
  try {
    return await Promise.race([pending.then(() => 'completed' as const), aborted])
  } finally {
    release()
  }
}
