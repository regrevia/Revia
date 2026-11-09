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

None of those files is a standalone program: each carries the module header the
project pins, so running the single-file checker on one exits `65` at `1:4` with
this diagnostic. That is about the entry point, not the code.

```text
examples/agent-expense-review/modules/api.re:1:4: unsupported-language-version (expected 0.1, got 1.0; phase header; rule header.language-version; repair choose 0.1)
```

Judge these files with `project-check` below, which reads them through
`project.json` and exits `0` when every pin and digest matches.

这些文件都不是独立程序：它们带的是项目固定 pin 的模块头，所以对单个文件运行
`check` 会在 `1:4` 以 `65` 退出，并报下面这条诊断。该诊断说的是入口，不是代码。

```text
examples/agent-expense-review/modules/api.re:1:4: unsupported-language-version (expected 0.1, got 1.0; phase header; rule header.language-version; repair choose 0.1)
```

请用下面的 `project-check` 判断这些文件；它通过 `project.json` 读取它们，所有
pin 与摘要都对得上时退出 `0`。

## Verify / 验证

Run from the repository root:

```bash
node src/cli/re.js project-check --format json examples/agent-expense-review
node src/cli/re.js project-translate \
  --locale en-US \
  --format json \
  examples/agent-expense-review
node src/cli/re.js project-projection \
  --routes examples/agent-expense-review/interface-routes.json \
  --out /tmp/revia-expense-client \
  examples/agent-expense-review
```

For the native surface-only check, use the versioned native candidate:

```bash
revia project-surface-check examples/agent-expense-review
```

native surface-only 检查使用版本化 native 候选：

```bash
revia project-surface-check examples/agent-expense-review
```

The first command checks module pins, source digests, capabilities, resources,
tasks, adapters, run cases and graph identity. The second command produces
human-review facts while preserving the same graph revision and semantic fact
digest across locales and output media.
The native surface check verifies authority linkage and required declaration
shape; it is not a replacement for the full Node normalizers or
`project-check`. It does not prove complete type semantics, task/Agent state
machine validity, adapter profile/configuration validity, control-flow
validity, runtime enforcement or successful execution.

请在仓库根目录运行。第一个命令检查模块 pin、源码摘要、能力、资源、任务、adapter、
run case 与图身份；第二个命令生成面向人类审阅的事实，同时保持不同 locale 和输出介质
共享同一 graph revision 与 semantic fact digest。
Native surface check 只验证 authority 绑定与声明的必要结构，不替代完整 Node normalizer
或 `project-check`；它不证明完整类型语义、task/Agent 状态机有效性、adapter profile/
配置有效性、控制流有效性、运行时强制或程序成功执行。

第三个命令生成确定性的 `types.ts`、`client.ts` 和 `projection.json`。route manifest
固定 graph revision、checked operation、adapter 契约、错误 variant、幂等要求和 HTTP
路径。生成 client 是有界集成产物，不是第二语义真源或完整生产 SDK。

The checked-in fixture `agent-expense-review-run.json` drives one bounded run
with `project-run`, which requires that argument:

```bash
node src/cli/re.js project-run \
  --fixture examples/agent-expense-review-run.json \
  examples/agent-expense-review
```

That command exits `0` and prints one JSON line: `"ok":true`, schema
`re.project-run-result@0.1.0`, and a receipt under schema
`re.project-run-receipt@0.3.0`. The receipt's `receipt_digest` is equal across
repeated runs of the same inputs, `replay` records `attempts: 2`, and
`typed_outcome.value.approved` is `true`. Without `--fixture` the CLI prints its
usage banner and exits `64`. The receipt is a preview project-run contract bound
to this fixture; it is not a production backend and does not extend the
single-file Node runtime.

A fixture that does not match the project is rejected the same way each time:
the result schema stays `re.project-run-result@0.1.0`, `"ok"` is `false`, the
process exits `65`, and `diagnostics` carries one code —
`missing-project-run-selection-field` for an empty object,
`project-run-graph-revision-mismatch` for an edited `graph_revision`, and
`project-run-case-not-found` for an unknown `case`.

