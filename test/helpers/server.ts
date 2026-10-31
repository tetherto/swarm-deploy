import path from '#path'
import { Server as DeployServer, type ServerOptions } from '../../dist/index.js'
import { stateDirFor } from './files.js'

/**
 * A `Server` whose private state defaults to the isolated sibling directory of its storage
 * root, so no test writes under the real home directory. An explicit `stateDir` still wins.
 */
export class Server extends DeployServer {
  constructor(options: ServerOptions) {
    super(
      options &&
        typeof options.storageDir === 'string' &&
        options.storageDir.length > 0 &&
        options.stateDir === undefined
        ? { ...options, stateDir: stateDirFor(path.resolve(options.storageDir)) }
        : options
    )
  }
}
