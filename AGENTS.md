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
   first, and put the file back for the second. A path the selection publishes
   itself is a third case: when one is gone the gate reports
   `source-import-explicit-path-missing`, because the tree lost a file the build
   must publish rather than the list going stale, and no refresh can bring it
   back. A published path whose directory cannot be entered is neither: the
   file is there and no list edit describes it, so every mode reports
   `source-import-explicit-path-unreadable`, which is a permission to fix
   rather than a file to restore. A source root the selection walks is not
   listed anywhere, so a tree
   that lost one has no stale entry to find: the gate reports
   `source-import-source-root-missing`, and only restoring the directory fixes
   it. The manifest is compared rather than parsed, so a missing one is not
   drift — there are no bytes to disagree — and the gate says
   `source-import-manifest-missing`; `--refresh` writes it, while a manifest
   that is present and differs is still `source-import-manifest-drift`. A path
   that holds a directory where the manifest belongs is neither: it cannot be
   read, and no refresh makes a manifest out of a directory, so `--check`
   reports `source-import-manifest-unreadable`. The
   allowlist reads the same way: a tree without one is
   `source-import-allowlist-missing` in `--check` and `--write`, while
   `--refresh` writes it, so an absent list is the state that mode exists to
   fix rather than a fault; a path that holds a directory where the list
   belongs is a fault, and since nothing can be read from it there is no
   content to name, so the two modes that only read report
   `source-import-allowlist-unreadable` rather than the unnamed failure. The
   modes that write the manifest say
   `source-import-manifest-unwritable` when the write cannot land — a
   directory on the path is the case that used to report the unnamed failure
   — while `--check` still reports drift or absence, because it never writes.
   The allowlist follows: `--refresh` is the only mode that writes it, so the
   same directory is `source-import-allowlist-unwritable` there, and the two
   answers are a fact about the mode rather than two names for one fault:
   `--refresh` replaces what the path holds, so it reaches the write and names
   the write, while the reading modes never reach one. A list the process may
   not read is the other cause, and that refusal is the same in every mode,
   because `--refresh` reads the list before replacing it rather than writing
   over a file it never looked at: it reports
   `source-import-allowlist-unreadable` instead of the unnamed failure, and
   only a file-system error is mapped there, because the marked-list refusal
   has no code and must still reach the operator as
   `byte-order-mark-not-allowed`, which a marked list is refused with before
   the write rather than repaired by the refresh that would erase it. A symbolic
   link at the manifest path is neither of those: the write would land on
   whatever it points at and still report the bytes it computed, and reading
   follows the link too, so a dangling one would look exactly like an absent
   manifest — every mode reports `source-import-manifest-symlink`. The
   allowlist is checked the same way and for the same reason, reported as
   `source-import-allowlist-symlink` before any mode reads or rewrites it.
   A directory inside a walked root that the process is not allowed to enter
   stopped the walk with an error whose message carried a path, so the unnamed
   failure reached the operator: it is now
   `source-import-directory-unreadable`, and it is the same name in every mode
   because every mode walks. A root that is gone keeps
   `source-import-source-root-missing`, so a directory to restore and a
   permission to fix stay apart.
   A writing mode that repaired the tree and one that found nothing to do leave
   the same bytes and the same exit code, so every mode's receipt carries
   `allowlist_transition` and `manifest_transition`, each `created`, `replaced`
   or `unchanged`, in one vocabulary: `--check` writes nothing and reports the
   state it read as `unchanged`, because that is what it found, and
   `--refresh` names a list it had to make out of nothing as `created` rather
   than `replaced`: nothing was there to compare with. A manifest that
   already holds the bytes `--write` computed is left alone rather than
   rewritten, so `unchanged` describes the file and not just the bytes it would
   have held. A repair that only reordered the list publishes exactly the same
   files as before, and `replaced` described it the same way as a list that
   gained or lost a path, so `--refresh` names it `reordered`: the reading
   modes refuse that list as `source-import-allowlist-order-invalid`, and the
   mode that fixes it says what it fixed.
   Every mode walks the source roots, not only the one that writes the list,
   because the walk is the only thing that sees an object that is not a file
   and not a directory: a pipe, a socket or a device standing inside a root
   was refused by `--refresh` alone, so `--check` called that tree clean and
   `--write` left it as it was. Every mode now reports
   `source-import-entry-invalid` for it, and `--refresh` publishes the files
   the same walk names rather than walking a second time.
   A pipe, a socket or a device is not a list or a manifest at all, and every
   mode opens both: the gate would stop with no answer rather than a name, so
   the kind is refused before the open and reports
   `source-import-allowlist-invalid-kind` or
   `source-import-manifest-invalid-kind`. A directory keeps its own names there,
   so this refusal never renames a fault those modes already describe.
   A published path that changed kind is neither missing nor unreadable: it is
   there and it cannot be entered or read wrongly, so no permission and no
   refresh brings back the file or the directory the list means, and the gate
   reports `source-import-explicit-path-invalid`.
   A root the tree holds a file at instead of a directory has nothing to
   enter, so no permission fixes it: it is removed and replaced, not chmodded,
   and it reports `source-import-source-root-invalid` rather than the refusal
   above.
   A root that is itself a symbolic link is neither: the walk is entered before
   anything looks at the root, so it published whatever the link pointed at
   instead of the tree. It is `source-import-symlink`, the name every other
   link in the tree already reports, and the root is asked about before the
   walk so absent and file roots keep their own names.
   A listed path the process is not allowed to look at is neither of those: it
   is there, it is a file, and the directory holding it cannot be entered, so
   every mode reports `source-import-file-unreadable` rather than the unnamed
   failure the raw error became. A path removed between the check and the read
   is still `source-import-file-missing`, so the two repairs stay apart.
   A list that is present but cannot be parsed is neither stale nor shaped
   wrongly: it is a file to restore, and the reader says
   `source-import-allowlist-unparseable`. Only the parse is mapped, so a marked
   list keeps `byte-order-mark-not-allowed` and a list of the wrong shape keeps
   `source-import-allowlist-invalid`. `--refresh` never parses the list it
   replaces, so it still repairs this one.
   The selection module is not one of those paths: it is the tracked file that
   reads and renders the list, so a tree without it cannot check anything, and
   no refresh brings a module back. Every mode reports
   `source-import-selection-missing`; only a missing module is mapped, so a
   module that is present and broken still reports what broke.
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
