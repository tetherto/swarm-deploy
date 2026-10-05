import path from '#path'
import { ERRORS, SwarmDeployError } from './errors.js'
import { snapshotHooks, type ServerHooks } from './hooks.js'

const INTEROP_EXPORTS = new Set(['default', '__esModule', 'module.exports'])

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

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Loads a JavaScript hooks module (`.js`, `.mjs` or `.cjs`) and returns the
 * validated, frozen hook snapshot. Named exports take precedence over the
 * default export's callbacks. Every failure is a fixed-message configuration
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

  let namespace: Record<string, unknown>
  try {
    namespace = (await import(fileUrl(resolved))) as Record<string, unknown>
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw rejected(modulePath, 'module not found')
    }
    throw rejected(modulePath, 'module failed to load')
  }

  try {
    const merged: Record<string | symbol, unknown> = {}
    const fallback = namespace.default
    if (fallback !== undefined) {
      if (!isRecord(fallback)) throw new Error('shape')
      for (const key of Reflect.ownKeys(fallback)) {
        if (key !== '__esModule') merged[key] = fallback[key]
      }
    }
    for (const key of Object.keys(namespace)) {
      if (!INTEROP_EXPORTS.has(key)) merged[key] = namespace[key]
    }
    const snapshot = snapshotHooks(merged as ServerHooks)
    if (Reflect.ownKeys(snapshot).length === 0) throw new Error('empty')
    return snapshot
  } catch {
    throw rejected(modulePath, 'invalid hooks exports')
  }
}
