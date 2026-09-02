#!/usr/bin/env node
'use strict'

const process = require('#process')
const { main } = require('../../lib/cli.js')

function reportFatal(err: unknown) {
  try {
    const message =
      err &&
      typeof err === 'object' &&
      'message' in err &&
      typeof err.message === 'string' &&
      err.message
        ? err.message
        : 'Unknown error'
    if (process.stderr && typeof process.stderr.write === 'function') {
      process.stderr.write(message.endsWith('\n') ? message : `${message}\n`)
    }
  } catch {}
}

function exitWith(code: unknown) {
  process.exitCode = Number.isInteger(code) ? (code as number) : 1
}

main(process.argv, process.env, { process }).then(exitWith, (err: unknown) => {
  reportFatal(err)
  exitWith(1)
})

if (typeof process.on === 'function') {
  process.on('uncaughtException', (err: unknown) => {
    reportFatal(err)
    process.exit(1)
  })
  process.on('unhandledRejection', (err: unknown) => {
    reportFatal(err)
    process.exit(1)
  })
}
