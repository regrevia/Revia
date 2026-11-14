# Agent Guide

This guide applies to automated and human contributors working in the public
Revia repository.

## Source Of Truth

- The public repository is authoritative for its source, specifications,
  conformance tests, and release records.
- Do not depend on private repositories, unpublished files, hidden review
  state, or local absolute paths.
- Treat files under `test/fixtures/` and checked-in experiment inputs as
  public test data; do not add real user data or credentials.

## Development Workflow

1. Read `README.md`, `CONTRIBUTING.md`, and the specification relevant to the
   change.
2. State the smallest counterexample the change addresses and its acceptance
   test.
3. Add or update a focused test before changing behavior.
4. Run the focused test, then `npm test` for shared Node behavior.
5. For Rust changes, run `cargo build --workspace --release --offline` first
   (the release-evidence test executes `native/target/release/revia`), then
   `cargo test --workspace --offline`, `cargo fmt --all -- --check`, and
   `cargo clippy --workspace --offline --all-targets -- -D warnings`.
6. Run `git diff --check`, `npm run source:manifest`, and the secret/privacy
   scan before submitting. The source-import gate refuses an allowlist or
   manifest that opens with a UTF-8 byte-order mark, reporting
   `byte-order-mark-not-allowed` in `--check`, `--write` and `--refresh` alike,
   so restore the file from Git instead of stripping the bytes by hand. The
   gate also tells a path listed in the allowlist that is not in the tree
   (`source-import-file-missing`) from one that is there but is a directory or
   a symbolic link (`source-import-file-invalid`); run `--refresh` for the
   first, and put the file back for the second.
   `--refresh` rewrites the allowlist one path per line, in the same order
   `--check` reads it, so the diff of a refresh shows the files that
   changed and nothing else; do not reformat the list by hand.

## Public Claims

Describe the exact implementation slice and tested targets. Keep `measured`,
`verified-only`, `pending`, and `fault-observed` distinct. Do not infer
production readiness, complete A2A/MCP support, cross-platform equivalence, or
Stable V1.0 from a bounded fixture or successful build.

## Data And Security

- Do not commit personal contact details, credentials, private messages,
  local absolute paths, internal coordination, or private infrastructure
  configuration.
- Do not put tokens or signing keys in fixtures or test output.
- Use the repository's private vulnerability reporting channel for
  security-sensitive findings.
- Keep generated archives, build output, and temporary probes out of Git.
