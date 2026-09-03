const leases = new Map<string, Promise<void>>()

function withLease<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = leases.get(key) || Promise.resolve()
  const result = previous.then(operation, operation)
  const tracked: Promise<void> = result.then(
    () => undefined,
    () => undefined
  )
  leases.set(key, tracked)
  return result.finally(() => {
    if (leases.get(key) === tracked) leases.delete(key)
  })
}

export function withRootLease<T>(root: string, operation: () => Promise<T> | T): Promise<T> {
  return withLease(root, operation)
}

/**
 * Serializes inspection, admission, replacement, and recovery for one visible
 * name. Distinct names stay concurrent. Callers that also need the root lease
 * must take the name lease first.
 */
export function withNameLease<T>(
  root: string,
  name: string,
  operation: () => Promise<T> | T
): Promise<T> {
  return withLease(`${root}\u0000${name}`, operation)
}
