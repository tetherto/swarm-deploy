import { ERRORS, SwarmDeployError } from '../errors.js'
import type { TreeExtractionTarget, TreeFileSink } from '../tar-protocol/tree-extract.js'
import {
  createTreeRoot,
  createTreeSubdirectory,
  openTreeFile,
  removeTree,
  syncTreeDirectories
} from './tree-fs.js'
import type { StorageAdapter, StorageLayout } from './types.js'

/**
 * Writes an extracted tree into `treePath`, which must live directly under
 * `parent`. Every path is created exclusively, with no-follow opens, from
 * validated components only, and every call carries the storage layout so the
 * protected directories are refused by identity.
 */
export function createTreeStagingTarget(
  treePath: string,
  parent: string,
  storage: StorageAdapter,
  layout: StorageLayout
): TreeExtractionTarget {
  const options = { layout }
  let created = false
  const ensureRoot = async (): Promise<void> => {
    if (created) return
    await createTreeRoot(treePath, parent, storage, options)
    created = true
  }
  return {
    async createDirectory(relativePath: string): Promise<void> {
      await ensureRoot()
      await createTreeSubdirectory(treePath, relativePath, storage, options)
    },
    async createFile(relativePath: string): Promise<TreeFileSink> {
      await ensureRoot()
      const handle = await openTreeFile(treePath, relativePath, storage, options)
      let position = 0
      return {
        async write(chunk: Uint8Array): Promise<void> {
          let offset = 0
          while (offset < chunk.byteLength) {
            const written = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              position + offset
            )
            const count = typeof written === 'number' ? written : written.bytesWritten
            if (!Number.isSafeInteger(count) || count <= 0) {
              throw new SwarmDeployError(
                ERRORS.PROTOCOL_INVALID,
                'Unable to write staged tree file'
              )
            }
            offset += count
          }
          position += chunk.byteLength
        },
        async close(): Promise<void> {
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
        }
      }
    },
    async complete(): Promise<void> {
      await ensureRoot()
      await syncTreeDirectories(treePath, storage)
    },
    async abort(): Promise<void> {
      if (!created) return
      await removeTree(treePath, parent, storage, options).catch(() => {})
    }
  }
}
