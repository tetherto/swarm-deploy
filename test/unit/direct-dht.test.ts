/// <reference path="../types/brittle.d.ts" />
/// <reference path="../types/third-party.d.ts" />

import test from 'brittle'
import b4a from 'b4a'
import DHT from 'hyperdht'
import { createAbortController } from '../../dist/abort.js'
import {
  DirectDhtClient,
  DirectDhtServer,
  type DirectDhtNode,
  type DirectDhtSocket
} from '../../dist/direct-dht.js'
import { Client, ERRORS, generateSeed, keyPairFromSeed, Server } from '../../dist/index.js'
import { createLocalTestnet, waitFor } from '../helpers/testnet.js'

const SERVER_SEED = b4a.alloc(32, 41)
const OTHER_SERVER_SEED = b4a.alloc(32, 42)
const CLIENT_A_SEED = b4a.alloc(32, 43)
const CLIENT_B_SEED = b4a.alloc(32, 44)
const UNKNOWN_SEED = b4a.alloc(32, 45)

test('public Client and Server use direct server-key configuration', (t) => {
  const server = new Server({
    seed: SERVER_SEED,
    storageDir: '/temporary/direct-dht-configuration',
    allowedKeys: [keyPairFromSeed(CLIENT_A_SEED).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096
  })
  const client = new Client({
    seed: CLIENT_A_SEED,
    serverPublicKey: server.publicKey
  } as unknown as ConstructorParameters<typeof Client>[0])
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  t.alike(client.serverPublicKey, server.publicKey)
  t.absent('topic' in client)
  t.absent('topic' in server)
})

test('runtime identities accept canonical seed strings', (t) => {
  const serverSeed = b4a.toString(SERVER_SEED, 'hex')
  const clientSeed = b4a.toString(CLIENT_A_SEED, 'hex')
  const server = new Server({
    seed: serverSeed,
    storageDir: '/temporary/direct-dht-string-seed',
    allowedKeys: [keyPairFromSeed(CLIENT_A_SEED).publicKey],
    maxFileBytes: 1024,
    maxStagingBytes: 4096
  })
  const client = new Client({
    seed: clientSeed,
    serverPublicKey: server.publicKey
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  t.alike(server.publicKey, keyPairFromSeed(SERVER_SEED).publicKey)
  t.alike(client.publicKey, keyPairFromSeed(CLIENT_A_SEED).publicKey)
  t.alike(keyPairFromSeed(serverSeed).publicKey, server.publicKey)
  t.exception(() => keyPairFromSeed('AB'.repeat(32)), { code: ERRORS.INVALID_SEED })
  t.exception(() => keyPairFromSeed('not-a-seed'), { code: ERRORS.INVALID_SEED })
})

function inertSocket(remotePublicKey: Buffer, opened: Promise<boolean>): DirectDhtSocket {
  let destroyed = false
  const errorListeners: Array<(error: Error) => void> = []
  const closeListeners: Array<() => void> = []
  return {
    opened,
    remotePublicKey,
    get destroyed() {
      return destroyed
    },
    on(event, listener) {
      if (event === 'error') errorListeners.push(listener)
      return this
    },
    once(event, listener) {
      if (event === 'close') closeListeners.push(listener)
      return this
    },
    destroy(error) {
      if (destroyed) return
      destroyed = true
      if (error instanceof Error) {
        for (const listener of errorListeners) listener(error)
      }
      for (const listener of closeListeners) listener()
    }
  }
}

function clientNode(socket: DirectDhtSocket, destroyed: boolean[] = []): DirectDhtNode {
  return {
    destroyed: false,
    createServer() {
      throw new Error('Unexpected server creation')
    },
    connect() {
      return socket
    },
    on() {
      return this
    },
    destroy() {
      this.destroyed = true
      destroyed.push(true)
      return Promise.resolve()
    }
  }
}

test('direct identities are deterministic and HyperDHT-compatible', (t) => {
  const seed = b4a.alloc(32, 19)
  const direct = keyPairFromSeed(seed)
  const hyperdht = DHT.keyPair(seed)

  t.is(generateSeed().byteLength, 32)
  t.is(direct.publicKey.byteLength, 32)
  t.is(direct.secretKey.byteLength, 64)
  t.alike(direct, keyPairFromSeed(seed))
  t.alike(direct, hyperdht)
})

test('direct transport allows an authenticated client', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverKeyPair = keyPairFromSeed(SERVER_SEED)
  const clientKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const accepted: DirectDhtSocket[] = []
  const server = new DirectDhtServer({
    keyPair: serverKeyPair,
    allowedClientPublicKeys: [clientKeyPair.publicKey],
    dht: testnet.createNode(),
    onConnection(socket) {
      accepted.push(socket)
    }
  })
  const client = new DirectDhtClient({
    keyPair: clientKeyPair,
    dht: testnet.createNode(),
    connectTimeout: 5_000
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  const socket = await client.connect(server.publicKey)
  await waitFor(() => accepted.length === 1)

  t.alike(server.publicKey, serverKeyPair.publicKey)
  t.alike(socket.remotePublicKey, serverKeyPair.publicKey)
})

test('direct firewall rejects unknown clients before the handler', async (t) => {
  const testnet = await createLocalTestnet(t)
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [keyPairFromSeed(CLIENT_A_SEED).publicKey],
    dht: testnet.createNode(),
    onConnection() {
      t.fail('firewalled connection reached handler')
    }
  })
  const unknown = new DirectDhtClient({
    keyPair: keyPairFromSeed(UNKNOWN_SEED),
    dht: testnet.createNode(),
    connectTimeout: 5_000
  })
  t.teardown(() => Promise.allSettled([unknown.close(), server.close()]))

  await server.listen()
  await t.exception(unknown.connect(server.publicKey))
})

test('direct server rechecks authenticated identity before its callback', (t) => {
  let acceptConnection: ((socket: DirectDhtSocket) => void) | undefined
  const handle = {
    publicKey: null,
    closed: false,
    on() {
      return this
    },
    listen() {
      return Promise.resolve(this)
    },
    close() {
      this.closed = true
      return Promise.resolve()
    }
  }
  const node: DirectDhtNode = {
    destroyed: false,
    createServer(options, handler) {
      t.is(options.firewall(keyPairFromSeed(UNKNOWN_SEED).publicKey), true)
      acceptConnection = handler
      return handle
    },
    connect() {
      throw new Error('Unexpected client connection')
    },
    on() {
      return this
    },
    destroy() {
      this.destroyed = true
      return Promise.resolve()
    }
  }
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [keyPairFromSeed(CLIENT_A_SEED).publicKey],
    dht: node,
    onConnection() {
      t.fail('unlisted authenticated identity reached callback')
    }
  })
  t.teardown(() => server.close())
  const socket = inertSocket(keyPairFromSeed(UNKNOWN_SEED).publicKey, Promise.resolve(true))

  if (!acceptConnection) throw new Error('Server did not register a connection handler')
  acceptConnection(socket)
  t.is(socket.destroyed, true)
})

