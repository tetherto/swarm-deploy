import path from '#path'
import { Server as DeployServer, type ServerOptions } from '../../dist/index.js'
import { stateDirFor } from './files.js'

function withFixtureState(options: ServerOptions): ServerOptions {
  if (!options || typeof options !== 'object') return options
  const next = { ...options }
  if (next.initializeState === undefined) next.initializeState = true
  if (
    next.stateDir === undefined &&
    typeof next.storageDir === 'string' &&
    next.storageDir.length > 0
  ) {
    next.stateDir = stateDirFor(path.resolve(next.storageDir))
  }
  return next
}

/**
 * A `Server` whose private state defaults to the isolated sibling directory of its storage
 * root, so no test writes under the real home directory. An explicit `stateDir` still wins.
 * Fixtures often start state for a root that already holds files, so initialization is
 * acknowledged by default; the tests of that guard pass `initializeState: false`.
 */
export class Server extends DeployServer {
  constructor(options: ServerOptions) {
    super(withFixtureState(options))
  }
}
