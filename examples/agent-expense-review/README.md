# Agent Expense Review / Agent 费用审批

This is the largest checked-in Revia project example. It models a bounded
expense-review workflow as six revision-pinned modules:

- `domain.re`: domain types and state facts;
- `policy.re`: policy decisions;
- `persistence.re`: durable write boundary;
- `intake.re`: typed intake, retry and failure paths;
- `approval.re`: approval transition;
- `api.re`: public service-facing surface.

这是仓库内较完整的 Revia 项目样例。它用六个固定 revision 的模块表达有界费用审批流程：

- `domain.re`：领域类型与状态事实；
- `policy.re`：策略决策；
- `persistence.re`：持久化写入边界；
- `intake.re`：带类型的接收、重试与失败路径；
- `approval.re`：批准状态转换；
- `api.re`：面向服务的公开接口。

## Verify / 验证

Run from the repository root:

```bash
node src/cli/re.js project-check --format json examples/agent-expense-review
node src/cli/re.js project-translate \
  --locale en-US \
  --format json \
  examples/agent-expense-review
```

The first command checks module pins, source digests, capabilities, resources,
tasks, adapters, run cases and graph identity. The second command produces
human-review facts while preserving the same graph revision and semantic fact
digest across locales and output media.

请在仓库根目录运行。第一个命令检查模块 pin、源码摘要、能力、资源、任务、adapter、
run case 与图身份；第二个命令生成面向人类审阅的事实，同时保持不同 locale 和输出介质
共享同一 graph revision 与 semantic fact digest。

## What To Inspect / 审阅重点

1. Change one module source and update only its declared source digest.
2. Run `project-check` and record the first diagnostic.
3. Mutate a capability reference, resource access, task identity or response
   fixture and confirm the project fails closed.
4. Compare `project-translate --locale zh-CN` and `--locale en-US`; wording may
   change, but semantic identity and fact IDs must not.
5. Submit one focused project or reproducible report under `projects/` or
   `feedback/submissions/`.

1. 修改一个模块源码，并只更新对应的源码摘要。
2. 运行 `project-check`，记录第一个诊断。
3. 修改能力引用、资源访问、任务身份或 response fixture，确认项目 fail closed。
4. 对比 `zh-CN` 与 `en-US` 的 `project-translate`；文字可以变化，但语义身份和 fact ID
   不应变化。
5. 在 `projects/` 或 `feedback/submissions/` 提交一个聚焦项目或可复现报告。

## Boundary / 边界

This fixture demonstrates checked project structure and bounded adapter
contracts. It does not claim a production expense service, authentication,
TLS, distributed scheduling, arbitrary database drivers, or general A2A/MCP
interoperability.

该 fixture 展示经过检查的项目结构与有界 adapter 契约，不代表生产费用服务、认证、TLS、
分布式调度、任意数据库驱动或完整 A2A/MCP 互操作。
