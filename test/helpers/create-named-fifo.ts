import fs from '#fs'
import path from '#path'
import process from '#process'

/** Installs a hard-linked FIFO member named `pipe` under `root`, when supported. */
export async function installFifoTreeMember(root: string): Promise<boolean> {
  const target = path.join(root, 'pipe')
  const external = process.env.SWARM_DEPLOY_TEST_FIFO
  if (external) {
    await fs.promises.link(external, target)
    return (await fs.promises.lstat(target)).isFIFO()
  }
  if ('Bare' in globalThis) return false
  const { execFileSync } = require('node:child_process') as {
    execFileSync: (command: string, args: string[]) => void
  }
  execFileSync('mkfifo', [target])
  return (await fs.promises.lstat(target)).isFIFO()
}
