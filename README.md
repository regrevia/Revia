# Revia

> An open-source research implementation of a graph-first language for
> Agent-authored work and human semantic governance.

Revia turns checked program structure into deterministic machine contracts and
human-readable projections. The repository contains the reference toolchain,
the native Rust implementation, conformance tests, language documents, and
bounded comparison fixtures.

The source tree is available under [MPL-2.0](LICENSE). Historical preview and
RC1 binaries remain governed by their original licenses:
[LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md) and
[LICENSE-RC.md](LICENSE-RC.md). Those historical terms are not changed
retroactively by publishing the source.

## Current Status

The open development line is a research and preview implementation. It
includes a bounded native translator/VM, project and module checking,
deterministic semantic artifacts, a bounded Server profile, interface
projection, and conformance/experiment infrastructure.

These capabilities are bounded evidence, not claims of a production backend,
complete language implementation, cross-platform equivalence, full A2A/MCP
interoperability, or Stable V1.0. See
[docs/development-status.md](docs/development-status.md) and
[docs/stable-release-gate.md](docs/stable-release-gate.md).

## Start Here

Read [CONTRIBUTING.md](CONTRIBUTING.md), then run the reference toolchain:

```bash
npm test
npm run re -- check examples/hello.re
npm run re -- run examples/hello.re
```

For the native implementation:

```bash
cargo test --workspace --offline
cargo fmt --all -- --check
cargo clippy --workspace --offline -- -D warnings
```

The native CLI is built from `native/`. The Node toolchain remains a reference
and development implementation; its presence does not make Node a semantic
requirement of the language.

## Repository Layout

```text
doc/             language and semantic specifications
examples/        executable and design fixtures
src/             Node reference toolchain and host adapters
native/          Rust native toolchain
test/            Node conformance tests and fixtures
test-support/    shared test helpers
scripts/         reproducible development and evidence commands
docs/            public integration, release, and status documentation
```

The public repository is the source and test authority for the open
development line. Private development history, relay state, local scratch
data, credentials, and unpublished release evidence are not part of this
repository.

## Design Direction

Revia is built around a checked semantic graph:

- capabilities, effects, errors, and resources are explicit;
- canonical serialization and graph identity are deterministic;
- generated projections are derived from checked interfaces rather than
  becoming a second semantic authority;
- protocol adapters remain outside the language core;
- evidence distinguishes measured, verified-only, pending, and
  fault-observed results.

The language and implementation are still evolving. A passing test or bounded
experiment must be read together with its stated scope and limitations.

## Community

Use GitHub issues for reproducible implementation problems and discussions for
design proposals. Do not publish credentials, personal data, private
messages, local paths, private infrastructure details, or proprietary
material. Security-sensitive reports should use the repository's private
security reporting channel.

## License

Newly published source is licensed under [MPL-2.0](LICENSE). See
[SOURCE-LICENSE.md](SOURCE-LICENSE.md) for the scope of the source transition
and the relationship to historical release assets.
