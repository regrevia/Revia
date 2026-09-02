# Cross-Platform Evidence Procedure / 跨平台证据流程

> 中文摘要：只有在对应操作系统与架构的原生环境中完成构建、执行和密封证据验证，平台状态才能标记为 `measured-native`；模拟环境不能替代最终原生证据。

The RC matrix distinguishes four states:

- `measured-native`: sealed asset accepted and executed on the named native OS
  and architecture.
- `measured-emulated`: useful diagnostic evidence, but not accepted as final
  native support or performance evidence.
- `pending`: no acceptable evidence yet.
- `blocked`: attempted on the target, with a public reproducible blocker.

## RC1 Matrix / RC1 矩阵

| Target | Required official runner | RC1 state |
|---|---|---|
| macOS arm64 | `macos-15` | `measured-native` |
| macOS x64 | `macos-15-intel` | `pending` |
| Linux arm64 | `ubuntu-24.04-arm` | `pending` |
| Linux x64 | `ubuntu-24.04` | `pending` |
| Windows arm64 | `windows-11-arm` | `pending` |
| Windows x64 | `windows-2025` | `pending` |

The Darwin arm64 claim binds the sealed archive, binary checksum, candidate
manifest, native evidence, and bounded trial manifest in
[`runtime/rc1/`](../runtime/rc1/). It does not transfer to a different target.

Darwin arm64 声明绑定 `runtime/rc1/` 中的密封归档、二进制摘要、候选 manifest、原生证据和
有界试用 manifest；该声明不会转移到其他目标。

## Evidence Required For A New Target / 新目标所需证据

1. Build and execute the candidate on the exact native official runner.
2. Bind package, CLI version, target, candidate manifest, and archive/executable
   SHA-256.
3. Run native version/help, source, project workflow, capability, multi-module,
   and target-appropriate bounded-profile smoke.
4. Produce canonical, path-free public JSON evidence and an exact inventory.
5. Scan the export for source, symlinks, private paths, credentials, and
   undeclared files.
6. Import only sealed public assets and run the public gate without repository
   credentials during candidate execution.

新增目标必须在精确的原生官方 runner 上构建和执行，绑定包、CLI 版本、目标、候选 manifest 与
归档/二进制 SHA-256，运行相应 smoke，并生成无私有路径的 canonical 公共证据和精确清单。导出
必须扫描源码、符号链接、私有路径、凭据与未声明文件；候选执行期间公开门禁不得提供仓库凭据。

Virtual machines are preferred when they are genuine native GitHub-hosted
runners. Local sandboxes and emulators are useful for early diagnosis, but
their results must stay `measured-emulated`; they cannot establish native
performance or final platform support.

当虚拟机是真实原生 GitHub 托管 runner 时，可优先用于验证其他操作系统。本地沙箱和模拟器适合
早期诊断，但结果必须保持 `measured-emulated`，不能建立原生性能或最终平台支持。
