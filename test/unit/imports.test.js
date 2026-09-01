'use strict'

const test = require('brittle')

test('package import maps resolve from package scope', (t) => {
  const imports = require('../helpers/import-probe')
  t.ok(typeof imports.crypto.createHash === 'function')
  t.ok(typeof imports.events.EventEmitter === 'function')
  t.ok(typeof imports.fs.readFile === 'function')
  t.ok(typeof imports.path.join === 'function')
})
