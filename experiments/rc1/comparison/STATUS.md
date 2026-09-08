# Comparison Status / 对照状态

The public RC currently has schemas for recording comparisons, but it does not
have a preregistered same-model, same-task result set that can establish an
Agent-native productivity advantage.

公开 RC 已提供记录对照的 Schema，但目前没有预注册、同模型、同任务的结果集，不能据此
证明 Agent-native 生产率优势。

The reviewed-file-plan case may be used as a future benchmark task. A valid
study must freeze the model/version, prompt, task bytes, tool access, time and
token budget, success oracle, negative controls, and sample count before the
first measured run. Report every terminal outcome. Do not pool missing or
failed runs into `passed`.

Until that study exists, runtime conformance such as direct/bundle/project byte
identity is evidence about implementation consistency only. It is not evidence
that task success rate is higher, repair rounds are lower, reviewers miss fewer
errors, or migration cost is recovered.
