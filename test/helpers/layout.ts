import path from '#path'
import { initLayout as initPrivateLayout } from '../../dist/storage/layout.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { stateDirFor } from './files.js'

/**
 * Initializes a layout whose private state lives in the test's isolated state directory
 * (a sibling of the root), so no test writes under the real home directory. An explicit
 * `stateDir` still wins. Fixtures often start state for a root that already holds files, so
 * initialization is acknowledged here; the tests of that guard pass `initializeState: false`.
 */
export function initLayout(
  storageDir: string,
  stateDir?: string,
  options: { initializeState?: boolean } = {}
): StorageLayout {
  return initPrivateLayout(storageDir, stateDir ?? stateDirFor(path.resolve(storageDir)), {
    initializeState: true,
    ...options
  })
}
