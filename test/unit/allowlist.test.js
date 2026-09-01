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

test('allowlist watcher emits fingerprint-only removal events', async (t) => {
  let source = `${KEY_A}\n${KEY_B}\n`
  const watcher = new AllowlistWatcher({
    filePath: 'allowed.txt',
    storage: { readFile: async () => source },
    onReload: async () => {}
  })
  const removed = []
  watcher.on('removed', (details) => removed.push(details))

  await watcher.poll()
  source = `${KEY_A}\n`
  await watcher.poll()
  await watcher.poll()

  t.alike(removed, [{ removed: 1 }])
})

test('allowlist watcher retries unchanged applied cleanup failures', async (t) => {
  let attempts = 0
  const watcher = new AllowlistWatcher({
    filePath: 'allowed.txt',
    storage: { readFile: async () => `${KEY_A}\n` },
    onReload: async () => {
      if (++attempts === 1) {
        const error = new AggregateError([new Error('cleanup failed')])
        error.allowlistApplied = true
        throw error
      }
    }
  })

  await t.exception(() => watcher.poll(), { name: 'AggregateError' })
  t.alike(watcher.keys, new Set([KEY_A]))
  await watcher.poll()
  t.is(attempts, 2)
})

test('live poll failures are contained, retain snapshot, and recover on next valid file', async (t) => {
  let source = `${KEY_A}\n`
  let readError = null
  let timer = null
  const applied = []
  const failures = []
  const emitted = []
  const watcher = new AllowlistWatcher({
    filePath: 'secret-customer-allowlist.txt',
    storage: {
      readFile: () => {
        if (readError) throw readError
        return source
      }
    },
    onReload: (keys) => applied.push(new Set(keys)),
    onFailure(details) {
      failures.push(details)
      throw new Error('throwing failure callback')
    },
    scheduler: {
      setInterval(callback) {
        timer = { callback, unref() {} }
        return timer
      },
      clearInterval() {}
    },
    logger: {
      warn() {
        throw new Error('throwing logger')
      }
    }
  })
  watcher.on('failure', (details) => emitted.push(details))
  watcher.on('failure', () => {
    throw new Error('throwing failure listener')
  })

  await watcher.load()
  watcher.startPolling()
  source = `${KEY_A}\nPRIVATE-CONTENT\n`
  const invalidPoll = timer.callback()
  t.ok(invalidPoll && typeof invalidPoll.then === 'function')
  await invalidPoll
  t.alike(watcher.keys, new Set([KEY_A]))

  readError = new Error('cannot read /private/customer/secret-customer-allowlist.txt')
  readError.code = 'EACCES'
  await timer.callback()
  t.alike(watcher.keys, new Set([KEY_A]))

  readError = new Error('symbolic allowlist rejected by no-follow safety')
  readError.code = 'ELOOP'
  await timer.callback()
  t.alike(watcher.keys, new Set([KEY_A]))

  readError = null
  source = `${KEY_B}\n`
  await timer.callback()
  t.alike(watcher.keys, new Set([KEY_B]))
  t.alike(applied, [new Set([KEY_A]), new Set([KEY_B])])
  t.alike(failures, [{ reason: 'INVALID_PUBLIC_KEY' }, { reason: 'EACCES' }, { reason: 'ELOOP' }])
  t.alike(emitted, failures)
  const serialized = JSON.stringify({ failures, emitted })
  t.absent(serialized.includes('secret-customer-allowlist'))
  t.absent(serialized.includes('PRIVATE-CONTENT'))
  await watcher.close()
})
