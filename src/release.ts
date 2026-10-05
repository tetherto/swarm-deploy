import b4a from 'b4a'
import { SemVer, compare } from 'semver'

export type VersionGranularity = 'major' | 'minor'

export interface ReleaseCoordinates {
  series: string
  version?: string
}

const PLACEHOLDER_SERIES = '{series}'
const PLACEHOLDER_VERSION = '{version}'

/** Protocol: artifact basenames are one safe path component, max 100 UTF-8 bytes (`+` disallowed). */
export const MAX_RELEASE_COMPONENT_BYTES = 100

const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** Immediate source parent: same 100-byte single-component rule; `+` allowed for SemVer build metadata. */
const SAFE_SOURCE_PARENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const SAFE_TEXT = '[A-Za-z0-9][A-Za-z0-9._-]{0,199}'

type SegmentMatcher =
  | { kind: 'regex'; regex: RegExp }
  | { kind: 'series-version-split'; prefix: string; suffix: string }

interface ParentMatcher {
  literal: string | null
  segment: SegmentMatcher | null
  hasVersion: boolean
}

interface CompiledPattern {
  fixedSeries: string | null
  versionInParent: boolean
  versionInBasename: boolean
  parent: ParentMatcher | null
  basename: SegmentMatcher
}

interface MatchGroups {
  series?: string
  version?: string
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function placeholderCount(template: string, placeholder: string): number {
  let count = 0
  let index = 0
  while ((index = template.indexOf(placeholder, index)) !== -1) {
    count++
    index += placeholder.length
  }
  return count
}

function assertPlaceholderLayout(template: string): void {
  if (
    template.includes(`${PLACEHOLDER_SERIES}${PLACEHOLDER_VERSION}`) ||
    template.includes(`${PLACEHOLDER_VERSION}${PLACEHOLDER_SERIES}`)
  ) {
    throw new Error('Invalid release template: adjacent placeholder')
  }
}

function componentByteLength(value: string): number {
  return b4a.from(value).byteLength
}

function isSafeArtifactName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    SAFE_ARTIFACT.test(value) &&
    componentByteLength(value) <= MAX_RELEASE_COMPONENT_BYTES
  )
}

