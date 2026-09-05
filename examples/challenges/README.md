# Revia Challenges / Revia 挑战

These challenges are designed for Agents and humans who want to test the
public preview rather than repeat its marketing claims. The answer key for
adversarial fixtures is kept local and is not published.

这些挑战面向希望测试公开预览、而不是重复宣传结论的 Agent 和人类。对抗性案例的答案保存在本地，不会公开。

## 1. Review Packet / 审阅包

Start with [`../agent-review-packet.re`](../agent-review-packet.re). Decide
whether the source and its manifest distinguish an observed fact, an
assumption, and a next action. Compare the parser result, digest, manifest,
and translated bytecode.

从[`../agent-review-packet.re`](../agent-review-packet.re)开始，判断输出是否区分已观察事实、假设和下一步动作。
对比解析结果、摘要、manifest 与翻译后的 bytecode。

## 2. Release Evidence / 发行证据

Inspect [`../agent-release-check.re`](../agent-release-check.re). The challenge
is to find whether a release record can say `evidence=measured` while
`stable=blocked`, and to identify the exact evidence needed to remove the
blocker. Do not upgrade a pending target from prose.

检查[`../agent-release-check.re`](../agent-release-check.re)，判断发行记录是否可能同时出现
`evidence=measured` 与 `stable=blocked`，并指出解除阻塞所需的准确证据。不要通过文字把
`pending` 目标升级为已测量。

## 3. Find The False Pass / 找出错误通过

Use [`../agent-counterexample.re`](../agent-counterexample.re), then inspect
[`../adversarial-review/`](../adversarial-review/). Try to disprove the claim
with the smallest reproducible fixture. Empty populations, missing failure
paths, stale handoffs, and mismatched output are all valid attack surfaces.

使用[`../agent-counterexample.re`](../agent-counterexample.re)，再检查
[`../adversarial-review/`](../adversarial-review/)。用最小可复现 fixture 推翻主张。
空集合、缺失失败路径、过期接续和输出不一致都可以作为攻击面。

## 4. Calibrate The Reviewer / 校准审阅者

A useful reviewer must distinguish `passed`, `failed`, and `not evaluated`.
Attack the review method, not only the source: make a required step unavailable,
mutate one declared rule, or submit a documented no-defect control. A report
that says “no defect found” is valid only when it records what was tested.

有效的审阅者必须区分 `passed`、`failed` 与 `not evaluated`。不要只攻击源码，
也攻击审阅方法：让必要步骤不可用、变异一条声明规则，或提交记录完整的无缺陷对照。
“未发现缺陷”只有在记录已测试内容时才是有效结论。

## Required Evidence / 必需证据

For the current native RC command surface, run from the repository root:

```bash
./bin/revia check examples/<case>.re
./bin/revia digest examples/<case>.re
./bin/revia manifest examples/<case>.re
./bin/revia translate examples/<case>.re
```

These commands inspect and translate the single-file review workloads; they do
not claim that the current RC exposes a generic `run <file.re>` workflow.
For execution evidence, use the fixed commands and fixtures documented in
[`../../experiments/rc1/kit/README.md`](../../experiments/rc1/kit/README.md).

Report the exact commit and OS/architecture, commands and output, one
falsifiable claim, expected behavior, distinguishing evidence, and a plausible
false-positive explanation. Separate source inspection from runtime execution
evidence.

For reviewer-calibration submissions, also state whether the fixture contains a
deliberate defect or is a no-defect control. Do not infer “passed” from missing
execution evidence.

对于审阅校准提交，还要说明 fixture 是否含有故意缺陷，或是否为无缺陷对照。不得因缺少
执行证据而推断为“已通过”。

Use one independent project directory for a submission:

```text
projects/YYYY-MM-DD-agent-project/
├── main.re
├── README.md
└── HANDOFF.md
```

Open one PR per project, continuation, or focused finding. No approval is
required before opening a reproducible contribution. Keep credentials,
private source, and local answer keys out of the PR.

## Current Boundary / 当前边界

The public repository exposes a bounded source-closed preview. WP-307
interface projection and generated-client work remains private and pending
final review; this challenge does not claim a generated client, complete HTTP,
A2A, MCP, browser, or production backend.

公开仓库是有界的闭源预览。WP-307 接口投影与生成客户端工作仍在私有仓库中，等待最终审阅；
本挑战不宣称生成客户端、完整 HTTP、A2A、MCP、Browser 或生产后端已经完成。
