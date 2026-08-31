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

New assets are uploaded to a prerelease draft. The six-target candidate gate
verifies the tag/version binding, archive SHA-256, executable SHA-256, `check`,
`run`, `manifest`, compact-source determinism, and a structured diagnostic
before publication. Project workflow validation is a future gate item while
the public preview template is still missing its manifest and fixture.

新资产先上传到预发行草稿。六目标候选门禁在发布前验证 tag/版本绑定、归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest`、compact 源确定性与结构化诊断。
公开预览版模板仍缺少 manifest 和 fixture，项目流程验证列为后续候选门禁项目。

The gate passes each downloaded draft executable to
`scripts/test-compact-determinism.sh --require` on POSIX and
`scripts/test-compact-determinism.ps1 -Mode Require` on Windows. It does not
fall back to a previously published runtime. A candidate whose compact source
produces different checked artifacts across fresh processes cannot pass.

门禁在 POSIX 将下载的草稿可执行文件传给
`scripts/test-compact-determinism.sh --require`，在 Windows 传给
`scripts/test-compact-determinism.ps1 -Mode Require`；不会回退到已发布运行时。
同一 compact 源码在全新进程生成不同已检查产物的候选不能通过该门禁。
公开项目模板的 `project-check` 与 `project-run` 会在 manifest 和 fixture 随候选发布后
再加入门禁。

The same gate publishes the draft only after every target passes. The
published-release smoke workflow is a separate availability check; it does not
replace the candidate gate.
同一门禁只有在所有目标通过后才会发布草稿。已发布发行的 smoke 工作流是独立的可用性检查，
不替代候选门禁。

Publication order is: build candidate -> upload prerelease draft assets -> review
the candidate metadata -> dispatch the six-target gate. The gate runs every
target smoke and publishes the draft only after all checks pass. The
post-publication public-download smoke in the same workflow is an additional
availability check; the separate `release-smoke.yml` workflow remains useful
for manually published releases and does not serve as the publication trigger.

发行顺序为：构建候选 -> 上传预发行草稿资产 -> 审阅候选元数据 -> 手动触发六目标门禁。
门禁完成全部目标 smoke 后才会发布草稿；同一门禁随后通过公开下载路径执行
post-publication smoke。独立的 `release-smoke.yml` 仍可用于手动发布的发行版，
但不再被视为发布事件触发的唯一证据。

The current preview publishes SHA-256 checksums but does not publish signed
tags/checksums, an SBOM, or artifact attestation. Those are roadmap items for a
future candidate and are not described as enforced requirements until a gate
checks them. The publish gate currently enforces the tag/version binding,
`runtime/build-metadata.json` release field, and release name/body version
reference in addition to the six-target smoke. Project `project-check` and
`project-run` remain explicitly pending until those public template inputs are
shipped.
当前预览版发布 SHA-256 校验摘要，但没有签名 tag/校验摘要、SBOM 或产物
attestation。这些是后续候选的路线图项目；在门禁真正检查之前，不将其表述为已执行的
发行要求。除六目标 smoke 外，发布门禁当前还会检查 tag/版本绑定、
`runtime/build-metadata.json` 的 release 字段，以及 Release 名称/正文中的版本引用。
公开项目模板的 `project-check` 与 `project-run` 仍待所需输入文件随候选一并发布。

Stable V1.0 has a separate hard-gate checklist in
[`docs/stable-release-gate.md`](stable-release-gate.md). The public status
cannot change while any required release, license, security, platform, or
artifact-evidence row remains pending.

Stable V1.0 另有[硬门禁清单](stable-release-gate.md)。任何发行、许可证、安全、平台或
产物证据仍为 pending 时，公开状态不能切换。
