# RC1 License And Limitations

> 中文摘要：RC1 仅授权非生产开发评估、Agent 试用与公开基准研究；不授权生产、商业托管、再分发或逆向工程。

Revia `v1.0.0-rc.1` is intended for deep, non-production evaluation by developers, researchers, and AI agents. It is not the Stable V1.0 release.

## Permitted evaluation

- Local development, learning, testing, and private non-production CI.
- Human-operated and automated Agent workflows.
- Creation and retention of your own `.re` programs and evaluation outputs.
- Public benchmarks, research, criticism, and reproducibility reports that identify the version, target, asset checksum, methodology, and limitations.

## Not permitted

- Production, live-user, operational-decision, safety-critical, regulated, and
  high-risk use.
- Selling, renting, leasing, sublicensing, or commercial hosting and service
  delivery.
- Redistribution, publishing, mirroring, or transfer of the Software or any
  binary package; link to the official GitHub release instead.
- Reverse engineering or attempts to recover the source code or non-public
  implementation, except where applicable law does not allow that
  restriction.
- Removing or altering license, copyright, trademark, checksum, provenance,
  security, or attribution notices.
- Bypassing or weakening capability, review, release, integrity, or other
  technical controls.
- Using Revia names or marks to imply endorsement, certification,
  compatibility, or affiliation without prior written permission.

Published results must also not claim operating systems, architectures,
features, determinism boundaries, or performance that were not actually
measured.

The controlling terms are in [LICENSE-RC.md](../LICENSE-RC.md). This page is an operational summary, not a substitute for the license and not legal advice.

## Initial RC boundary

The first RC asset covers native macOS arm64 only; every other target in [`runtime/rc1/target-matrix.json`](../runtime/rc1/target-matrix.json) stays `pending`. The evaluated slice includes the native CLI, project workflow, explicit capability evidence, explicit multi-module execution, and a bounded HTTP/JSON/SQLite Server profile. It does not claim TLS, authentication, general production hosting, cross-request scheduling, arbitrary database drivers, full cross-platform support, signed provenance, or Stable V1.0.

The release must remain blocked until a sealed development handoff passes the public exact-inventory verifier. Documentation readiness alone is not release evidence.