function isSafeSourceParent(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    SAFE_SOURCE_PARENT.test(value) &&
    componentByteLength(value) <= MAX_RELEASE_COMPONENT_BYTES &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function isSafeSeriesCapture(value: string): boolean {
  return SAFE_ARTIFACT.test(value) && componentByteLength(value) <= MAX_RELEASE_COMPONENT_BYTES
}

function normalizeCapturedVersion(raw: string): string | undefined {
  if (raw.length === 0 || componentByteLength(raw) > MAX_RELEASE_COMPONENT_BYTES) {
    return undefined
  }
  if (raw.trim() !== raw) return undefined
  if (/^[vV]/.test(raw)) return undefined
  if (/[/\\]/.test(raw)) return undefined
  try {
    const parsed = new SemVer(raw, { loose: false })
    const core = raw.split('+', 1)[0]!
    if (core !== parsed.version) return undefined
    return parsed.version
  } catch {
    return undefined
  }
}

function parseReleaseVersion(raw: string): SemVer {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Invalid release version')
  }
  if (componentByteLength(raw) > MAX_RELEASE_COMPONENT_BYTES) {
    throw new Error('Invalid release version')
  }
  if (raw.trim() !== raw) {
    throw new Error('Invalid release version')
  }
  if (/^[vV]/.test(raw)) {
    throw new Error('Invalid release version')
  }
  try {
    const parsed = new SemVer(raw, { loose: false })
    const core = raw.split('+', 1)[0]!
    if (core !== parsed.version) {
      throw new Error('Invalid release version')
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid release version') throw error
    throw new Error('Invalid release version')
  }
}

function seriesVersionSplitParts(
  template: string
): { prefix: string; suffix: string } | null {
  const seriesAt = template.indexOf(PLACEHOLDER_SERIES)
  const versionAt = template.indexOf(PLACEHOLDER_VERSION)
  if (seriesAt === -1 || versionAt === -1 || seriesAt >= versionAt) return null
  const between = template.slice(seriesAt + PLACEHOLDER_SERIES.length, versionAt)
  if (between !== '-') return null
  return {
    prefix: template.slice(0, seriesAt),
    suffix: template.slice(versionAt + PLACEHOLDER_VERSION.length)
  }
}

function segmentRegex(template: string): { source: string; hasVersion: boolean } {
  const seriesCount = placeholderCount(template, PLACEHOLDER_SERIES)
  const versionCount = placeholderCount(template, PLACEHOLDER_VERSION)
  if (seriesCount > 1 || versionCount > 1) {
    throw new Error('Invalid release template: repeated placeholder')
  }

  let hasVersion = false
  let source = '^'
  let cursor = 0
  while (cursor < template.length) {
    const seriesAt = template.indexOf(PLACEHOLDER_SERIES, cursor)
    const versionAt = template.indexOf(PLACEHOLDER_VERSION, cursor)
    let next = -1
    let kind: 'series' | 'version' | null = null
    if (seriesAt !== -1 && (versionAt === -1 || seriesAt < versionAt)) {
      next = seriesAt
      kind = 'series'
    } else if (versionAt !== -1) {
      next = versionAt
      kind = 'version'
    }

    if (next === -1) {
      source += escapeRegexLiteral(template.slice(cursor))
      break
    }

    source += escapeRegexLiteral(template.slice(cursor, next))
    if (kind === 'series') {
      source += `(?<series>${SAFE_TEXT})`
      cursor = next + PLACEHOLDER_SERIES.length
    } else {
      source += `(?<version>[^/]+)`
      hasVersion = true
      cursor = next + PLACEHOLDER_VERSION.length
    }
  }
  source += '$'
  return { source, hasVersion }
}

function compileSegmentMatcher(template: string): {
  matcher: SegmentMatcher
  hasVersion: boolean
} {
  const split = seriesVersionSplitParts(template)
  if (split) {
    return { matcher: { kind: 'series-version-split', ...split }, hasVersion: true }
  }
  const compiled = segmentRegex(template)
  return { matcher: { kind: 'regex', regex: new RegExp(compiled.source) }, hasVersion: compiled.hasVersion }
}

function compileParentMatcher(parent: string): ParentMatcher {
  if (placeholderCount(parent, PLACEHOLDER_SERIES) === 0 && placeholderCount(parent, PLACEHOLDER_VERSION) === 0) {
    return { literal: parent, segment: null, hasVersion: false }
  }
  const compiled = compileSegmentMatcher(parent)
  return { literal: null, segment: compiled.matcher, hasVersion: compiled.hasVersion }
}

function compileTemplate(template: string): CompiledPattern {
  assertPlaceholderLayout(template)

  const seriesCount = placeholderCount(template, PLACEHOLDER_SERIES)
  const versionCount = placeholderCount(template, PLACEHOLDER_VERSION)
  if (seriesCount === 0 && versionCount === 0) {
    throw new Error('Invalid release template: missing placeholder')
  }
  if (seriesCount > 1 || versionCount > 1) {
    throw new Error('Invalid release template: repeated placeholder')
  }

  const segments = template.split('/')
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('Invalid release template: empty segment')
  }
  if (segments.length > 2) {
    throw new Error('Invalid release template: path separator outside parent boundary')
  }

  const fixedSeries = seriesCount === 0 ? template : null
  if (segments.length === 1) {
    const basename = compileSegmentMatcher(template)
    return {
      fixedSeries,
      versionInParent: false,
      versionInBasename: basename.hasVersion,
      parent: null,
      basename: basename.matcher
    }
  }

  const parentSegment = segments[0]!
  const basenameSegment = segments[1]!
  const parent = compileParentMatcher(parentSegment)
  const basename = compileSegmentMatcher(basenameSegment)
  return {
    fixedSeries,
    versionInParent: parent.hasVersion,
    versionInBasename: basename.hasVersion,
    parent,
    basename: basename.matcher
  }
}

function splitSeriesVersionStem(stem: string): MatchGroups | null {
  if (stem.length === 0 || componentByteLength(stem) > MAX_RELEASE_COMPONENT_BYTES) return null
  for (let index = stem.lastIndexOf('-'); index > 0; index = stem.lastIndexOf('-', index - 1)) {
    const series = stem.slice(0, index)
    const versionRaw = stem.slice(index + 1)
    if (!isSafeSeriesCapture(series)) continue
    const version = normalizeCapturedVersion(versionRaw)
    if (version) return { series, version }
  }
  return null
}

function matchSegment(matcher: SegmentMatcher, value: string): MatchGroups | null {
  if (matcher.kind === 'series-version-split') {
    if (!value.startsWith(matcher.prefix) || !value.endsWith(matcher.suffix)) return null
    const stem = value.slice(matcher.prefix.length, value.length - matcher.suffix.length)
    return splitSeriesVersionStem(stem)
  }

  const match = matcher.regex.exec(value)
  if (!match) return null
  const seriesCapture = match.groups?.series
  const versionCapture = match.groups?.version
  const groups: MatchGroups = {}
  if (typeof seriesCapture === 'string' && seriesCapture.length > 0) {
    if (!isSafeSeriesCapture(seriesCapture)) return null
    groups.series = seriesCapture
  }
  if (typeof versionCapture === 'string' && versionCapture.length > 0) {
    const version = normalizeCapturedVersion(versionCapture)
    if (version === undefined) return null
    groups.version = version
  }
  return groups
}

