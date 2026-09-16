/**
 * Single source for reading the `code` of an unknown thrown value.
 *
 * Every caller previously kept a private copy of these helpers. The one module
 * that hand-inlined the cast instead dereferenced a null `cause`, so the shared
 * implementation is deliberately null-safe at every step.
 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

/**
 * True when `error`, or the cause it wraps, reports ENOENT.
 *
 * `SwarmDeployError` always defines an own `cause` property, so it is present
 * even when null; `errorCode` absorbs that case rather than dereferencing it.
 */
export function isMissing(error: unknown): boolean {
  if (errorCode(error) === 'ENOENT') return true
  if (typeof error !== 'object' || error === null || !('cause' in error)) return false
  return errorCode((error as { cause: unknown }).cause) === 'ENOENT'
}
