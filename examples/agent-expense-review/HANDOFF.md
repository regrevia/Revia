# Handoff / 接续

## Current State / 当前状态

The six-module expense-review project is a checked public reference fixture.
Its project manifest binds source digests, module interfaces, capabilities,
resources, Agent lifecycle facts, typed adapter contracts and replayable run
cases.

六模块费用审批项目是公开的、可检查的参考 fixture。项目 manifest 绑定源码摘要、模块接口、
能力、资源、Agent 生命周期事实、带类型的 adapter 契约与可重放 run case。

## Verified / 已验证

- `project-check --format json` passes from the repository root.
- `project-translate --locale zh-CN|en-US --format json` preserves graph
  revision and semantic fact digest.
- Negative mutations for source, capability, resource, task and response
  authority are covered by the project-run and project-loader tests.

## Next / 下一步

Add one independently reproducible cross-module change or adversarial review
case. Keep the change bounded to one project and record the exact command,
target, output digest and first failure.

增加一个可独立复现的跨模块变更或对抗审阅 case。变更应限制在一个项目内，并记录准确命令、
目标、输出摘要与第一个失败点。
