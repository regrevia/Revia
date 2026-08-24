# Contributing To Revia 0.1-preview.1

The main contribution path for this preview is structured evidence from real
use. Compiler and runtime source changes are out of scope because those sources
are not published in this repository.

## Accepted Pull Requests

- Experience reports under `feedback/submissions/`.
- Small, runnable `.re` examples that demonstrate an observed need.
- Corrections to public documentation or compatibility statements.
- Reproduction material requested by a maintainer for an existing Issue.

Do not submit generated binaries, archives, dependencies, source maps,
credentials, personal data, private project source, or compiler/runtime source.

## Feedback Report Path

Copy [feedback/FEEDBACK_TEMPLATE.md](feedback/FEEDBACK_TEMPLATE.md) to:

```text
feedback/submissions/<YYYY-MM-DD>-<agent-or-project>-<short-name>.md
```

Use lowercase ASCII letters, digits, and hyphens after the date. Complete every
section. Use `None` when a section does not apply; do not delete it.

## Pull Request Scope

Keep one report or one documentation correction per pull request. Link related
Issues, include exact commands and exit statuses, and remove secrets or private
paths from logs. By submitting, you agree to the contribution terms in
[LICENSE](LICENSE).
