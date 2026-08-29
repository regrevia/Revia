<h1 align="center">Revia</h1>

<p align="center">
  <strong>面向 AI 原生时代的 Agent 原生可执行语言。</strong><br>
  Agent 编写可执行程序，人类审阅语义图。
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/assets/agent-review-graph.png" alt="由 Revia 翻译器根据 Agent 审阅示例生成的语义图" width="920">
</p>

Revia 将 Agent 编写的程序转换为可执行契约，让人类能够直接审阅：显式能力、
可见效果，以及可检查的成功与失败路径。

上图是 Revia 翻译器根据
[`examples/agent-review/main.re`](examples/agent-review/main.re) 输出的语义事实整理出的简洁审阅图。

## 查看执行契约

[执行契约](docs/execution-contract.zh-CN.md)展示一份 `.re` 源码如何生成已检查语义图、
机器 manifest、人类语义视图并完成有界运行。需要体验显式状态、风险与接续输出时，
从[Agent 接续审阅示例](examples/agent-handoff-review/)或
[工作流简报](examples/agent-workflow-brief.re)开始。

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

`manifest.json` 是机器契约，`review.html` 是人类审阅视图，
`view --format svg` 可生成结构化语义视图。

## 发行运行时

`0.1-preview.1` 是为已文档化的单文件命令面提供的、固定版本的闭源二进制运行时。
首次运行会下载、校验并缓存对应可执行文件。环境要求、离线复用、退出码、构建产物与
安装恢复见[快速开始](QUICKSTART.md)。

## 当前开发进展

公开发行版已经可以直接运行。开发线已完成至 `WP-285`，包括确定性 compact identity、
Host 支撑的项目执行、可复现项目证据和 native 一致性目录。当前公开二进制的 compact
派生产物在全新进程间仍报告 `PENDING`；下一候选必须通过该门禁才可发布。详见
[开发进展](docs/development-status.md)和[验证证据](docs/evidence.md)，
其中区分了当前公开边界、开发沉淀与尚未进入 `0.1-preview.1` 的内容。

## Revia 让什么变得明确

- **能力**：外部能力显式声明并固定版本。
- **行为**：效果返回带类型的结果，不隐藏在隐式控制流中。
- **审阅**：`manifest` 与 `view` 将同一程序同时交给机器和人类检查。

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

最小完整审阅工作负载见[工作流简报](examples/agent-workflow-brief.re)。
它输出结构化接续记录，同时让能力声明、结果分支和退出状态在生成契约中保持可见。

## 与其他 Agent 构建接力

每个独立实验使用自己的目录：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
  main.re
  README.md
  HANDOFF.md
```

独立工作创建新目录；只有接续同一项目时才更新其 `HANDOFF.md`；
每个 PR 只提交一个项目或一次接续。

更好的示例、反例或可复现发现都欢迎提交。从
[项目模板](projects/_template/) 开始，集中反馈使用[反馈模板](feedback/FEEDBACK_TEMPLATE.md)。

## 文档与入口

### 从这里开始

[快速开始](QUICKSTART.md) · [兼容性](docs/compatibility.md) ·
[执行契约](docs/execution-contract.zh-CN.md)

### 了解 Revia

[架构](docs/architecture.zh-CN.md) · [语言](docs/language.md) ·
[语言参考](docs/language-reference.md) ·
[协议](docs/protocol.md) · [验证证据](docs/evidence.md) ·
[演进记录](docs/evolution.md) · [开发进展](docs/development-status.md) ·
[发行政策](docs/release-policy.md)

### 参与协作

[Agent 工作流](docs/agent-workflow.md) · [项目](projects/README.md) ·
[反馈循环](docs/feedback-loop.md)

### 项目

[发行说明](RELEASE_NOTES.md) · [参与贡献](CONTRIBUTING.md)

### 社区

[Issues](https://github.com/tangshuang631/Revia/issues) ·
[Discussions](https://github.com/tangshuang631/Revia/discussions) ·
[宣传海报](docs/assets/revia-agents-write-humans-govern.png)

## 许可

Revia 使用 [Revia Technical Preview License 0.1](LICENSE)。
第三方运行时许可见 [NOTICE.md](NOTICE.md)。
