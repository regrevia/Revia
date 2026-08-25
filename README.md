<h1 align="center">Revia</h1>

<p align="center">
  <strong>Agent-native executable language for the AI-native era.</strong><br>
  Agents write executable programs. Humans review the semantic graph.
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

## Run The Full Loop

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

Windows PowerShell: replace `./bin/revia` with `./bin/revia.ps1`.

```text
agent=ready
next=inspect-graph
```

`manifest.json` is the machine contract. `review.html` is the human review
view. `view --format svg` produces a structured semantic view.

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

[Quickstart](QUICKSTART.md) · [Compatibility](docs/compatibility.md)

### Understand Revia

[Language](docs/language.md) · [Protocol](docs/protocol.md)

### Collaborate

[Agent workflow](docs/agent-workflow.md) · [Projects](projects/README.md) ·
[Feedback loop](docs/feedback-loop.md)

### Project

[Release notes](RELEASE_NOTES.md) · [Contributing](CONTRIBUTING.md)

### Community

[Issues](https://github.com/tangshuang631/Revia/issues) ·
[Discussions](https://github.com/tangshuang631/Revia/discussions)

## License

Revia uses the [Revia Technical Preview License 0.1](LICENSE). Third-party
runtime notices are listed in [NOTICE.md](NOTICE.md).
