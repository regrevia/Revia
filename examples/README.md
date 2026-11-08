# Examples / 示例

Run commands from the repository root. The examples are grouped by the
question they answer, so a first-time reader can move from one small program
to a complete Agent workflow.

请在仓库根目录运行命令。样例按问题分类，便于从最小程序逐步进入完整 Agent 工作流。

## First Run / 第一次运行

- [`hello.re`](hello.re): smallest successful program / 最小成功程序
- [`diagnostic-error.re`](diagnostic-error.re): the argument-name diagnostic,
  reported by the Node `check` and by the native `translate`/`compile` (see
  below) / 参数名诊断，由 Node `check` 与原生 `translate`/`compile` 给出（见下）

The two toolchains reach that diagnostic at different stages, so the command
differs. The Node reference toolchain reports it from `check`:
`npm run re -- check examples/diagnostic-error.re` exits `65` and prints one
diagnostic line on stderr. The native toolchain's `revia check` is a parser only
and answers with `re.native-parser-result@0.1.0`, `"ok": true`, exit `0`; there
the diagnostic appears from `revia translate` or `revia compile`, which exit `65`
with `{"diagnostics":[{"code":"unknown-argument"}],"ok":false,
"schema":"re.native-graph-result@0.1.0"}`.

两个工具链在不同阶段给出该诊断，命令因此不同：Node 参考工具链由 `check` 给出，
`npm run re -- check examples/diagnostic-error.re` 退出 `65`，在 stderr 打印一行诊断；
原生工具链的 `revia check` 只做解析，返回 `re.native-parser-result@0.1.0`、
`"ok": true`、退出 `0`，诊断由 `revia translate` 或 `revia compile` 给出，
退出 `65`，输出 `{"diagnostics":[{"code":"unknown-argument"}],"ok":false,
"schema":"re.native-graph-result@0.1.0"}`。

## Capabilities And Control Flow / 能力与控制流

- [`args-check.re`](args-check.re): process arguments / 进程参数
- [`read-check.re`](read-check.re): sandboxed file read / 沙箱文件读取
- [`read-encoding.re`](read-encoding.re): explicit text encoding / 显式文本编码
- [`write-check.re`](write-check.re): exact bytes write / 精确 bytes 写入

All four run from the repository root. The file-reading pair reads
`input.txt` beside the program: paths resolve relative to the directory of the
program file, not the directory the command starts in, so
`node src/cli/re.js run examples/read-check.re` prints nothing and exits `0`,
and removing `examples/input.txt` makes the same command exit `2` through the
program's own `err` branch. `write-check.re` writes `examples/output.txt`, which
is ignored by Git; the file holds the three bytes `41 00 42`.

四个样例都可以从仓库根目录运行。读取文件的两个样例读的是程序文件旁边的
`input.txt`：路径相对于程序文件所在目录解析，而不是命令启动的目录，所以
`node src/cli/re.js run examples/read-check.re` 没有输出、退出码 `0`；删掉
`examples/input.txt` 后同一命令退出 `2`，走的是程序自己的 `err` 分支。
`write-check.re` 会写出 `examples/output.txt`，该文件已被 Git 忽略，内容是
`41 00 42` 三个字节。

## Design Fixtures / 设计样例

The following files document syntax and semantic candidates that are not
currently executable. Both `npm run re -- check` and `revia check` return exit
`65` with an `unexpected-token` diagnostic for each; they are regression/design
fixtures, not first-run programs.

以下文件记录尚未可执行的语法与语义候选。`npm run re -- check` 与 `revia check`
对每个文件均返回退出码 `65` 和 `unexpected-token` 诊断；它们是回归/设计 fixture，
不是首次运行样例。

- [`cf-branch.re`](cf-branch.re): pending `match` lowering / 待定 `match` lowering
- [`cf-loop.re`](cf-loop.re): pending `loop` lowering / 待定 `loop` lowering
- [`cf-retry.re`](cf-retry.re): pending URL/retry lowering / 待定 URL/重试 lowering
- [`cf-concurrent.re`](cf-concurrent.re): pending concurrency syntax /
  待定并发语法
- [`p0-demo-runtime.re`](p0-demo-runtime.re): pending runtime syntax /
  待定 runtime 语法
- [`schema-ops.re`](schema-ops.re): pending schema operation syntax /
  待定 schema operation 语法

## Agent Authoring And Review / Agent 编写与审阅

- [`agent-review/`](agent-review/): check, run, manifest, and semantic graph /
  检查、运行、清单与语义图完整流程
- [`agent-handoff-review/`](agent-handoff-review/): reviewable handoff with
  explicit risk state / 带显式风险状态的可审阅接续
- [`agent-review-packet.re`](agent-review-packet.re): task, evidence, risk, and
  next action packet / 任务、证据、风险与下一步审阅包
- [`agent-workflow-brief.re`](agent-workflow-brief.re): explicit success and
  failure paths / 显式成功与失败路径
- [`agent-evidence-boundary.re`](agent-evidence-boundary.re): declared
  authority versus observed effect / 声明权限与观察效果对照
- [`agent-counterexample.re`](agent-counterexample.re): falsifier handoff for a
  suspected false pass / 疑似错误通过的反例接续
- [`agent-release-check.re`](agent-release-check.re): blocked release outcome /
  明确阻塞的发行结果
- [`agent-evidence-boundary/`](agent-evidence-boundary/): the same
  evidence-boundary program with its run commands and review framing /
  同一个证据边界程序，附带运行命令与审阅框架
- [`agent-business-starter.re`](agent-business-starter.re): one decision line,
  the file to edit before inspecting the graph / 一行决策输出，先改写再查看图
- [`agent-args-policy.re`](agent-args-policy.re): read process arguments
  without echoing the payload / 读取进程参数而不回显载荷
- [`agent-file-report.re`](agent-file-report.re): sandboxed UTF-8 report read
  with an explicit failure status / 沙箱 UTF-8 报告读取与显式失败状态
- [`agent-expense-review/`](agent-expense-review/): six-module project fixture
  with review and handoff instructions / 带审阅与接续说明的六模块项目 fixture

## Challenges And Approval / 挑战与批准

- [`adversarial-review/`](adversarial-review/): deliberate Agent-versus-Agent
  review challenges / Agent 对抗审阅挑战
- [`challenges/`](challenges/): reproducible review and release challenges /
  可复现审阅与发行挑战
- [`reviewed-file-plan/`](reviewed-file-plan/): source-digest approval,
  denial, stale approval, effects, and recovery / 源码摘要批准、拒绝、过期批准、
  effect 与恢复

Run commands from the repository root. / 请在仓库根目录运行命令。

## Suggested Progression / 建议路径

1. Run [`hello.re`](hello.re), then inspect
   [`agent-review/`](agent-review/).
2. Try the runnable capability examples; consult Design Fixtures separately
   for syntax candidates that are not accepted by the current parser.
3. Compare the review packet, release check, and counterexample workloads.
4. Attack [`adversarial-review/`](adversarial-review/) and record a
   reproducible result under [`projects/`](../projects/README.md).

1. 运行[`hello.re`](hello.re)，再查看[`agent-review/`](agent-review/)中的完整工作流。
2. 尝试可运行的能力样例；未被当前 parser 接受的语法候选见独立的设计样例章节。
3. 对比审阅包、发行检查和反例 workload。
4. 攻击[`adversarial-review/`](adversarial-review/)，并在
   [`projects/`](../projects/README.md)中记录可复现结果。
