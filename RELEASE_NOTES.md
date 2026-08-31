# Release Notes / 发行说明

## Next Candidate / 下一候选

The current development status, including work-package review state, is kept in
the [development status](docs/development-status.md) document. The current
`0.1-preview.1` assets are unchanged. A new runtime candidate must rebuild from
the reviewed line, pass the fresh-process determinism probe, validate the
runtime JSON contracts, and pass the six-target gate before publication.
Project-template validation will be added once the public manifest and fixture
inputs ship.

工作包的当前审阅状态统一记录在[开发进展](docs/development-status.md)文档中。
当前 `0.1-preview.1` 资产不变。新的运行时候选必须基于已审阅的开发线重新构建，
通过全新进程确定性探针和运行时 JSON 契约，并在发布前通过六目标发行门禁。
公开 manifest 与 fixture 到位后再加入项目模板验证。

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
`run`, `manifest`, determinism, runtime JSON contracts, and diagnostic exit
status. Project workflow validation remains pending the public template inputs.
后续资产先上传到草稿发行版，并在每个声明目标上完成发布前验证：归档 SHA-256、
可执行文件 SHA-256、`check`、`run`、`manifest`、确定性、运行时 JSON 契约与诊断退出状态。
项目流程验证等待公开模板输入文件到位。

The release tag must equal `v` plus `VERSION`. Documentation and launcher
changes on `main` do not create a new runtime release. See the
[release policy](docs/release-policy.md).
发行 tag 必须等于 `v` 加 `VERSION`。`main` 上的文档和启动器变更不会自动形成新的
运行时发行。详见[发行政策](docs/release-policy.md)。

## 0.1-preview

Initial macOS Apple silicon distribution with `check`, `run`, `manifest`,
`translate`, and `view`.
首个 macOS Apple silicon 发行版，包含 `check`、`run`、`manifest`、`translate` 与 `view`。
