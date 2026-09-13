# Changelog

All notable changes to this package are documented here.

## 0.1.0

- Initial public release.
- Add authenticated, encrypted direct-HyperDHT uploads pinned to the server public key and a static server allowlist.
- Add bounded one-file and immediate-directory uploads with canonical TAR verification and TAR-byte-offset resumable staging.
- Add crash-safe create-only commits, startup recovery, storage scrubbing, and retention cleanup.
- Add opt-in atomic replacement for exact configured names with retained version history and v2 journal recovery.
- Add Node.js and Bare APIs, CLI identity provisioning, structured lifecycle events, and safe exit codes.
- Reserve direct `history-*` inputs and report batch children as `reserved-history` skips.
- Reclaim expired inactive staging before offer admission while preserving active uploads.
- Add stable `ACTIVE_UPLOAD_LIMIT` and `CONNECT_TIMEOUT` errors.
- Require an explicit terminal result; EOF and close are not success.
- Keep recovery logs on 12-character transfer fingerprints and narrow the supported root API to Client/Server usage.
- Pin the release publish action to the reviewed immutable Holepunch actions revision.
