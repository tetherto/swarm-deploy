import b4a from 'b4a'
import fs from '#fs'
import os from '#os'

/** One line of `/proc/self/mountinfo`, reduced to what a same-mount check needs. */
export interface MountEntry {
  id: number
  device: string
  mountPoint: string
}

const MOUNTINFO_PATH = '/proc/self/mountinfo'
/** The kernel table is a few hundred bytes per mount; a table larger than this is not used. */
export const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

/** The kernel writes space, tab, newline, and backslash as three-digit octal escapes. */
function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  )
}

/**
 * Parses mountinfo(5). Every line is `id parent major:minor root mountpoint options
 * [optional...] - fstype source super-options`. A line that does not have that shape,
 * or whose mount point is not an absolute path, is skipped rather than guessed at.
 */
export function parseMountInfo(text: string): MountEntry[] {
  const mounts: MountEntry[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split(' ')
    const separator = fields.indexOf('-')
    if (separator < 6 || fields.length < separator + 3) continue
    const id = Number(fields[0])
    if (!Number.isSafeInteger(id) || id < 0 || !/^\d+:\d+$/.test(fields[2])) continue
    const mountPoint = unescapeMountField(fields[4])
    if (!mountPoint.startsWith('/')) continue
    mounts.push({ id, device: fields[2], mountPoint })
  }
  return mounts
}

/**
 * The mount holding `target`: the one with the longest mount point containing it. The
 * table is in mount order, so among mounts stacked on one mount point the last one is
 * the one that is visible.
 */
export function mountFor(mounts: readonly MountEntry[], target: string): MountEntry | null {
  let found: MountEntry | null = null
  for (const mount of mounts) {
    const point = mount.mountPoint
    const contains = point === '/' || target === point || target.startsWith(`${point}/`)
    if (contains && (found === null || point.length >= found.mountPoint.length)) found = mount
  }
  return found
}

/**
 * Reads `file` as UTF-8 text through at most `limit + 1` bytes, and returns null when the file
 * holds more than `limit` bytes. The size is never taken from `stat`, which reports zero for
 * files the kernel generates on read, so the read runs to end of file; the descriptor is
 * closed however it ends. Failures to open or read are thrown.
 */
export function readBoundedText(file: string, limit: number): string | null {
  const fd = fs.openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total <= limit) {
      const chunk = b4a.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - total))
      // Position -1 reads from the current offset, which both runtimes accept.
      const count = fs.readSync(fd, chunk, 0, chunk.byteLength, -1)
      if (count === 0) return b4a.toString(b4a.concat(chunks, total), 'utf8')
      chunks.push(chunk.subarray(0, count))
      total += count
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The Linux mount table, or null where there is none to use: on other platforms, when
 * `/proc` cannot be opened or read, or when the table is larger than `MAX_MOUNTINFO_BYTES`.
 * Callers then rely on the device-number check alone, and a publication that still fails with
 * `EXDEV` is reported by the server. The read itself is `readBoundedText`, which throws on a
 * failure, so a platform where it cannot read the file is visible to a test, not only here.
 */
export function readMountInfo(): MountEntry[] | null {
  if (os.platform() !== 'linux') return null
  try {
    const text = readBoundedText(MOUNTINFO_PATH, MAX_MOUNTINFO_BYTES)
    if (text === null) return null
    const mounts = parseMountInfo(text)
    return mounts.length > 0 ? mounts : null
  } catch {
    return null
  }
}
