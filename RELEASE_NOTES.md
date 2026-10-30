# Release Notes / 发行说明

## v1.0.0-rc.2.2.1 — Linux and Windows x64 Native Candidate / Linux 与 Windows x64 原生候选

The published `v1.0.0-rc.2.2.1` prerelease contains native Linux x64 and
Windows x64 assets with target-specific evidence in
[`runtime/rc2.2.1/`](runtime/rc2.2.1/). The tag points to `35ae4ed`; it is a
candidate, not Stable V1.0 or a production-readiness claim.

The current main source later passed Source validation and native Linux x64 and
Windows x64 CI at `e4e7198`, including the native project-surface-check gate
and the bound Windows x64 artifact-integrity check.
Those checks are not part of the existing published RC2.2.1 assets.

The RC2.2.1 export includes `LICENSE-RC.md`, whose text applies only to RC1.
Do not infer RC2.2.1 binary usage or redistribution terms from that RC1 license
or from the source's MPL-2.0 license; version-specific binary terms need
clarification.

已发布的 `v1.0.0-rc.2.2.1` 预发行包包含 Linux x64 与 Windows x64 原生资产，按目标划分的证据见
[`runtime/rc2.2.1/`](runtime/rc2.2.1/)。该 tag 指向 `35ae4ed`；它是候选版本，不是 Stable V1.0，
也不代表生产就绪。

当前 main 源码随后在 `e4e7198` 通过 Source validation、Linux x64 与 Windows x64 native CI，
包括 native project-surface-check 门禁和 Windows x64 绑定 runner 的发行产物完整性校验。这些检查不属于现有
已发布的 RC2.2.1 资产。

RC2.2.1 导出包包含一份文本适用范围仅为 RC1 的 `LICENSE-RC.md`。不得从 RC1 许可或源码
MPL-2.0 推断 RC2.2.1 二进制的使用/再分发条款；二进制的版本专属条款仍需澄清。

## v1.0.0-rc.2.2 — Linux and Windows x64 Native Candidate / Linux 与 Windows x64 原生候选

`v1.0.0-rc.2.2` adds measured-native Linux x64 evidence alongside the
previously verified Windows x64 target. Both assets are non-production
developer-evaluation artifacts. The candidate requires native build/test,
fresh-process artifact checks, archive and executable checksums, and public
download smoke before publication.

`v1.0.0-rc.2.2` 在已验证的 Windows x64 目标之外新增 Linux x64 原生证据。两个目标
均为非生产开发评估资产；候选必须通过原生构建/测试、全新进程产物检查、归档与可执行文件
摘要校验及公开下载 smoke 后才能发布。

- Linux x64 archive: `revia-1.0.0-rc.2.2-linux-x64.tar.gz`
- Windows x64 archive: `revia-1.0.0-rc.2.2-windows-x64.zip`
- Other targets remain `pending`.

## v1.0.0-rc.2.1 — Windows x64 Native Candidate / Windows x64 原生候选

`v1.0.0-rc.2.1` is a source-available, non-production developer-evaluation
candidate for the measured `windows-x64` target. Its Windows asset is accepted
only after the hosted Windows build, native conformance suite, bound
`regrevia-win` execution, checksum verification, and public-download smoke all
pass.

`v1.0.0-rc.2.1` 是源码公开、非生产的开发者评估候选。当前只在
`windows-x64` 目标完成原生候选验证；必须通过 Windows 构建、native 一致性测试、
`regrevia-win` 实机执行、摘要校验和公开下载 smoke 后才可发布。

### Explicit Boundary / 明确边界

- `windows-x64` is the only target declared by this candidate as `measured-native`.
- Other targets remain pending and are not represented by placeholder assets.
- This candidate does not claim Stable V1.0, production readiness, or complete
  A2A/MCP interoperability.
- The historical `v1.0.0-rc.1` assets and license remain unchanged.

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

### Trial runner correction / 试用 runner 修正

The public trial runner now consumes the ordered `steps` contract in
`revia.public-trial-kit@1.1.0`. The previous 1.0 runner could execute only the
first command and falsely pass a multi-step trial; it also could not verify the
`project-workflow` result digest. The 1.1 contract is intentionally incompatible
with that broken execution shape. The reviewed-file-plan example is a bounded
source-digest approval case: it is not general risk inference, an open-runtime
security proof, a productivity benchmark, or production readiness.

公开 trial runner 现在按 `revia.public-trial-kit@1.1.0` 的有序 `steps` 契约执行。
旧版 1.0 runner 可能只执行第一条命令并错误通过多步骤试验，也无法核验
`project-workflow` 的结果摘要；1.1 契约因此与旧的错误执行形状不兼容。
`reviewed-file-plan` 只是绑定源码摘要的有界审批示例，不代表通用风险推断、
开放 runtime 安全证明、生产效率基准或生产就绪。

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
