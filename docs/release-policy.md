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
`run`, `manifest`, compact-source determinism, and a structured diagnostic
before publication.

新资产先上传到草稿发行。六目标候选门禁在发布前验证 tag/版本绑定、归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest`、compact 源确定性与结构化诊断。

The gate passes each downloaded draft executable to
`scripts/test-compact-determinism.sh --require` on POSIX and
`scripts/test-compact-determinism.ps1 -Mode Require` on Windows. It does not
fall back to a previously published runtime. A candidate whose compact source
produces different checked artifacts across fresh processes cannot pass.

门禁在 POSIX 将下载的草稿可执行文件传给
`scripts/test-compact-determinism.sh --require`，在 Windows 传给
`scripts/test-compact-determinism.ps1 -Mode Require`；不会回退到已发布运行时。
同一 compact 源码在全新进程生成不同已检查产物的候选不能通过该门禁。
同一门禁还会使用仓库中的 project manifest 和 fixture，通过 `project-check` 与
`project-run` 验证公开项目模板。

The published-release smoke workflow is a separate availability check; it does
not replace the candidate gate.
已发布发行的 smoke 工作流是独立的可用性检查，不替代候选门禁。

Publication order is: build candidate -> upload draft assets -> run the
six-target gate and release smoke -> review the evidence -> publish the release.
The post-publication workflow is an additional availability check.

发行顺序为：构建候选 -> 上传草稿资产 -> 运行六目标门禁和发行 smoke -> 审阅证据 ->
发布发行版。发布后的工作流只是额外可用性检查。

Signed tags/checksums, SBOM, and artifact attestation are not currently
published for `0.1-preview.1`; they remain requirements for a future candidate.
`0.1-preview.1` 当前未发布签名 tag/校验摘要、SBOM 或产物 attestation；它们仍是后续候选
的发行要求。
