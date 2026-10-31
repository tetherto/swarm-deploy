export interface StorageStats {
  dev: number | bigint
  ino: number | bigint
  size: number
  /** Hard-link count; tree primitives reject any file reporting more than one. */
  nlink?: number
  /** Modification time, compared across hashing when the adapter reports it. */
  mtimeMs?: number
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
  /**
   * Optional because storage adapters that never publish payloads do not need
   * mode changes. When provided, this must change the already-open file
   * descriptor (`fchmod` semantics), never re-resolve the path. Publication
   * fails closed when this capability is absent.
   */
  chmod?(mode: number): Promise<void>
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
  /** Required only when symlink rules are configured. */
  symlink?(target: string, path: string): Promise<void>
  readlink?(path: string): Promise<string>
}

export type SymlinkCapableStorage = StorageAdapter & {
  symlink(target: string, path: string): Promise<void>
  readlink(path: string): Promise<string>
}

export interface StorageLayout {
  /** The output root: published artifacts and managed links only, never private state. */
  root: string
  /** The private state directory: outside `root`, on the same filesystem, mode 0700. */
  internal: string
  staging: string
  sessions: string
  commits: string
  journals: string
  /** Private destinations for replacement publications before they are visible. */
  publications: string
  /** Private managed-symlink ownership records. */
  links: string
  /** Private destination a managed directory is renamed into before deletion. */
  trash: string
  lock: string
}

export interface StorageIdentity {
  dev: number | bigint
  ino: number | bigint
}
