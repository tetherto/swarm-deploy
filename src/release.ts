import b4a from 'b4a'
import { SemVer, compare } from 'semver'
import { validateBasename } from './files.js'
import { sodiumSha256 } from './tar-protocol/hash.js'

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
const FIXED_SERIES_PREFIX = 'fixed-'
/** The exact shape `fixedSeriesKey` produces; captures may not occupy it. */
const RESERVED_FIXED_SERIES = /^fixed-[0-9a-f]{64}$/

/**
 * The persisted series of a template that captures no `{series}`.
 *
 * The template text itself cannot be the key: braces and slashes fail the
 * commit-record basename rules, so every version-only pattern would reject at
 * commit time. Hashing gives a safe 70-byte basename that is stable across
 * restarts and identical on Node and Bare, and distinct templates that happen
 * to describe the same literals stay distinct releases.
 */
export function fixedSeriesKey(template: string): string {
  return `${FIXED_SERIES_PREFIX}${b4a.toString(sodiumSha256(b4a.from(template)), 'hex')}`
}

type TemplatePart = { kind: 'literal'; text: string } | { kind: 'series' } | { kind: 'version' }

interface SegmentPlan {
  parts: TemplatePart[]
}

interface ParentMatcher {
  literal: string | null
  plan: SegmentPlan | null
  hasVersion: boolean
}

interface CompiledPattern {
  fixedSeries: string | null
  versionInParent: boolean
  versionInBasename: boolean
  parent: ParentMatcher | null
  basename: SegmentPlan
}

interface MatchGroups {
  series?: string
  version?: string
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

/** Literal text is matched verbatim, so a stray brace is always a typo, not a literal. */
function assertNoResidualBraces(template: string): void {
  const literals = template.split(PLACEHOLDER_SERIES).join('').split(PLACEHOLDER_VERSION).join('')
  if (literals.includes('{') || literals.includes('}')) {
    throw new Error('Invalid release template: unexpected brace')
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

/**
 * A captured `{series}` may not take the shape of a derived fixed-series key,
 * so an upload cannot name itself into the rotation group of a version-only
 * pattern. The namespace is reserved rather than escaped: a collision is a
 * non-match, which fails closed as an unmatched offer.
 */
function isSafeSeriesCapture(value: string): boolean {
  return (
    SAFE_ARTIFACT.test(value) &&
    componentByteLength(value) <= MAX_RELEASE_COMPONENT_BYTES &&
    !RESERVED_FIXED_SERIES.test(value)
  )
}

function validateStrictReleaseVersion(raw: string): SemVer | undefined {
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
    return parsed
  } catch {
    return undefined
  }
}

function normalizeCapturedVersion(raw: string): string | undefined {
  return validateStrictReleaseVersion(raw)?.version
}

function parseReleaseVersion(raw: string): SemVer {
  const parsed = validateStrictReleaseVersion(raw)
  if (!parsed) throw new Error('Invalid release version')
  return parsed
}

function parseSegmentParts(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
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
      parts.push({ kind: 'literal', text: template.slice(cursor) })
      break
    }

    if (next > cursor) {
      parts.push({ kind: 'literal', text: template.slice(cursor, next) })
    }
    parts.push({ kind: kind! })
    cursor = next + (kind === 'series' ? PLACEHOLDER_SERIES.length : PLACEHOLDER_VERSION.length)
  }
  return parts
}

function compileSegmentPlan(template: string): {
  plan: SegmentPlan
  hasSeries: boolean
  hasVersion: boolean
} {
  const seriesCount = placeholderCount(template, PLACEHOLDER_SERIES)
  const versionCount = placeholderCount(template, PLACEHOLDER_VERSION)
  if (seriesCount > 1 || versionCount > 1) {
    throw new Error('Invalid release template: repeated placeholder')
  }
  const parts = parseSegmentParts(template)
  return {
    plan: { parts },
    hasSeries: seriesCount > 0,
    hasVersion: versionCount > 0
  }
}

function compileParentMatcher(parent: string): ParentMatcher {
  if (
    placeholderCount(parent, PLACEHOLDER_SERIES) === 0 &&
    placeholderCount(parent, PLACEHOLDER_VERSION) === 0
  ) {
    return { literal: parent, plan: null, hasVersion: false }
  }
  const compiled = compileSegmentPlan(parent)
  return { literal: null, plan: compiled.plan, hasVersion: compiled.hasVersion }
}

function compileTemplate(template: string): CompiledPattern {
  assertNoResidualBraces(template)
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

  const fixedSeries = seriesCount === 0 ? fixedSeriesKey(template) : null
  if (fixedSeries !== null) {
    try {
      validateBasename(fixedSeries)
    } catch (error) {
      throw new Error('Invalid release template: unusable fixed series key', { cause: error })
    }
  }
  if (segments.length === 1) {
    const basename = compileSegmentPlan(template)
    return {
      fixedSeries,
      versionInParent: false,
      versionInBasename: basename.hasVersion,
      parent: null,
      basename: basename.plan
    }
  }

  const parentSegment = segments[0]!
  const basenameSegment = segments[1]!
  const parent = compileParentMatcher(parentSegment)
  const basename = compileSegmentPlan(basenameSegment)
  return {
    fixedSeries,
    versionInParent: parent.hasVersion,
    versionInBasename: basename.hasVersion,
    parent,
    basename: basename.plan
  }
}

