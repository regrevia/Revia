# Release Policy / 发行政策

## Version Binding / 版本绑定

Each runtime release binds one version across `VERSION`, tag, asset names,
checksums, build metadata, and release notes. The tag is `v` plus `VERSION`.

每个运行时发行在 `VERSION`、tag、资产名称、校验摘要、构建元数据和发行说明中绑定同一版本。
tag 为 `v` 加 `VERSION`。

Documentation, examples, and launcher changes on `main` do not by themselves
create a new runtime release.
`main` 上的文档、示例和启动器变更本身不构成新的运行时发行。

## Historical 0.1 Preview Gate / 历史 0.1 预览版门禁

The `0.1-preview.1` workflow uploaded assets to a prerelease draft. Its six-target gate
verifies the tag/version binding, archive SHA-256, executable SHA-256, `check`,
`run`, `manifest`, compact-source determinism, and a structured diagnostic
before publication. That historical package did not include the current
`projects/_template/project.json` or the native project workflow.

`0.1-preview.1` 历史工作流先将资产上传到预发行草稿。其六目标门禁在发布前验证 tag/版本绑定、归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest`、compact 源确定性与结构化诊断。
该历史资产不包含当前的 `projects/_template/project.json` 或 native 项目流程。

The gate passes each downloaded draft executable to
`scripts/test-compact-determinism.sh --require` on POSIX and
`scripts/test-compact-determinism.ps1 -Mode Require` on Windows. It does not
fall back to a previously published runtime. A candidate whose compact source
produces different checked artifacts across fresh processes cannot pass.

门禁在 POSIX 将下载的草稿可执行文件传给
`scripts/test-compact-determinism.sh --require`，在 Windows 传给
`scripts/test-compact-determinism.ps1 -Mode Require`；不会回退到已发布运行时。
同一 compact 源码在全新进程生成不同已检查产物的候选不能通过该门禁。
历史 `0.1-preview.1` 没有验证项目模式的 `project-check` / `project-run`。

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

## Current RC2.2.1 And Main / 当前 RC2.2.1 与 main

The latest published candidate is `v1.0.0-rc.2.2.1`. Its target matrix records
native Linux x64 and Windows x64 evidence; the other four
desktop targets remain pending. The tag points to `35ae4ed`.

The latest code-validation snapshot is public main commit `b479fea`. Source
validation and native Linux/Windows CI pass on that commit, including the
checked-in project template workflow. These source checks do not change the
published RC2.2.1 binaries. A new versioned candidate must carry the project
template, rerun the release gate, and publish evidence bound to its own tag.

The RC2.2.1 export manifest includes `LICENSE-RC.md`, but that document says it
applies only to `v1.0.0-rc.1`. Do not infer RC2.2.1 binary terms from this RC1
license or from the source MPL-2.0 license. The RC2.2.1 binary license scope
needs version-specific clarification. Signed tags/checksums, immutable
releases, SBOM, and artifact attestation also remain pending for Stable V1.0.

最新已发布候选为 `v1.0.0-rc.2.2.1`。其目标矩阵记录 Linux x64 与 Windows x64
原生证据，其余四个桌面目标仍为 pending；该 tag 指向 `35ae4ed`。

最新代码验证快照为公开 main commit `b479fea`。该 commit 上的 source validation 与 Linux/Windows
native CI 通过，包含仓库内项目模板流程；这些源码检查不会
改变已发布的 RC2.2.1 二进制。新版本候选必须带上项目模板、重新运行发行门禁，并将证据绑定到新 tag。

RC2.2.1 导出 manifest 包含 `LICENSE-RC.md`，但该文件声明只适用于 `v1.0.0-rc.1`。
不得从 RC1 许可或源码 MPL-2.0 推断 RC2.2.1 二进制条款；该二进制许可范围需按版本澄清。
Stable V1.0 的签名 tag/checksum、immutable release、SBOM 和 artifact attestation 也仍为 pending。

## V1 RC1 Gate / V1 RC1 门禁

The historical `v1.0.0-rc.1` binary remains a non-production evaluation
candidate under its dedicated license. Its initial declared target is native
Darwin arm64 only. The other five target records remain `pending`; the RC does
not publish placeholder assets or reuse preview evidence as if it measured the
new runtime. This binary boundary is separate from the MPL-2.0 source tree.

历史版本 `v1.0.0-rc.1` 二进制仍是受专用许可约束的非生产评估候选，初始只声明原生
Darwin arm64。其余五个目标记录保持 `pending`；RC 不发布占位资产，也不会把旧预览版证据
冒充为新运行时实测。二进制边界与按 MPL-2.0 发布的源码树相互独立。

The RC release uses the [sealed export](rc1-sealed-export-contract.md). The
public verifier checks the exact file set, hashes, canonical JSON,
version/target/license binding, archive contents, and source/private-data
leakage. The native `macos-15` job executes the binary with repository
credentials removed. A separate no-token job downloads the public asset after
publication.

RC 发行使用[密封导出](rc1-sealed-export-contract.md)。公开验证器检查精确文件集、摘要、
canonical JSON、版本/目标/许可绑定、归档内容及源码/私有数据泄漏；随后原生 `macos-15` job
在移除仓库凭据后执行二进制，并在发布后由独立无凭据 job 通过公开地址重新下载验证。

Adding another RC target requires a native build and smoke on that exact OS and
architecture, a new sealed evidence record, and an updated public gate. It does
not require owning physical hardware if an official native hosted runner is
available. Emulation is diagnostic evidence only.

新增 RC 目标必须在该操作系统与架构上完成原生构建和 smoke，生成新的密封证据记录，并更新
公开门禁。若有官方原生托管 runner，无需持有对应实体设备；模拟结果只能作为诊断证据。

Stable V1.0 has a separate hard-gate checklist in
[`docs/stable-release-gate.md`](stable-release-gate.md). The public status
cannot change while any required release, license, security, platform, or
artifact-evidence row remains pending.

Stable V1.0 另有[硬门禁清单](stable-release-gate.md)。任何发行、许可证、安全、平台或
产物证据仍为 pending 时，公开状态不能切换。
