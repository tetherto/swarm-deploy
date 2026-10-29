import path from '#path'
import { ERRORS, SwarmDeployError } from './errors.js'
import {
  HOOK_NAMES,
  snapshotHookModes,
  snapshotHooks,
  type HookModes,
  type ServerHooks
} from './hooks.js'

/** A loaded hooks module: the callbacks, and the `hookModes` it declared for them. */
export interface LoadedHooks {
  hooks: ServerHooks
  modes: HookModes
}

const HOOK_EXTENSIONS = ['.js', '.mjs', '.cjs']

function rejected(modulePath: string, reason: string): SwarmDeployError {
  // Only the basename and a fixed reason: module text, stack traces, causes and
  // directory names can carry secrets and must never reach the operator log.
  return new SwarmDeployError(
    ERRORS.PROTOCOL_INVALID,
    `Unable to load hooks module ${path.basename(modulePath)}: ${reason}`
  )
}

function fileUrl(file: string): string {
  if (/^[A-Za-z]:[\\/]/.test(file)) {
    return `file:///${encodeURI(file.replace(/\\/g, '/')).replace(/[?#]/g, encodeURIComponent)}`
  }
  return `file://${encodeURI(file).replace(/[?#]/g, encodeURIComponent)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name)
}

/** Reads an error's string `code` without ever letting a hostile getter or proxy throw. */
function errorCode(error: unknown): string | undefined {
  try {
    if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
      return undefined
    }
    const code: unknown = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * The default export's hook object, or `undefined` when the default is absent or not
 * a plain object (function, primitive, null, array). Unwraps exactly one explicit
 * `__esModule` interop level (TypeScript-compiled CommonJS).
 */
function defaultHooks(namespace: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!hasOwn(namespace, 'default')) return undefined
  const fallback = namespace.default
  if (fallback === undefined) return undefined
  if (!isRecord(fallback)) return undefined
  if (
    hasOwn(fallback, '__esModule') &&
    fallback.__esModule === true &&
    hasOwn(fallback, 'default')
  ) {
    const inner = fallback.default
    return isRecord(inner) ? inner : undefined
  }
  return fallback
}

/**
 * Loads a JavaScript hooks module (`.js`, `.mjs` or `.cjs`) and returns the
 * validated, frozen hook snapshot and the validated `hookModes` declaration.
 * Only `beforeCommit`, `afterCommit`, `afterLink`, `onFailure` and `hookModes`
 * are picked, by own property name; other exports are ignored. `hookModes` is
 * read as data (`{ afterCommit?, afterLink?, onFailure? }`, each `'response'` or
 * `'detached'`), never guessed from the callbacks.
 * Defined named exports take precedence over the default export's callbacks and
 * declarations. Every failure is a fixed-message configuration error that never
 * includes module content.
 */
export async function loadHooksModule(modulePath: string, cwd: string): Promise<LoadedHooks> {
  if (typeof modulePath !== 'string' || modulePath.length === 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid hooks module path')
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid working directory')
  }
  const resolved = path.resolve(cwd, modulePath)
  // Checked before the import so an unsupported extension gives a precise
  // startup error instead of whatever the runtime's loader happens to say.
  if (!HOOK_EXTENSIONS.includes(path.extname(resolved))) {
    throw rejected(modulePath, 'unsupported module extension')
  }

  let namespace: Record<string, unknown>
  try {
    namespace = (await import(fileUrl(resolved))) as Record<string, unknown>
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw rejected(modulePath, 'module not found')
    }
    throw rejected(modulePath, 'module failed to load')
  }

  let fallback: Record<string, unknown> | undefined
  let hooks: ServerHooks
  try {
    fallback = defaultHooks(namespace)
    const merged = Object.create(null) as Record<string, unknown>
    for (const name of HOOK_NAMES) {
      if (fallback !== undefined && hasOwn(fallback, name)) {
        const value = fallback[name]
        if (value !== undefined) merged[name] = value
      }
      if (hasOwn(namespace, name)) {
        const value = namespace[name]
        if (value !== undefined) merged[name] = value
      }
    }
    hooks = snapshotHooks(merged as ServerHooks)
    if (Reflect.ownKeys(hooks).length === 0) throw new Error('empty')
  } catch {
    throw rejected(modulePath, 'invalid hooks exports')
  }

  try {
    const declared = Object.create(null) as Record<string, unknown>
    for (const source of [
      fallback !== undefined && hasOwn(fallback, 'hookModes') ? fallback.hookModes : undefined,
      hasOwn(namespace, 'hookModes') ? namespace.hookModes : undefined
    ]) {
      if (source === undefined) continue
      if (!isRecord(source)) throw new Error('not an object')
      for (const name of Reflect.ownKeys(source)) {
        if (typeof name === 'symbol') throw new Error('symbol key')
        const value = source[name]
        if (value !== undefined) declared[name] = value
      }
    }
    // Checked against the module's own callbacks: a typo or a mode for a hook the
    // module does not export is a startup error, never a silently detached hook.
    const modes = snapshotHookModes(declared as HookModes, hooks)
    return { hooks, modes: { ...modes } }
  } catch {
    throw rejected(modulePath, 'invalid hookModes export')
  }
}
