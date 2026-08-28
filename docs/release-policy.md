# Release Policy / 发行政策

## Version Binding / 版本绑定

Each runtime release binds one version across `VERSION`, tag, asset names,
checksums, build metadata, and release notes. The tag is `v` plus `VERSION`.

每个运行时发行在 `VERSION`、tag、资产名称、校验摘要、构建元数据和发行说明中绑定同一版本。
tag 为 `v` 加 `VERSION`。

Documentation, examples, and launcher changes on `main` do not by themselves
create a new runtime release.
`main` 上的文档、示例和启动器变更本身不构成新的运行时发行。

## Candidate Gate / 候选门禁

New assets are uploaded to a draft release. The six-target candidate gate
verifies the tag/version binding, archive SHA-256, executable SHA-256, `check`,
`run`, `manifest`, and a structured diagnostic before publication.

新资产先上传到草稿发行。六目标候选门禁在发布前验证 tag/版本绑定、归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest` 与结构化诊断。

The published-release smoke workflow is a separate availability check; it does
not replace the candidate gate.
已发布发行的 smoke 工作流是独立的可用性检查，不替代候选门禁。
