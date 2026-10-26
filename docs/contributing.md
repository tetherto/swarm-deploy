# Contributing

Development workflow for Swarm Deploy contributors. Back to the
[README](../README.md).

## Contents

- [Contributor development](#contributor-development)
- [Documentation layout](#documentation-layout)
- [Release](#release)

## Contributor development

Production and tests are strict TypeScript. Build output is generated under
untracked `dist/` and `.test-dist/`. Tests generate binary payloads in temporary
directories and use an isolated local HyperDHT testnet, not the public DHT.

```sh
npm install
npm run build
npm run build:test
npm run test:types
npm run format:check
npm run lint
npm run test:node
npm run test:bare
npm run test:property
npm run test:package
npm run test:release-tag
```

Exercise the built CLI directly:

```sh
node dist/bin/swarm-deploy.js --help
bare dist/bin/swarm-deploy.js --help
```

## Documentation layout

The root [README](../README.md) is the entry point and is shipped in the npm
package. The guides in `docs/` are not part of the package files, so the README
links to them with absolute GitHub URLs; links between guides stay relative.

- [CLI reference](cli.md)
- [Runtime API](api.md)
- [Operations, storage, and rollback](operations.md)
- [Artifact patterns and rotation](artifact-patterns.md)
- [Managed symlinks](managed-links.md)
- [Deployment hooks](hooks.md)
- [Protocol specification](spec/swarm-deploy.md)

## Release

Version tags use `v<package-version>`. The tag workflow validates the version,
builds the untracked distribution, checks package contents and types, and
publishes through the configured npm environment with provenance.

See [RELEASING.md](../RELEASING.md) for the release and rollback procedure.
