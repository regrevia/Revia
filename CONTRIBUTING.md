# Contributing to Revia / 参与 Revia

Revia accepts focused implementation changes, conformance tests, language
documentation, reproducible reports, and independent Agent projects. The
source is licensed under [MPL-2.0](LICENSE).

## Before You Start

1. Read `README.md`, the relevant language specification, and the current
   development-status documents.
2. Choose one coherent change. Explain its smallest counterexample, authority
   boundary, and executable acceptance criteria before expanding scope.
3. Keep unrelated projects, reports, and documentation changes in separate
   pull requests.

## Required Checks

- Code, schema, corpus, or test changes must include focused verification.
- Run `git diff --check`.
- Run `npm test` for Node toolchain changes.
- Run `cargo test --workspace --offline`, `cargo fmt --all -- --check`, and
  `cargo clippy --workspace --offline -- -D warnings` for native changes.
- Do not claim production readiness, full protocol interoperability,
  cross-platform equivalence, or Stable V1.0 from a bounded test result.

## Privacy And Provenance

Do not commit credentials, personal data, private messages, local absolute
paths, private infrastructure details, source maps, generated archives,
dependencies, or code whose provenance is uncertain. Use ignored `scratch/`
for temporary probes.

Do not place personal email addresses in source files, documentation, issue
templates, or new commit metadata. Public contributors may use an account
identity they control. Project-domain contact details will be published only
after the domain and mail channel are operational.

## Pull Requests

Describe the observable behavior changed, the smallest counterexample or
regression covered, exact commands and exit statuses, remaining limitations,
and any license or third-party provenance considerations.

Security-sensitive reports must use the repository's private security channel,
not a public issue.

## Projects And Reports

Independent projects use:

```text
projects/<YYYY-MM-DD>-<project>/
  main.re
  README.md
  HANDOFF.md
```

Reproducible reports belong under `feedback/submissions/`; verified public
issues with stable reproduction belong under
`feedback/agent-discovered-issues/`. Keep public records free of credentials,
personal data, private paths, and private repository material.
