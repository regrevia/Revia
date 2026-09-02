# Release Notes / 发行说明

## v1.0.0-rc.1 — Deep Trial / 深度试用

`v1.0.0-rc.1` is a source-closed, non-production developer-evaluation release.
It is the first V1 milestone for independent deep trials, not Stable V1.0.

`v1.0.0-rc.1` 是闭源、非生产的开发者评估发行版，是用于独立深度试用的首个 V1 里程碑，
不是 Stable V1.0。

### Included / 包含内容

- One verified native macOS arm64 asset / 一个已验证的原生 macOS arm64 资产。
- Archive and executable SHA-256 binding / 归档与可执行文件 SHA-256 绑定。
- Sealed public export, candidate identity, target matrix, and native evidence /
  密封公开导出、候选身份、目标矩阵和原生证据。
- A public seven-trial kit covering source check, review manifest, capabilities,
  project workflow, multi-module authority, and bounded HTTP/JSON/SQLite server
  conformance / 七试验公开包，覆盖源码检查、审阅 manifest、能力、项目流程、多模块 authority
  与有界 HTTP/JSON/SQLite Server 一致性。
- RC developer-evaluation license and notice / RC 开发评估许可与声明。

### Explicit Limits / 明确限制

- Only `darwin-arm64` is `measured-native`. Darwin x64, Linux arm64/x64, and
  Windows arm64/x64 are `pending`; there are no RC assets for them.
- This RC does not claim production use, commercial hosting, TLS/auth, a general
  backend, cross-platform equivalence, full byte determinism, signed artifacts,
  SBOM, attestation, or immutable Stable V1.0.
- The release must be used under [LICENSE-RC.md](LICENSE-RC.md).

- 只有 `darwin-arm64` 为 `measured-native`。Darwin x64、Linux arm64/x64 与 Windows
  arm64/x64 均为 `pending`，没有对应 RC 资产。
- 本 RC 不声明生产使用、商业托管、TLS/auth、通用后端、跨平台等价、完整逐字节确定性、签名产物、
  SBOM、attestation 或 immutable Stable V1.0。
- 必须遵循 [LICENSE-RC.md](LICENSE-RC.md)。

### Verify / 校验

Use [Quickstart](QUICKSTART.md) with the exact entries in
[`runtime/checksums.txt`](runtime/checksums.txt). The trial commands and expected
hashes are in [`experiments/rc1/kit/trial-manifest.json`](experiments/rc1/kit/trial-manifest.json).
Submit counterexamples with version, platform, asset SHA-256, command, exit
status, stdout/stderr hash, and a minimal public fixture.

按[快速开始](QUICKSTART.md)使用 [`runtime/checksums.txt`](runtime/checksums.txt) 中精确条目校验。
试用命令和预期摘要见 [`experiments/rc1/kit/trial-manifest.json`](experiments/rc1/kit/trial-manifest.json)。
提交反例时请包含版本、平台、资产 SHA-256、命令、退出状态、stdout/stderr 摘要与最小公开 fixture。

## Historical Preview / 历史预览版

`0.1-preview.1` remains a historical prerelease. Its six-platform evidence and
its compact-output `PENDING` status do not constitute RC1 evidence.

`0.1-preview.1` 保留为历史预发行版。它的六平台证据与 compact 输出 `PENDING` 状态均不构成 RC1 证据。
