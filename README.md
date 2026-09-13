<h1 align="center">Swarm Deploy</h1>
<p align="center">Authenticated, encrypted, resumable artifact uploads over direct HyperDHT.</p>
<p align="center">
  <a href="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/tetherto/swarm-deploy/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/tetherto/swarm-deploy/blob/main/package.json"><img alt="Package version" src="https://img.shields.io/github/package-json/v/tetherto/swarm-deploy?filename=package.json&amp;label=version&amp;style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 and 24" src="https://img.shields.io/badge/node-22%20%7C%2024-339933?logo=nodedotjs&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="https://github.com/holepunchto/bare"><img alt="Bare supported" src="https://img.shields.io/badge/Bare-supported-171717?logo=javascript&amp;logoColor=white&amp;style=flat-square"></a>
</p>

## Direct server-key setup

Generate independent server and client identities; seed files are owner-only and
must never be supplied on the command line:

```sh
swarm-deploy keygen --out server.seed
swarm-deploy keygen --out client.seed
SERVER_KEY=$(swarm-deploy public-key --seed-file server.seed)
CLIENT_KEY=$(swarm-deploy public-key --seed-file client.seed)
swarm-deploy server --seed-file server.seed --storage /srv/artifacts \
  --allow-key "$CLIENT_KEY" --max-file-bytes 1073741824 --max-staging-bytes 2147483648
swarm-deploy upload --seed-file client.seed --server-key "$SERVER_KEY" ./artifact.tgz
```

The server prints its full public key and then `ready`. Its `--allow-key`
arguments are parsed once at startup and immutable for that process. There is
no topic, discovery, allowlist polling, or reconnect budget.

Each file uses a fresh mutually authenticated HyperDHT connection. An upload
transfers one canonical USTAR archive, optionally resuming at a durable TAR-byte
offset. The server returns an explicit `COMMITTED`, `ALREADY_COMMITTED`, or
stable failure; connection EOF is never success. A directory upload processes
only immediate regular-file children in lexical order.

## API

```ts
import { Client, Server, generateSeed, parsePublicKey } from '@tetherto/swarm-deploy'

const server = new Server({
  seed: generateSeed(),
  storageDir: '/srv/artifacts',
  allowedKeys: [parsePublicKey(process.env.CLIENT_KEY!)],
  maxFileBytes: 1_073_741_824,
  maxStagingBytes: 2_147_483_648
})
await server.listen()

const client = new Client({
  seed: generateSeed(),
  serverPublicKey: parsePublicKey(process.env.SERVER_KEY!)
})
const result = await client.upload('./artifact.tgz')
await client.close()
await server.close()
```

Events and logs use short SHA-256 fingerprints only. They never expose seeds,
secret keys, full remote public keys, TAR contents, or resumable session data.

## Safety

Stored artifacts are never served or executed. The receiver accepts one
canonical regular file per archive, validates TAR and extracted SHA-256 values,
uses durable staging reservations, and preserves create/replace/history recovery
and retention semantics. See [SECURITY.md](SECURITY.md).
