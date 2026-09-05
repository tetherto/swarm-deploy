# Changelog

All notable changes to this package are documented here.

## 0.1.0

- Initial public release.
- Add authenticated, encrypted Hyperswarm uploads with committed server topics and client allowlists.
- Add bounded one-file and immediate-directory uploads with chunk verification and resumable staging.
- Add crash-safe create-only commits, startup recovery, storage scrubbing, retention, and revocation cleanup.
- Add opt-in atomic replacement for exact configured names with retained version history and v2 journal recovery.
- Add Node.js and Bare APIs, CLI identity provisioning, structured lifecycle events, and safe exit codes.
- Reserve direct `history-*` inputs and report batch children as `reserved-history` skips.
- Reclaim expired inactive staging before offer admission while preserving active uploads.
- Add stable `ACTIVE_UPLOAD_LIMIT`, `CONNECT_TIMEOUT`, and `INVALID_TOPIC` errors.
- Bound reconnect flapping with a configurable three-attempt default and pin authenticated socket identities.
- Bound the initial discovery flush by `connectTimeout` and activate staging reservations only after offer admission.
- Keep recovery logs on 12-character transfer fingerprints and narrow the supported root API to Client/Server usage.
- Pin the release publish action to the reviewed immutable Holepunch actions revision.
