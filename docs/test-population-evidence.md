# Node Test Population Evidence / Node 测试人口证据

The tracked Node test runner emits one `revia.test-population@0.1.0` JSON
document on stdout. Node's JUnit report for each selected file is written to
stderr. CI retains both streams as the `node-test-population-<version>`
artifact, including when the test command fails.

tracked Node 测试 runner 在 stdout 输出一份
`revia.test-population@0.1.0` JSON 报告；每个 selected 文件的 Node JUnit
报告写入 stderr。CI 将两种输出保存为
`node-test-population-<version>` artifact，测试失败时也会保留。

## Populations / 人口

- `intended`: test paths returned by `git ls-files test/*.test.js` from the
  current checkout's index. CI checks out the workflow commit with a clean
  index, so this is the committed suite for that run.
- `discovered`: regular `.test.js` files found recursively under `test/`.
  Symlinks and unreadable directory entries fail closed.
- `selected`: `intended` for the default full run, or the validated explicit
  subset passed to `npm test -- <path...>`.
- `executed`: selected paths whose child Node process emitted a non-empty
  JUnit `tests` count. The `executions` array records each selected path's
  process `status`, `signal`, test count, and terminal `outcome`
  (`passed`, `failed`, `no-report`, or `signaled`).

- `intended`：当前 checkout index 中由
  `git ls-files test/*.test.js` 返回的测试路径。CI 对 workflow commit 做干净
  checkout，因此对应本次提交的测试集合。
- `discovered`：在 `test/` 下递归发现的常规 `.test.js` 文件。符号链接或不可读
  目录会 fail closed。
- `selected`：默认全量运行时等于 `intended`；显式运行
  `npm test -- <path...>` 时是经过校验的子集。
- `executed`：其 Node 子进程产生非空 JUnit `tests` 数量的 selected 路径。
  `executions` 为每个 selected 路径记录进程 `status`、`signal`、测试数及终态
  （`passed`、`failed`、`no-report` 或 `signaled`）。

## Completion / 完成判定

`execution_status` reports the aggregate child-test result. `status` is the
runner exit status. `complete` means a successful full-population run and is
true only when all four populations are exactly equal, every selected file
emitted test evidence, and every child exited successfully without a signal.
When the default full run has a population mismatch, `status` is non-zero even
if every selected child passed. An explicit subset can pass with `status=0`,
but `complete` remains false unless it covers the full intended population
and meets the other completion conditions.

`execution_status` 是子测试进程的汇总结果；`status` 是 runner 最终退出状态。
`complete` 表示完整人口成功运行，仅在四类人口逐项相等、每个 selected 文件
都有测试证据且子进程均成功退出、没有 signal 时为 true。默认全量运行若人口
不一致，即使已选子进程全部通过，`status` 仍非零。显式子集可返回
`status=0`；除非该子集恰好覆盖完整 intended 人口并满足其他完成条件，
否则 `complete` 为 false。

An empty intended or discovered population is invalid. A no-defect full run
must pass; a must-fail control with an extra discovered file, missing execution
report, missing child exit status, non-zero child status, or signal must not
produce `complete=true`.

`intended` 或 `discovered` 为空都无效。无缺陷全量控制必须通过；若 must-fail
控制中出现额外 discovered 文件、缺失执行报告、子进程缺少退出状态、非零退出
或 signal，则不得产生 `complete=true`。
