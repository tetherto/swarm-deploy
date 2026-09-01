'use strict'

const leases = new Map()

function withRootLease(root, operation) {
  const previous = leases.get(root) || Promise.resolve()
  const result = previous.then(operation, operation)
  const tracked = result.catch(() => {})
  leases.set(root, tracked)
  return result.finally(() => {
    if (leases.get(root) === tracked) leases.delete(root)
  })
}

module.exports = {
  withRootLease
}
