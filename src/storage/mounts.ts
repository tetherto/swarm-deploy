import fs from '#fs'
import os from '#os'

/** One line of `/proc/self/mountinfo`, reduced to what a same-mount check needs. */
export interface MountEntry {
  id: number
  device: string
  mountPoint: string
}

const MOUNTINFO_PATH = '/proc/self/mountinfo'
/** The kernel table is a few hundred bytes per mount; anything this large is not read. */
const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024

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
 * The Linux mount table, or null where there is none to read: on other platforms, when
 * `/proc` is unavailable, or when the file is larger than any real table. Callers then
 * rely on the device-number check alone.
 */
export function readMountInfo(): MountEntry[] | null {
  if (os.platform() !== 'linux') return null
  try {
    const text = fs.readFileSync(MOUNTINFO_PATH, 'utf8')
    if (text.length > MAX_MOUNTINFO_BYTES) return null
    const mounts = parseMountInfo(text)
    return mounts.length > 0 ? mounts : null
  } catch {
    return null
  }
}
