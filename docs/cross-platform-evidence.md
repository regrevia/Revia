# Cross-Platform Evidence Procedure

> 中文摘要：只有在对应操作系统与架构的原生环境中完成构建、执行和密封证据验证，平台状态才能标记为 `measured-native`；模拟环境不能替代最终原生证据。

The RC matrix distinguishes four states:

- `measured-native`: built and executed on the named operating system and architecture, with a sealed asset and public evidence.
- `measured-emulated`: useful diagnostic evidence, but not accepted as final native support or performance evidence.
- `pending`: no acceptable evidence yet.
- `blocked`: attempted on the target, with a published reproducible blocker.

## Initial matrix

| Target | Required official runner | RC1 state before sealed handoff |
|---|---|---|
| macOS arm64 | `macos-15` | `pending` |
| macOS x64 | `macos-15-intel` | `pending` |
| Linux arm64 | `ubuntu-24.04-arm` | `pending` |
| Linux x64 | `ubuntu-24.04` | `pending` |
| Windows arm64 | `windows-11-arm` | `pending` |
| Windows x64 | `windows-2025` | `pending` |

The macOS arm64 row may change to `measured-native` only after the public verifier accepts the sealed export and the token-free release gate executes the candidate on `macos-15`.

## Evidence required for each target

1. Checkout the exact private development commit with persisted Git credentials disabled.
2. Build a release binary on the target's native official runner.
3. Bind package, CLI version, candidate manifest, target, toolchain digest, and source-inventory digest.
4. Run version/help, source check, project workflow, capability, multi-module, release-package/release-verify, and target-appropriate bounded profile smokes.
5. Produce canonical, path-free JSON evidence and an exact-inventory export manifest.
6. Scan the export for source files, symlinks, private paths, governance markers, credentials, and undeclared files.
7. Import only the sealed asset and public evidence. Run the public gate with repository tokens removed before candidate execution.

Virtual machines are the preferred way to validate other operating systems when they are genuine native GitHub-hosted runners. Local sandboxes and emulators are useful for early diagnosis, but emulated results must stay `measured-emulated` and cannot establish native performance or final platform support.
