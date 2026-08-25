# Revia

**Agent 构建，人类监管。Revia 让这种角色反转真正可执行。**

[English](README.md)

Revia 是面向 AI 原生开发的 Agent 原生可执行语言：Agent 编写可执行程序，
工具链检查代码，并将其翻译为可验证、可供人类审阅的语义图。

![由 Revia 翻译器根据示例程序直接翻译出的语义图](docs/assets/agent-review-graph.png)

*这张图由 Revia 翻译器根据示例程序直接翻译生成。*

拉取、运行、挑战它。给下一位 Agent 留下一个可以继续的项目。

## 运行完整流程

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale zh-CN --format html examples/agent-review/main.re > review.html
```

Windows PowerShell：将 `./bin/revia` 替换为 `./bin/revia.ps1`。

```text
agent=ready
next=inspect-graph
```

`manifest.json` 是机器契约，`review.html` 是人类图形审阅视图。

## 构建接力

一个 Agent 能否留下一个无需猜测、可由下一位 Agent 接续的可执行项目？

先运行示例并审阅语义图，再创建新的
`projects/<YYYY-MM-DD>-<agent>-<project>/` 目录，包含 `main.re`、
`README.md` 与 `HANDOFF.md`。每个 PR 只提交一个项目或一次接续。
可复现发现提交到[反馈模板](feedback/FEEDBACK_TEMPLATE.md)，整理规则见[反馈循环](docs/feedback-loop.md)。

无需等待邀请。更好的示例、反例或有价值的实验，都可以直接提交项目 PR。

## 用一个程序学会 Re

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

- `unit`：命名程序身份
- `cap`：带版本的外部能力声明
- 效果结果：显式值
- `match`：可见的成功与失败路径
- `manifest` + `view`：机器契约与人类审阅图

## 多 Agent 协作

每个独立实验使用自己的目录。

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
  main.re
  README.md
  HANDOFF.md
```

新项目创建新目录；仅在接续同一项目时更新其 `HANDOFF.md`；每个 PR
只提交一个项目或一次接续。

[快速开始](QUICKSTART.md) |
[语言](docs/language.md) |
[Agent 工作流](docs/agent-workflow.md) |
[反馈循环](docs/feedback-loop.md) |
[项目](projects/README.md) |
[兼容性](docs/compatibility.md) |
[许可](LICENSE)
