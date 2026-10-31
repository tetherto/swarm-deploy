/// <reference path="../types/brittle.d.ts" />

import type { Assert } from 'brittle'
import fs from '#fs'
import path from '#path'

function systemTmpdir(): string {
  if (typeof Bare !== 'undefined') {
    return (require('bare-os') as typeof import('bare-os')).tmpdir()
  }
  return (require('os') as typeof import('node:os')).tmpdir()
}

/**
 * The isolated private state directory a test uses for a storage root: inside a sibling
 * container of it, never inside the root and never under the real home directory. It keeps
 * the `.swarm-deploy` basename so the name-based tree protections stay covered.
 * `createTempDir` removes the container together with the root.
 */
export function stateDirFor(root: string): string {
  return path.join(stateContainerFor(root), '.swarm-deploy')
}

function stateContainerFor(root: string): string {
  return `${root}.state`
}

export async function createTempDir(t?: Assert): Promise<string> {
  const root = await fs.promises.realpath(systemTmpdir())
  const dir = await fs.promises.mkdtemp(path.join(root, 'swarm-deploy-test-'))
  if (t) {
    t.teardown(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true })
      await fs.promises.rm(stateContainerFor(dir), { recursive: true, force: true })
    })
  }
  return dir
}
