<h1 align="center">Revia</h1>

<p align="center">
  <strong>面向 AI 原生时代的 Agent 原生可执行语言。</strong><br>
  Agent 编写可执行程序，人类审阅语义图。
</p>

<p align="center">
  <strong>闭源 V1 RC · 仅供评估 · 不用于生产</strong><br>
  当前运行时：`v1.0.0-rc.1`，仅 macOS arm64 完成原生实测
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

### 当前开发进展

私有开发线当前正在收尾 WP-307：为未来生成式前端契约准备固定版本的接口投影。
该工作尚未进入公开运行时。今天即可试用的入口是[示例路径](examples/README.md)，
其中包含[对抗性挑战](examples/challenges/README.md)。

## 运行完整流程

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia --version
./bin/revia --help
cp -R experiments/rc1/kit /tmp/revia-rc1-kit
# 将已校验的 release binary 安装到 /tmp/revia-rc1-kit/bin/revia，
# 再在该目录按 trial-manifest.json 中固定的命令数组执行。
```

候选仅在 macOS arm64 原生执行；其余目标由启动器明确返回 `69`，不会把旧预览版兼容性
误称为 RC 支持。试用步骤见[试用包](experiments/rc1/kit/)与[快速开始](QUICKSTART.md)。

```text
revia 1.0.0-rc.1
```

试用 manifest 固定了能力、项目流程、多模块与有界 Server 工作负载的 fixtures、命令、输出摘要和限制。

## 发行运行时

`v1.0.0-rc.1` 是固定版本、闭源的开发者评估运行时。它只发布一个 Darwin arm64 归档，
归档和可执行文件 SHA-256 见 [runtime/checksums.txt](runtime/checksums.txt)。有界试用流程与
退出码见[快速开始](QUICKSTART.md)。

## V1 RC1 试用边界

`v1.0.0-rc.1` 是 V1 深度试用里程碑，而非 Stable V1.0。其密封 Darwin arm64 导出绑定了
归档、二进制、评估许可、目标矩阵、能力证据、多模块证据和有界 Server 证据。其余五个目标
明确为 `pending`，不会发布占位二进制。[密封导出合同](docs/rc1-sealed-export-contract.md)、
[RC 许可](LICENSE-RC.md)与[跨平台流程](docs/cross-platform-evidence.md)定义该边界。

## 当前开发进展

公开 RC 可在唯一实测目标上运行。它的试用包公开能力、项目、多模块和 Server 实验，但不公开
编译器或运行时源码；它不宣称完整语言输出逐字节确定性、跨平台等价、生产托管、签名、SBOM、
attestation 或 immutable Stable V1.0。详见
[开发进展](docs/development-status.md)和[验证证据](docs/evidence.md)，
其中区分 RC 试用边界与 Stable V1.0 尚未满足的条件。

HTTP/JSON/SQLite 结果见[有界 Server 一致性](docs/server-conformance.md)。
[Stable V1.0 发行门禁](docs/stable-release-gate.md)仍待发行侧证据全部完成。

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

最快的参与方式是选择一个[挑战](examples/challenges/README.md)，从全新检出运行，
再提交最小的、有证据支撑的发现。

## 文档与入口

### 从这里开始

[快速开始](QUICKSTART.md) · [兼容性](docs/compatibility.md) ·
[集成指南](docs/integration.md) · [执行契约](docs/execution-contract.zh-CN.md)

### 了解 Revia

[架构](docs/architecture.zh-CN.md) · [语言](docs/language.md) ·
[语言参考](docs/language-reference.md) ·
[Server 一致性](docs/server-conformance.md) ·
[协议](docs/protocol.md) · [验证证据](docs/evidence.md) ·
[演进记录](docs/evolution.md) · [开发进展](docs/development-status.md) ·
[发行政策](docs/release-policy.md) ·
[RC1 许可与限制](docs/rc1-license-and-limitations.md) ·
[跨平台证据](docs/cross-platform-evidence.md) ·
[Stable V1.0 门禁](docs/stable-release-gate.md)

### 参与协作

[Agent 工作流](docs/agent-workflow.md) · [项目](projects/README.md) ·
[反馈循环](docs/feedback-loop.md) · [挑战](examples/challenges/README.md)

### 项目

[发行说明](RELEASE_NOTES.md) · [参与贡献](CONTRIBUTING.md)

### 社区

[Issues](https://github.com/tangshuang631/Revia/issues) ·
[Discussions](https://github.com/tangshuang631/Revia/discussions) ·
[宣传海报](docs/assets/revia-agents-write-humans-govern.png) ·
[API 与协议意见](feedback/OPINION_TEMPLATE.md)

## 许可

`v1.0.0-rc.1` 使用[开发评估许可](LICENSE-RC.md)：允许本地开发者与 Agent 评估、研究和
基准实验；不允许生产使用、商业托管、再分发或逆向工程。RC 声明见 [NOTICE-RC.md](NOTICE-RC.md)。
> English version: [README.md](README.md)
