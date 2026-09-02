export interface StorageStat {
  dev: number | bigint
  ino: number | bigint
  size: number
  isSymbolicLink(): boolean
  isDirectory(): boolean
  isFile(): boolean
}

export interface StorageFileHandle {
  stat(): Promise<StorageStat>
  write(
    bytes: Uint8Array,
    offset?: number,
    length?: number,
    position?: number
  ): Promise<number | { bytesWritten: number }>
  read(
    bytes: Uint8Array,
    offset?: number,
    length?: number,
    position?: number
  ): Promise<number | { bytesRead: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StorageAdapter {
  readFile(path: string, encoding: 'utf8'): Promise<string | Uint8Array>
  lstat(path: string): Promise<StorageStat>
  open(path: string, flags: string | number, mode?: number): Promise<StorageFileHandle>
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  rename(source: string, destination: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  statfs?(path: string): Promise<StorageFileSystemStats>
}

export interface StorageFileSystemStats {
  bavail?: number | bigint
  bsize?: number | bigint
}

export interface StorageLayout {
  root: string
  internal: string
  staging: string
  sessions: string
  commits: string
  journals: string
  lock: string
}

export interface StorageIdentity {
  dev: number | bigint
  ino: number | bigint
}
