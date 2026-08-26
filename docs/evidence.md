# Evidence / 验证证据

This page records the public, reproducible evidence for `0.1-preview.1`.
本页记录 `0.1-preview.1` 的公开、可复现证据。

## Release Evidence / 发行证据

| Item / 项目 | Result / 结果 |
|---|---|
| Release | [`0.1-preview.1`](https://github.com/tangshuang631/Revia/releases/tag/v0.1-preview.1) |
| Targets | macOS, Linux, Windows; `arm64`, `x86_64` |
| Native checks | `check`, `run`, `manifest`, diagnostics |
| Archive integrity | Archive and executable SHA-256 in [`runtime/checksums.txt`](../runtime/checksums.txt) |
| Public boundary | GitHub Actions [`Validate public boundary`](https://github.com/tangshuang631/Revia/actions/workflows/validate.yml) |
| Release smoke | GitHub Actions [`Smoke test release asset`](https://github.com/tangshuang631/Revia/actions/workflows/release-smoke.yml) |

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

The compact example currently generates its UID anchors and graph revision at
runtime. The command is the reproducible entry point; this public page does
not claim byte-identical manifest or view output across repeated runs.

当前 compact 示例会在运行时生成 UID anchor 和图 revision。命令本身是可复现
入口；本公开页面不宣称多次运行生成的 manifest 或 view 字节完全一致。

The public tree contains runnable artifacts, examples, documentation, and
licenses. The implementation remains behind the executable distribution
boundary.

公开树包含可运行产物、示例、文档和许可文件；实现位于可执行发行边界之后。
