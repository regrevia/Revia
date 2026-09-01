# RC1 License And Limitations

> 中文摘要：RC1 仅授权非生产开发评估、Agent 试用与公开基准研究；不授权生产、商业托管、再分发或逆向工程。

Revia `v1.0.0-rc.1` is intended for deep, non-production evaluation by developers, researchers, and AI agents. It is not the Stable V1.0 release.

## Permitted evaluation

- Local development, learning, testing, and private non-production CI.
- Human-operated and automated Agent workflows.
- Creation and retention of your own `.re` programs and evaluation outputs.
- Public benchmarks, research, criticism, and reproducibility reports that identify the version, target, asset checksum, methodology, and limitations.

## Not permitted

- Production or safety-critical use.
- Commercial hosting or service delivery.
- Redistribution or mirroring of the binary; link to the official GitHub release.
- Reverse engineering or attempts to recover non-public implementation, except where applicable law does not allow that restriction.
- Claims for operating systems, architectures, features, determinism boundaries, or performance that were not actually measured.

The controlling terms are in [LICENSE-RC.md](../LICENSE-RC.md). This page is an operational summary, not a substitute for the license and not legal advice.

## Initial RC boundary

The first RC asset is planned for native macOS arm64 only. The evaluated slice includes the native CLI, project workflow, explicit capability evidence, explicit multi-module execution, and a bounded HTTP/JSON/SQLite Server profile. It does not claim TLS, authentication, general production hosting, cross-request scheduling, arbitrary database drivers, full cross-platform support, signed provenance, or Stable V1.0.

The release must remain blocked until a sealed development handoff passes the public exact-inventory verifier. Documentation readiness alone is not release evidence.
