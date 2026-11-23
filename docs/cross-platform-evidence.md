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

## RC2.1 Windows x64 Evidence / RC2.1 Windows x64 证据

`v1.0.0-rc.2.1` publishes only the `windows-x64` asset. The candidate passed
the hosted Windows source build and native conformance workflow, executed the
same source-built binary on the bound `regrevia-win` runner, and passed the
public download checksum and archive-content smoke.

- Release gate: [Windows RC2.1 gate](https://github.com/regrevia/Revia/actions/runs/40869293781)
- Windows source/bound-runner evidence: [Windows native workflow](https://github.com/regrevia/Revia/actions/runs/40867766279)
- Archive SHA-256: `ea07d6aa3b688e7e03e737411cb4c598ba2436d9fbf13b9877ec2a4726ef8db8`
- Executable SHA-256: `3b30599f8b748682f3403e1be6a34b3af617eea4496b7ac1a2c6d0666cdf6f36`

This evidence does not upgrade the other targets, Stable V1.0, production
readiness, or complete protocol interoperability.

`v1.0.0-rc.2.1` 只发布 `windows-x64` 资产。该候选已通过 Windows 托管构建与 native
一致性测试，在绑定的 `regrevia-win` runner 上执行同一 source-built 二进制，并通过公开下载
摘要、解包内容与 smoke 校验。

- 发行门禁：[Windows RC2.1 gate](https://github.com/regrevia/Revia/actions/runs/40869293781)
- Windows 构建/绑定节点证据：[Windows native workflow](https://github.com/regrevia/Revia/actions/runs/40867766279)
- 归档 SHA-256：`ea07d6aa3b688e7e03e737411cb4c598ba2436d9fbf13b9877ec2a4726ef8db8`
- 可执行文件 SHA-256：`3b30599f8b748682f3403e1be6a34b3af617eea4496b7ac1a2c6d0666cdf6f36`

该证据不会升级其他目标，也不代表 Stable V1.0、生产就绪或完整协议互操作。

## RC2.2.1 Matrix / RC2.2.1 矩阵

`v1.0.0-rc.2.2.1` covers two native targets. Both were built and executed on
their exact native runner, and each is bound to the archive and executable
digest that `runtime/checksums.txt` records. Linux builds and runs on the
GitHub-hosted `ubuntu-24.04` image. Windows builds and runs on the
GitHub-hosted `windows-2025` image in one job: it builds the executable, runs
it for a loopback `server-smoke`, runs the workspace tests, then runs
`--version`, `--help`, `check` and `manifest` against it. A second job
re-downloads that artifact on the self-hosted bound node `regrevia-revia`
(`[self-hosted, Windows, X64, regrevia-win]`) and refuses to launch if the
digest disagrees, which is an independent second-machine check rather than the
basis of the row. That node is offline, so the second check is outstanding.

| Target / 目标 | Runner | State / 状态 | Native workflow | Archive SHA-256 |
| --- | --- | --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `measured-native` | `40881177716` | `cee357cf80fe48068fa8c16dc59590ac1299fb0f992eb38f22e0be769c0631b9` |
| Windows x64 | `windows-2025` | `measured-native` | `40881177895` | `d36fc1c473cd9de6f5a7b231b1747b6158dcd9b15462d52c22c63064ba294175` |
| macOS arm64 | — | `pending` | — | — |
| macOS x64 | — | `pending` | — | — |
| Linux arm64 | — | `pending` | — | — |
| Windows arm64 | — | `pending` | — | — |

`v1.0.0-rc.2.2.1` 覆盖两个原生目标。两者都在各自的原生 runner 上构建并执行，并各自绑定到
`runtime/checksums.txt` 记录的归档与可执行文件 SHA-256：Linux 在 GitHub 托管的 `ubuntu-24.04` 镜像上
构建并运行；Windows 在同一个作业里于 GitHub 托管的 `windows-2025` 镜像上构建并运行——构建出可执行
文件，用它跑回环 `server-smoke`、跑工作区测试，再对同一个文件跑 `--version`、`--help`、`check` 与
`manifest`。另有一个作业在自托管绑定节点 `regrevia-revia`（`[self-hosted, Windows, X64,
regrevia-win]`）上重新下载该产物，摘要不符即拒绝启动；这是第二台机器上的独立复核，而不是该行的依据。
该节点当前离线，因此这项复核尚未完成。上表其余四个目标保持 `pending`。

### Export note / 导出说明

The `v1.0.0-rc.2.2.1` assets are immutable and two of them disagree with the
artifacts beside them. Both disagreements are recorded here rather than
repaired in place.

- The exported `target-matrix.json` is 539 bytes and reports
  `"version": "1.0.0-rc.2.2.1.1"`. The tag was cut before that string was
  corrected; the repository holds the corrected 537-byte record, and its pin in
  `runtime/rc2.2.1/export-manifest.json` now matches those bytes.
- The exported `linux-native-evidence.json` and `windows-native-evidence.json`
  describe source commit `5f4f2d86`, whose archives and executables differ from
  the ones `checksums.txt` records for `b76dbfc2`. The repository records and
  `checksums.txt` agree with each other and with the shipped archives, so those
  are the authoritative digests for this candidate.

`v1.0.0-rc.2.2.1` 的资产不可修改，其中两份与同批工件不一致，故在此记录而不就地修复：导出的
`target-matrix.json` 为 539 字节且版本串为 `1.0.0-rc.2.2.1.1`（tag 在纠正该串之前就已切出，仓库中
为纠正后的 537 字节记录，其在 `export-manifest.json` 中的 pin 现与字节一致）；导出的两个
`*-native-evidence.json` 描述源码提交 `5f4f2d86`，其归档与可执行文件不同于 `checksums.txt` 为
`b76dbfc2` 记录的那一组。仓库记录与 `checksums.txt` 互相一致且与随附归档一致，本候选的权威摘要以
它们为准。

The remaining acceptance order is Linux arm64 on `ubuntu-24.04-arm`. It stays
pending until it satisfies the separate [RC2 target expansion contract](rc2-target-expansion-contract.md).
Android arm64 / Termux is a separate experimental track under the
[Android experimental contract](android-termux-experimental-contract.md); it
does not alter this six-target matrix.

剩余接收顺序为 `ubuntu-24.04-arm` 上的 Linux arm64。该目标在满足独立的
[RC2 目标扩展合同](rc2-target-expansion-contract.md)前保持 pending。Android arm64 / Termux
在[Android 实验合同](android-termux-experimental-contract.md)中作为独立实验轨道，不改变此六目标矩阵。

## Next Expansion / 下一次扩展

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
