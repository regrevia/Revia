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

Choose a path:

- **Try Revia:** [Quickstart](QUICKSTART.md) and the
  [examples index](examples/README.md).
- **Understand the language:** [language specifications](doc/README.md).
- **Inspect implementation status:** [development status](docs/development-status.md)
  and [compatibility](docs/compatibility.md).
- **Run published trials:** [experiments index](experiments/README.md).
- **Start a project:** [project template](projects/README.md).
- **Contribute:** [contributor guide](CONTRIBUTING.md).

Run the Node reference toolchain from the repository root:

```bash
npm run re -- check examples/hello.re
npm run re -- run examples/hello.re
```

Run its conformance suite:

```bash
npm test
```

The Rust implementation lives in `native/`:

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
doc/             language, syntax, semantics, and execution specifications
docs/            compatibility, integration, release, evidence, and status
examples/        small programs, Agent workflows, and review challenges
experiments/     historical release trials and comparison records
projects/        contributor project template and sample projects
src/             Node reference toolchain and host adapters
native/          Rust translator, VM, CLI, and native conformance tests
test/            Node tests, fixtures, and byte-exact goldens
test-support/    shared test adapters and fixtures
scripts/         development, conformance, and evidence commands
runtime/         historical packaged runtimes and release evidence
```

The public repository is the source and test authority for the open
development line. `runtime/` and `experiments/rc1/` describe historical
evaluation assets; they are separate from the current source toolchain.

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
