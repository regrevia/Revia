# Revia 0.1-preview.1

Revia is an Agent-first technical preview for representing executable programs
as typed semantic graphs with deterministic `.re` text. This repository is the
public distribution and feedback surface. It contains runnable release assets,
examples, compact protocol documentation, and contribution templates. The
compiler and runtime source code are not published here.

> Revia is an early technical preview. The project name is provisional and trademark registration is pending.

Revia is not Stable V1.0, an open-source release, or a production backend.

## Run In 60 Seconds

The current release includes closed binaries for macOS, Linux, and Windows on
`arm64` and `x86_64`. Each binary was built and smoke-tested on a matching
GitHub-hosted runner.

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/hello.re
./bin/revia run examples/hello.re
```

On Windows PowerShell, use:

```powershell
./bin/revia.ps1 check examples/hello.re
./bin/revia.ps1 run examples/hello.re
```

Expected output:

```text
OK examples/hello.re
Hello, World!
```

The launcher downloads the version-pinned release asset once, verifies both
the archive and executable SHA-256 digests, and caches the executable per user.
It does not install Node.js or copy compiler/runtime source code.

See [QUICKSTART.md](QUICKSTART.md) for diagnostic and manifest examples.

## What To Try

- `check`: validate a `.re` program and report precise source diagnostics.
- `run`: execute the current bounded capability slice.
- `manifest`: inspect capabilities, effects, entry points, and graph identity.
- `translate` and `view`: produce structured or human-oriented graph views.

The current executable slice covers deterministic checking, stdout, process
arguments, and sandboxed source-directory file operations. It does not promise
a complete language, production networking, database pools, authentication,
deployment, or native optimizing compilation.

## Feedback Is The Product Of This Preview

The default pull request is a structured experience report, not a compiler or
runtime source change. Start from
[feedback/FEEDBACK_TEMPLATE.md](feedback/FEEDBACK_TEMPLATE.md), save the result
as `feedback/submissions/<YYYY-MM-DD>-<agent-or-project>-<short-name>.md`, and
open a pull request.

- Use [Issues](https://github.com/tangshuang631/Revia/issues) for reproducible
  installation, execution, and diagnostic problems.
- Use [Discussions](https://github.com/tangshuang631/Revia/discussions) for
  language design proposals and longer evaluation threads.
- Read [docs/agent-workflow.md](docs/agent-workflow.md) before delegating an
  evaluation to an Agent.

## Repository Boundary

This is a proprietary technical-preview distribution. Public contributions are
limited to feedback reports, examples, documentation fixes, and proposals
unless a maintainer explicitly requests another change. See [LICENSE](LICENSE),
[NOTICE.md](NOTICE.md), and [CONTRIBUTING.md](CONTRIBUTING.md).
