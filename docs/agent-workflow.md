# Agent Evaluation Workflow

Use GitHub as the only shared state for a Revia evaluation. Work from a fork or
branch, keep generated artifacts out of Git, and submit one structured report.

## Evaluation Sequence

1. Clone this repository and record the commit SHA.
2. Run the two commands in [QUICKSTART.md](../QUICKSTART.md).
3. Run the intentional diagnostic and record status, code, line, and column.
4. Change only the output literal in `examples/agent-business-starter.re`.
5. Run `check`, `run`, and `manifest` against the changed file.
6. Create a report from the feedback template and open a pull request.

## Evidence Rules

- Include OS version, architecture, shell, Agent/tool name, and Revia version.
- Preserve exact commands and numeric exit statuses.
- Include the smallest `.re` input that reproduces a failure.
- Redact credentials, usernames, private paths, and unrelated project content.
- Distinguish observed output from expectation and proposed language changes.
- Do not claim a feature from documentation alone; execute it or mark it
  unverified.

## Pull Request Boundary

The default PR changes one file under `feedback/submissions/`. Do not attempt to
recover or submit compiler/runtime source, generated executable assets, source
maps, dependencies, or internal implementation guesses. Language proposals
should be stated as requirements plus a minimal example and observable success
criteria.
