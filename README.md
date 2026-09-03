<h1 align="center">Revia</h1>

<p align="center">
  <strong>Agent-native executable language for the AI-native era.</strong><br>
  Agents write executable programs. Humans review the semantic graph.
</p>

<p align="center">
  <strong>Source-closed V1 RC · Evaluation only · Not for production</strong><br>
  Current runtime: `v1.0.0-rc.1`, measured native on macOS arm64 only
</p>

<p align="center">
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="docs/assets/agent-review-graph.png" alt="Revia semantic graph translated from the agent review example" width="920">
</p>

Revia turns an Agent-written program into an executable contract that people
can inspect: explicit capabilities, visible effects, and reviewable success
and failure paths.

The graph above is a compact presentation of semantic facts emitted by the
Revia translator from [`examples/agent-review/main.re`](examples/agent-review/main.re).

## See The Contract

The [execution contract](docs/execution-contract.md) shows how one `.re` source
becomes a checked graph, machine manifest, human semantic view, and bounded
run. Start with the [Agent handoff review](examples/agent-handoff-review/) or
the [workflow brief](examples/agent-workflow-brief.re) when you want a compact
workload with explicit state, risk, and handoff output.

The public RC now also documents the installation contract, cache lifecycle,
generated-contract boundary, and protocol adapter questions for the next
development stage. See the [Quickstart](QUICKSTART.md) and
[Integration Guide](docs/integration.md).

## Run The Full Loop

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia --version
./bin/revia --help
cp -R experiments/rc1/kit /tmp/revia-rc1-kit
# Install the verified release binary as /tmp/revia-rc1-kit/bin/revia,
# then run the exact command arrays in trial-manifest.json from that directory.
```

The candidate executes natively only on macOS arm64. The launcher reports exit
`69` for every other target rather than claiming preview compatibility. See the
[trial kit](experiments/rc1/kit/) and [Quickstart](QUICKSTART.md).

```text
revia 1.0.0-rc.1
```

The trial manifest pins the fixtures, commands, output hashes, and declared
limits for capability, project workflow, multi-module, and bounded server work.

## Release Runtime

`v1.0.0-rc.1` is a version-pinned, source-closed developer-evaluation runtime.
It ships one Darwin arm64 archive whose archive and executable SHA-256 are
published in [runtime/checksums.txt](runtime/checksums.txt). See
[Quickstart](QUICKSTART.md) for the bounded trial workflow and exit codes.

## V1 RC1 Trial Boundary

`v1.0.0-rc.1` is the V1 deep-trial milestone, not Stable V1.0. Its sealed
Darwin arm64 export binds the archive, binary, evaluation license, target
matrix, capability evidence, multi-module evidence, and bounded Server evidence.
The other five targets are explicitly `pending`, with no placeholder binaries.
The [sealed export contract](docs/rc1-sealed-export-contract.md),
[RC license](LICENSE-RC.md), and [cross-platform procedure](docs/cross-platform-evidence.md)
define the boundary.

## Current Development

The public RC is runnable on its sole measured target. Its trial kit exposes
the bounded capability, project, multi-module, and Server experiments without
exposing compiler or runtime source. It does not claim full language output
byte determinism, cross-platform equivalence, production hosting, signing,
SBOM, attestation, or immutable Stable V1.0. See the
[development status](docs/development-status.md) and [evidence](docs/evidence.md)
for the verified public boundary, current milestones, and what is not yet in
the RC trial boundary.

The HTTP/JSON/SQLite result is documented in
[bounded Server conformance](docs/server-conformance.md). The
[Stable V1.0 release gate](docs/stable-release-gate.md) remains open until
release-side evidence is complete.

## What Revia Makes Explicit

- **Authority** — capabilities are declared and revision-pinned.
- **Behavior** — effects return typed results instead of disappearing into
  implicit control flow.
- **Review** — `manifest` and `view` expose the same program to machines and
  humans.

## Learn Re In One Program

```re
re 0.1 compact

unit @agent_review

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %handoff = @stdout.write("agent=ready\nnext=inspect-graph\n")
  return match %handoff {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
```

For the smallest complete review workload, see the
[workflow brief](examples/agent-workflow-brief.re). It emits a structured
handoff record while keeping the capability, result branches, and exit status
visible in the generated contract.

## Build With Other Agents

Each independent experiment owns one directory:

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
  main.re
  README.md
  HANDOFF.md
```

Create a new directory for independent work. Update `HANDOFF.md` only when
continuing that exact project. Submit one project or one continuation per PR.

Bring a stronger example, a counterexample, or a reproducible finding. Start
from the [project template](projects/_template/) and use the
[feedback template](feedback/FEEDBACK_TEMPLATE.md) for focused reports.

## Explore

### Start Here

[Quickstart](QUICKSTART.md) · [Compatibility](docs/compatibility.md) ·
[Integration Guide](docs/integration.md) · [Execution contract](docs/execution-contract.md)

### Understand Revia

[Architecture](docs/architecture.md) · [Language](docs/language.md) ·
[Language reference](docs/language-reference.md) ·
[Server conformance](docs/server-conformance.md) ·
[Protocol](docs/protocol.md) · [Evidence](docs/evidence.md) ·
[Evolution](docs/evolution.md) · [Development status](docs/development-status.md) ·
[Release policy](docs/release-policy.md) ·
[RC1 license and limits](docs/rc1-license-and-limitations.md) ·
[Cross-platform evidence](docs/cross-platform-evidence.md) ·
[Stable V1.0 gate](docs/stable-release-gate.md)

### Collaborate

[Agent workflow](docs/agent-workflow.md) · [Projects](projects/README.md) ·
[Feedback loop](docs/feedback-loop.md)

### Project

[Release notes](RELEASE_NOTES.md) · [Contributing](CONTRIBUTING.md)

### Community

[Issues](https://github.com/tangshuang631/Revia/issues) ·
[Discussions](https://github.com/tangshuang631/Revia/discussions) ·
[Campaign poster](docs/assets/revia-agents-write-humans-govern.png) ·
[API and protocol opinions](feedback/OPINION_TEMPLATE.md)

## License

`v1.0.0-rc.1` uses the [Developer Evaluation License](LICENSE-RC.md). The
candidate permits local developer and Agent evaluation, research, and benchmark
work; it does not permit production use, commercial hosting, redistribution, or
reverse engineering. [Notice](NOTICE-RC.md) records the RC notice.
