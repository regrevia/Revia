# Revia

**面向 Agent 时代的原生可执行语言。Revia 代表软件创作路径与角色的反转：由 Agent 编写程序，人类审阅语义图。**

[English](README.md)

Revia 让能力、效果与失败路径从源码到执行始终清晰可见。

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
[项目](projects/README.md) |
[兼容性](docs/compatibility.md) |
[许可](LICENSE)
