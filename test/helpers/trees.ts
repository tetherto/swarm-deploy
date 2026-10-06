import fs from '#fs'
import path from '#path'

export interface TreeSpec {
  /** Relative POSIX paths. A trailing `/` creates an empty directory. */
  [relativePath: string]: string
}

/** Writes `spec` under `root`, creating parents, and returns `root`. */
export async function writeTree(root: string, spec: TreeSpec): Promise<string> {
  for (const relativePath of Object.keys(spec).sort()) {
    const target = path.join(root, ...relativePath.split('/').filter(Boolean))
    if (relativePath.endsWith('/')) {
      await fs.promises.mkdir(target, { recursive: true })
      continue
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(target, spec[relativePath])
  }
  return root
}
