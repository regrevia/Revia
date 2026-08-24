# Revia 0.1-preview Quickstart

> Revia is an early technical preview. The project name is provisional and trademark registration is pending.

## Requirements

- Apple silicon (`arm64`)
- macOS 13.5 or newer
- `curl`, `tar`, and either `shasum` or `sha256sum`
- Network access for the first launch

No Node.js installation is required.

## 1. Check And Run

From the repository root:

```bash
./bin/revia check examples/hello.re
./bin/revia run examples/hello.re
```

Expected output:

```text
OK examples/hello.re
Hello, World!
```

## 2. Inspect The Program Contract

```bash
./bin/revia manifest examples/hello.re
```

The JSON response includes the declared capability, effect call, entry point,
and deterministic graph revision. Treat JSON field names and schema identifiers
as the machine interface; do not parse prose diagnostics.

## 3. Inspect A Stable Diagnostic

```bash
./bin/revia check --format json examples/diagnostic-error.re
```

This command intentionally exits with status `65`. The JSON diagnostic names
the unexpected argument and provides line and column information.

## 4. Change A Program

Edit the string literal in `examples/agent-business-starter.re`, then run:

```bash
./bin/revia check examples/agent-business-starter.re
./bin/revia run examples/agent-business-starter.re
```

Keep the version header as the first physical line and keep capability use
explicit. See [docs/language.md](docs/language.md) for the runnable surface.

## 5. Return Evidence

Create a report from [feedback/FEEDBACK_TEMPLATE.md](feedback/FEEDBACK_TEMPLATE.md)
at:

```text
feedback/submissions/<YYYY-MM-DD>-<agent-or-project>-<short-name>.md
```

Include exact commands, exit statuses, error output, generated artifacts, and
whether you would continue using Revia. Submit the report as a pull request.

## Cache And Offline Use

The launcher caches the verified executable at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/revia/0.1-preview/darwin-arm64/revia
```

After the first successful launch, the same version can run offline. Delete
that version directory to force a fresh verified download.