function matchParent(parent: ParentMatcher, value: string): MatchGroups | null {
  if (parent.literal !== null) {
    return parent.literal === value ? {} : null
  }
  return matchSegment(parent.segment!, value)
}

function matchCandidate(pattern: CompiledPattern, candidate: string): MatchGroups | null {
  if (pattern.parent === null) {
    return matchSegment(pattern.basename, candidate)
  }

  const slash = candidate.indexOf('/')
  if (slash === -1) return null
  const parentPart = candidate.slice(0, slash)
  const basePart = candidate.slice(slash + 1)
  if (!isSafeSourceParent(parentPart) || !isSafeArtifactName(basePart)) return null

  const parentGroups = matchParent(pattern.parent, parentPart)
  if (parentGroups === null) return null
  const basenameGroups = matchSegment(pattern.basename, basePart)
  if (basenameGroups === null) return null
  return { ...parentGroups, ...basenameGroups }
}

function coordinatesFromGroups(
  pattern: CompiledPattern,
  groups: MatchGroups,
  mode: 'basename' | 'full'
): ReleaseCoordinates | null {
  const series =
    pattern.fixedSeries ??
    (typeof groups.series === 'string' && groups.series.length > 0 ? groups.series : null)
  if (series === null) return null
  if (pattern.fixedSeries === null && !isSafeSeriesCapture(series)) return null

  const normalized = groups.version
  const requiresVersion =
    mode === 'basename'
      ? pattern.versionInBasename
      : pattern.versionInBasename || pattern.versionInParent
  if (requiresVersion && normalized === undefined) return null

  if (normalized !== undefined) {
    return { series, version: normalized }
  }
  return { series }
}

export class ReleaseMatcher {
  readonly #patterns: CompiledPattern[]

  constructor(patterns: Iterable<string>) {
    const seen = new Set<string>()
    const compiled: CompiledPattern[] = []
    for (const template of patterns) {
      if (typeof template !== 'string') {
        throw new Error('Invalid release template')
      }
      if (seen.has(template)) {
        throw new Error('Invalid release template: duplicate template')
      }
      seen.add(template)
      compiled.push(compileTemplate(template))
    }
    this.#patterns = compiled
  }

  get size(): number {
    return this.#patterns.length
  }

  get hasVersionPattern(): boolean {
    return this.#patterns.some(
      (pattern) => pattern.versionInBasename || pattern.versionInParent
    )
  }

  match(name: string, sourceParent?: string): ReleaseCoordinates | null {
    if (!isSafeArtifactName(name)) return null
    if (sourceParent !== undefined && !isSafeSourceParent(sourceParent)) return null

    for (const pattern of this.#patterns) {
      const literalParentOnly =
        pattern.parent !== null &&
        pattern.parent.literal !== null &&
        !pattern.versionInBasename

      if (pattern.versionInParent || literalParentOnly) {
        if (sourceParent === undefined) continue
        const groups = matchCandidate(pattern, `${sourceParent}/${name}`)
        if (groups) {
          const coords = coordinatesFromGroups(pattern, groups, 'full')
          if (coords) return coords
        }
        continue
      }

      const basenameGroups = matchSegment(pattern.basename, name)
      if (basenameGroups) {
        const coords = coordinatesFromGroups(pattern, basenameGroups, 'basename')
        if (coords) return coords
      }

      if (sourceParent !== undefined) {
        const groups = matchCandidate(pattern, `${sourceParent}/${name}`)
        if (groups) {
          const coords = coordinatesFromGroups(pattern, groups, 'full')
          if (coords) return coords
        }
      }
    }
    return null
  }
}

export function compareReleaseVersions(left: string, right: string): number {
  return compare(parseReleaseVersion(left), parseReleaseVersion(right))
}

export function releaseVersionGroup(version: string, granularity: VersionGranularity): string {
  if (granularity !== 'major' && granularity !== 'minor') {
    throw new Error('Invalid version granularity')
  }
  const parsed = parseReleaseVersion(version)
  if (granularity === 'major') return String(parsed.major)
  return `${parsed.major}.${parsed.minor}`
}
