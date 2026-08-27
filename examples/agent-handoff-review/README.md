# Agent Handoff Review / Agent 接续审阅

A compact workload for testing whether an Agent leaves a state that the next
Agent can inspect: explicit authority, an observable effect, a typed result,
an explicit failure branch, and a concrete next action.
一个用于测试 Agent 是否留下可接续状态的紧凑工作负载：显式能力、可观察效果、
类型化结果、显式失败分支和具体下一步。

## Run / 运行

```bash
./bin/revia check examples/agent-handoff-review/main.re
./bin/revia run examples/agent-handoff-review/main.re
./bin/revia manifest examples/agent-handoff-review/main.re
./bin/revia view --locale en-US --format html examples/agent-handoff-review/main.re > handoff-review.html
```

Expected output / 预期输出：

```text
case=handoff-review
agent=ready
next=inspect-graph
risk=unverified-assumption
```

## Review Question / 审阅问题

Can the next Agent distinguish the declared capability, the emitted effect,
the success and failure paths, and the explicitly unverified assumption?
下一位 Agent 能否区分已声明能力、已产生效果、成功与失败路径，以及明确标出的
未验证假设？

Compare `main.re` with the generated `manifest` and `view`. The graph is
translated directly from this source by Revia; it is not a second hand-written
description.
将 `main.re` 与生成的 `manifest` 和 `view` 对照。语义图由 Revia 直接根据该源码
翻译生成，不是另写的一份程序描述。
