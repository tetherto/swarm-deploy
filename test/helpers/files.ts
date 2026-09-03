/// <reference path="../types/brittle.d.ts" />

import type { Assert } from 'brittle'
import crypto from '#crypto'
import fs from '#fs'
import path from '#path'
import type { Digest } from '../../dist/types.js'

export const CHUNK_SIZE = 1024 * 1024

export interface ExpectedManifest {
  size: number
  digest: Digest
  chunkDigests: Digest[]
  chunkCount: number
  chunkSize: number
}

function systemTmpdir(): string {
  if (typeof Bare !== 'undefined') {
    return (require('bare-os') as typeof import('bare-os')).tmpdir()
  }
  return (require('os') as typeof import('node:os')).tmpdir()
}

export async function createTempDir(t?: Assert): Promise<string> {
  const root = await fs.promises.realpath(systemTmpdir())
  const dir = path.join(
    root,
    `swarm-deploy-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  await fs.promises.mkdir(dir, { recursive: true })
  if (t) t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}

export function deterministicByte(index: number): number {
  return index & 0xff
}

export function digestBuffer(data: Uint8Array): Digest {
  return crypto.createHash('sha256').update(data).digest()
}

export function expectedManifest(size: number, chunkSize = CHUNK_SIZE): ExpectedManifest {
  const whole = crypto.createHash('sha256')
  const chunkDigests: Digest[] = []
  let offset = 0

  while (offset < size) {
    const end = Math.min(offset + chunkSize, size)
    const chunk = Buffer.allocUnsafe(end - offset)
    for (let i = offset; i < end; i++) {
      chunk[i - offset] = deterministicByte(i)
    }
    whole.update(chunk)
    chunkDigests.push(digestBuffer(chunk))
    offset = end
  }

  return {
    size,
    digest: whole.digest(),
    chunkDigests,
    chunkCount: chunkDigests.length,
    chunkSize
  }
}

export async function writeDeterministicFile(filePath: string, size: number): Promise<void> {
  const fd = await fs.promises.open(filePath, 'w')
  try {
    const chunkLen = 64 * 1024
    let offset = 0
    while (offset < size) {
      const end = Math.min(offset + chunkLen, size)
      const chunk = Buffer.allocUnsafe(end - offset)
      for (let i = offset; i < end; i++) {
        chunk[i - offset] = deterministicByte(i)
      }
      await fd.write(chunk, 0, chunk.byteLength)
      offset = end
    }
  } finally {
    await fd.close()
  }
}
