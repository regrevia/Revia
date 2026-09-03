# Quickstart / 快速开始

## Scope / 适用范围

`v1.0.0-rc.1` is a source-closed technical preview for evaluation only. The
only measured native runtime is macOS arm64. Linux, Windows, macOS x64 and
production use remain outside this release.

`v1.0.0-rc.1` 是闭源技术预览版，仅用于评估。当前唯一完成原生实测的是 macOS arm64；
Linux、Windows、macOS x64 和生产使用不属于本次发行范围。

## Requirements / 环境要求

**macOS / Linux**

- `curl`, `tar`, and `shasum` or `sha256sum`
- a writable working directory
- internet access for the first launcher download

**Windows**

- PowerShell 7+
- `tar` or `Expand-Archive`
- `Get-FileHash`
- internet access for the first launcher download

Accept [LICENSE-RC.md](LICENSE-RC.md) before use.

## Clone And Run / 克隆并运行

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia --version
./bin/revia --help
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

The native CLI downloads the target archive on first use, verifies both archive
and executable SHA-256, then caches the verified executable. It does not need
Node.js. `build` outputs may have a separate Node.js dependency; that is
different from the native CLI runtime.

原生 CLI 首次运行时下载目标归档，校验归档和可执行文件 SHA-256 后缓存已校验的可执行文件，
不依赖 Node.js。`build` 产物可能有独立的 Node.js 依赖，不等同于原生 CLI 运行时。

## Verify A Release Asset / 校验发行资产

Download the matching asset from the [release page](https://github.com/tangshuang631/Revia/releases/tag/v1.0.0-rc.1):

```bash
asset=revia-1.0.0-rc.1-darwin-arm64.tar.gz
curl --fail --location \
  "https://github.com/tangshuang631/Revia/releases/download/v1.0.0-rc.1/$asset" \
  --output "$asset"
grep "  $asset$" runtime/checksums.txt
shasum -a 256 "$asset"
tar -xzf "$asset"
grep "  revia$" runtime/checksums.txt
shasum -a 256 revia
./revia --version
```

Use `sha256sum` on Linux or `Get-FileHash -Algorithm SHA256` on Windows.
Do not substitute checksums from another version.

## Offline Run / 离线运行

After one successful verified download, the launcher can run from its cache
without network access. Keep the version-and-target cache intact and invoke
the launcher normally. A missing cache in offline mode returns `70`; a pending
target returns `69`.

完成一次联网下载并校验后，启动器可以直接使用缓存离线运行。保留版本与目标对应的缓存目录，
正常调用启动器即可。离线时缓存不存在返回 `70`；目标仍为 pending 返回 `69`。

Default cache locations:

```text
macOS/Linux: ~/.cache/revia/<version>/<target>/revia
Windows:     %LOCALAPPDATA%\Revia\<version>\<target>\revia.exe
```

Set `XDG_CACHE_HOME` on macOS/Linux or use `LOCALAPPDATA` on Windows to select
the parent cache location.

## Reinstall Or Uninstall / 重装或卸载

The same section also covers rollback. / 本节同时覆盖回滚。

To reinstall, remove only the selected version and target cache directory,
then run the launcher again:

```bash
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/revia/1.0.0-rc.1/darwin-arm64"
./bin/revia --version
```

To roll back, restore the previous launcher checkout and use its matching
release asset; never mix a launcher, `VERSION`, archive and checksum file from
different releases.

To uninstall, remove the Revia cache directory and the cloned repository:

```bash
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/revia"
rm -rf Revia
```

Windows equivalents:

```powershell
Remove-Item "$env:LOCALAPPDATA\Revia\1.0.0-rc.1\windows-x64" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\Revia" -Recurse -Force
```

## Bounded Trial Kit / 有界试用包

```bash
cp -R experiments/rc1/kit /tmp/revia-rc1-kit
cd /tmp/revia-rc1-kit
mkdir -p bin
# Place the verified native `revia` binary at bin/revia.
chmod 755 bin/revia
./bin/revia check fixtures/hello-check/hello.re
```

Use only the command arrays in `trial-manifest.json`. The kit covers source
check, manifest, capabilities, project workflow, multi-module and bounded
HTTP/JSON/SQLite evidence. Some trials write files or SQLite data.

## Exit Codes / 退出码

| Code | Meaning / 含义 |
|---:|---|
| `0` | command succeeded / 成功 |
| `64` | invalid usage / 用法错误 |
| `65` | source or project diagnostic / 源码或项目诊断 |
| `69` | pending or unsupported target / pending 或不支持的目标 |
| `70` | download, cache, checksum or runtime failure / 下载、缓存、校验或运行时失败 |

## Submit Evidence / 提交证据

Record version, commit, OS/architecture, asset SHA-256, trial id, exact
commands, exit statuses, output hashes and generated artifact hashes. Use the
[feedback template](feedback/FEEDBACK_TEMPLATE.md) for a report or the
[opinion template](feedback/OPINION_TEMPLATE.md) for an API/protocol proposal.
