# Native And Reference CLI Surface Design

**Goal:** Make the published native launcher and the Node reference CLI
unambiguously distinct, so users can select a command surface that actually
supports the requested operation.

**Decision:** Keep the existing native graph/artifact command contract and the
Node source-oriented command contract separate. Do not add implicit fallback
from native execution to Node execution.

## Evidence And Counterexample

At public main `7f7d19c`, `bin/revia` and `bin/revia.ps1` advertise
`run <file.re>`, `view`, `audit`, `profile`, `patch`, `review-index`, and
`build`, then dispatch to the versioned native release asset. The native CLI
defines `run <graph> <artifact> <input-digest>` instead. The Node reference
CLI accepts source-oriented commands, and
`npm run re -- run examples/agent-review/main.re` was observed to execute
successfully.

The Linux x64 RC2.2.1 archive downloaded for issue #17 has SHA-256
`cee357cf80fe48068fa8c16dc59590ac1299fb0f992eb38f22e0be769c0631b9`,
matching `runtime/checksums.txt`. This Darwin host cannot execute that ELF;
the issue contains a clean-Linux reproduction of the source-form native
invocation returning exit 64. The tag and release assets are historical and
must remain unchanged.

## Public Interface

- `bin/revia` and `bin/revia.ps1` describe and dispatch to the versioned native
  release CLI only.
- `npm run re -- <command> [arguments]` describes and invokes the current Node
  reference CLI.
- Overlapping command names are documented with both signatures. The native
  three-operand `run <graph> <artifact> <input-digest>` is always pass-through,
  including when the graph filename ends in `.re`.
- Recognized source-form commands sent to the current native launcher fail
  with exit 64 and a deterministic diagnostic naming the Node reference
  command. The launcher must not execute or fall back to Node. A valid native
  one-shot alternative, `execute <source> <input-digest>`, remains available
  and is documented distinctly from reference `run`.
- `run` routing recognizes only valid Node source-form shapes: a source file
  with no program arguments, recognized Node run options before the source
  path, or a source path followed by the literal `--` argument separator.
  Other incomplete native `run` forms retain the native usage failure and are
  not guessed to be Node invocations.
- The source-form guard is bound to native version `1.0.0-rc.2.2.1`; a future
  native candidate must update its supported command matrix deliberately.
- Tests must assert that repository `VERSION` is
  `1.0.0-rc.2.2.1` while this compatibility guard is active. A later native
  version cannot silently inherit the old release matrix.
- Source examples, integration guidance, and CLI reference pages use the Node
  reference prefix for Node-only capabilities and use the native launcher only
  for commands supported by the published native surface.

## Scope

- Update both launchers' help and source-form mismatch diagnostics, including
  `help run` so it displays the two signatures separately.
- Add a shared command-surface corpus and focused shell/Node contract tests.
- Update affected README, execution, architecture, integration, language
  reference, and example instructions.
- Preserve native source execution commands and existing release verification.

Out of scope: implementing Node reference command parity in Rust; changing
language semantics; changing RC2.2.1 binaries, tag, checksums, or release
metadata; claiming that issue #17's historical asset is fixed.

## Acceptance

1. Both launchers' `--help` and `help run` identify the native release surface,
   distinguish the Node reference CLI, exit successfully, and do not download
   an asset.
2. Tests assert the active guard version equals the repository `VERSION`
   (`1.0.0-rc.2.2.1`). If `VERSION` changes without an updated command matrix,
   the focused contract fails.
3. On that version, source-form calls such as
   `bin/revia run examples/hello.re`, its absolute-path equivalent, recognized
   Node run options, and a source path followed by `-- <program-args>` fail
   before download with exit 64, empty stdout, and an actionable reference
   command on stderr. A two-operand incomplete native form retains native
   usage behavior.
4. Native `run <graph> <artifact> <input-digest>` is not intercepted even when
   `<graph>` ends in `.re`; the native `execute <source> <input-digest>` form
   also remains outside the source-form guard.
5. `npm run re -- run examples/agent-review/main.re` and the corresponding
   `view --format html` invocation both exit 0. They are not expected to fail
   with exit 64 or to fall back to the native launcher.
6. Both launcher `--help`, `help run`, and source-only `help view` return
   successfully without downloading an asset. Native-supported
   check/manifest/translate forms remain accurately identified.
7. A shared corpus covers the route matrix, relative and absolute paths,
   argument separator, version binding, and the no-defect controls. Focused
   tests exercise Bash and PowerShell launchers and reject contradictory
   command/help/docs fixtures.
8. Tests assert that RC2.2.1 `VERSION`, candidate manifest, checksums and
   release-gate historical-tag rejection remain unchanged.

## Evidence Boundary

The work can establish that current main no longer advertises source-form
commands as native and that source examples use the correct CLI. It cannot
establish that the published RC2.2.1 binary supports those commands or that
native source-form parity exists.
