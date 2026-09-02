# Quickstart / 快速开始

## Scope / 适用范围

`v1.0.0-rc.1` is a source-closed, non-production developer-evaluation release.
Its only measured-native target is macOS arm64. Linux, Windows, macOS x64, and
all production use are out of scope; their launchers return exit `69` rather
than downloading an unmeasured asset.

`v1.0.0-rc.1` 是闭源、非生产的开发者评估发行版。唯一完成原生实测的目标是 macOS arm64。
Linux、Windows、macOS x64 和所有生产使用均不在本次范围内；启动器会返回 `69`，不会下载
未经实测的资产。

## Requirements / 环境要求

- macOS arm64, `curl`, `tar`, and `shasum` or `sha256sum`.
- A writable working directory for the trial kit.
- Agreement to the [Developer Evaluation License](LICENSE-RC.md).

- macOS arm64，以及 `curl`、`tar` 与 `shasum` 或 `sha256sum`。
- 一个可写的试用包工作目录。
- 接受[开发评估许可](LICENSE-RC.md)。

## Verify The Candidate / 校验候选

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia --version
./bin/revia --help
# After downloading the official release asset:
shasum -a 256 revia-1.0.0-rc.1-darwin-arm64.tar.gz
tar -xzf revia-1.0.0-rc.1-darwin-arm64.tar.gz
shasum -a 256 revia
```

The launcher verifies the downloadable archive and executable before native
execution. `runtime/checksums.txt` is the authoritative two-entry RC list;
do not substitute checksums from `0.1-preview.1`.

启动器会在原生执行前校验可下载归档和可执行文件。`runtime/checksums.txt` 是 RC 的两条权威
清单；请勿使用 `0.1-preview.1` 的摘要替代。

## Run The Bounded Trial Kit / 运行有界试用包

The repository contains an inspectable copy of the kit. Make a writable copy,
put the verified RC binary at `bin/revia`, then execute only the arrays recorded
in `trial-manifest.json` from the kit root:

```bash
cp -R experiments/rc1/kit /tmp/revia-rc1-kit
cd /tmp/revia-rc1-kit
mkdir -p bin
# Copy the verified `revia` extracted from the official Darwin arm64 asset here.
chmod 755 bin/revia
./bin/revia check fixtures/hello-check/hello.re
```

The manifest covers seven measured trials: source check, review manifest,
argument and file capabilities, project initialization/check/test, a two-module
gate, and bounded HTTP/JSON/SQLite conformance. Some trials create result files
or a SQLite database, so never run them inside the read-only repository copy.

仓库内含可检查的试用包副本。请创建可写副本，将官方 Darwin arm64 资产中解出的、已校验的
`revia` 放在 `bin/revia`，并只在试用包根目录执行 `trial-manifest.json` 记录的命令数组。
该 manifest 覆盖七个实测试验：源码检查、审阅 manifest、参数与文件能力、项目初始化/检查/测试、
两模块门禁和有界 HTTP/JSON/SQLite 一致性。部分试验会生成结果文件或 SQLite 数据库，切勿在
只读的仓库副本中执行。

## Exit Codes / 退出码

- `0`: the selected candidate command succeeded / 选定候选命令成功。
- `64`: invalid launcher or CLI usage / 启动器或 CLI 用法无效。
- `65`: structured source or project diagnostic / 结构化源码或项目诊断。
- `69`: target is pending or unsupported / 目标仍 pending 或不受支持。
- `70`: launcher, download, checksum, cache, or runtime setup failure /
  启动器、下载、校验、缓存或运行时准备失败。

## Record A Useful Result / 记录有效结果

For a challenge, benchmark, or comparison, include the exact version, target,
archive SHA-256, trial id, command array, exit status, stdout/stderr hashes,
and any generated-result hash. Do not include credentials, private source,
personal data, or the executable itself. The [feedback template](feedback/FEEDBACK_TEMPLATE.md)
is the preferred submission shape.

用于挑战、基准或对比的记录应包含精确版本、目标、归档 SHA-256、试验 ID、命令数组、退出状态、
stdout/stderr 摘要和生成结果摘要。不得包含凭据、私有源码、个人数据或可执行文件本身；优先使用
[反馈模板](feedback/FEEDBACK_TEMPLATE.md)。

## Reinstall Or Uninstall / 重装或卸载

The RC launcher caches only the verified Darwin arm64 binary. Remove the
version-and-target cache directory only when you intentionally want a fresh
download; do not replace the cached executable manually.

RC 启动器仅缓存已校验的 Darwin arm64 二进制。只有需要重新下载时才删除版本与目标缓存目录；
不要手工替换缓存的可执行文件。
