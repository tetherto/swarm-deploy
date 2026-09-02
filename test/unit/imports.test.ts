import test from 'brittle'
import * as api from '../../dist/index.js'

test('compiled package import maps resolve from package scope', (t) => {
  t.is(typeof api.Server, 'function')
  t.is(typeof require('#crypto').createHash, 'function')
})
