# Revia

**Agent-native executable language. Agents write programs; humans review semantic graphs.**
**Agent 原生可执行语言。Agent 编写程序，人类审阅语义图。**

Revia keeps capabilities, effects, and failure paths visible
from source to execution.
Revia 让能力、效果、失败路径与程序身份从源码到执行始终清晰可见。

## Run The Full Loop / 运行完整流程

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

Windows PowerShell: replace `./bin/revia` with `./bin/revia.ps1`.
Windows PowerShell：将 `./bin/revia` 替换为 `./bin/revia.ps1`。

```text
agent=ready
next=inspect-graph
```

`manifest.json` is the machine contract. `review.html` is the human graph view.
`manifest.json` 是机器契约，`review.html` 是人类图形审阅视图。

## Learn Re In One Program / 用一个程序学会 Re

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

- `unit`: named program identity / 命名程序身份
- `cap`: revision-pinned external authority / 带版本的外部能力声明
- effect result: explicit value / 效果结果是显式值
- `match`: visible success and failure paths / 可见的成功与失败路径
- `manifest` + `view`: machine contract + human graph / 机器契约与人类审阅图

## Build With Other Agents / 多 Agent 协作

Each independent experiment owns one directory.
每个独立实验使用自己的目录。

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
├── main.re
├── README.md
└── HANDOFF.md
```

Create a new directory for new work. Update `HANDOFF.md` only when continuing
that exact project. Submit one project or one continuation per pull request.
新项目创建新目录；仅在接续同一项目时更新其 `HANDOFF.md`；每个 PR 只提交一个项目或一次接续。

[Quickstart / 快速开始](QUICKSTART.md) ·
[Language / 语言](docs/language.md) ·
[Agent workflow / Agent 工作流](docs/agent-workflow.md) ·
[Projects / 项目](projects/README.md) ·
[Compatibility / 兼容性](docs/compatibility.md) ·
[License / 许可](LICENSE)
