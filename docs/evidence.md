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

The private implementation line has completed reviewed foundations through
`WP-277`, including graph, bytecode, VM, bounded task execution, native
execution boundaries, and a five-case fault corpus release report. These are
engineering evidence for release planning; the current public binary remains
`0.1-preview.1` and does not expose the private implementation.

私有实现线已完成至 `WP-277` 的审阅基础，包括语义图、字节码、VM、有界 Task 执行、
Native 执行边界和五类 fault corpus 发行报告。这些是发行规划的工程证据；当前
公开二进制仍为 `0.1-preview.1`，不公开私有实现。

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

The public tree contains runnable artifacts, examples, documentation, and
licenses. The implementation remains behind the executable distribution
boundary.

公开树包含可运行产物、示例、文档和许可文件；实现位于可执行发行边界之后。
