/**
 * The open(2) flags a safe file open depends on, for the runtimes that do not provide them.
 *
 * Node provides every one of them in `fs.constants`. Bare's `fs` provides `O_CREAT` but neither
 * `O_EXCL` nor `O_NOFOLLOW`, so a safe open there needs the platform's own numbers. They are not
 * one set: the numbers differ by operating system, and on Linux `O_NOFOLLOW` also differs by
 * architecture, so a value right for x86 silently means something else on ARM (0x20000 is
 * `O_LARGEFILE` there, and a symlink is followed). The table below is therefore keyed by platform
 * and architecture and holds only combinations whose numbers are known. Anything else gets no
 * answer, and the caller refuses to open, rather than guessing.
 *
 * Pure on purpose: constants, platform and architecture are arguments, so every row can be
 * checked on any machine. The real filesystem guards are tested separately.
 */

export type OpenFlagName = 'O_CREAT' | 'O_EXCL' | 'O_NOFOLLOW'
export type SafeOpenAccess = 'read' | 'write' | 'create'

/** What a runtime's `fs.constants` may provide; a value that is not a positive integer is ignored. */
export interface OpenFlagConstants {
  readonly O_RDONLY?: unknown
  readonly O_WRONLY?: unknown
  readonly O_RDWR?: unknown
  readonly O_CREAT?: unknown
  readonly O_EXCL?: unknown
  readonly O_NOFOLLOW?: unknown
}

// Darwin (sys/fcntl.h): the same on arm64 and x64.
const DARWIN: Readonly<Record<OpenFlagName, number>> = {
  O_CREAT: 0x200,
  O_EXCL: 0x800,
  O_NOFOLLOW: 0x100
}

// Linux: `O_CREAT` (0100 octal) and `O_EXCL` (0200 octal) are the same on every architecture
// below. `O_NOFOLLOW` is 0400000 octal on x86 and 0100000 octal on ARM.
const LINUX_COMMON: Readonly<Record<Exclude<OpenFlagName, 'O_NOFOLLOW'>, number>> = {
  O_CREAT: 0x40,
  O_EXCL: 0x80
}
const LINUX_NOFOLLOW: Readonly<Record<string, number>> = {
  x64: 0x20000,
  ia32: 0x20000,
  arm64: 0x8000,
  arm: 0x8000
}

function provided(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function fallback(name: OpenFlagName, platform: string, arch: string): number | undefined {
  if (platform === 'darwin') return DARWIN[name]
  // An architecture missing from the table is an unknown ABI, for all three flags.
  if (platform !== 'linux' || !Object.hasOwn(LINUX_NOFOLLOW, arch)) return undefined
  return name === 'O_NOFOLLOW' ? LINUX_NOFOLLOW[arch] : LINUX_COMMON[name]
}

/**
 * The value of one flag: the runtime's own when it provides one, otherwise the documented value
 * for this platform and architecture, otherwise `undefined` (unsupported, never a guess).
 */
export function nativeOpenFlag(
  name: OpenFlagName,
  constants: OpenFlagConstants | null | undefined,
  platform: string,
  arch: string
): number | undefined {
  return provided(constants?.[name]) ?? fallback(name, platform, arch)
}

/**
 * The flags for a safe open of a regular file, every one of them refusing a symlink at the final
 * path: `read`, `write` (read and write, existing file) and `create` (write-only, exclusive, new
 * file). `undefined` when any flag the access needs is unsupported here. The three descriptor
 * modes are the same number on every Unix.
 */
export function safeOpenFlags(
  access: SafeOpenAccess,
  constants: OpenFlagConstants | null | undefined,
  platform: string,
  arch: string
): number | undefined {
  const noFollow = nativeOpenFlag('O_NOFOLLOW', constants, platform, arch)
  if (noFollow === undefined) return undefined
  if (access === 'read') return (provided(constants?.O_RDONLY) ?? 0) | noFollow
  if (access === 'write') return (provided(constants?.O_RDWR) ?? 2) | noFollow
  const create = nativeOpenFlag('O_CREAT', constants, platform, arch)
  const exclusive = nativeOpenFlag('O_EXCL', constants, platform, arch)
  if (create === undefined || exclusive === undefined) return undefined
  return (provided(constants?.O_WRONLY) ?? 1) | create | exclusive | noFollow
}