test('direct client fails when the committed server key is wrong', async (t) => {
  const testnet = await createLocalTestnet(t)
  const clientKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [clientKeyPair.publicKey],
    dht: testnet.createNode()
  })
  const client = new DirectDhtClient({
    keyPair: clientKeyPair,
    dht: testnet.createNode(),
    connectTimeout: 5_000
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  await t.exception(client.connect(keyPairFromSeed(OTHER_SERVER_SEED).publicKey))
})

test('direct client validates the post-open remote public key', async (t) => {
  const expected = keyPairFromSeed(SERVER_SEED).publicKey
  const socket = inertSocket(keyPairFromSeed(OTHER_SERVER_SEED).publicKey, Promise.resolve(true))
  const client = new DirectDhtClient({
    keyPair: keyPairFromSeed(CLIENT_A_SEED),
    dht: clientNode(socket)
  })
  t.teardown(() => client.close())

  await t.exception(client.connect(expected), {
    name: 'SwarmDeployError',
    code: ERRORS.SERVER_KEY_MISMATCH
  })
  t.is(socket.destroyed, true)
})

test('direct server accepts multiple allowed clients', async (t) => {
  const testnet = await createLocalTestnet(t)
  const clientAKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const clientBKeyPair = keyPairFromSeed(CLIENT_B_SEED)
  let accepted = 0
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [clientAKeyPair.publicKey, clientBKeyPair.publicKey],
    dht: testnet.createNode(),
    onConnection() {
      accepted++
    }
  })
  const clientA = new DirectDhtClient({
    keyPair: clientAKeyPair,
    dht: testnet.createNode()
  })
  const clientB = new DirectDhtClient({
    keyPair: clientBKeyPair,
    dht: testnet.createNode()
  })
  t.teardown(() => Promise.allSettled([clientA.close(), clientB.close(), server.close()]))

  await server.listen()
  await Promise.all([clientA.connect(server.publicKey), clientB.connect(server.publicKey)])
  await waitFor(() => accepted === 2)
  t.is(accepted, 2)
})

