/// <reference path="../types/brittle.d.ts" />

import test from 'brittle'
import * as api from '../../dist/index.js'

declare const require: (id: string) => unknown

test('compiled package import maps resolve from package scope', (t) => {
  t.is(typeof api.Server, 'function')
  t.is(typeof api.Client, 'function')
  t.is(typeof (require('#crypto') as { createHash: unknown }).createHash, 'function')
  t.is(typeof (require('#events') as { EventEmitter: unknown }).EventEmitter, 'function')
  t.is(typeof (require('#fs') as { readFile: unknown }).readFile, 'function')
  t.is(typeof (require('#os') as { platform: unknown }).platform, 'function')
  t.is(typeof (require('#path') as { join: unknown }).join, 'function')
  t.is(typeof (require('#process') as { env: unknown }).env, 'object')
})
