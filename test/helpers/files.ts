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

export async function createTempDir(t?: Assert): Promise<string> {
  const root = await fs.promises.realpath(systemTmpdir())
  const dir = await fs.promises.mkdtemp(path.join(root, 'swarm-deploy-test-'))
  if (t) t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}
