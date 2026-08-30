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
tests on all six targets. It has not been rebuilt with the `WP-295` determinism
fix.
`0.1-preview.1` 已在六个目标平台通过原生 `check`、`run`、`manifest` 与诊断测试。
该版本尚未使用 `WP-295` 确定性修复重新构建。

- Bundled runtime; no Node.js installation / 内置运行时，无需安装 Node.js
- Independent archive and executable SHA-256 verification / 归档与可执行文件独立 SHA-256 校验
- Per-user verified executable cache / 用户级已校验可执行文件缓存
- macOS: ad-hoc signed / macOS：临时签名
- Linux and Windows: unsigned / Linux 与 Windows：未签名
- PowerShell 7 is the documented Windows onboarding shell / Windows 入门流程要求 PowerShell 7
- Full `project-check`/`project-run` template validation: pending next candidate;
  the current template lacks the required project manifest and fixture /
  完整 `project-check`/`project-run` 模板验证：等待下一候选；当前模板缺少所需的项目
  manifest 和 fixture
- CLI/native runtime is Node-free; current `build` output execution needs Node.js /
  CLI/native runtime 不依赖 Node.js；当前 `build` 产物运行需要 Node.js
- Launcher symlinks resolve the repository root before reading `VERSION` /
  启动器会先解析软链接到仓库根目录，再读取 `VERSION`
- Cache, download, unpack, checksum, and runtime setup failures use exit `70` /
  缓存、下载、解包、校验和运行时准备失败统一返回 `70`
- SBOM, signed tag/checksums, and artifact attestation: pending /
  SBOM、签名 tag/校验摘要和产物 attestation：待完成
- Go, JVM, full Server profile, production backend, and Stable V1.0: pending /
  Go、JVM、完整 Server profile、production backend 与 Stable V1.0：待完成

The release archive digest verifies downloaded bytes against this repository's
published checksums. Signature and notarization status are recorded above.
发行归档摘要用于核对下载字节与本仓库发布的校验摘要；签名与公证状态如上。

[Checksums / 校验摘要](../runtime/checksums.txt) ·
[Build metadata / 构建元数据](../runtime/build-metadata.json)
