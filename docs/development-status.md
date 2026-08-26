# Development Status / 开发进展

Updated 2026-08-26.
更新日期：2026-08-26。

Revia has a runnable public release and an active implementation line. The
public release is the executable starting point; the development line records
the next verified execution layers being prepared for later distribution.

Revia 已有可运行的公开发行版，同时持续推进实现线。公开发行版是当前可直接
使用的入口；开发线记录正在为后续发行准备的、已经完成验证的执行层。

## Public Release / 公开发行

`0.1-preview.1` currently provides:

- Native `check`, `run`, `manifest`, and diagnostic verification.
- macOS, Linux, and Windows targets on `arm64` and `x86_64`.
- A complete `check -> run -> manifest -> view` workflow.
- Published archive and executable SHA-256 verification.

`0.1-preview.1` 当前提供：

- 原生 `check`、`run`、`manifest` 与诊断校验。
- 支持 macOS、Linux、Windows 的 `arm64` 与 `x86_64` 目标。
- 完整的 `check -> run -> manifest -> view` 流程。
- 已发布归档与可执行文件 SHA-256 校验。

## Reviewed Development Milestones / 已审阅开发沉淀

| Work package | Layer / 层 | Status / 状态 | What it establishes / 形成的能力 |
|---|---|---|---|
| `WP-253` | Graph and canonical boundary / 语义图与规范化边界 | Reviewed | Checked graph, identity, canonical representation, and strict drift rejection |
| `WP-254` | Bytecode artifact boundary / 字节码产物边界 | Reviewed | Graph-bound translation, canonical artifact loading, and pre-effect verification |
| `WP-255` | VM execution foundation / VM 执行基础 | Reviewed | Bounded four-instruction execution, explicit capability bridge, deterministic trace and receipt |
| `WP-256` | Task runtime core / Task 运行时核心 | Reviewed | Request-bound task identity, retry/replay, first-reason cancellation, cleanup, and effect admission |

上述开发沉淀均已完成对应的 focused verification 和审阅闭环。它们属于当前发行
线之后的开发进展，不等同于 `0.1-preview.1` 下载包已经包含全部能力。

## Current Boundary / 当前边界

The public binary remains `0.1-preview.1`. The next candidate will be created
only after the reviewed development layers are integrated, rebuilt, and pass
the release gates for their declared platforms.

当前公开二进制仍为 `0.1-preview.1`。后续候选版本只有在已审阅开发层完成集成、
重新构建，并通过声明平台的发行门禁后才会创建。

Latest reviewed work package: `WP-256 native task runtime core`. It is ready
for the next implementation handoff; no later work package is represented here
until it has an auditable result.

最新已审阅工作包为 `WP-256 native task runtime core`，目前已交回下一实现接力。
后续工作包只有形成可审计结果后才会写入此页。

## Follow The Work / 跟进进展

- [Release notes](../RELEASE_NOTES.md)
- [Architecture](architecture.md)
- [Evidence](evidence.md)
- [Compatibility](compatibility.md)
- [Agent projects](../projects/README.md)
- [Feedback loop](feedback-loop.md)
