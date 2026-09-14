/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import fs from '#fs'
import path from '#path'
import { main } from '../../dist/cli.js'
import { parseAllowlist } from '../../dist/allowlist.js'
import { keyPairFromSeed } from '../../dist/identity.js'
import type { ClientOptions, ServerOptions } from '../../dist/index.js'
import { createTempDir } from '../helpers/files.js'

const CLIENT_SEED = b4a.alloc(32, 71)
const SERVER_SEED = b4a.alloc(32, 72)
const CLIENT_KEY = keyPairFromSeed(CLIENT_SEED).publicKey
const SERVER_KEY = keyPairFromSeed(SERVER_SEED).publicKey

function output() {
  let text = ''
  return {
    stream: {
      write(value: string) {
        text += value
      }
    },
    text: () => text
  }
}

test('allowlist parsing rejects duplicate canonical keys', (t) => {
  const key = b4a.toString(CLIENT_KEY, 'hex')
  let failure: unknown = null
  try {
    parseAllowlist(`${key}\n${key}\n`)
  } catch (error) {
    failure = error
  }
  t.is((failure as Error | null)?.message, 'Duplicate allowlist key')
})

test('CLI passes --server-key only to the direct client', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'client.seed')
  const artifact = path.join(root, 'artifact.txt')
  await fs.promises.writeFile(seedPath, `${b4a.toString(CLIENT_SEED, 'hex')}\n`, { mode: 0o600 })
  await fs.promises.writeFile(artifact, 'small direct upload')

  let options: ClientOptions | null = null
  class Client {
    constructor(value: ClientOptions) {
      options = value
    }
    upload() {
      return Promise.resolve({
        status: 'COMMITTED' as const,
        name: 'artifact.txt',
        size: 19,
        digest: b4a.alloc(32),
        transferId: b4a.alloc(32)
      })
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  const stderr = output()
  t.is(
    await main(
      [
        'upload',
        '--seed-file',
        seedPath,
        '--server-key',
        b4a.toString(SERVER_KEY, 'hex'),
        artifact
      ],
      {},
      {
        Client: Client as unknown as new (
          options: ClientOptions
        ) => import('../../dist/client.js').Client,
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    ),
    0
  )
  const clientOptions = options as unknown as ClientOptions
  t.alike(clientOptions.serverPublicKey, SERVER_KEY)
  t.absent('topic' in clientOptions)
  t.is(stdout.text(), 'artifact.txt COMMITTED\n')
  t.is(stderr.text(), '')
})

test('CLI snapshots repeatable --allow-key values for the direct server', async (t) => {
  const root = await createTempDir(t)
  const seedPath = path.join(root, 'server.seed')
  await fs.promises.writeFile(seedPath, `${b4a.toString(SERVER_SEED, 'hex')}\n`, { mode: 0o600 })

  let options: ServerOptions | null = null
  let stop: (() => void) | null = null
  class Server {
    publicKey = SERVER_KEY
    constructor(value: ServerOptions) {
      options = value
    }
    listen() {
      queueMicrotask(() => stop?.())
      return Promise.resolve(this)
    }
    close() {
      return Promise.resolve()
    }
  }
  const stdout = output()
  const stderr = output()
  const signals = {
    on(_signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
      stop = listener
    },
    off() {}
  }
  t.is(
    await main(
      [
        'server',
        '--seed-file',
        seedPath,
        '--storage',
        root,
        '--allow-key',
        b4a.toString(CLIENT_KEY, 'hex'),
        '--max-file-bytes',
        '1024',
        '--max-staging-bytes',
        '4096'
      ],
      {},
      {
        Server: Server as unknown as new (
          options: ServerOptions
        ) => import('../../dist/server.js').Server,
        process: signals,
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    ),
    0
  )
  const serverOptions = options as unknown as ServerOptions
  t.alike([...serverOptions.allowedKeys], [CLIENT_KEY])
  t.is(stdout.text(), `${b4a.toString(SERVER_KEY, 'hex')}\nready\n`)
  t.is(stderr.text(), '')
})
