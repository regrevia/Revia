# Development Status / 开发进展

Updated 2026-11-24.

## Source And Runtime

The public repository now contains the reviewed RE source tree under
MPL-2.0. The source includes the Node reference toolchain, Rust native
translator/VM slice, project and module checking, deterministic semantic
artifacts, a bounded Server profile, interface projection, and conformance
tests.

The latest published candidate is `v1.0.0-rc.2.2.1`, with separately verified
native Linux x64 and Windows x64 assets. Its tag points to `35ae4ed`. The
current-main code-validation snapshot below is `e3e3f8d`; later source or
documentation commits do not alter the existing tag or its downloadable assets.

公开仓库现已包含按 MPL-2.0 发布、经过筛选的 RE 源码。当前源码包括 Node 参考工具链、
Rust native 翻译器/VM 切片、项目与模块检查、确定性语义产物、有界 Server profile、
接口投影以及一致性测试。

最新已发布候选为 `v1.0.0-rc.2.2.1`，包含分别验证的 Linux x64 与 Windows x64 原生资产。
该 tag 指向 `35ae4ed`。下方 main 代码验证快照为 `e3e3f8d`；后续源码或文档提交不会改变
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
| Current main source, `e3e3f8d` | Source validation and Linux x64 native conformance passed in GitHub Actions. Windows x64 source conformance is measured on the GitHub-hosted `windows-2025` job, which builds the executable and then runs it: loopback `server-smoke`, the workspace tests, `--version`, `--help`, `check`, and `manifest`. The separate bound-node job that re-checks the downloaded artifact digest is `fault-observed` — the runner `regrevia-revia` is offline — so that independent second-machine check is outstanding, not the Windows row |
| Windows x64 bound runner digest check | The bound-runner job hashes the downloaded executable and refuses to launch on a mismatch. On the `bd33023` run it reported `expected=0cb4bb4d…` / `actual=39a6f581…` and did not launch. Downloading that run's artifact here reproduces `0cb4bb4d…` byte for byte, so the build record and the upload agree and the disagreement is on the bound node: its download step took 2 m 36 s for a 1.4 MB artifact, and its run step took 9 m 48 s to reach the digest of a 4 MB file. The producer side is not the fault: across three runs (`45193181724`, `45137029970`, `45217840753`) the build job's recorded digest and a re-hash of the uploaded artifact agree byte for byte, most recently `fd8cfebc…` on `e3e3f8d`. The check is working; the digest disagreement itself is unreproduced while the runner is offline |
| Native declared capability execution | `--schema-registry` + `--capability-policy` path, typed declared-call encoding, and fail-closed authorization boundary are covered by 13 core tests, 9 native CLI tests, and a 14-case CLI conformance corpus (`test/fixtures/declared-capability-execution-corpus.json`); plan and limits in [work-packages/availability.md](work-packages/availability.md) |
| Native host execution boundary | Four builtin members plus three served declared members are the language-visible host surface; fail-closed refusals for path escapes, size limits, ungranted members, and status-domain overflows are pinned by a 22-case CLI corpus (`test/fixtures/host-boundary-refusal-corpus.json`) and a Unix-only symlink test, with the residual trust boundary stated in [work-packages/availability.md](work-packages/availability.md) section 4 |
| Native result value evidence | `revia execute --print-values` prints one typed value per invocation (`invocation_values[]`); the member is additive, opt-in, and outside every `receipt_digest`, and the default output is unchanged. Language-level `ok(%value)` binding stays scheduled (artifact `@0.2.0`) in [work-packages/result-value-interface.md](work-packages/result-value-interface.md) |
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

The following checks ran at public main commit
[`e3e3f8d`](https://github.com/regrevia/Revia/commit/e3e3f8df0149ed0293e72ffc65ac3437977a6638):

- [Source and release validation](https://github.com/regrevia/Revia/actions/runs/45217840474) — passed
- [Linux x64 native conformance](https://github.com/regrevia/Revia/actions/runs/45217840285) — passed
- [Windows x64 native conformance](https://github.com/regrevia/Revia/actions/runs/45217840753) — the hosted `windows-2025` job passed, building the executable and running it there. Its bound-node job is `fault-observed`: it never started because the runner `regrevia-revia` is offline, and the run was then closed as `cancelled` when the next push superseded it, so the link shows `cancelled` rather than a verdict on the Windows row. The hosted result stands on its own; the outstanding piece is the independent digest re-check on that second machine.

These runs exercise current source, including the checked-in runnable project
template. They do not replace a versioned candidate or prove the older
`v1.0.0-rc.2.2.1` binary assets contain those later changes.

以下检查在公开 main commit
[`e3e3f8d`](https://github.com/regrevia/Revia/commit/e3e3f8df0149ed0293e72ffc65ac3437977a6638)
运行：

- [Source and release validation](https://github.com/regrevia/Revia/actions/runs/45217840474) — 通过
- [Linux x64 native conformance](https://github.com/regrevia/Revia/actions/runs/45217840285) — 通过
- [Windows x64 native conformance](https://github.com/regrevia/Revia/actions/runs/45217840753) — 托管的 `windows-2025` 作业通过，在该镜像上构建并实际运行可执行文件。其绑定节点作业为 `fault-observed`：因 runner `regrevia-revia` 离线，该作业从未启动，随后该次运行被下一次 push 取代而置为 `cancelled`，因此该链接显示的是 `cancelled`，并非对 Windows 行的判定。托管结果独立成立；尚未完成的是那台第二机器上对下载产物的独立摘要复核。

这些工作流测试当前源码，包括仓库内可运行的项目模板；它们不等同于新的版本化候选，
也不能证明较早的 `v1.0.0-rc.2.2.1` 二进制包含之后的源码变更。
