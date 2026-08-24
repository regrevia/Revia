# Release Notes

## Revia 0.1-preview

Release channel: early technical preview.

> Revia is an early technical preview. The project name is provisional and trademark registration is pending.

### Included

- Closed-source standalone CLI for macOS 13.5+ on Apple silicon.
- Version-pinned launcher with SHA-256 verification.
- `check`, `run`, `manifest`, `translate`, and `view` command surfaces.
- Runnable hello, diagnostic, and Agent editing examples.
- Concise language, protocol, Agent workflow, and compatibility documents.
- Structured Issues, Discussions, and feedback-report pull requests.

### Boundaries

- No compiler or runtime source code is included.
- No Stable V1.0 compatibility promise.
- No production backend, optimizing native compiler, service SLA, external
  database, production TLS/authentication, or deployment promise.
- Linux, Windows, and Intel macOS binaries are not included in this first asset.
- The macOS binary is ad-hoc signed and is not Apple-notarized.

### Integrity

Release asset digests are pinned in [runtime/checksums.txt](runtime/checksums.txt).
The launcher rejects missing or mismatched assets before execution.
