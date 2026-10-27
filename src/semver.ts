import b4a from 'b4a'
import { Version } from 'bare-semver'

/** Protocol: a release version is one safe path component, max 100 UTF-8 bytes. */
const MAX_VERSION_BYTES = 100

const NUMERIC = /^[0-9]+$/

/** A strictly validated SemVer 2.0.0 version with every core component a safe integer. */
export interface StrictVersion {
  major: number
  minor: number
  patch: number
  prerelease: readonly string[]
  /** `major.minor.patch[-prerelease]`: the canonical form, which never carries build metadata. */
  version: string
  /** Whether the input carried `+build` metadata that `version` omits. */
  hasBuild: boolean
}

/**
 * Parses one canonical release version, or returns undefined.
 *
 * The version must be a string of at most 100 UTF-8 bytes with no surrounding
 * whitespace, `v` prefix, or path separator, and its major, minor, and patch
 * must be safe integers. `bare-semver` accepts any length and rounds oversized
 * components through `parseInt`, so those bounds are enforced here. Build
 * metadata is accepted and reported through `hasBuild`; a caller that stores
 * versions compares `version` with its input to reject it.
 */
export function parseStrictVersion(raw: unknown): StrictVersion | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  if (b4a.from(raw).byteLength > MAX_VERSION_BYTES) return undefined
  if (raw.trim() !== raw || /^[vV]/.test(raw) || /[/\\]/.test(raw)) return undefined
  let parsed: Version
  try {
    parsed = Version.parse(raw)
  } catch {
    return undefined
  }
  const { major, minor, patch, prerelease, build } = parsed
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) return undefined
  const core = `${major}.${minor}.${patch}`
  const version = prerelease.length > 0 ? `${core}-${prerelease.join('.')}` : core
  if (raw.split('+', 1)[0] !== version) return undefined
  return { major, minor, patch, prerelease, version, hasBuild: build.length > 0 }
}

/**
 * SemVer 2.0.0 precedence; build metadata never takes part.
 *
 * This does not delegate to `Version.compare`: it coerces numeric prerelease
 * identifiers to Number, so two distinct identifiers beyond 2^53 that round to
 * the same value each compare as lower than the other. Retention sorts by this
 * order, so it has to stay total. Valid identifiers carry no leading zeros, so a
 * longer digit string is the larger number and equal lengths order
 * lexicographically; every other case matches `Version.compare`.
 */
export function compareStrictVersions(left: StrictVersion, right: StrictVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1

  const a = left.prerelease
  const b = right.prerelease
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0
    return a.length === 0 ? 1 : -1
  }
  for (let i = 0; i < a.length && i < b.length; i++) {
    const order = compareIdentifiers(a[i]!, b[i]!)
    if (order !== 0) return order
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

function compareIdentifiers(a: string, b: string): number {
  if (a === b) return 0
  const aNumeric = NUMERIC.test(a)
  const bNumeric = NUMERIC.test(b)
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1
    return a < b ? -1 : 1
  }
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : 1
}
