# Examples / 示例

- [`agent-review/`](agent-review/): check, run, manifest, graph / 检查、运行、清单、语义图完整流程
- [`agent-handoff-review/`](agent-handoff-review/): a reviewable Agent handoff workload with explicit risk state / 带显式风险状态的可审阅 Agent 接续工作负载
- [`agent-evidence-boundary.re`](agent-evidence-boundary.re): compare declared authority, one observed effect, and the generated review graph / 对照声明权限、一次观察到的效果与生成审阅图
- [`agent-workflow-brief.re`](agent-workflow-brief.re): a compact structured handoff record with explicit success and failure paths / 带显式成功与失败路径的结构化接续记录
- [`hello.re`](hello.re): smallest successful program / 最小成功程序
- [`agent-business-starter.re`](agent-business-starter.re): single-file editing exercise / 单文件编辑练习
- [`agent-args-policy.re`](agent-args-policy.re): read process arguments without interpreting payloads / 读取进程参数而不解释载荷
- [`agent-file-report.re`](agent-file-report.re): source-directory UTF-8 file read with an explicit failure status / 源目录 UTF-8 文件读取与显式失败状态
- [`diagnostic-error.re`](diagnostic-error.re): structured diagnostic, exit `65` / 结构化诊断，退出码 `65`
- [`adversarial-review/`](adversarial-review/): small programs for Agent-versus-Agent review challenges; answer keys are not public / 用于 Agent 对抗审阅挑战的小型程序，答案不公开
- [`agent-review-packet.re`](agent-review-packet.re): compact task, evidence, risk, and next-action packet / 紧凑的任务、证据、风险与下一步审阅包
- [`agent-release-check.re`](agent-release-check.re): release evidence with an explicit blocked stability outcome / 带明确稳定性阻塞结果的发行证据清单
- [`agent-counterexample.re`](agent-counterexample.re): falsifier handoff for a suspected false pass / 针对疑似错误通过的反例接续记录
- [`challenges/`](challenges/): reproducible challenges for review, release evidence, and false-pass resistance / 面向审阅、发行证据与错误通过防护的可复现挑战

Run commands from the repository root. / 请在仓库根目录运行命令。

## Suggested Progression / 建议路径

1. Run [`hello.re`](hello.re), then inspect a complete workflow in
   [`agent-review/`](agent-review/).
2. Compare the review packet, release check, and counterexample workloads.
3. Attack the deliberate fixtures in [`adversarial-review/`](adversarial-review/)
   and submit one reproducible project through
   [`challenges/`](challenges/README.md).

1. 运行[`hello.re`](hello.re)，再查看[`agent-review/`](agent-review/)中的完整工作流。
2. 对比审阅包、发行检查和反例 workload。
3. 攻击[`adversarial-review/`](adversarial-review/)中的故意缺陷，并通过
   [`challenges/`](challenges/README.md)提交一个可复现项目。
