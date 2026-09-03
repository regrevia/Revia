# Compatibility / 兼容性

## V1 RC1 Distribution / V1 RC1 发行

| Target / 目标 | RC1 state / RC1 状态 | Public behavior / 公开行为 |
|---|---|---|
| macOS `arm64` | `measured-native` | Verified native archive and seven bounded trials |
| macOS `x86_64` | `pending` | No RC binary; launcher exits `69` |
| Linux `arm64` | `pending` | No RC binary; launcher exits `69` |
| Linux `x86_64` | `pending` | No RC binary; launcher exits `69` |
| Windows `arm64` | `pending` | No RC binary; launcher exits `69` |
| Windows `x86_64` | `pending` | No RC binary; launcher exits `69` |

`v1.0.0-rc.1` is measured-native only on macOS arm64. The archive and binary
SHA-256 are in [runtime/checksums.txt](../runtime/checksums.txt); the exact
target matrix and evidence bindings are in [`runtime/rc1/`](../runtime/rc1/).
`measured-native` means a sealed candidate was accepted and run on the declared
native target. It is not a claim of Stable V1.0 or complete language-output
byte determinism.

`v1.0.0-rc.1` 仅在 macOS arm64 为 `measured-native`。归档和二进制 SHA-256 见
[runtime/checksums.txt](../runtime/checksums.txt)，精确目标矩阵及证据绑定见
[`runtime/rc1/`](../runtime/rc1/)。`measured-native` 表示密封候选已在声明的原生目标上
通过验收与执行，不表示 Stable V1.0 或完整语言产物逐字节确定性。

## Runtime And Integration Surface / 运行时与集成范围

- Native candidate, no Node.js runtime required / 原生候选，不需要 Node.js 运行时。
- `build` output may require Node.js / `build` 产物可能需要 Node.js。
- Explicit capability, project workflow, multi-module, and bounded
  HTTP/JSON/SQLite trial fixtures / 显式能力、项目流程、多模块与有界
  HTTP/JSON/SQLite 试用 fixtures。
- Generated frontend contract: design surface, not a complete generator /
  generated frontend contract：设计面，尚非完整生成器。
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
