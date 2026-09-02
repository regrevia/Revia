# Evidence / 验证证据

This page records public, reproducible evidence for `v1.0.0-rc.1`. The source
implementation remains outside this repository; only the sealed public export,
trial fixtures, hashes, and evidence records are published.

本页记录 `v1.0.0-rc.1` 的公开、可复现证据。源码实现不在本仓库；公开内容仅为密封导出、
试用 fixtures、摘要与证据记录。

## RC1 Release Evidence / RC1 发行证据

| Item / 项目 | Result / 结果 |
|---|---|
| Release channel / 发行通道 | `v1.0.0-rc.1` prerelease, developer evaluation only / 预发行，仅开发评估 |
| Measured target / 实测目标 | macOS arm64 only / 仅 macOS arm64 |
| Archive integrity / 归档完整性 | Archive and executable SHA-256 in [`runtime/checksums.txt`](../runtime/checksums.txt) |
| Export binding / 导出绑定 | [`export-manifest.json`](../runtime/rc1/export-manifest.json) |
| Candidate identity / 候选身份 | [`candidate-manifest.json`](../runtime/rc1/candidate-manifest.json) |
| Native evidence / 原生证据 | [`native-evidence.json`](../runtime/rc1/native-evidence.json) |
| Trial boundary / 试用边界 | [`trial-manifest.json`](../experiments/rc1/kit/trial-manifest.json) |
| Public boundary / 公开边界 | GitHub Actions [`Validate public boundary`](https://github.com/tangshuang631/Revia/actions/workflows/validate.yml) |

The trial kit records seven measured command paths: source check, review
manifest, argument capability, file capability, project workflow, multi-module
gate, and bounded HTTP/JSON/SQLite server gate. Every trial records its command,
fixture hashes, target, exit status, and expected output or result hash.

试用包记录七条实测命令路径：源码检查、审阅 manifest、参数能力、文件能力、项目流程、多模块门禁和
有界 HTTP/JSON/SQLite Server 门禁。每条试验都记录命令、fixture 摘要、目标、退出状态以及预期
输出或结果摘要。

## What This Does Not Prove / 本证据不证明什么

- Any native behavior on the five pending targets.
- Full output byte determinism for every language surface.
- TLS/authentication, production database operations, distributed execution, or
  commercial hosting.
- Signing, SBOM, attestation, immutable releases, or Stable V1.0.

- 其余五个 pending 目标上的任何原生行为。
- 每个语言命令面的完整产物逐字节确定性。
- TLS/认证、生产数据库操作、分布式执行或商业托管。
- 签名、SBOM、attestation、immutable releases 或 Stable V1.0。

## Reproduce Or Challenge / 复现或挑战

Use a writable copy of [`experiments/rc1/kit`](../experiments/rc1/kit/), install
the verified Darwin arm64 binary at `bin/revia`, and execute the exact arrays in
`trial-manifest.json`. A high-value report includes the candidate version,
archive SHA-256, platform, trial id, command, exit code, stdout/stderr hashes,
and the smallest public fixture that differs.

使用 [`experiments/rc1/kit`](../experiments/rc1/kit/) 的可写副本，将已校验 Darwin arm64
二进制安装到 `bin/revia`，并执行 `trial-manifest.json` 中精确记录的命令数组。高价值报告应包含
候选版本、归档 SHA-256、平台、试验 ID、命令、退出码、stdout/stderr 摘要及最小可公开差异 fixture。

## Stable Boundary / Stable 边界

The historical `0.1-preview.1` compact-determinism probe remains `PENDING` and
is not evidence for this candidate. Stable V1.0 remains blocked until the full
[stable release gate](stable-release-gate.md) is satisfied.

历史 `0.1-preview.1` 的 compact determinism 探针仍为 `PENDING`，不能作为本候选的证据。
Stable V1.0 仍被完整 [stable release gate](stable-release-gate.md) 阻止。
