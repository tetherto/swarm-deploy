import fs from '#fs'
import type {
  StorageAdapter,
  StorageFileHandle,
  StorageMkdirOptions,
  StorageReadResult,
  StorageRmOptions,
  StorageStats,
  StorageWriteResult
} from '../../dist/storage/types.js'

/** Every filesystem operation the injectable storage adapter reports. */
export type StorageOperationName =
  | 'mkdir'
  | 'lstat'
  | 'readdir'
  | 'readFile'
  | 'writeFile'
  | 'rename'
  | 'link'
  | 'unlink'
  | 'rmdir'
  | 'rm'
  | 'open'
  | 'close'
  | 'read'
  | 'stat'
  | 'truncate'
  | 'write'
  | 'sync'

/**
 * Failure-injection hook. `target` is always the path the operation acts on;
 * the remaining arguments are the operation's own arguments in order, so
 * two-path operations receive their destination as the first rest argument.
 */
export type StorageOperationHook = (
  name: StorageOperationName,
  target: string,
  ...rest: unknown[]
) => void | Promise<void>

export type StoragePathPredicate = (filePath: string) => boolean

export interface CreateStorageOptions {
  failWriteFor?: StoragePathPredicate
  failSyncFor?: StoragePathPredicate
  beforeOperation?: StorageOperationHook
  afterOperation?: StorageOperationHook
}

export interface TestStorageFileHandle extends StorageFileHandle {
  fd: number
  truncate(length?: number): Promise<void>
}

export interface TestStorage extends StorageAdapter {
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  open(path: string, flags: string | number, mode?: number): Promise<TestStorageFileHandle>
}

export function createStorage({
  failWriteFor = () => false,
  failSyncFor = () => false,
  beforeOperation = () => {},
  afterOperation = () => {}
}: CreateStorageOptions = {}): TestStorage {
  const promises = fs.promises

  return {
    async mkdir(target: string, options?: StorageMkdirOptions): Promise<void> {
      await beforeOperation('mkdir', target, options)
      await promises.mkdir(target, options)
      await afterOperation('mkdir', target, options)
    },
    async lstat(target: string): Promise<StorageStats> {
      await beforeOperation('lstat', target)
      const result = await promises.lstat(target)
      await afterOperation('lstat', target)
      return result
    },
    async readdir(target: string): Promise<string[]> {
      await beforeOperation('readdir', target)
      const result = await promises.readdir(target)
      await afterOperation('readdir', target)
      return result
    },
    async readFile(target: string, encoding: 'utf8'): Promise<string> {
      await beforeOperation('readFile', target, encoding)
      const result = await promises.readFile(target, encoding)
      await afterOperation('readFile', target, encoding)
      return result
    },
    async writeFile(target: string, data: string | Uint8Array): Promise<void> {
      await beforeOperation('writeFile', target, data)
      await promises.writeFile(target, data)
      await afterOperation('writeFile', target, data)
    },
    async rename(source: string, destination: string): Promise<void> {
      await beforeOperation('rename', source, destination)
      await promises.rename(source, destination)
      await afterOperation('rename', source, destination)
    },
    async link(existingPath: string, newPath: string): Promise<void> {
      await beforeOperation('link', existingPath, newPath)
      await promises.link(existingPath, newPath)
      await afterOperation('link', existingPath, newPath)
    },
    async unlink(target: string): Promise<void> {
      await beforeOperation('unlink', target)
      await promises.unlink(target)
      await afterOperation('unlink', target)
    },
    async rmdir(target: string): Promise<void> {
      await beforeOperation('rmdir', target)
      await promises.rmdir(target)
      await afterOperation('rmdir', target)
    },
    async rm(target: string, options?: Partial<StorageRmOptions>): Promise<void> {
      await beforeOperation('rm', target, options)
      await promises.rm(target, options)
      await afterOperation('rm', target, options)
    },
    async open(
      filePath: string,
      flags: string | number,
      mode?: number
    ): Promise<TestStorageFileHandle> {
      await beforeOperation('open', filePath, flags, mode)
      const handle = await promises.open(filePath, flags, mode)
      try {
        await afterOperation('open', filePath, flags, mode)
      } catch (err) {
        await handle.close().catch(() => {})
        throw err
      }

      return {
        fd: handle.fd,
        close: async (): Promise<void> => {
          try {
            await beforeOperation('close', filePath)
          } catch (err) {
            await handle.close().catch(() => {})
            throw err
          }
          const result = await handle.close()
          await afterOperation('close', filePath)
          return result
        },
        read: async (
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): Promise<StorageReadResult> => {
          await beforeOperation('read', filePath, bytes, offset, length, position)
          const result = await handle.read(bytes, offset, length, position)
          await afterOperation('read', filePath, bytes, offset, length, position)
          return result
        },
        stat: async (): Promise<StorageStats> => {
          await beforeOperation('stat', filePath)
          const result = await handle.stat()
          await afterOperation('stat', filePath)
          return result
        },
        truncate: async (length?: number): Promise<void> => {
          await beforeOperation('truncate', filePath, length)
          const result = await handle.truncate(length)
          await afterOperation('truncate', filePath, length)
          return result
        },
        write: async (
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): Promise<StorageWriteResult> => {
          await beforeOperation('write', filePath, bytes, offset, length, position)
          if (failWriteFor(filePath)) throw new Error(`Injected write failure for ${filePath}`)
          const result = await handle.write(bytes, offset, length, position)
          await afterOperation('write', filePath, bytes, offset, length, position)
          return result
        },
        sync: async (): Promise<void> => {
          await beforeOperation('sync', filePath)
          if (failSyncFor(filePath)) throw new Error(`Injected sync failure for ${filePath}`)
          const result = await handle.sync()
          await afterOperation('sync', filePath)
          return result
        }
      }
    }
  }
}
