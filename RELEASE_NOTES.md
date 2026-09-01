# Release Notes / 发行说明

## Next Candidate / 下一候选

The current development status, including work-package review state, is kept in
the [development status](docs/development-status.md) document. The current
`0.1-preview.1` assets are unchanged. The next milestone is
`v1.0.0-rc.1`, initially declared only for native macOS arm64. It must arrive
through the sealed export contract, bind version/target/license and hashes,
and pass the Darwin arm64 token-free prerelease gate. The other five targets
remain pending until their own native evidence is added; Stable V1.0 still
requires the complete stable gate.

工作包的当前审阅状态统一记录在[开发进展](docs/development-status.md)文档中。
当前 `0.1-preview.1` 资产不变。下一里程碑为初始只声明原生 macOS arm64 的
`v1.0.0-rc.1`。它必须通过密封导出合同，绑定版本、目标、许可与摘要，并在发布前通过
Darwin arm64 无仓库凭据预发行门禁。其余五个目标等待各自原生证据；Stable V1.0
仍必须通过完整稳定版门禁。

## 0.1-preview.1

Cross-platform Revia CLI for macOS, Linux, and Windows on `arm64` and
`x86_64`.
面向 macOS、Linux、Windows `arm64` 与 `x86_64` 的跨平台 Revia CLI。

- Native `check`, `run`, `manifest`, and diagnostic verification on six targets / 六目标平台原生验证
- POSIX and PowerShell launchers / POSIX 与 PowerShell 启动器
- Archive and executable SHA-256 verification / 归档与可执行文件 SHA-256 校验
- Deterministic release archives / 确定性发行归档

[Build metadata / 构建元数据](runtime/build-metadata.json) ·
[Checksums / 校验摘要](runtime/checksums.txt)

## Candidate Gate / 候选门禁

Every published asset must be verified on its own declared native target before
publication. RC1 begins with Darwin arm64 only. Adding a target requires its
archive/executable SHA-256, sealed evidence, and native smoke; Stable V1.0
retains the full six-target requirement.
每个已发布资产都必须在其声明的原生目标上完成发布前验证。RC1 初始仅包含 Darwin
arm64；新增目标必须提供归档/可执行文件 SHA-256、密封证据与原生 smoke。Stable V1.0
继续保留完整六目标要求。

The release tag must equal `v` plus `VERSION`. Documentation and launcher
changes on `main` do not create a new runtime release. See the
[release policy](docs/release-policy.md).
发行 tag 必须等于 `v` 加 `VERSION`。`main` 上的文档和启动器变更不会自动形成新的
运行时发行。详见[发行政策](docs/release-policy.md)。

## 0.1-preview

Initial macOS Apple silicon distribution with `check`, `run`, `manifest`,
`translate`, and `view`.
首个 macOS Apple silicon 发行版，包含 `check`、`run`、`manifest`、`translate` 与 `view`。
