# Development Status / 开发进展

Updated 2026-10-29.

## Source And Runtime

The public repository now contains the reviewed RE source tree under
MPL-2.0. The source includes the Node reference toolchain, Rust native
translator/VM slice, project and module checking, deterministic semantic
artifacts, a bounded Server profile, interface projection, and conformance
tests.

The latest published binary remains the historical `v1.0.0-rc.1` evaluation
candidate. A `v1.0.0-rc.2.1` Windows x64 candidate is being verified separately;
it does not rewrite or replace the historical RC1 release.

公开仓库现已包含按 MPL-2.0 发布、经过筛选的 RE 源码。当前源码包括 Node 参考工具链、
Rust native 翻译器/VM 切片、项目与模块检查、确定性语义产物、有界 Server profile、
接口投影以及一致性测试。

最新已发布二进制仍是历史版本 `v1.0.0-rc.1` 评估候选；`v1.0.0-rc.2.1` 的
Windows x64 候选正在独立验证，不会改写或替换历史 RC1 发行。

## Verified Scope

| Area | Current evidence |
|---|---|
| Source license | New source uses the unmodified MPL-2.0 text |
| Node reference toolchain | Focused and full test suites run from a clean checkout |
| Rust native toolchain | Workspace tests, formatting, and clippy are required in CI |
| Runtime target support | Only targets with published native evidence are measured |
| Historical RC1 | Existing Darwin arm64 archive, checksums, manifest, and RC license remain unchanged |
| Production readiness | Not claimed |
| Complete A2A/MCP interoperability | Not claimed |
| Stable V1.0 | Blocked by [stable-release-gate.md](stable-release-gate.md) |

The source includes experimental and bounded implementations. A module,
fixture, test, or protocol-shaped contract is not by itself evidence that a
complete production feature is implemented.

## Release Boundary

- New source files are licensed under MPL-2.0 from the source-transition
  commit.
- The historical preview and RC binary lines retain their original license
  files and published checksums.
- Future releases must be built from a public source commit and publish target,
  license, artifact, and test evidence together.
- A green source CI run is not cross-platform runtime evidence unless the
  specific target was executed on its native runner.
