# RC2 Native Target Expansion Contract / RC2 原生目标扩展合同

> 中文摘要：Linux x64、Windows x64 和 Linux arm64 必须分别以密封、无源码的目标交付进入下一 RC；旧预览、模拟结果或其他目标二进制不能替代对应原生证据。

## Scope / 范围

The next native acceptance order is:

1. `linux-x64` on GitHub-hosted `ubuntu-24.04`;
2. `windows-x64` on GitHub-hosted `windows-2025`;
3. `linux-arm64` on GitHub-hosted `ubuntu-24.04-arm`.

Android is independent experimental work under
[android-termux-experimental-contract.md](android-termux-experimental-contract.md).
It does not replace a desktop target.

下一次原生接收顺序为 GitHub 托管 `ubuntu-24.04` 上的 `linux-x64`、`windows-2025` 上的
`windows-x64`、以及 `ubuntu-24.04-arm` 上的 `linux-arm64`。Android 是独立实验工作，
见 [android-termux-experimental-contract.md](android-termux-experimental-contract.md)，不替代桌面目标。

## One Target, One Sealed Handoff / 一个目标，一个密封交付

For each target, the closed development side must provide a separate regular
directory containing only public-safe release material:

- one target-native archive and extracted executable SHA-256;
- canonical candidate, target-matrix, native, capability, multi-module, and
  bounded-Server evidence bound to one version and target;
- an export manifest with exact file sizes and SHA-256 values;
- RC license and notice byte-identical to the public candidate commit; and
- a source-free bounded trial kit whose runner digest equals the executable digest.

每个目标必须独立交付只含公开安全发行材料的普通目录：目标原生归档与解出后二进制 SHA-256；绑定同一
版本和目标的 canonical 候选、目标矩阵、原生、能力、多模块和有界 Server 证据；精确文件大小及 SHA-256
的导出 manifest；与公开候选提交逐字节一致的 RC 许可和声明；以及 runner 摘要等于该二进制摘要的无源码
有界试用包。

## Native Gate / 原生门禁

The named runner executes the downloaded archive before publication, covering
version/help, source check, capability, project workflow, multi-module, and the
bounded Server trial. Candidate execution has no repository credentials. A
separate public-download smoke repeats archive and executable verification.

声明 runner 必须在发布前执行下载归档，覆盖 version/help、源码检查、能力、项目流程、多模块和有界
Server 试用。候选执行没有仓库凭据；独立公开下载 smoke 重复归档和二进制校验。

## Rejection And Publication / 拒绝与发布

Reject an extra or missing file, source/runtime implementation, source map,
symlink, private path, credential, non-canonical JSON, version/target/hash drift,
trial-runner mismatch, or emulation presented as native evidence.

`v1.0.0-rc.1` remains unchanged. A later RC may mark a target `measured-native`
only after its sealed handoff, public verifier, target-native gate, and
public-download smoke all pass. macOS x64 and Windows arm64 remain pending.

若存在额外或缺失文件、源码/运行时实现、source map、符号链接、私有路径、凭据、非 canonical JSON、
版本/目标/摘要漂移、试用 runner 不匹配或以模拟冒充原生证据，必须拒绝。`v1.0.0-rc.1` 保持不变；后续 RC
只有在密封交付、公开 verifier、原生门禁及公开下载 smoke 全部通过后才能标记目标为 `measured-native`。
macOS x64 和 Windows arm64 保持 pending。