function assignPlaceholderPair(
  first: 'series' | 'version',
  second: 'series' | 'version',
  left: string,
  right: string
): MatchGroups | null {
  if (first === 'series' && second === 'version') {
    if (!isSafeSeriesCapture(left)) return null
    const version = normalizeCapturedVersion(right)
    return version ? { series: left, version } : null
  }
  if (first === 'version' && second === 'series') {
    const version = normalizeCapturedVersion(left)
    if (!version) return null
    if (!isSafeSeriesCapture(right)) return null
    return { series: right, version }
  }
  return null
}

function splitSeriesThenVersion(stem: string): MatchGroups | null {
  for (let index = stem.lastIndexOf('-'); index > 0; index = stem.lastIndexOf('-', index - 1)) {
    const groups = assignPlaceholderPair(
      'series',
      'version',
      stem.slice(0, index),
      stem.slice(index + 1)
    )
    if (groups) return groups
  }
  return null
}

function splitVersionThenSeries(stem: string): MatchGroups | null {
  for (let index = stem.indexOf('-'); index > 0; index = stem.indexOf('-', index + 1)) {
    const groups = assignPlaceholderPair(
      'version',
      'series',
      stem.slice(0, index),
      stem.slice(index + 1)
    )
    if (groups) return groups
  }
  return null
}

function tryLiteralSeparator(
  stem: string,
  separator: string,
  first: 'series' | 'version',
  second: 'series' | 'version'
): MatchGroups | null {
  if (separator.length === 0) return null
  let index = stem.indexOf(separator)
  while (index !== -1) {
    const left = stem.slice(0, index)
    const right = stem.slice(index + separator.length)
    const groups = assignPlaceholderPair(first, second, left, right)
    if (groups) return groups
    index = stem.indexOf(separator, index + 1)
  }
  return null
}

function matchStem(middle: TemplatePart[], stem: string): MatchGroups | null {
  if (middle.length === 1) {
    const part = middle[0]!
    if (part.kind === 'series') {
      return isSafeSeriesCapture(stem) ? { series: stem } : null
    }
    const version = normalizeCapturedVersion(stem)
    return version ? { version } : null
  }

  if (
    middle.length === 3 &&
    middle[0]!.kind !== 'literal' &&
    middle[1]!.kind === 'literal' &&
    middle[2]!.kind !== 'literal'
  ) {
    const first = middle[0]!.kind
    const separator = (middle[1] as { kind: 'literal'; text: string }).text
    const second = middle[2]!.kind
    if (first === 'series' && second === 'version' && separator === '-') {
      const split = splitSeriesThenVersion(stem)
      if (split) return split
    }
    if (first === 'version' && second === 'series' && separator === '-') {
      const split = splitVersionThenSeries(stem)
      if (split) return split
    }
    return tryLiteralSeparator(stem, separator, first, second)
  }

  return null
}

function matchSegmentPlan(plan: SegmentPlan, value: string): MatchGroups | null {
  const { parts } = plan
  if (parts.length === 0) return null

  let prefix = ''
  let start = 0
  while (start < parts.length && parts[start]!.kind === 'literal') {
    prefix += (parts[start] as { kind: 'literal'; text: string }).text
    start++
  }

  let suffix = ''
  let end = parts.length - 1
  while (end >= start && parts[end]!.kind === 'literal') {
    suffix = (parts[end] as { kind: 'literal'; text: string }).text + suffix
    end--
  }

  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null
  const stem = value.slice(prefix.length, value.length - suffix.length)
  if (componentByteLength(stem) > MAX_RELEASE_COMPONENT_BYTES) return null

  const middle = parts.slice(start, end + 1)
  if (middle.length === 0) {
    return stem.length === 0 ? {} : null
  }
  return matchStem(middle, stem)
}

function matchWithParent(
  pattern: CompiledPattern,
  sourceParent: string,
  name: string
): MatchGroups | null {
  if (!isSafeArtifactName(name)) return null

  let parentGroups: MatchGroups = {}
  const parent = pattern.parent!
  if (parent.literal !== null) {
    if (parent.literal !== sourceParent) return null
  } else {
    const matched = matchSegmentPlan(parent.plan!, sourceParent)
    if (matched === null) return null
    parentGroups = matched
  }

  const basenameGroups = matchSegmentPlan(pattern.basename, name)
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
    return this.#patterns.some((pattern) => pattern.versionInBasename || pattern.versionInParent)
  }

  match(name: string, sourceParent?: string): ReleaseCoordinates | null {
    if (!isSafeArtifactName(name)) return null
    if (sourceParent !== undefined && !isSafeSourceParent(sourceParent)) return null

    for (const pattern of this.#patterns) {
      if (pattern.parent !== null) {
        if (sourceParent === undefined) continue
        const groups = matchWithParent(pattern, sourceParent, name)
        if (groups) {
          const coords = coordinatesFromGroups(pattern, groups, 'full')
          if (coords) return coords
        }
        continue
      }

      const basenameGroups = matchSegmentPlan(pattern.basename, name)
      if (basenameGroups) {
        const coords = coordinatesFromGroups(pattern, basenameGroups, 'basename')
        if (coords) return coords
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
