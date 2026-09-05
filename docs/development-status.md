# Development Status / 开发进展

Updated 2026-09-05. / 更新日期：2026-09-05。

## Public Release / 公开发行

The current public release channel is `v1.0.0-rc.1`, a source-closed,
non-production developer-evaluation candidate. The sealed public export has
been independently accepted for `darwin-arm64`; the public trial kit exposes
seven bounded, hash-recorded experiments.

当前公开发行通道为 `v1.0.0-rc.1`，闭源、非生产的开发者评估候选。其密封公开导出已为
`darwin-arm64` 完成独立验收；公开试用包提供七个有界、记录摘要的实验。

| Area / 领域 | RC1 status / RC1 状态 |
|---|---|
| Native distribution / 原生发行 | `darwin-arm64` measured-native |
| Other target assets / 其他目标资产 | Five targets pending, no placeholder binaries / 五目标 pending，无占位二进制 |
| Capability and project trials / 能力与项目试用 | Public, bounded, hash-recorded / 公开、有界、记录摘要 |
| Multi-module and bounded Server / 多模块与有界 Server | Public fixtures and measured evidence / 公开 fixtures 与实测证据 |
| Stable V1.0 / Stable V1.0 | Blocked by the stable hard gate / 被稳定版硬门禁阻止 |

## Public Boundary / 公开边界

The release repository publishes only the executable archive, public evidence,
fixtures, documentation, and evaluation license. It does not publish compiler
source, runtime source, credentials, private paths, or private build metadata.

发行仓库只发布可执行归档、公开证据、fixtures、文档和评估许可；不发布编译器源码、运行时源码、
凭据、私有路径或私有构建元数据。

## Next Release Work / 下一步发行工作

1. Produce native sealed evidence and candidate assets for every pending target.
2. Complete signing/custody, SBOM, attestation, immutable-release, stable
   license, and project-workflow gates.
3. Resolve every Stable V1.0 requirement in
   [stable-release-gate.md](stable-release-gate.md) before changing the channel.

1. 为每个 pending 目标提供原生密封证据和候选资产。
2. 完成签名/托管、SBOM、attestation、immutable-release、稳定许可和项目流程门禁。
3. 只有完整满足 [stable-release-gate.md](stable-release-gate.md) 后才可切换到 Stable V1.0。

## Reviewed Development Boundary / 已审阅开发边界

WP-307 has completed private review for a revision-pinned checked-interface
projection intended for future generated frontend contracts. It has not been
added to the public RC executable, trial kit, release evidence, or compatibility
matrix. The public generated-contract row therefore remains a design surface,
not an available generator.

WP-307 已完成私有审阅，内容是面向未来生成式前端契约的、固定 revision 的 checked-interface
投影。它尚未进入公开 RC 可执行文件、试用包、发行证据或兼容性矩阵。因此公开的生成契约条目
仍是设计边界，不是可用生成器。

## Follow The Work / 跟进进展

- [Release notes](../RELEASE_NOTES.md)
- [Evidence](evidence.md)
- [Compatibility](compatibility.md)
- [RC trial kit](../experiments/rc1/kit/)
