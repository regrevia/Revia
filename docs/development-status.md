# Development Status / 开发进展

Updated 2026-10-31.

## Source And Runtime

The public repository now contains the reviewed RE source tree under
MPL-2.0. The source includes the Node reference toolchain, Rust native
translator/VM slice, project and module checking, deterministic semantic
artifacts, a bounded Server profile, interface projection, and conformance
tests.

The latest published candidate is `v1.0.0-rc.2.2.1`, with separately verified
native Linux x64 and Windows x64 assets. Its tag points to `35ae4ed`. The
current-main code-validation snapshot below is `e4e7198`; later source or
documentation commits do not alter the existing tag or its downloadable assets.

公开仓库现已包含按 MPL-2.0 发布、经过筛选的 RE 源码。当前源码包括 Node 参考工具链、
Rust native 翻译器/VM 切片、项目与模块检查、确定性语义产物、有界 Server profile、
接口投影以及一致性测试。

最新已发布候选为 `v1.0.0-rc.2.2.1`，包含分别验证的 Linux x64 与 Windows x64 原生资产。
该 tag 指向 `35ae4ed`。下方 main 代码验证快照为 `e4e7198`；后续源码或文档提交不会改变
既有 tag 或其可下载资产。

## Verified Scope

| Area | Current evidence |
|---|---|
| Source license | New source uses the unmodified MPL-2.0 text |
| Node reference toolchain | Focused and full test suites run from a clean checkout |
| Rust native toolchain | Workspace tests, formatting, and clippy are required in CI |
| Runtime target support | Only targets with published native evidence are measured |
| Historical RC1 | Existing Darwin arm64 archive, checksums, manifest, and RC license remain unchanged |
| RC2.2.1 Linux x64 asset | Native evidence and public-download checksum recorded in `runtime/rc2.2.1/` |
| RC2.2.1 Windows x64 asset | Native evidence and public-download checksum recorded in `runtime/rc2.2.1/` |
| Current main source, `e4e7198` | Source validation, Linux x64 native conformance, and Windows x64 native conformance passed in GitHub Actions; bound Windows runner verified the downloaded executable digest before launch |
| Project surface on current main | Source and native `project-check`/`project-surface-check` gates passed; native build/run remain versioned-candidate scope |
| Production readiness | Not claimed |
| Complete A2A/MCP interoperability | Not claimed |
| Stable V1.0 | Blocked by [stable-release-gate.md](stable-release-gate.md) |

The source includes experimental and bounded implementations. A module,
fixture, test, or protocol-shaped contract is not by itself evidence that a
complete production feature is implemented.

## Release Boundary

- New source files are licensed under MPL-2.0 from the source-transition
  commit.
- Historical preview and RC1 binary assets retain their original license
  files and published checksums.
- The `v1.0.0-rc.2.2.1` export includes `LICENSE-RC.md`, whose text scopes that
  license to `v1.0.0-rc.1` only. RC2.2.1 binary terms therefore require
  version-specific clarification; neither the source MPL-2.0 nor the RC1 text
  should be treated as silently resolving that scope.
- Future releases must be built from a public source commit and publish target,
  license, artifact, and test evidence together.
- A green source CI run is not cross-platform runtime evidence unless the
  specific target was executed on its native runner.

## Main-Branch Evidence / Main 分支证据

The following checks passed at public main commit
[`e4e7198`](https://github.com/regrevia/Revia/commit/e4e7198c23adb4e700b5d98344f2a832e18d8008):

- [Source and release validation](https://github.com/regrevia/Revia/actions/runs/41119018246)
- [Linux x64 native conformance](https://github.com/regrevia/Revia/actions/runs/41119018558)
- [Windows x64 native conformance](https://github.com/regrevia/Revia/actions/runs/41119018407)

These runs exercise current source, including the checked-in runnable project
template. They do not replace a versioned candidate or prove the older
`v1.0.0-rc.2.2.1` binary assets contain those later changes.

以下检查在公开 main commit
[`e4e7198`](https://github.com/regrevia/Revia/commit/e4e7198c23adb4e700b5d98344f2a832e18d8008)
通过：

- [Source and release validation](https://github.com/regrevia/Revia/actions/runs/41119018246)
- [Linux x64 native conformance](https://github.com/regrevia/Revia/actions/runs/41119018558)
- [Windows x64 native conformance](https://github.com/regrevia/Revia/actions/runs/41119018407)

这些工作流测试当前源码，包括仓库内可运行的项目模板；它们不等同于新的版本化候选，
也不能证明较早的 `v1.0.0-rc.2.2.1` 二进制包含之后的源码变更。
