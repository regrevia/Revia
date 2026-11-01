# Examples / 示例

Run commands from the repository root. The examples are grouped by the
question they answer, so a first-time reader can move from one small program
to a complete Agent workflow.

请在仓库根目录运行命令。样例按问题分类，便于从最小程序逐步进入完整 Agent 工作流。

## First Run / 第一次运行

- [`hello.re`](hello.re): smallest successful program / 最小成功程序
- [`diagnostic-error.re`](diagnostic-error.re): structured diagnostic and exit
  `65` / 结构化诊断与退出码 `65`

## Capabilities And Control Flow / 能力与控制流

- [`args-check.re`](args-check.re): process arguments / 进程参数
- [`read-check.re`](read-check.re): sandboxed file read / 沙箱文件读取
- [`read-encoding.re`](read-encoding.re): explicit text encoding / 显式文本编码
- [`write-check.re`](write-check.re): exact bytes write / 精确 bytes 写入

## Design Fixtures / 设计样例

The following files document syntax and semantic candidates that are not
currently executable. `re check` is expected to return exit `65` with an
`unexpected-token` diagnostic for each; they are regression/design fixtures,
not first-run programs.

以下文件记录尚未可执行的语法与语义候选。每个文件使用 `re check` 时均预期返回退出码
`65` 和 `unexpected-token` 诊断；它们是回归/设计 fixture，不是首次运行样例。

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
