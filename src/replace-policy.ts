import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from './errors.js'
import { isReservedHistoryName, validateBasename } from './files.js'
import { ReleaseMatcher } from './release.js'

/** The most selectors one policy may hold; a longer list is a typo or a generated mistake. */
export const MAX_REPLACE_SELECTORS = 64
const MAX_SELECTOR_BYTES = 256

/**
 * Which artifact names a server may replace, as an opt-in permission. It decides only whether a
 * name is eligible: replacement still needs a Swarm-managed current artifact whose content is
 * proven, whatever this allows, and a permission here never pins anything against retention.
 */
export interface ReplacePolicy {
  /** Every managed name is eligible, except the reserved history namespace. */
  readonly global: boolean
  /** The accepted selectors, in order; empty for the global policy and the disabled policy. */
  readonly selectors: readonly string[]
  /** Whether an upload named `name` may replace the managed artifact that holds it. */
  allows(name: string): boolean
}

function invalid(): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, 'Invalid allowReplace')
}

function hasPlaceholder(selector: string): boolean {
  return selector.includes('{') || selector.includes('}')
}

const OFF: ReplacePolicy = Object.freeze({
  global: false,
  selectors: Object.freeze([] as string[]),
  allows: () => false
})

// Even the global permission never reaches the reserved history namespace: a history copy is
// what a replacement leaves behind, not an artifact a later upload may replace.
const GLOBAL: ReplacePolicy = Object.freeze({
  global: true,
  selectors: Object.freeze([] as string[]),
  allows: (name: string) => typeof name === 'string' && !isReservedHistoryName(name)
})

/**
 * Validates and snapshots `allowReplace`.
 *
 * - `undefined`, `false` and an empty list disable replacement through this option.
 * - `true` allows every managed name except the reserved history namespace (`history-<ID>`).
 * - A list holds selectors. A selector without braces is one exact artifact name; a selector with
 *   `{series}` / `{version}` is a release template in the grammar of `artifactPatterns`, matched
 *   against the artifact's final basename only. A bare `{version}` therefore selects the names
 *   that are SemVer versions, not every name. A source-parent segment (`/`) is refused: the parent
 *   is asserted by the client and is not stored with the artifact, so a permission could not be
 *   judged again from what is on disk.
 *
 * Every problem raises the same fixed `PROTOCOL_INVALID` error, so a rejected value is never
 * echoed. The result shares nothing with the input.
 */
export function compileReplacePolicy(input: unknown): ReplacePolicy {
  if (input === undefined || input === false) return OFF
  if (input === true) return GLOBAL
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as Iterable<unknown>)[Symbol.iterator] !== 'function'
  ) {
    throw invalid()
  }
  const names = new Set<string>()
  const templates: string[] = []
  const selectors: string[] = []
  try {
    for (const selector of input as Iterable<unknown>) {
      if (selectors.length >= MAX_REPLACE_SELECTORS) throw invalid()
      if (
        typeof selector !== 'string' ||
        selector.length === 0 ||
        b4a.from(selector).byteLength > MAX_SELECTOR_BYTES ||
        selector.includes('/') ||
        selector.includes('\\') ||
        selector.includes('\0') ||
        isReservedHistoryName(selector) ||
        selectors.includes(selector)
      ) {
        throw invalid()
      }
      if (hasPlaceholder(selector)) {
        templates.push(selector)
      } else {
        validateBasename(selector)
        names.add(selector)
      }
      selectors.push(selector)
    }
  } catch {
    // A hostile iterable or a bad selector alike: one fixed error, nothing of the input in it.
    throw invalid()
  }
  if (selectors.length === 0) return OFF

  let matcher: ReleaseMatcher | null = null
  if (templates.length > 0) {
    try {
      matcher = new ReleaseMatcher(templates)
    } catch {
      throw invalid()
    }
  }
  const compiled = matcher
  return Object.freeze({
    global: false,
    selectors: Object.freeze(selectors.slice()),
    allows(name: string): boolean {
      if (typeof name !== 'string' || isReservedHistoryName(name)) return false
      if (names.has(name)) return true
      return compiled !== null && compiled.match(name) !== null
    }
  })
}

/** The public, immutable view of a policy: `false`, `true`, or the frozen selector list. */
export function describeReplacePolicy(policy: ReplacePolicy): boolean | readonly string[] {
  if (policy.global) return true
  return policy.selectors.length === 0 ? false : policy.selectors
}
