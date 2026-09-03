export interface StorageStats {
  dev: number | bigint
  ino: number | bigint
  size: number
  isSymbolicLink(): boolean
  isDirectory(): boolean
  isFile(): boolean
}

/** Historical internal alias for {@link StorageStats}. */
export type StorageStat = StorageStats

export interface StorageReadResult {
  bytesRead: number
}

export interface StorageWriteResult {
  bytesWritten: number
}

export interface StorageMkdirOptions {
  mode?: number
}

export interface StorageRmOptions {
  recursive: boolean
  force: boolean
}

export interface StorageStatFs {
  bavail: number | bigint
  bsize: number | bigint
}

export interface StorageFileHandle {
  stat(): Promise<StorageStats>
  write(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<number | StorageWriteResult>
  read(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<number | StorageReadResult>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StorageAdapter {
  readFile(path: string, encoding: 'utf8'): Promise<string | Uint8Array>
  lstat(path: string): Promise<StorageStats>
  open(path: string, flags: string | number, mode?: number): Promise<StorageFileHandle>
  mkdir(path: string, options?: StorageMkdirOptions): Promise<void>
  rm(path: string, options?: Partial<StorageRmOptions>): Promise<void>
  rename(source: string, destination: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  statfs?(path: string): Promise<StorageStatFs>
}

export interface StorageLayout {
  root: string
  internal: string
  staging: string
  sessions: string
  commits: string
  journals: string
  /** Private destinations for replacement publications before they are visible. */
  publications: string
  lock: string
}

export interface StorageIdentity {
  dev: number | bigint
  ino: number | bigint
}
