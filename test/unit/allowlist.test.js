'use strict'

const test = require('brittle')
const { parseAllowlist, AllowlistWatcher } = require('../../lib/allowlist')

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

test('parseAllowlist ignores blanks and comments', (t) => {
  t.alike(
    parseAllowlist(`\n# uploader keys\n${KEY_A}\n\n  # retained comment\n${KEY_B}\n`),
    new Set([KEY_A, KEY_B])
  )
})

test('parseAllowlist rejects noncanonical key lines', (t) => {
  for (const value of [`${KEY_A.toUpperCase()}`, 'a'.repeat(63), ` ${KEY_A}`, `${KEY_A} `]) {
    t.exception(() => parseAllowlist(value), {
      name: 'SwarmDeployError',
      code: 'INVALID_PUBLIC_KEY'
    })
  }
})

test('allowlist watcher applies a valid replacement atomically', async (t) => {
  let source = `${KEY_A}\n${KEY_B}\n`
  const applied = []
  const watcher = new AllowlistWatcher({
    filePath: 'allowed.txt',
    storage: { readFile: async () => source },
    onReload: async (keys) => applied.push(new Set(keys))
  })

  await watcher.poll()
  source = `${KEY_A}\ninvalid\n`
  await t.exception(() => watcher.poll(), { name: 'SwarmDeployError', code: 'INVALID_PUBLIC_KEY' })

  t.alike(watcher.keys, new Set([KEY_A, KEY_B]))
  t.alike(applied, [new Set([KEY_A, KEY_B])])
})

test('allowlist watcher emits each removed key once', async (t) => {
  let source = `${KEY_A}\n${KEY_B}\n`
  const watcher = new AllowlistWatcher({
    filePath: 'allowed.txt',
    storage: { readFile: async () => source },
    onReload: async () => {}
  })
  const removed = []
  watcher.on('removed', (key) => removed.push(key))

  await watcher.poll()
  source = `${KEY_A}\n`
  await watcher.poll()
  await watcher.poll()

  t.alike(removed, [KEY_B])
})
