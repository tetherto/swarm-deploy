import type { StorageAdapter, StorageFileHandle, StorageStats } from '../../dist/storage/types.js'

interface MemoryNode {
  kind: 'directory' | 'file'
  ino: number
  children: Map<string, MemoryNode>
}

export interface MemoryStorage extends StorageAdapter {
  /** Creates every directory along the absolute POSIX `directory`. */
  mkdirp(directory: string): void
  /** Creates one empty file; its parent must already exist. */
  addFile(filePath: string): void
  /** Counts every node below `directory`, not counting `directory` itself. */
  count(directory: string): number
  exists(target: string): boolean
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/**
 * Pure in-memory storage used to exercise tree limits without touching the
 * disk. It supports exactly the operations tree removal needs.
 */
export function createMemoryStorage(): MemoryStorage {
  let nextIno = 1
  const root: MemoryNode = { kind: 'directory', ino: nextIno++, children: new Map() }

  const find = (target: string): MemoryNode | null => {
    let node: MemoryNode = root
    for (const part of target.split('/').filter(Boolean)) {
      const child = node.children.get(part)
      if (!child || node.kind !== 'directory') return null
      node = child
    }
    return node
  }

  const stat = (node: MemoryNode): StorageStats => ({
    dev: 1,
    ino: node.ino,
    size: 0,
    nlink: 1,
    isSymbolicLink: () => false,
    isDirectory: () => node.kind === 'directory',
    isFile: () => node.kind === 'file'
  })

  const required = (target: string): MemoryNode => {
    const node = find(target)
    if (!node) throw errno('ENOENT')
    return node
  }

  const split = (target: string): { parent: MemoryNode; name: string } => {
    const parts = target.split('/').filter(Boolean)
    const name = parts.pop()
    if (name === undefined) throw errno('EEXIST')
    const parent = required('/' + parts.join('/'))
    return { parent, name }
  }

  const add = (target: string, kind: MemoryNode['kind']): void => {
    const { parent, name } = split(target)
    if (parent.children.has(name)) throw errno('EEXIST')
    parent.children.set(name, { kind, ino: nextIno++, children: new Map() })
  }

  const unsupported = (): never => {
    throw errno('ENOSYS')
  }

  const handle = (node: MemoryNode): StorageFileHandle => ({
    stat: () => Promise.resolve(stat(node)),
    write: () => Promise.reject(errno('ENOSYS')),
    read: () => Promise.reject(errno('ENOSYS')),
    sync: () => Promise.resolve(),
    close: () => Promise.resolve()
  })

  const countBelow = (node: MemoryNode): number => {
    let total = 0
    for (const child of node.children.values()) total += 1 + countBelow(child)
    return total
  }

  return {
    mkdirp(directory: string): void {
      let current = ''
      for (const part of directory.split('/').filter(Boolean)) {
        current += `/${part}`
        if (!find(current)) add(current, 'directory')
      }
    },
    addFile: (filePath: string): void => add(filePath, 'file'),
    count: (directory: string): number => countBelow(required(directory)),
    exists: (target: string): boolean => find(target) !== null,
    lstat: (target: string): Promise<StorageStats> => {
      try {
        return Promise.resolve(stat(required(target)))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    readdir: (target: string): Promise<string[]> => {
      try {
        const node = required(target)
        if (node.kind !== 'directory') throw errno('ENOTDIR')
        return Promise.resolve([...node.children.keys()])
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    unlink: (target: string): Promise<void> => {
      try {
        const { parent, name } = split(target)
        const node = parent.children.get(name)
        if (!node) throw errno('ENOENT')
        if (node.kind === 'directory') throw errno('EISDIR')
        parent.children.delete(name)
        return Promise.resolve()
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    rmdir: (target: string): Promise<void> => {
      try {
        const { parent, name } = split(target)
        const node = parent.children.get(name)
        if (!node) throw errno('ENOENT')
        if (node.kind !== 'directory') throw errno('ENOTDIR')
        if (node.children.size > 0) throw errno('ENOTEMPTY')
        parent.children.delete(name)
        return Promise.resolve()
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    open: (target: string): Promise<StorageFileHandle> => {
      try {
        return Promise.resolve(handle(required(target)))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    mkdir: (target: string): Promise<void> => {
      try {
        add(target, 'directory')
        return Promise.resolve()
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    readFile: () => Promise.resolve(unsupported()),
    rm: () => Promise.resolve(unsupported()),
    rename: () => Promise.resolve(unsupported()),
    link: () => Promise.resolve(unsupported())
  }
}
