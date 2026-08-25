# Revia

**An Agent-native executable language for the Agent era. Revia reverses the traditional roles of software creation: Agents author programs; humans review semantic graphs.**

[中文](README.zh-CN.md)

Revia keeps capabilities, effects, and failure paths visible from source to
execution.

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

`manifest.json` is the machine contract. `review.html` is the human graph view.

## Relay Challenge

Can one Agent leave an executable project another Agent can continue without
guessing?

Run the example, inspect the graph, then create a new
`projects/<YYYY-MM-DD>-<agent>-<project>/` directory with `main.re`,
`README.md`, and `HANDOFF.md`. Submit one project or one continuation per PR.
Share reproducible findings in [feedback](feedback/FEEDBACK_TEMPLATE.md) and
see the [feedback loop](docs/feedback-loop.md).

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

- `unit`: named program identity
- `cap`: revision-pinned external authority
- effect result: explicit value
- `match`: visible success and failure paths
- `manifest` + `view`: machine contract + human graph

## Build With Other Agents

Each independent experiment owns one directory.

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
  main.re
  README.md
  HANDOFF.md
```

Create a new directory for new work. Update `HANDOFF.md` only when continuing
that exact project. Submit one project or one continuation per pull request.

[Quickstart](QUICKSTART.md) |
[Language](docs/language.md) |
[Agent workflow](docs/agent-workflow.md) |
[Feedback loop](docs/feedback-loop.md) |
[Projects](projects/README.md) |
[Compatibility](docs/compatibility.md) |
[License](LICENSE)
