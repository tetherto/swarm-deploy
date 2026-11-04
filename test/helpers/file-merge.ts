import b4a from 'b4a'
import {
  emptyFileCatalog,
  type FileCatalog,
  type FileWriter
} from '../../dist/storage/file-catalog.js'
import {
  observationPaths,
  planFileMerge,
  type IncomingEntry,
  type MergeLimits,
  type MergeOutcome,
  type Observation
} from '../../dist/storage/file-merge.js'
import { sodiumSha256 } from '../../dist/tar-protocol/hash.js'
import { compareTreePaths } from '../../dist/tar-protocol/tree.js'

/** SHA-256 of `content` as lowercase hex. */
export function sha(content: string): string {
  return b4a.toString(sodiumSha256(b4a.from(content)), 'hex')
}

/** A 64-hex identifier made of one byte repeated, for transfer IDs and fingerprints. */
export function hexId(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(32)
}

/** A writer whose transfer is `hexId(transfer)`; `committedAt` defaults to a distinct time. */
export function writerOf(transfer: number, committedAt = 1_000 + transfer): FileWriter {
  return { transferId: hexId(transfer), uploader: hexId(200), committedAt }
}

/** A file's facts for an expected-identity computation written out by hand. */
export function facts(
  path: string,
  content: string
): { path: string; size: number; sha256: string } {
  return { path, size: b4a.from(content).byteLength, sha256: sha(content) }
}

/**
 * The entries of an uploaded tree from a spec of relative path to content. A key ending in `/` is
 * an empty directory; the parents of every entry are added as directory entries, so the list is a
 * canonical tree as `digestTree` would report it.
 */
export function incomingOf(spec: Record<string, string>): IncomingEntry[] {
  const directories = new Set<string>()
  const files = new Map<string, string>()
  for (const [key, content] of Object.entries(spec)) {
    const directory = key.endsWith('/')
    const relative = directory ? key.slice(0, -1) : key
    const parts = relative.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      directories.add(parts.slice(0, depth).join('/'))
    }
    if (directory) directories.add(relative)
    else files.set(relative, content)
  }
  const entries: IncomingEntry[] = [
    ...[...directories].map((path): IncomingEntry => ({ kind: 'directory', path, size: 0 })),
    ...[...files].map(([path, content]): IncomingEntry => ({
      kind: 'file',
      path,
      size: b4a.from(content).byteLength,
      sha256: sha(content)
    }))
  ]
  return entries.sort((left, right) => compareTreePaths(left.path, right.path))
}

type DiskNode =
  | { kind: 'file'; content: string }
  | { kind: 'directory' }
  | { kind: 'symlink' }
  | { kind: 'special' }

/**
 * A model of a container directory: what is there, by relative path, and how a caller would observe
 * it. Files that Swarm does not own (an operator's) are simply files here, with no catalog entry.
 */
export class Disk {
  readonly nodes = new Map<string, DiskNode>()

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) this.put(path, content)
  }

  private parents(path: string): void {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/')
      if (!this.nodes.has(parent)) this.nodes.set(parent, { kind: 'directory' })
    }
  }

  put(path: string, content: string): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'file', content })
  }

  mkdir(path: string): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'directory' })
  }

  symlink(path: string): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'symlink' })
  }

  special(path: string): void {
    this.parents(path)
    this.nodes.set(path, { kind: 'special' })
  }

  read(path: string): string | undefined {
    const node = this.nodes.get(path)
    return node?.kind === 'file' ? node.content : undefined
  }

  /** Every regular file, sorted. */
  files(): string[] {
    return [...this.nodes]
      .filter(([, node]) => node.kind === 'file')
      .map(([path]) => path)
      .sort(compareTreePaths)
  }

  /** Every directory, sorted. */
  directories(): string[] {
    return [...this.nodes]
      .filter(([, node]) => node.kind === 'directory')
      .map(([path]) => path)
      .sort(compareTreePaths)
  }

  /** Everything that is there, serialized, to compare before and after. */
  snapshot(): string {
    return JSON.stringify([...this.nodes].sort(([left], [right]) => compareTreePaths(left, right)))
  }

  observe(paths: readonly string[]): Map<string, Observation> {
    const observed = new Map<string, Observation>()
    for (const path of paths) {
      const node = this.nodes.get(path)
      const variants = [...this.nodes.keys()].filter(
        (other) => other !== path && other.toLowerCase() === path.toLowerCase()
      )
      const base: Observation =
        node === undefined
          ? { kind: 'missing' }
          : node.kind === 'file'
            ? { kind: 'file', size: b4a.from(node.content).byteLength, sha256: sha(node.content) }
            : { kind: node.kind }
      observed.set(path, variants.length > 0 ? { ...base, caseVariants: variants } : base)
    }
    return observed
  }

  /** What publishing a plan would do to the container: create parents, write added/replaced files. */
  apply(outcome: MergeOutcome, spec: Record<string, string>): void {
    if (!outcome.ok) throw new Error('a refused plan has nothing to apply')
    for (const directory of outcome.directories) this.mkdir(directory)
    for (const action of outcome.actions) {
      if (action.op === 'skip') continue
      const content = spec[action.path]
      if (content === undefined) throw new Error(`no content for ${action.path}`)
      this.put(action.path, content)
    }
  }
}

export interface PlanOptions {
  allowReplace?: boolean
  writer?: FileWriter
  release?: { series: string; version?: string }
  limits?: MergeLimits
}

/** Observes `disk` for exactly what the planner asks about, and plans the upload `spec`. */
export function plan(
  disk: Disk,
  catalog: FileCatalog,
  spec: Record<string, string>,
  options: PlanOptions = {}
): MergeOutcome {
  const incoming = incomingOf(spec)
  return planFileMerge({
    catalog,
    incoming,
    observed: disk.observe(observationPaths(incoming)),
    allowReplace: options.allowReplace ?? false,
    writer: options.writer ?? writerOf(1),
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.limits === undefined ? {} : { limits: options.limits })
  })
}

export type AcceptedMerge = Extract<MergeOutcome, { ok: true }>
export type RefusedMerge = Extract<MergeOutcome, { ok: false }>

export function accepted(outcome: MergeOutcome): AcceptedMerge {
  if (!outcome.ok) {
    throw new Error(`expected an accepted merge, got ${JSON.stringify(outcome.conflicts)}`)
  }
  return outcome
}

export function refused(outcome: MergeOutcome): RefusedMerge {
  if (outcome.ok) throw new Error('expected a refused merge')
  return outcome
}

/** Plans, applies to the disk, and returns the catalog afterwards. */
export function merge(
  disk: Disk,
  catalog: FileCatalog,
  spec: Record<string, string>,
  options: PlanOptions = {}
): { outcome: AcceptedMerge; catalog: FileCatalog } {
  const outcome = accepted(plan(disk, catalog, spec, options))
  disk.apply(outcome, spec)
  return { outcome, catalog: outcome.next }
}

export function fresh(
  name = 'beta-1.2.3',
  release?: { series: string; version?: string }
): FileCatalog {
  return emptyFileCatalog(name, release)
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
