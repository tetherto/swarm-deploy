# Security policy

## Supported versions

Security fixes are provided for the latest published release. This repository
is preparing its initial `0.1.0` release; unreleased commits are not a supported
production distribution.

## Report a vulnerability

Email [security-oss@tether.io](mailto:security-oss@tether.io). Do not open a
public issue for a suspected vulnerability and do not include live seeds,
private infrastructure details, or production artifacts.

Include the affected version and runtime, operating system, impact, minimal
reproduction, and whether seed material or stored artifacts may have been
exposed. We will acknowledge the report within five working days. Coordination
and disclosure may use a private GitHub Security Advisory.

## Operator precautions

- Generate independent server and client seeds, store them as owner-readable
  secrets, and never pass or log them as command-line arguments. If a seed may
  be exposed, rotate it, remove the corresponding public key from the
  allowlist, and purge the compromised secret from logs and caches.
- Run under a dedicated non-root account with a dedicated storage root.
  Swarm Deploy protects against detected symlink and directory-identity
  changes, but it does not defend against a malicious process with the same OS
  permissions.
- Protect the allowlist as security-sensitive configuration. Review
  authentication/revocation diagnostics after every change.
- Do not manipulate `.swarm-deploy/` or copy an active storage root. Stop the
  server cleanly before backup or restore, preserve the whole root, and let the
  same or newer package version complete recovery before serving traffic.
- Fingerprints, topics, digests, and public keys are not seeds, but full public
  keys still identify deployment principals. Share only what operations
  require.
