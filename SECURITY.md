# Security policy

## Supported versions

Security fixes are provided for the latest published release. Unreleased commits
are not a supported production distribution.

## Report a vulnerability

Email [security-oss@tether.io](mailto:security-oss@tether.io). Do not open a
public issue for a suspected vulnerability and do not include live seeds,
private infrastructure details, or production artifacts.

Include the affected version and runtime, operating system, impact, minimal
reproduction, and whether seed material or stored artifacts may have been
exposed. We will acknowledge the report within five working days. Coordination
and disclosure may use a private GitHub Security Advisory.

## Operator precautions

- Generate independent server and client seeds and prefer owner-readable files
  or protected environment variables. The CLI accepts `--seed` for explicit
  inline configuration, but command arguments may be exposed through shell
  history, process listings, CI tracing, and diagnostic tooling. Never log a
  seed. A client pins the server's full public key; the server's immutable
  startup allowlist names permitted client public keys. If a seed may be
  exposed, rotate it, restart with a revised allowlist, and purge the
  compromised secret from logs and caches.
- Run under a dedicated non-root account with a dedicated storage root.
  Swarm Deploy protects against detected symlink and directory-identity
  changes, but it does not defend against a malicious process with the same OS
  permissions.
- Protect the startup allowlist as security-sensitive configuration. It is not
  watched or reloaded: use a controlled server restart to change access.
- Never serve, share, or expose the private state directory (by default
  `~/.swarm-deploy/<id>` under the server user's home, or the `--state-dir` you
  choose). Serve only the output root (`--storage`), which holds published
  artifacts and managed links. State holds session and commit metadata, which
  includes uploader public keys, digests, and optional source-parent paths; lock
  records (a process ID and a random token); and incomplete partial artifact
  payloads that were never verified or published. It does not hold seeds by
  default: the server seed is read at startup from the source you provide and
  kept in memory, and `keygen --out` writes a seed only where you point it.
  Swarm Deploy creates the state directory at mode `0700`; keep it owner-only,
  outside the output root, and on the same filesystem.
- Releases before 0.6.1 kept this state in `<storage>/.swarm-deploy`, inside the
  output root. If a web server ever served such a root, treat that state as
  having been reachable. Swarm Deploy cannot tell whether it was, and it does
  not inspect or delete old copies; migrate it as described in the README.
- Do not manipulate the private state directory or copy an active storage root.
  Stop the server cleanly before backup or restore, preserve the output root
  together with its state directory, and let the same or newer package version
  complete recovery before serving traffic. Run every instance and
  `reset-storage` for one root with the same state settings.
- Fingerprints and digests are not seeds, but full public keys still identify
  deployment principals. Share only the server public key with uploaders and
  only client public keys with server operators.
