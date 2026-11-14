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

Both evidence records are outcome records: `source_commit`,
`source_inventory_digest`, `binary_sha256` and `archive_sha256` say which bytes
a commit produced and which workflow run produced them. Neither carries a
`witness`, so a record without a `witness` cannot support a `requires` sentence:
the bytes can be checked, the observation behind them cannot be repeated. A
record that does carry a `witness` must give the `command` that produced it and
the `environment_digest` and `raw_log_sha256` of that run, and the release tests
refuse a partial one.

两份证据记录都是结果记录：`source_commit`、`source_inventory_digest`、
`binary_sha256` 与 `archive_sha256` 说明哪个提交产出了哪些字节、由哪次工作流运行产出。
两者都不带 `witness`，因此没有 `witness` 的记录不能支撑 `requires` 这类句子：
字节可核，但产生它的那次观察无法复现。带 `witness` 的记录必须给出产生它的 `command`
以及该次运行的 `environment_digest` 与 `raw_log_sha256`，残缺的会被发布测试拒绝。

On a target that the candidate never published, `bin/revia` reports
`pending target` and exits 69, naming the target and pointing back at this
table; it does not claim the checkout is broken. Exit 70 means the checkout's
release records are damaged (missing `runtime/checksums.txt`, or no entries
for the version in `VERSION`), not an unsupported host. The distinction
matters because macOS arm64 is a pending RC2.2.1 target: building the native
toolchain from source and invoking `native/target/release/revia` directly is
the supported path there.

在该候选没有发布产物的目标上，`bin/revia` 报告 `pending target` 并以 69 退出，
同时指出目标并指回本表；它不会声称仓库已损坏。70 表示仓库中的发布记录损坏
（缺少 `runtime/checksums.txt`，或 `VERSION` 所指版本没有任何记录），
而非主机不受支持。这一点对 macOS arm64 尤其重要：它是 RC2.2.1 的 pending 目标，
在该平台上受支持的路径是从源码构建原生工具链并直接调用
`native/target/release/revia`。

## Linux x64 Runtime Baseline

The `v1.0.0-rc.2.2.1` Linux x64 asset requires glibc **2.39**. The published binary (`revia-1.0.0-rc.2.2.1-linux-x64.tar.gz`, archive SHA-256
`cee357cf80fe48068fa8c16dc59590ac1299fb0f992eb38f22e0be769c0631b9`; executable
`revia`, SHA-256
`7899d04f954fc83757866c35710bdbce7604f8c52a8fbc51a599563be65819ca`) requires the
symbol version `GLIBC_2.39`, introduced in glibc 2.39, so 2.39 is the lowest
libc that provides it. The candidate is
published from GitHub's `ubuntu-24.04` runner, whose system libc is 2.39; the
symbol version records which symbols the binary references, not the runner's
whole libc. Since the dynamic loader only exposes the symbol versions of the
host libc, any host below glibc 2.39 cannot load the binary; the loader reports
the missing version at startup, before `--help` runs. That covers Ubuntu 20.04 (2.31)
and 22.04 (2.35), Debian 12 (2.36), RHEL 9 and Amazon Linux 2023 (2.34), and
Fedora 39 (2.38) and earlier releases, as well as any other host on an older
libc: the requirement is on the libc version, not on Debian or Ubuntu
specifically. musl-based distributions such as Alpine are excluded for a
different reason: the binary is linked against glibc and no `-musl` variant
exists, so it cannot load there either, and a `gcompat` layer is not a supported
configuration. A load failure on a glibc 2.31 host has been reported externally;
that host was not reproduced here. Independently of any report, the declared
symbol floor alone means a libc below 2.39 cannot load the binary. The floor is the lowest libc that can load the binary, not a support
matrix: only `ubuntu-24.04` has actually been exercised by this project, and hosts at or above
glibc 2.39 on other distributions are expected to load it but were not measured
here. Check a host with `getconf GNU_LIBC_VERSION` (or `ldd --version`) inside the
environment the binary will actually run in: `LD_LIBRARY_PATH`, conda and
containers can make the command report a libc other than the one the binary
resolves. `ldd --version` reports the loader's glibc; to see the symbol versions
a binary requires, use `objdump -T` or `readelf -V`. Ubuntu 23.10 (2.38) and
openSUSE Leap 15.x sit below the floor.

