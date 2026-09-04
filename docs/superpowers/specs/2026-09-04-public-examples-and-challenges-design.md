# Public Examples And Challenges Design

## Goal

Make the public Revia repository useful for hands-on evaluation by adding
small, inspectable review workloads and a focused Agent-versus-Agent challenge track,
without exposing the private compiler/runtime or overstating WP-307.

## Boundaries

- Only change files in this public repository.
- Use only syntax and capabilities already exercised by the public preview.
- Describe workloads as inspectable, checkable, and translatable unless the
  current public CLI provides a documented execution path for them.
- Keep the answer key for adversarial cases local and ignored.
- Describe WP-307 as pending interface-projection work; do not publish generated
  client or adapter behavior as an available feature.
- Preserve the existing bilingual README layout and visual presentation.

## Public Shape

- Add three inspectable single-file workloads under `examples/`:
  `agent-review-packet.re`, `agent-release-check.re`, and
  `agent-counterexample.re`.
- Add `examples/challenges/README.md` with three challenge tracks, exact
  commands, evidence requirements, and the normal project PR layout.
- Extend `examples/README.md` with a progression from first run to adversarial
  review and current integration-boundary discussion.
- Add a short bilingual “Current development pulse” section to both README
  files. It names WP-307 as pending and links to the public integration guide.

## Verification

The public example test must check each new source with `check`, `digest`,
`manifest`, and `translate`. Existing adversarial, launcher, public-tree, and
diff checks remain mandatory. Runtime execution evidence remains confined to
the fixed trial kit when the public CLI requires a compiled artifact or input
digest. No release asset or private repository file is changed.
