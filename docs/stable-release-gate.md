# Stable V1.0 Release Gate / Stable V1.0 发行门禁

This checklist defines the evidence required before the public repository
changes its status to Stable V1.0. A development review result alone does not
close these gates.

本清单定义公开仓库切换为 Stable V1.0 前必须具备的证据。开发审阅结果本身不能关闭
这些门禁。

| Gate / 门禁 | Status / 状态 |
|---|---|
| Stable-use license and redistribution terms / 稳定使用与再分发许可证条款 | Pending |
| Reachable private security channel / 可访问的私密安全渠道 | Pending |
| CLI help, version, subcommand help and exit-code matrix / CLI 帮助、版本、子命令帮助与退出码矩阵 | Pending release candidate |
| Runnable project template and project workflow / 可运行项目模板与项目流程 | Pending release candidate |
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
