# Compatibility / 兼容性

## Current RC2.2.1 Candidate / 当前 RC2.2.1 候选

| Target / 目标 | RC2.2.1 state / 状态 | Evidence / 证据 |
|---|---|---|
| macOS `arm64` | `pending` | No RC2.2.1 evidence |
| macOS `x86_64` | `pending` | No RC2.2.1 evidence |
| Linux `arm64` | `pending` | No RC2.2.1 evidence |
| Linux `x86_64` | `measured-native` | `runtime/rc2.2.1/linux-native-evidence.json` |
| Windows `arm64` | `pending` | No RC2.2.1 evidence |
| Windows `x86_64` | `measured-native` | `runtime/rc2.2.1/windows-native-evidence.json` |

The latest candidate is `v1.0.0-rc.2.2.1`. Its Linux x64 and Windows x64
targets have separate native evidence. `measured-native` is limited to the
named target and recorded candidate; it does not establish Stable V1.0 or
complete language-output byte determinism.

当前候选为 `v1.0.0-rc.2.2.1`，Linux x64 与 Windows x64 各自有独立原生证据。
`measured-native` 仅适用于所列目标与记录中的候选，不证明 Stable V1.0 或所有语言产物均逐字节确定。

## Historical RC1 Distribution / 历史 RC1 发行

`v1.0.0-rc.1` is measured-native only on macOS arm64. Its archive and binary
SHA-256 values remain in [runtime/checksums.txt](../runtime/checksums.txt);
the immutable target evidence is in [`runtime/rc1/`](../runtime/rc1/).
Historical RC1 target status must not be substituted for the current matrix.

`v1.0.0-rc.1` 仅 macOS arm64 为 `measured-native`。其归档与二进制 SHA-256 仍见
[runtime/checksums.txt](../runtime/checksums.txt)，不可变目标证据在 [`runtime/rc1/`](../runtime/rc1/)。
不得用历史 RC1 状态替代当前矩阵。

## Runtime And Integration Surface / 运行时与集成范围

- Native candidate, no Node.js runtime required / 原生候选，不需要 Node.js 运行时。
- `build` output may require Node.js / `build` 产物可能需要 Node.js。
- Explicit capability, project workflow, multi-module, and bounded
  HTTP/JSON/SQLite trial fixtures / 显式能力、项目流程、多模块与有界
  HTTP/JSON/SQLite 试用 fixtures。
- Generated frontend contract: bounded TypeScript projection from checked
  interfaces; not a complete generator or production SDK /
  generated frontend contract：从 checked interface 生成的有界 TypeScript projection，
  尚非完整生成器或生产 SDK。
- HTTP adapter: bounded trial only; A2A and MCP adapters: pending /
  HTTP adapter：仅有界试验；A2A 与 MCP adapter：pending。
- Trial outputs are bound by recorded SHA-256 values / 试用输出由记录的 SHA-256 绑定。
- SQLite and loopback HTTP are test dependencies, not a production hosting
  profile / SQLite 与 loopback HTTP 是测试依赖，并非生产托管能力。

## Not Claimed / 未声明能力

- Native equivalence on the five pending targets.
- TLS, authentication, HTTP/2 or HTTP/3, production database lifecycle,
  scheduler, commercial hosting, or production SLA.
- Signed release/checksums, SBOM, attestation, immutable Stable release, or
  Stable V1.0 licensing.
- General byte-for-byte identity for all language outputs across fresh processes.
- Browser profile, complete A2A/MCP adapters, and production backend.

- 其余五个 pending 目标的原生等价性。
- TLS、认证、HTTP/2/HTTP/3、生产数据库生命周期、调度器、商业托管或生产 SLA。
- 签名 release/checksums、SBOM、attestation、immutable Stable release 或 Stable V1.0 许可。
- 所有语言产物在全新进程间普遍逐字节一致。
- Browser profile、完整 A2A/MCP 适配器和 production backend。

Virtual machines are useful when they are genuine native official runners. Local
sandboxes and emulators can provide `measured-emulated` diagnostics, but never
establish final native support or performance evidence. See the
[cross-platform evidence procedure](cross-platform-evidence.md).

只有真实原生的官方 runner 上的虚拟机可以形成最终原生证据。本地沙箱与模拟器可以提供
`measured-emulated` 诊断，但不能建立最终原生支持或性能证据。详见[跨平台证据流程](cross-platform-evidence.md)。

[Build metadata / 构建元数据](../runtime/build-metadata.json) ·
[RC trial kit / RC 试用包](../experiments/rc1/kit/)