仓库内固定的 `agent-expense-review-run.json` 驱动一次有界 `project-run`，该参数必填。
命令以 `0` 退出并输出一行 JSON：`"ok":true`、schema 为
`re.project-run-result@0.1.0`，receipt 的 schema 为 `re.project-run-receipt@0.3.0`。
相同输入重复运行时 `receipt_digest` 相同，`replay` 记录 `attempts: 2`，
`typed_outcome.value.approved` 为 `true`。缺少 `--fixture` 时 CLI 打印 usage 并以
`64` 退出。该 receipt 是绑定此 fixture 的预览 project-run 契约，不是生产后端，也不扩展
单文件 Node 运行时。

与项目不匹配的 fixture 每次都以同样方式被拒绝：结果 schema 仍为
`re.project-run-result@0.1.0`，`"ok"` 为 `false`，进程以 `65` 退出，`diagnostics`
带一个稳定 code——空对象为 `missing-project-run-selection-field`，被改动的
`graph_revision` 为 `project-run-graph-revision-mismatch`，未知 `case` 为
`project-run-case-not-found`。

## What To Inspect / 审阅重点

1. Copy the example to a scratch tree (`cp -R examples/agent-expense-review
   scratch/agent-expense-review`) so the checked-in pins stay untouched, then
   change one module source, then run
   `npm run re -- project-check --format json scratch/agent-expense-review`:
   it exits `65` with `project-module-source-digest-mismatch`, naming the
   module, its path, and the expected and actual digests. Set that actual
   digest as the module's `source_sha256`; the same command then exits `65`
   with `project-module-implementation-digest-mismatch` for the same module
   until its `implementation_digest` in `package_manifest` carries that value
   too. With both pins updated it exits `0`.
2. Build the native binary once (`cd native && cargo build --workspace
   --release --offline`), then run
   `native/target/release/revia project-surface-check` on the scratch copy and
   record its `re.native-project-surface-result@0.1.0` line. That line's
   `graph_revision` is a native digest over the module surfaces, so it does not
   equal the Node-pinned `graph_revision` in `interface-routes.json`.
3. Change a function capability call, its effect edge, or adapter binding
   (UID, reference, resource instance or access direction) and update the same
   two pins. `project-check` and the native surface check both still exit `0`,
   so the closed gate is the run: `npm run re -- project-run --fixture
   examples/agent-expense-review-run.json scratch/agent-expense-review` exits
   `65` with `project-run-graph-revision-mismatch`, because the fixture pins the
   pre-edit `graph_revision`.
4. Compare `project-translate --locale zh-CN` and `--locale en-US`; wording may
   change, but semantic identity and fact IDs must not.
5. Submit one focused project or reproducible report under `projects/` or
   `feedback/submissions/`.

1. 先把示例复制到 scratch 树（`cp -R examples/agent-expense-review
   scratch/agent-expense-review`），让仓库内的固定 pin 保持不变；在副本里修改
   一个模块源码，再运行
   `npm run re -- project-check --format json scratch/agent-expense-review`：
   它以 `65` 退出并给出 `project-module-source-digest-mismatch`，指明模块、路径、
   期望与实际摘要。把实际摘要写进该模块的 `source_sha256`；同一条命令仍会以 `65`
   退出，并对同一模块给出 `project-module-implementation-digest-mismatch`，直到
   `package_manifest` 里对应的 `implementation_digest` 也写入同一值。两处 pin 都
   更新后它以 `0` 退出。
2. 先构建一次 native 二进制（`cd native && cargo build --workspace --release
   --offline`），再运行
   `native/target/release/revia project-surface-check` 检查该副本，记录其
   `re.native-project-surface-result@0.1.0` 输出行。该行的 `graph_revision`
   是 native 对模块 surface 求的摘要，因此不等于 `interface-routes.json`
   中 Node 固定的 `graph_revision`。
3. 修改函数 capability call、对应 effect edge 或 adapter 绑定（UID、引用、资源实例或访问方向），并更新同样两处 pin。`project-check` 与 native surface check 都以 `0` 退出，真正拦下来的是运行：`npm run re -- project-run --fixture examples/agent-expense-review-run.json scratch/agent-expense-review` 会以 `65` 退出并给出 `project-run-graph-revision-mismatch`，因为 fixture 固定的是修改前的 `graph_revision`。
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