Building from source on a host below glibc 2.39 has not been verified here
either; the `native/` toolchain requirements in `QUICKSTART.md` still apply, and
an `--offline` build needs the vendored dependencies available on that host.
A host that fails to load the binary reports a missing `GLIBC_2.39` version, for
example `revia: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not
found`; the `libc.so.6` path differs by distribution (RHEL-family hosts usually
use `/lib64/libc.so.6`), and a different path does not change the conclusion.

No `-musl` or static variant is published for this candidate. On an older glibc
baseline, either run the published binary inside a container whose distribution
ships glibc >= 2.39 (when such an image is available), or build from source
under `native/` on that host (or in a container matching its glibc) — building inside a newer-glibc container can only
raise that floor, never lower it. Publishing a lower-baseline or
`x86_64-unknown-linux-musl` asset is a build-infrastructure change, not a
property of the current asset.

`v1.0.0-rc.2.2.1` 的 Linux x64 资产要求 glibc **2.39** 或更新版本。已发布二进制
（`revia-1.0.0-rc.2.2.1-linux-x64.tar.gz`，归档 SHA-256
`cee357cf80fe48068fa8c16dc59590ac1299fb0f992eb38f22e0be769c0631b9`；可执行文件
`revia`，SHA-256
`7899d04f954fc83757866c35710bdbce7604f8c52a8fbc51a599563be65819ca`）需要符号版本
`GLIBC_2.39`，该符号版本自 glibc 2.39 起引入，因此 2.39 是提供该符号版本的
最低 libc。该候选从 GitHub `ubuntu-24.04` runner
（系统 libc 2.39）发布；符号版本只记录二进制引用的符号，不代表 runner 整套 libc。
动态加载器只提供主机 libc 的符号版本，所以任何低于 glibc 2.39 的主机都无法加载该二进制，
加载器会在启动时、`--help` 之前报告缺失的版本。
这包括 Ubuntu 20.04（2.31）与 22.04（2.35）、Debian 12（2.36）、RHEL 9 与
Amazon Linux 2023（2.34）、以及 Fedora 39（2.38）及更早版本；限制在 libc 版本上，
并非 Debian 或 Ubuntu 特有。musl 发行版（如 Alpine）另有原因：该二进制链接 glibc 且不提供
`-musl` 变体，同样无法加载，`gcompat` 兼容层不属于受支持配置。glibc 2.31 的主机上有外部
报告的加载失败，该主机未在本机复现；无论该报告存在与否，仅凭已声明的符号下限即可推出
低于 2.39 的 libc 无法加载该二进制。该下限是最低可加载 libc，不是支持
矩阵：本项目实际演练过的只有 `ubuntu-24.04`，其他发行版上 glibc >= 2.39 预期可加载但未在本机
测量。可用 `getconf GNU_LIBC_VERSION` 或 `ldd --version` 检查主机（在目标二进制实际
运行的环境里查：`LD_LIBRARY_PATH`、conda 或容器都可能让报告的不是它解析到的那份 libc；
`ldd --version` 报告的是加载器版本，要看二进制要求的符号版本用 `objdump -T` 或 `readelf -V`）；Ubuntu 23.10（2.38）
与 openSUSE Leap 15.x 低于下限。在低于 glibc 2.39 的主机上源码构建同样未在本机验证；
`QUICKSTART.md` 里的 `native/` 工具链要求仍适用，`--offline` 构建还需要该主机上有
可用的随附依赖。

当前候选不提供 `-musl` 或静态变体。glibc 基线较旧时，可以在发行版 glibc >= 2.39 的容器里
运行已发布二进制，或在该主机（或与它 glibc 一致的容器）里用 `native/` 源码构建（这样的镜像同样未必存在）——在更新
glibc 的容器里构建只会抬高该下限，不会使其更低。发布更低基线或 `x86_64-unknown-linux-musl`
资产属于构建基础设施改动，不是当前资产的性质。

这类主机上的加载错误形如（外部报告的形状，不是本机复现的完整记录；
`libc.so.6` 的路径因发行版而异，Debian/Ubuntu 是上面这个，RHEL 系通常形如
`/lib64/libc.so.6`，路径不同不改变结论）：

```
revia: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by ./revia)
```

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

- Native equivalence on the pending targets.
- TLS, authentication, HTTP/2 or HTTP/3, production database lifecycle,
  scheduler, commercial hosting, or production SLA.
- Signed release/checksums, SBOM, attestation, immutable Stable release, or
  Stable V1.0 licensing.
- General byte-for-byte identity for all language outputs across fresh processes.
- Browser profile, complete A2A/MCP adapters, and production backend.

- 其余 pending 目标的原生等价性。
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