test('direct server copies its startup allowlist', async (t) => {
  const testnet = await createLocalTestnet(t)
  const allowedKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const allowedInput = b4a.from(allowedKeyPair.publicKey)
  const allowedInputs = [allowedInput]
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: allowedInputs,
    dht: testnet.createNode()
  })
  allowedInput.fill(0)
  allowedInputs[0] = keyPairFromSeed(UNKNOWN_SEED).publicKey
  const client = new DirectDhtClient({
    keyPair: allowedKeyPair,
    dht: testnet.createNode()
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  const socket = await client.connect(server.publicKey)
  t.alike(socket.remotePublicKey, server.publicKey)
})

test('direct connect abort destroys the pending socket', async (t) => {
  const testnet = await createLocalTestnet(t)
  const controller = createAbortController()
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [keyPairFromSeed(CLIENT_A_SEED).publicKey],
    dht: testnet.createNode()
  })
  const client = new DirectDhtClient({
    keyPair: keyPairFromSeed(UNKNOWN_SEED),
    dht: testnet.createNode(),
    connectTimeout: 5_000
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  const pending = client.connect(server.publicKey, {
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 10)
  await t.exception(pending, { name: 'SwarmDeployError', code: ERRORS.ABORTED })
})

test('direct connect timeout is bounded and closes its socket', async (t) => {
  const socket = inertSocket(keyPairFromSeed(SERVER_SEED).publicKey, new Promise(() => {}))
  const client = new DirectDhtClient({
    keyPair: keyPairFromSeed(CLIENT_A_SEED),
    dht: clientNode(socket),
    connectTimeout: 20
  })
  t.teardown(() => client.close())

  await t.exception(client.connect(keyPairFromSeed(SERVER_SEED).publicKey), {
    name: 'SwarmDeployError',
    code: ERRORS.CONNECT_TIMEOUT
  })
  t.is(socket.destroyed, true)
})

test('direct close destroys accepted sockets and preserves injected DHT ownership', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverNode = testnet.createNode()
  const clientNodeInstance = testnet.createNode()
  const clientKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const accepted: DirectDhtSocket[] = []
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [clientKeyPair.publicKey],
    dht: serverNode,
    onConnection(socket) {
      accepted.push(socket)
    }
  })
  const client = new DirectDhtClient({
    keyPair: clientKeyPair,
    dht: clientNodeInstance
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  const clientSocket = await client.connect(server.publicKey)
  await waitFor(() => accepted.length === 1)
  await server.close()

  t.is(accepted[0].destroyed, true)
  t.is(clientSocket.destroyed, true)
  t.is(serverNode.destroyed, false)
  await client.close()
  t.is(clientNodeInstance.destroyed, false)
})

test('direct transports close factory-owned DHT nodes', async (t) => {
  const testnet = await createLocalTestnet(t)
  const serverNode = testnet.createNode()
  const clientNodeInstance = testnet.createNode()
  const clientKeyPair = keyPairFromSeed(CLIENT_A_SEED)
  const server = new DirectDhtServer({
    keyPair: keyPairFromSeed(SERVER_SEED),
    allowedClientPublicKeys: [clientKeyPair.publicKey],
    dhtFactory: () => serverNode
  })
  const client = new DirectDhtClient({
    keyPair: clientKeyPair,
    dhtFactory: () => clientNodeInstance
  })
  t.teardown(() => Promise.allSettled([client.close(), server.close()]))

  await server.listen()
  await client.connect(server.publicKey)
  await client.close()
  await server.close()

  t.is(clientNodeInstance.destroyed, true)
  t.is(serverNode.destroyed, true)
})
