import path from '#path'
import { ERRORS, SwarmDeployError } from './errors.js'
import { snapshotHooks, type ServerHooks } from './hooks.js'

const HOOK_NAMES = ['beforeCommit', 'afterCommit', 'onFailure'] as const
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
 * validated, frozen hook snapshot. Only `beforeCommit`, `afterCommit` and
 * `onFailure` are picked, by own property name; other exports are ignored.
 * Defined named exports take precedence over the default export's callbacks. Every failure is a fixed-message configuration
 * error that never includes module content.
 */
export async function loadHooksModule(modulePath: string, cwd: string): Promise<ServerHooks> {
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

  try {
    const merged = Object.create(null) as Record<string, unknown>
    const fallback = defaultHooks(namespace)
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
    const snapshot = snapshotHooks(merged as ServerHooks)
    if (Reflect.ownKeys(snapshot).length === 0) throw new Error('empty')
    return snapshot
  } catch {
    throw rejected(modulePath, 'invalid hooks exports')
  }
}
