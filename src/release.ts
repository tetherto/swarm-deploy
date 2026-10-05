import { SemVer, compare } from 'semver'

export type VersionGranularity = 'major' | 'minor'

export interface ReleaseCoordinates {
  series: string
  version?: string
}

const PLACEHOLDER_SERIES = '{series}'
const PLACEHOLDER_VERSION = '{version}'
const SAFE_TEXT = '[A-Za-z0-9][A-Za-z0-9._-]{0,199}'
const NON_SEPARATOR = '[^/]+'

interface CompiledPattern {
  fixedSeries: string | null
  versionInParent: boolean
  versionInBasename: boolean
  basename: RegExp
  full: RegExp | null
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
      const afterSeries = template.slice(next + PLACEHOLDER_SERIES.length)
      const beforeVersion =
        afterSeries.startsWith('-') && afterSeries.includes(PLACEHOLDER_VERSION)
      source += beforeVersion
        ? `(?<series>[A-Za-z0-9][A-Za-z0-9._-]*?)`
        : `(?<series>${SAFE_TEXT})`
      cursor = next + PLACEHOLDER_SERIES.length
    } else {
      source += `(?<version>${NON_SEPARATOR})`
      hasVersion = true
      cursor = next + PLACEHOLDER_VERSION.length
    }
  }
  source += '$'
  return { source, hasVersion }
}

function compileTemplate(template: string): CompiledPattern {
  const seriesCount = placeholderCount(template, PLACEHOLDER_SERIES)
  const versionCount = placeholderCount(template, PLACEHOLDER_VERSION)
  if (seriesCount === 0 && versionCount === 0) {
    throw new Error('Invalid release template: missing placeholder')
  }
  if (seriesCount > 1 || versionCount > 1) {
    throw new Error('Invalid release template: repeated placeholder')
  }

  const segments = template.split('/')
  if (segments.length > 2) {
    throw new Error('Invalid release template: path separator outside parent boundary')
  }

  const fixedSeries = seriesCount === 0 ? template : null
  if (segments.length === 1) {
    const compiled = segmentRegex(template)
    return {
      fixedSeries,
      versionInParent: false,
      versionInBasename: compiled.hasVersion,
      basename: new RegExp(compiled.source),
      full: null
    }
  }

  const parent = segments[0]!
  const basename = segments[1]!
  const parentCompiled = segmentRegex(parent)
  const basenameCompiled = segmentRegex(basename)
  return {
    fixedSeries,
    versionInParent: parentCompiled.hasVersion,
    versionInBasename: basenameCompiled.hasVersion,
    basename: new RegExp(basenameCompiled.source),
    full: new RegExp(`${parentCompiled.source.slice(0, -1)}/${basenameCompiled.source.slice(1)}`)
  }
}

function normalizeVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0) return undefined
  try {
    return new SemVer(value, { loose: false }).version
  } catch {
    return undefined
  }
}

function coordinatesFromMatch(
  pattern: CompiledPattern,
  match: RegExpMatchArray,
  mode: 'basename' | 'full'
): ReleaseCoordinates | null {
  const seriesCapture = match.groups?.series
  const series =
    pattern.fixedSeries ??
    (typeof seriesCapture === 'string' && seriesCapture.length > 0 ? seriesCapture : null)
  if (series === null) return null

  const versionCapture = match.groups?.version
  const normalized = normalizeVersion(versionCapture)
  if (versionCapture !== undefined && versionCapture.length > 0 && normalized === undefined) {
    return null
  }

  const requiresVersion =
    mode === 'basename' ? pattern.versionInBasename : pattern.versionInBasename || pattern.versionInParent
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
    for (const pattern of this.#patterns) {
      const tryBasename = !(sourceParent !== undefined && pattern.versionInParent)
      if (tryBasename) {
        const basenameMatch = pattern.basename.exec(name)
        if (basenameMatch) {
          const coords = coordinatesFromMatch(pattern, basenameMatch, 'basename')
          if (coords) return coords
        }
      }

      if (sourceParent !== undefined) {
        const candidate = `${sourceParent}/${name}`
        const regex = pattern.full ?? pattern.basename
        const fullMatch = regex.exec(candidate)
        if (fullMatch) {
          const coords = coordinatesFromMatch(pattern, fullMatch, 'full')
          if (coords) return coords
        }
      }
    }
    return null
  }
}

export function compareReleaseVersions(left: string, right: string): number {
  return compare(new SemVer(left, { loose: false }), new SemVer(right, { loose: false }))
}

export function releaseVersionGroup(version: string, granularity: VersionGranularity): string {
  const parsed = new SemVer(version, { loose: false })
  if (granularity === 'major') return String(parsed.major)
  return `${parsed.major}.${parsed.minor}`
}
