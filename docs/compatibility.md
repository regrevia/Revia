# Compatibility / 兼容性

| Target / 目标 | Verified environment / 验证环境 |
|---|---|
| macOS `arm64` | macOS 15 |
| macOS `x86_64` | macOS 15 Intel |
| Linux `arm64` | Ubuntu 24.04 |
| Linux `x86_64` | Ubuntu 24.04 |
| Windows `arm64` | Windows 11 |
| Windows `x86_64` | Windows Server 2025 |

Release `0.1-preview.1` passed native `check`, `run`, `manifest`, and diagnostic
tests on all six targets.
`0.1-preview.1` 已在六个目标平台通过原生 `check`、`run`、`manifest` 与诊断测试。

- Bundled runtime; no Node.js installation / 内置运行时，无需安装 Node.js
- Independent archive and executable SHA-256 verification / 归档与可执行文件独立 SHA-256 校验
- Per-user verified executable cache / 用户级已校验可执行文件缓存

[Checksums / 校验摘要](../runtime/checksums.txt) ·
[Build metadata / 构建元数据](../runtime/build-metadata.json)
