import b4a from 'b4a'
import { ERRORS, SwarmDeployError } from './errors.js'
import { isReservedHistoryName, validateBasename } from './files.js'
import {
  commitRecordKind,
  compareCommitOrder,
  type CommitRecord
} from './storage/commit-journal.js'
import type { ArtifactKind } from './types.js'

export const MAX_SYMLINK_SELECTOR_BYTES = 200

export interface SymlinkRule {
  /** An exact managed artifact basename, or `/pattern/` with no flags. */
  selector: string
  /** The safe basename of the managed link, a sibling of its target. */
  name: string
}

export interface CompiledSymlinkRule {
  readonly selector: string
  readonly name: string
  /** The exact target basename, or `null` for a regular-expression selector. */
  readonly exact: string | null
  matches(name: string): boolean
}

export interface DesiredLink {
  name: string
  /** Always exactly the selected record's basename. */
  target: string
  transferId: string
  targetKind: ArtifactKind
}

function invalid(message: string, cause: unknown = null): SwarmDeployError {
  return new SwarmDeployError(ERRORS.PROTOCOL_INVALID, message, cause)
}

function assertLinkName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Invalid symlink name')
  }
  const name = validateBasename(value)
  if (isReservedHistoryName(name)) {
    throw new SwarmDeployError(ERRORS.INVALID_FILENAME, 'Reserved symlink name')
  }
  return name
}

/**
 * Validates and snapshots operator symlink rules. The regex source is bounded,
 * has no flags, and runs only against validated 100-byte artifact basenames; it
 * is trusted operator configuration, and an invalid one is a startup error.
 */
export function compileSymlinkRules(
  rules: Iterable<SymlinkRule> | null | undefined
): readonly CompiledSymlinkRule[] {
  if (rules === null || rules === undefined) return Object.freeze([])
  if (
    typeof rules === 'string' ||
    typeof rules !== 'object' ||
    typeof (rules as Iterable<SymlinkRule>)[Symbol.iterator] !== 'function'
  ) {
    throw invalid('Invalid symlink rules')
  }
  const compiled: CompiledSymlinkRule[] = []
  const names = new Set<string>()
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw invalid('Invalid symlink rule')
    }
    const keys = Object.keys(rule).sort()
    if (keys.length !== 2 || keys[0] !== 'name' || keys[1] !== 'selector') {
      throw invalid('Invalid symlink rule')
    }
    const { selector, name: rawName } = rule
    const name = assertLinkName(rawName)
    if (names.has(name)) throw invalid('Duplicate symlink name')
    names.add(name)
    if (typeof selector !== 'string' || selector.length === 0) {
      throw invalid('Invalid symlink selector')
    }
    if (b4a.from(selector).byteLength > MAX_SYMLINK_SELECTOR_BYTES) {
      throw invalid('Invalid symlink selector')
    }
    if (selector.length >= 2 && selector.startsWith('/') && selector.endsWith('/')) {
      const source = selector.slice(1, -1)
      if (source.length === 0) throw invalid('Invalid symlink selector')
      let pattern: RegExp
      try {
        pattern = new RegExp(source)
      } catch (error: unknown) {
        throw invalid('Invalid symlink selector', error)
      }
      compiled.push(
        Object.freeze({
          selector,
          name,
          exact: null,
          matches: (candidate: string): boolean => pattern.test(candidate)
        })
      )
      continue
    }
    const exact = validateBasename(selector)
    if (isReservedHistoryName(exact)) throw invalid('Reserved symlink selector')
    if (exact === name) throw invalid('Symlink selector equals its own name')
    compiled.push(
      Object.freeze({
        selector,
        name,
        exact,
        matches: (candidate: string): boolean => candidate === exact
      })
    )
  }
  return Object.freeze(compiled)
}

export function symlinkRuleNames(rules: readonly CompiledSymlinkRule[]): ReadonlySet<string> {
  return new Set(rules.map((rule) => rule.name))
}

/**
 * Computes the desired links from validated commit records only. A rule with no
 * match is dormant. Replacement history names never match, and a candidate
 * whose name equals its own link name is skipped.
 */
export function selectDesiredLinks(
  rules: readonly CompiledSymlinkRule[],
  records: readonly CommitRecord[]
): DesiredLink[] {
  const desired: DesiredLink[] = []
  for (const rule of rules) {
    let selected: CommitRecord | null = null
    for (const record of records) {
      if (isReservedHistoryName(record.name)) continue
      if (record.name === rule.name) continue
      if (!rule.matches(record.name)) continue
      if (selected === null || compareCommitOrder(record, selected) < 0) selected = record
    }
    if (selected === null) continue
    desired.push({
      name: rule.name,
      target: selected.name,
      transferId: selected.transferId,
      targetKind: commitRecordKind(selected)
    })
  }
  return desired
}
