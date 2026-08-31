# Development Status / 开发进展

Updated 2026-08-31.
更新日期：2026-08-31。

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
- A reproducible determinism probe. The current release reports `PENDING` for
  generated compact artifacts; the next candidate must pass the probe before
  publication.

`0.1-preview.1` 当前提供：

- 原生 `check`、`run`、`manifest` 与诊断校验。
- 支持 macOS、Linux、Windows 的 `arm64` 与 `x86_64` 目标。
- 完整的 `check -> run -> manifest -> view` 流程。
- 已发布归档与可执行文件 SHA-256 校验。
- 可复跑的确定性探针。当前发行版的 compact 派生产物报告为 `PENDING`；下一候选
  必须通过该探针才可发布。

## Development Milestones / 开发沉淀

| Work package | Layer / 层 | Status / 状态 | What it establishes / 形成的能力 |
|---|---|---|---|
| `WP-253` | Graph and canonical boundary / 语义图与规范化边界 | Reviewed | Checked graph, identity, canonical representation, and strict drift rejection |
| `WP-254` | Bytecode artifact boundary / 字节码产物边界 | Reviewed | Graph-bound translation, canonical artifact loading, and pre-effect verification |
| `WP-255` | VM execution foundation / VM 执行基础 | Reviewed | Bounded four-instruction execution, explicit capability bridge, deterministic trace and receipt |
| `WP-256` | Task runtime core / Task 运行时核心 | Reviewed | Request-bound task identity, retry/replay, first-reason cancellation, cleanup, and effect admission |
| `WP-257–WP-276` | Native execution and release foundations / Native 执行与发行基础 | Reviewed | Project authority, cache and direct-runner boundaries, server/task execution, native fault handling, and release evidence |
| `WP-277` | Native fault corpus release evidence / Native fault corpus 发行证据 | Reviewed | Five bounded fault cases, authority-bound evidence, and a release gate that verifies the evidence without changing fault semantics |
| `WP-278–WP-280` | Host-backed execution / Host 支撑执行 | Completed | Real stdout and sandboxed file effects, project entry integration, path-free observations, closed host faults, and atomic file publication |
| `WP-281` | Deterministic identity / 确定性身份 | Reviewed | Versioned compact identity allocation and fresh-process, two-directory byte comparison for canonical, manifest, views, and build trees |
| `WP-282–WP-283` | External project workflow and release evidence / 外部项目工作流与发行证据 | Completed | Canonical project initialization and testing plus fresh, empty-`PATH` release evidence over project, fault, and reproducibility workloads |
| `WP-284–WP-285` | Conformance catalog and CLI contract / 一致性目录与 CLI 契约 | Completed | Canonical four-domain comparison workloads and deterministic, path-free help/version discovery for the native command surface |
| `WP-295` | Compact identity determinism / Compact identity 确定性 | Reviewed | Reuses the stable identity path across compact projections and targets fresh-process byte equality for checked artifacts |
| `WP-296` | Native capability release evidence / Native capability 发行证据 | Awaiting final review | Closes the release-evidence authority boundary and records the next candidate handoff |

`WP-281` through `WP-295` reviewed entries have independent review evidence. Later
completed entries have passed their internal focused and workspace gates and
remain development-line evidence. None of these milestones imply that the
`0.1-preview.1` download already contains the capability.

`WP-281` 至 `WP-295` 的 reviewed 条目具有独立审阅证据；后续 completed 条目已通过各自的
focused 与 workspace 内部门禁，仍属于开发线证据。任何条目都不表示
`0.1-preview.1` 下载包已经包含对应能力。

## Current Boundary / 当前边界

The public binary remains `0.1-preview.1`. The next candidate will be created
only after the reviewed development layers are integrated, rebuilt, and pass
the release gates for their declared platforms.

当前公开二进制仍为 `0.1-preview.1`。后续候选版本只有在已审阅开发层完成集成、
重新构建，并通过声明平台的发行门禁后才会创建。

Latest development handoff: `WP-296 native capability release evidence closeout`,
following the reviewed `WP-295` determinism work. It is still in development
review. The current public binary remains `0.1-preview.1`, so these development
results are not capabilities of the release until a reviewed candidate is
rebuilt and passes all release gates.

最新开发交接为 `WP-296 native capability release evidence closeout`，承接已审阅的
`WP-295` 确定性工作，仍在开发审阅中。当前公开二进制仍为 `0.1-preview.1`；
这些开发结果只有在经过审阅的新候选重新构建并通过全部发行门禁后，才会进入公开能力。

## Active Work Package / 当前工作包

The next public candidate must rebuild the runtime, rerun the two-directory
fresh-process determinism probe, verify the runtime JSON contracts, and pass
the six-target release gate before publication. Project-template validation is
pending the public manifest and fixture inputs.

下一公开候选必须重新构建运行时，重跑两个独立目录的全新进程确定性探针，验证运行时
JSON 契约，并在发布前通过六目标发行门禁。项目模板验证等待公开 manifest 和 fixture
输入文件到位。

## Follow The Work / 跟进进展

- [Release notes](../RELEASE_NOTES.md)
- [Architecture](architecture.md)
- [Evidence](evidence.md)
- [Compatibility](compatibility.md)
- [Agent projects](../projects/README.md)
- [Feedback loop](feedback-loop.md)
