import { parsePublicKey } from './identity.js'

/** Parses immutable, canonical client public keys for server startup. */
export function parseAllowlist(text: string): Set<string> {
  if (typeof text !== 'string') throw new TypeError('Allowlist must be text')
  const keys = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const key = line.trim()
    if (key === '' || key.startsWith('#')) continue
    parsePublicKey(key)
    if (keys.has(key)) throw new TypeError('Duplicate allowlist key')
    keys.add(key)
  }
  return keys
}
