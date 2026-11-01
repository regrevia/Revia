# Node Test Population Evidence / Node 测试人口证据

The tracked Node test runner emits one `revia.test-population@0.2.0` JSON
document on stdout. Node's JUnit report for each selected file is written to
stderr. CI retains both streams as the `node-test-population-<version>`
artifact, including when the test command fails.

tracked Node 测试 runner 在 stdout 输出一份
`revia.test-population@0.2.0` JSON 报告；每个 selected 文件的 Node JUnit
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
- `source_revision`: the exact Git commit checked out for this run.
- `working_tree_clean` / `worktree_status_digest`: whether the checkout had
  tracked or untracked changes both before and after execution, plus a digest
  derived from the before/after Git status output hashes. Raw path entries are
  not included in the report.
- `fixture_digest`: SHA-256 over the fixture schema, source revision, and
  intended test path set.
- `command` / `command_digest`: a path-free description and digest of the
  runner's direct per-test child invocation, selected file set, no-shell
  policy, and executable path digest. This records the invocation requested by
  the runner, not independent proof of PATH resolution or the CI wrapper.
  The raw absolute executable path is not included.
- `execution_log_digest`: SHA-256 over the exact combined JUnit log uploaded
  beside the JSON report.
- `evidence_digest`: SHA-256 over the canonical JSON report content excluding
  this field. `hash_algorithm` and `canonicalization` are explicit.

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
- `source_revision`：本次运行检出的精确 Git commit。
- `working_tree_clean` / `worktree_status_digest`：执行前后 checkout 是否包含
  tracked 或 untracked 修改，以及执行前后 Git status 输出摘要的 digest；报告不包含
  原始路径条目。
- `fixture_digest`：由 fixture schema、source revision 和 intended 测试路径集合
  计算的 SHA-256。
- `command` / `command_digest`：runner 请求的逐文件直接子进程调用、selected 文件
  集合、no-shell 策略和 executable 路径摘要的 path-free 描述与 digest。它记录
  runner 请求，不独立证明 PATH 解析结果或 CI 外层 wrapper；报告不含 executable
  绝对路径。
- `execution_log_digest`：与 JSON 并列上传的完整 JUnit 日志字节的 SHA-256。
- `evidence_digest`：排除该字段自身后，对 canonical JSON 报告内容计算的
  SHA-256；`hash_algorithm` 和 `canonicalization` 显式版本化。

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

`validateTrackedTestPopulationReport` checks the schema, population relations,
terminal states, fixture/command/report digests, Node floor, and the supplied
execution log digest. `working_tree_clean=false` means the report describes a
modified checkout and must not be presented as evidence for the bare commit
alone. These hashes provide consistency and tamper detection,
not a signature or authenticity root; GitHub's workflow/job/artifact metadata
supplies the external association between the report and the checked-out
commit.

`validateTrackedTestPopulationReport` 会校验 schema、人口关系、终态、
fixture/command/report digest、Node floor 以及调用方提供的执行日志 digest。
`working_tree_clean=false` 表示报告对应修改后的 checkout，不能单独当作裸 commit
的测试证据。这些 hash 用于一致性与篡改检测，不是签名或真实性根；报告与检出
commit 的外部关联由 GitHub workflow/job/artifact metadata 提供。
