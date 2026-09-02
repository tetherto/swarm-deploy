const leases = new Map<string, Promise<void>>()

export function withRootLease<T>(root: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = leases.get(root) || Promise.resolve()
  const result = previous.then(operation, operation)
  const tracked: Promise<void> = result.then(
    () => undefined,
    () => undefined
  )
  leases.set(root, tracked)
  return result.finally(() => {
    if (leases.get(root) === tracked) leases.delete(root)
  })
}
