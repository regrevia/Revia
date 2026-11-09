# Projects / 项目

This directory is for runnable Revia projects and reproducible experiments
that are larger than a single example. It is the right place to compare a
workflow across revisions or languages while keeping the input, commands, and
result evidence together.

本目录用于存放大于单个样例的可运行 Revia 项目与可复现实验。跨版本或跨语言对比时，应将
输入、命令与结果证据放在同一个项目目录中。

## Start / 创建

Copy `_template` to / 将 `_template` 复制到：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
```

Use lowercase ASCII letters, digits, and hyphens. Keep the manifest and module
path consistent. Each project includes:
名称使用小写 ASCII 字母、数字和连字符，并包含：

- `project.json`: exact project/package/module manifest / 精确项目、包与模块清单
- `modules/main.re`: runnable module source / 可运行模块源码
- `README.md`: goal, commands, result / 目标、命令、结果
- `HANDOFF.md`: state for the next Agent / 下一位 Agent 的接续状态

Write `README.md` and `HANDOFF.md` in English and Chinese.
`README.md` 与 `HANDOFF.md` 使用中英双语。

The checked-in `_template` is a checked project seed. Verify it with the
source CLI's `project-check --format json`; projects with Agent or business
facts can also use `project-translate`. Native
`project-build`/`project-run` require the versioned candidate contract and
target evidence. Do not replace its digests by hand.
`project-init <directory>` is a native command, not a source subcommand: build
the release binary once (`cd native && cargo build --workspace --release
--offline`) and run `native/target/release/revia project-init <directory>`,
which exits `0` with `re.native-project-init@0.1.0`. The starter it writes is
sealed to a `re 0.1 compact` module, so the source CLI's
`project-check --format json` rejects it with exit `65` and
`unsupported-module-surface-header`, and the native surface check rejects it
with `native-project-module-surface-header-unsupported`. Verify the generated
starter with `native/target/release/revia project-check <directory>` (exit `0`,
`re.native-project-graph@0.1.0`). Do not rewrite its module header by hand: the
pinned module digest then stops matching, and no reseal command ships.

仓库内 `_template` 是可检查的项目起始项目。使用源码 CLI 的 `project-check --format json` 验证；
包含 Agent 或业务事实的项目还可以使用 `project-translate`。native
`project-build`/`project-run` 需要版本化候选契约与目标证据。不要手工替换摘要。
`project-init <directory>` 是 native 命令，不是源码子命令：先构建一次 release
二进制（`cd native && cargo build --workspace --release --offline`），再运行
`native/target/release/revia project-init <directory>`，它以 `0` 退出并给出
`re.native-project-init@0.1.0`。它写出的起始项目封存的是 `re 0.1 compact` 模块，
因此源码 CLI 的 `project-check --format json` 会以 `65` 退出并给出
`unsupported-module-surface-header`，native surface check 也会以
`native-project-module-surface-header-unsupported` 拒绝它。请用
`native/target/release/revia project-check <directory>` 验证生成的起始项目（以 `0`
退出，schema 为 `re.native-project-graph@0.1.0`）。不要手工改写它的模块头：固定的
模块摘要随后会对不上，而当前不提供重新封存的命令。

## Command Evidence / 命令证据边界

| Command | Public source status |
|---|---|
| `node src/cli/re.js project-check --format json` | Checked project graph and source authority |
| `node src/cli/re.js project-translate` | Human-review projection for projects with Agent/business facts |
| native `revia project-check` | Native project-manifest and module-surface check |
| native `revia project-surface-check` | Native `re 1.0` module-surface authority check without translation |
| native `revia project-test/build/run` | `project-test` reports an explicit module-surface boundary; build/run require versioned candidate contracts |

命令证据边界：

| 命令 | 公开源码状态 |
|---|---|
| `node src/cli/re.js project-check --format json` | 检查项目图与源码 authority |
| `node src/cli/re.js project-translate` | 面向含 Agent/业务事实项目的人类审阅投影 |
| native `revia project-check` | native 项目 manifest 与 module surface 检查 |
| native `revia project-surface-check` | native `re 1.0` module surface authority 检查，不执行 translation |
| native `revia project-test/build/run` | `project-test` 会明确报告 module-surface 边界；build/run 需要版本化候选契约 |

Every independent experiment gets a new directory.
每个独立实验创建新目录。

Do not treat a project directory as a package registry or production service.
Dependencies, host services, and protocol adapters must be declared in the
project README and remain outside the language-core claim.

项目目录不是包注册中心或生产服务。依赖、宿主服务和协议适配器必须在项目 README 中明确，
不能扩大为语言核心能力声明。

## Continue / 接续

Work only inside the selected project. Update its `HANDOFF.md` with the Agent,
date, change, verification, and one next task.
只修改选中的项目，并在其 `HANDOFF.md` 中记录 Agent、日期、改动、验证与一个下一任务。

Submit one project or one continuation per pull request.
每个 PR 只提交一个项目或一次接续。
