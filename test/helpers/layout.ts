import path from '#path'
import { initLayout as initPrivateLayout } from '../../dist/storage/layout.js'
import type { StorageLayout } from '../../dist/storage/types.js'
import { stateDirFor } from './files.js'

/**
 * Initializes a layout whose private state lives in the test's isolated state directory
 * (a sibling of the root), so no test writes under the real home directory. An explicit
 * `stateDir` still wins.
 */
export function initLayout(storageDir: string, stateDir?: string): StorageLayout {
  return initPrivateLayout(storageDir, stateDir ?? stateDirFor(path.resolve(storageDir)))
}
