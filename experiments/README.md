# Experiments / 实验索引

This directory contains public experiment definitions and historical trial
records. It is evidence-oriented: a fixture, schema, or report describes a
bounded experiment and does not by itself establish production readiness or
cross-language superiority.

本目录包含公开实验定义与历史试验记录，强调可复现证据：fixture、schema 或报告只描述
一个有边界的实验，不单独证明生产就绪或语言优越性。

## Available Now / 当前可用

### RC1 Deep-Trial Kit / RC1 深度试用包

[`rc1/`](rc1/) contains the historical `v1.0.0-rc.1` Darwin arm64 evaluation
kit and its exact trial manifest. It covers bounded source checking,
capabilities, project workflow, multi-module behavior, a bounded Server
profile, and comparison-record format.

[`rc1/`](rc1/) 包含历史 `v1.0.0-rc.1` Darwin arm64 评估试用包及其精确清单，覆盖有界的
源码检查、能力、项目流程、多模块行为、受限 Server profile 与对比记录格式。

Use a writable copy of the kit and read its
[license and target boundary](rc1/README.md) and
[trial manifest](rc1/kit/trial-manifest.json) first.

请先阅读[许可与目标边界](rc1/README.md)及[试验清单](rc1/kit/trial-manifest.json)，
并使用试用包的可写副本。

## Current Source Experiments / 当前源码实验

The source repository currently provides runnable examples, conformance
fixtures, and benchmark-oriented test modules under [`../examples/`](../examples/)
and [`../test/fixtures/`](../test/fixtures/). These are the preferred starting
points for new reproducible comparisons.

当前源码仓库在 [`../examples/`](../examples/) 与
[`../test/fixtures/`](../test/fixtures/) 中提供可运行样例、一致性 fixture 与面向 benchmark
的测试模块；新的可复现实验应从这些入口开始。

There is not yet a maintained, language-neutral performance leaderboard or a
claim that Revia outperforms another language. Any comparison should record
source revision, toolchain, target, workload, backend status, and raw result
artifacts.

当前还没有维护中的跨语言性能排行榜，也没有 Revia 优于其他语言的声明。任何对比实验都应记录
源码提交、工具链、目标平台、workload、backend 状态和原始结果产物。

## Submission Boundary / 提交边界

- Keep each project or experiment in its own directory.
- Include exact commands, expected exit status, input fixture, and result
  digest where applicable.
- Mark measured, verified-only, pending, and fault-observed results
  separately.
- Do not commit credentials, private data, generated archives, or local
  absolute paths.

- 每个项目或实验使用独立目录。
- 尽可能记录准确命令、预期退出码、输入 fixture 与结果摘要。
- 分开标注 measured、verified-only、pending 与 fault-observed。
- 不提交凭据、私有数据、生成归档或本机绝对路径。
