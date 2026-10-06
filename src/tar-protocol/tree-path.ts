import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from '../errors.js'
import { isReservedHistoryName, validateBasename } from '../files.js'
import type { ArtifactKind } from '../types.js'

export const MAX_TREE_DEPTH = 32
export const MAX_TREE_NAME_BYTES = 100

function unsafeName(message: string): SwarmDeployError {
  return new SwarmDeployError(ERRORS.INVALID_FILENAME, message)
}

export interface TreePathEntryLike {
  kind: ArtifactKind
  path: string
}

/** The exact TAR name field for an entry: directories carry a trailing `/`. */
export function tarEntryName(entry: Pick<TreePathEntryLike, 'kind' | 'path'>): string {
  return entry.kind === 'directory' ? `${entry.path}/` : entry.path
}

export function assertTreeEntryPath(value: unknown, kind: ArtifactKind): string {
  if (typeof value !== 'string' || value.length === 0) throw unsafeName('Invalid tree entry path')
  if (value.includes('\\') || value.includes('\u0000')) throw unsafeName('Invalid tree entry path')
  const components = value.split('/')
  if (components.length > MAX_TREE_DEPTH) throw unsafeName('Tree entry path is too deep')
  for (const component of components) {
    if (component.length === 0) throw unsafeName('Invalid tree entry path')
    validateBasename(component)
    if (isReservedHistoryName(component)) throw unsafeName('Reserved tree entry path')
  }
  const stored = b4a.from(tarEntryName({ kind, path: value }))
  if (stored.byteLength > MAX_TREE_NAME_BYTES) throw unsafeName('Tree entry path is too long')
  return value
}

/** Bytewise order. A parent is a proper prefix, so it always sorts first. */
export function compareTreePaths(left: string, right: string): number {
  return b4a.compare(b4a.from(left), b4a.from(right))
}

/** Normalizes a canonical TAR stored name to a tree entry path and validates components. */
export function assertTreeStoredName(storedName: string, kind: ArtifactKind): string {
  if (typeof storedName !== 'string') throw unsafeName('Invalid tree entry path')
  if (storedName.includes('\u0000') || storedName.includes('\\') || storedName.startsWith('/')) {
    throw unsafeName('Invalid tree entry path')
  }
  const encoded = b4a.from(storedName)
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_TREE_NAME_BYTES) {
    throw unsafeName('Tree entry path is too long')
  }
  if (kind === 'directory') {
    if (!storedName.endsWith('/')) throw unsafeName('Invalid tree entry path')
    return assertTreeEntryPath(storedName.slice(0, -1), 'directory')
  }
  if (storedName.endsWith('/')) throw unsafeName('Invalid tree entry path')
  return assertTreeEntryPath(storedName, 'file')
}
