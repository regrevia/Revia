# Release Notes / 发行说明

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

Future assets are uploaded to a draft release and verified on every declared
target before publication: archive SHA-256, executable SHA-256, `check`,
`run`, `manifest`, and diagnostic exit status.
后续资产先上传到草稿发行版，并在每个声明目标上完成发布前验证：归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest` 与诊断退出状态。

## 0.1-preview

Initial macOS Apple silicon distribution with `check`, `run`, `manifest`,
`translate`, and `view`.
首个 macOS Apple silicon 发行版，包含 `check`、`run`、`manifest`、`translate` 与 `view`。
