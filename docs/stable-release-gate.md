# Stable V1.0 Release Gate / Stable V1.0 发行门禁

This checklist defines the evidence required before the public repository
changes its status to Stable V1.0. A development review result alone does not
close these gates.

本清单定义公开仓库切换为 Stable V1.0 前必须具备的证据。开发审阅结果本身不能关闭
这些门禁。

| Gate / 门禁 | Status / 状态 |
|---|---|
| Stable-use license and redistribution terms / 稳定使用与再分发许可证条款 | Pending |
| Reachable private security channel / 可访问的私密安全渠道 | Enabled; verified through GitHub API on 2026-10-30 / 已启用；2026-10-30 经 GitHub API 核验 |
| CLI help, version, subcommand help and exit-code matrix / CLI 帮助、版本、子命令帮助与退出码矩阵 | Pending release candidate |
| Runnable project template and project workflow / 可运行项目模板与项目流程 | Source/native `project-check` passed at `a57a8bb`; native build/run pending a versioned release candidate / `a57a8bb` 源码/native `project-check` 已通过；native build/run 等待版本化候选 |
| Symlink launcher and PowerShell verification / 软链接启动器与 PowerShell 验证 | Pending release candidate |
| Six independent platform runners / 六个独立平台 runner | Pending release candidate |
| Pre-publication release smoke / 发布前 release smoke | Enforced by workflow |
| Signed tag and signed checksums / 签名 tag 与签名 checksum | Pending |
| Immutable release / 不可变 release | Pending |
| SBOM / SBOM | Pending |
| Artifact attestation / 产物 attestation | Pending |
| Stable assets and matching `VERSION` / 稳定版资产与 `VERSION` 一致 | Pending |

The repository remains Candidate/Preview until every row has machine-readable
evidence linked from the release record. Existing preview tags and assets are
not reclassified.

在每项都有可从 Release 记录追溯的机器可读证据前，仓库保持 Candidate/Preview 状态。
既有预览 tag 和资产不会被重新归类。

The project-template source/native check and bound Windows artifact-integrity check passed on main commit `a57a8bb` in source
validation and native Linux x64/Windows x64 jobs. The gate remains pending
until a new versioned candidate includes that workflow and binds its evidence
to the candidate tag.

The current RC2.2.1 export includes `LICENSE-RC.md`, whose text states it
applies only to RC1. RC2.2.1 binary license applicability must be clarified
before another binary candidate is presented as having settled evaluation or
redistribution terms.

项目模板源码/native 检查和 Windows 绑定 runner 的产物完整性校验已在 main commit `a57a8bb` 的源码验证、
Linux x64 与 Windows x64 原生工作流中通过。
但必须等新版本候选包含此流程并将证据绑定到候选 tag 后，门禁才能关闭。

当前 RC2.2.1 导出包包含声明只适用于 RC1 的 `LICENSE-RC.md`。在将后续二进制候选描述为
具有明确评估或再分发条款前，必须先澄清 RC2.2.1 二进制许可适用范围。
