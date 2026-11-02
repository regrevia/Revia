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
- Overlapping command names are documented with both signatures. Native
  `run <graph> <artifact> <input-digest>` remains pass-through behavior.
- Recognized source-form commands sent to the current native launcher fail
  with exit 64 and a deterministic diagnostic naming the Node reference
  command. The launcher must not execute or fall back to Node.
- The source-form guard is bound to native version `1.0.0-rc.2.2.1`; a future
  native candidate must update its supported command matrix deliberately.
- Source examples, integration guidance, and CLI reference pages use the Node
  reference prefix for Node-only capabilities and use the native launcher only
  for commands supported by the published native surface.

## Scope

- Update both launchers' help and source-form mismatch diagnostics.
- Add a shared command-surface corpus and focused shell/Node contract tests.
- Update affected README, execution, architecture, integration, language
  reference, and example instructions.
- Preserve native source execution commands and existing release verification.

Out of scope: implementing Node reference command parity in Rust; changing
language semantics; changing RC2.2.1 binaries, tag, checksums, or release
metadata; claiming that issue #17's historical asset is fixed.

## Acceptance

1. Both launchers identify native release commands and point to
   `npm run re --` for source-oriented reference commands.
2. Source-form calls such as `bin/revia run examples/hello.re` fail before
   download with exit 64, an actionable reference command, and no stdout or
   effect.
3. Native `run <graph> <artifact> <input-digest>` is not intercepted.
4. Node source-oriented run/view examples pass through the documented
   reference CLI; native-supported check/manifest/translate forms remain
   accurately identified.
5. Tests reject contradictory command/help/docs fixtures and cover both launch
   scripts plus a no-defect native command control.
6. Historical RC2.2.1 tag, release assets, and checksums remain unchanged.

## Evidence Boundary

The work can establish that current main no longer advertises source-form
commands as native and that source examples use the correct CLI. It cannot
establish that the published RC2.2.1 binary supports those commands or that
native source-form parity exists.
