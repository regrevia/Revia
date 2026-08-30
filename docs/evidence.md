# Evidence / 验证证据

This page records the public, reproducible evidence for `0.1-preview.1` and
the reviewed development line that informs the next release candidate.
本页记录 `0.1-preview.1` 的公开、可复现证据，以及为下一发行候选提供依据的
已审阅开发线。

## Release Evidence / 发行证据

| Item / 项目 | Result / 结果 |
|---|---|
| Release | [`0.1-preview.1`](https://github.com/tangshuang631/Revia/releases/tag/v0.1-preview.1) |
| Targets | macOS, Linux, Windows; `arm64`, `x86_64` |
| Native checks | `check`, `run`, `manifest`, diagnostics |
| Archive integrity | Archive and executable SHA-256 in [`runtime/checksums.txt`](../runtime/checksums.txt) |
| Public boundary | GitHub Actions [`Validate public boundary`](https://github.com/tangshuang631/Revia/actions/workflows/validate.yml) |
| Release smoke | GitHub Actions [`Smoke test release asset`](https://github.com/tangshuang631/Revia/actions/workflows/release-smoke.yml) |

## Development Evidence / 开发证据

The private implementation line has completed work packages through `WP-295`.
The evidence now covers graph and bytecode authority, bounded VM/task execution,
host-backed project effects, deterministic compact identity, external project
initialization/testing, fresh release evidence, a canonical comparison catalog,
and deterministic native CLI discovery. `WP-295` reports the compact identity
determinism fix and is awaiting final independent review. These are engineering
evidence for release planning; the current public binary remains `0.1-preview.1`
and does not expose the private implementation.

私有实现线已完成至 `WP-295`。现有证据覆盖语义图与字节码 authority、有界 VM/Task
执行、Host 支撑的项目 effect、确定性 compact identity、外部项目初始化与测试、fresh
发行证据、canonical 比较目录和确定性的 native CLI 可发现性。`WP-295` 报告 compact
identity 确定性修复，正在等待最终独立审阅。这些是发行规划的工程证据；
当前公开二进制仍为 `0.1-preview.1`，不公开私有实现。

## Reproducible Commands / 复现命令

```bash
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

Expected runtime output:

```text
agent=ready
next=inspect-graph
```

预期运行输出：

```text
agent=ready
next=inspect-graph
```

## Evidence Categories / 证据类别

- **Execution**: the example passes `check` and produces the expected output.
  **运行**：示例通过 `check` 并产生预期输出。
- **Contract**: `manifest` exposes capabilities, effects, error paths, and a
  graph revision for the same source file.
  **契约**：`manifest` 为同一源码暴露能力、效果、错误路径和图 revision。
- **Review**: `view` renders the translated semantic facts for human review.
  **审阅**：`view` 将翻译后的语义事实渲染为人类可审阅的图。
- **Distribution**: release archives and executables are checked against the
  published SHA-256 list.
  **发行**：发行归档和可执行文件依据公开 SHA-256 清单校验。

The current compact example is the reproducible execution entry point. Exact
byte identity of generated manifest or view output across fresh processes is
not a claim of `0.1-preview.1`; it remains a release-candidate correctness
item.

当前 compact 示例是可复现的执行入口。`0.1-preview.1` 不宣称全新进程之间生成的
manifest 或 view 字节完全一致；这仍是发行候选的正确性事项。

`scripts/test-compact-determinism.sh --report` and
`scripts/test-compact-determinism.ps1 -Mode Report` reproduce this status in
two fresh working directories. Current `0.1-preview.1` reports `PENDING`:
`check` is stable, while compact `check --write`, `manifest`, `view`, and
`build` receive newly allocated UIDs. Release candidates run the same probes
in `Require` mode and cannot publish until every compared checksum is identical.

`scripts/test-compact-determinism.sh --report` 与
`scripts/test-compact-determinism.ps1 -Mode Report` 会在两个全新工作目录复现该状态。
当前 `0.1-preview.1` 报告 `PENDING`：`check` 稳定，而 compact `check --write`、
`manifest`、`view` 与 `build` 会获得新分配的 UID。发行候选以 `Require` 模式运行同一
探针，只有所有校验摘要完全一致才可发布。

The public tree contains runnable artifacts, examples, documentation, and
licenses. The implementation remains behind the executable distribution
boundary.

公开树包含可运行产物、示例、文档和许可文件；实现位于可执行发行边界之后。

## Candidate Requirements / 候选要求

The current release does not include the `WP-295` runtime. A new candidate must
be rebuilt from the reviewed implementation and prove, on every declared
platform:

- identical `check`, `check --write`, `manifest`, `view`, `build`, and checksum
  trees across two fresh processes and directories;
- a passing public project template through `project-check` and `project-run`;
- native CLI smoke, archive and executable SHA-256, and the release gate before
  publication.

当前发行版不包含 `WP-295` 运行时。新候选必须基于完成审阅的实现重新构建，并在每个声明
平台证明：两个全新进程和目录的 `check`、`check --write`、`manifest`、`view`、`build`
及 checksum 树逐字节一致；公开项目模板通过 `project-check` 和 `project-run`；
原生 CLI、归档与可执行文件 SHA-256 以及发布前发行门禁全部通过。

## Challenge The Gate / 挑战发行门禁

The current `PENDING` result is intentionally public. Run the report in two
fresh directories, inspect every changed byte, and try to find a case that the
future `--require` gate would classify incorrectly. A useful submission includes
the source, platform, command transcript, compared files, and expected result.

当前 `PENDING` 结果是有意公开的边界。请在两个全新目录运行报告，检查每一个漂移字节，
并尝试寻找会被未来 `--require` 门禁错误分类的输入。有效提交应包含源码、平台、命令记录、
参与比较的文件和预期结果。
