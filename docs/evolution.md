# Evolution / 演进记录

Revia's public history is organized by release, with each entry tied to a
published artifact and a runnable workflow.

Revia 的公开演进按发行版本组织，每条记录都对应已发布产物和可运行流程。

## Timeline / 时间线

| Version / 版本 | Focus / 重点 | Public evidence / 公开证据 |
|---|---|---|
| `0.1-preview` | Initial macOS Apple silicon CLI with `check`, `run`, `manifest`, `translate`, and `view` | [Release notes](../RELEASE_NOTES.md#01-preview) |
| `0.1-preview.1` | Six-target distribution with native smoke coverage and deterministic archives | [Release notes](../RELEASE_NOTES.md#01-preview1) |
| `1.0.0-rc.1` | Darwin arm64 deep trial with sealed evidence and seven bounded trials | [Release notes](../RELEASE_NOTES.md#v100-rc1--deep-trial-) |

## Resolved In The Public Line / 已解决的公开发行问题

- The English and Chinese home pages are separate, linked mirrors.
  英文与中文首页已拆分为互链镜像。
- The release includes a complete `check -> run -> manifest -> view` path.
  发行内容已具备完整的 `check -> run -> manifest -> view` 流程。
- Archive and executable digests are published together.
  归档与可执行文件摘要已同步发布。
- The six-target smoke record belongs to the historical preview; RC1 declares
  only Darwin arm64 and keeps all other targets pending.
  六目标冒烟记录属于历史预览版；RC1 仅声明 Darwin arm64，其余目标保持 pending。
- Agent projects use independent dated directories; only a continuation updates
  the matching `HANDOFF.md`.
  Agent 项目使用按日期划分的独立目录；只有接续同一项目时才更新对应的
  `HANDOFF.md`。

## Compatibility Changes / 兼容性变化

The current public line keeps the compact `0.1` source header and the commands
documented in [`docs/language.md`](language.md). New public behavior is added
through a versioned release and its release notes rather than silently changing
an existing artifact.

当前公开版本保留 `0.1` compact 源码头和
[`docs/language.md`](language.md) 中记录的命令。新增公开行为通过版本化发行和
发行说明加入，不静默改变既有产物。
