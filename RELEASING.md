# Releasing

Releases are immutable npm versions published by the tag-triggered GitHub Actions workflow. Do not publish from a workstation.

## One-time setup

1. In npm, create the `@tetherto/swarm-deploy` package or grant the maintainers access to the `@tetherto` scope.
2. Configure npm trusted publishing for this GitHub repository, workflow `publish.yml`, and environment `npm`.
3. Protect the `npm` environment with the required reviewers and deployment-branch/tag rules. Do not add an npm token: the workflow uses OIDC.
4. Protect release tags and require the CI checks on `main`.

## Preflight

1. Update `package.json` and `package-lock.json` to the same SemVer version and update `CHANGELOG.md`.
2. From a clean checkout, run:

   ```sh
   npm ci
   npm run build
   npm run build:test
   npm run lint
   npm run test:node
   npm run test:bare
   npm run test:package
   npm audit --omit=dev
   npm publish --dry-run
   ```

3. Verify `GITHUB_REF_NAME=vX.Y.Z npm run test:release-tag` with the intended version.
4. Merge the release commit and wait for required `main` CI checks.

## Publish and verify

The following are deliberate external actions and are not performed by tests or local release preparation:

```sh
git tag -s vX.Y.Z <release-commit>
git push origin vX.Y.Z
```

Approve the protected `npm` environment if required. Confirm the workflow used provenance, then verify the registry metadata, provenance statement, tarball contents, and a fresh install:

```sh
npm view @tetherto/swarm-deploy@X.Y.Z version dist.integrity
npm install --save-exact @tetherto/swarm-deploy@X.Y.Z
npx swarm-deploy --help
```

Roll the package into one canary client/server pair first. Confirm `ready`, authentication, offer, progress, verification, commit, recovery, scrub, retention, and cleanup diagnostics before broader rollout.

## Rollback

Package versions and deployment configuration are immutable inputs. Roll clients and servers back by reinstalling and redeploying the last known-good exact version; never republish an existing version. If the bad version should not be selected by users, deprecate it with a clear replacement:

```sh
npm deprecate @tetherto/swarm-deploy@X.Y.Z "Use X.Y.(Z+1); reason: <summary>"
```

Do not roll a server back while a v2 replacement journal is in flight. Stop new uploads, drain active work, and allow the current version to recover or finish every replacement journal first. Back up the dedicated storage root after a clean shutdown, and test the previous version against a copy before production rollback. An older server may not understand v2 replacement state.
