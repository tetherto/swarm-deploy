import b4a from 'b4a'

/** One JSON value a hook may return: no `undefined`, function, symbol, or BigInt anywhere. */
export type HookResultValue =
  | null
  | boolean
  | number
  | string
  | readonly HookResultValue[]
  | { readonly [key: string]: HookResultValue }

/** A plain JSON object a hook returns to describe its own work. Never built from the context. */
export type HookResult = { readonly [key: string]: HookResultValue }

/**
 * At most this many UTF-8 bytes of compact JSON. The whole link result record
 * still has to fit one control record (4 KiB), and its fixed fields take well
 * under 100 bytes of that.
 */
export const MAX_HOOK_RESULT_BYTES = 3 * 1024
/** The returned object is depth 1; each nested object or array adds one. */
export const MAX_HOOK_RESULT_DEPTH = 8

/** Why a returned value was refused. Carries a reason and a path, never a value. */
export class HookResultError extends Error {
  constructor(reason: string, where: string) {
    super(`Invalid hook result: ${reason} at ${where}`)
    this.name = 'HookResultError'
  }
}

interface Budget {
  /** A lower bound of the compact JSON size so far; every node costs at least one byte. */
  bytes: number
}

function charge(budget: Budget, bytes: number, where: string): void {
  budget.bytes += bytes
  if (budget.bytes > MAX_HOOK_RESULT_BYTES) throw new HookResultError('too large', where)
}

function describe(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`
}

/** The own data properties of a plain object or array, or an error for anything else. */
function dataProperties(value: object, where: string): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new HookResultError('symbol key', where)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new HookResultError('accessor property', describe(where, key))
    }
    if (Array.isArray(value) && key === 'length') continue
    if (descriptor.enumerable !== true) {
      throw new HookResultError('non-enumerable property', describe(where, key))
    }
    entries.push([key, descriptor.value])
  }
  return entries
}

function copyValue(value: unknown, depth: number, where: string, budget: Budget): HookResultValue {
  if (value === null) {
    charge(budget, 4, where)
    return null
  }
  switch (typeof value) {
    case 'boolean':
      charge(budget, value ? 4 : 5, where)
      return value
    case 'number':
      if (!Number.isFinite(value)) throw new HookResultError('non-finite number', where)
      charge(budget, 1, where)
      return value
    case 'string':
      charge(budget, value.length + 2, where)
      return value
    case 'object':
      break
    default:
      throw new HookResultError(`unsupported ${typeof value}`, where)
  }
  if (depth > MAX_HOOK_RESULT_DEPTH) throw new HookResultError('too deep', where)
  charge(budget, 2, where)
  const object = value as object
  if (Array.isArray(object)) {
    const properties = dataProperties(object, where)
    if (properties.length !== object.length) {
      throw new HookResultError('sparse array or array property', where)
    }
    const items: HookResultValue[] = []
    for (const [key, item] of properties) {
      if (key !== String(items.length)) throw new HookResultError('array property', where)
      charge(budget, 1, where)
      items.push(copyValue(item, depth + 1, describe(where, items.length), budget))
    }
    return items
  }
  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HookResultError('not a plain object', where)
  }
  const copy: { [key: string]: HookResultValue } = {}
  for (const [key, item] of dataProperties(object, where)) {
    // An own `__proto__` key would turn into a prototype assignment in a consumer's merge.
    if (key === '__proto__') throw new HookResultError('reserved key', where)
    charge(budget, key.length + 3, describe(where, key))
    copy[key] = copyValue(item, depth + 1, describe(where, key), budget)
  }
  return copy
}

/**
 * Checks a value a hook returned (or a decoded wire value) and returns a fresh
 * deep copy of it. It throws `HookResultError` for anything that is not a plain
 * JSON object within the size and depth limits: a non-object, a class instance
 * (so `toJSON` is never called), a getter or other accessor, a symbol key,
 * `undefined`, a function, a BigInt, a non-finite number, a cycle (it exceeds
 * the depth limit), or a result larger than `MAX_HOOK_RESULT_BYTES`. The copy
 * is the only thing that is sent, so later mutation of the original cannot
 * change it.
 */
export function copyHookResult(value: unknown): HookResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HookResultError('not an object', '$')
  }
  const copy = copyValue(value, 1, '$', { bytes: 0 }) as HookResult
  // The running total is only a lower bound; the exact compact size decides.
  if (b4a.from(JSON.stringify(copy)).byteLength > MAX_HOOK_RESULT_BYTES) {
    throw new HookResultError('too large', '$')
  }
  return copy
}
