# Quickstart / 快速开始

## Requirements / 环境要求

- macOS or Linux `arm64`/`x86_64`: `curl`, `tar`, and `shasum` or `sha256sum`.
- Windows `arm64`/`x86_64`: Windows PowerShell 5.1 or PowerShell 7.
- Network access is required for the first launch. The CLI runtime itself does
  not require a Node.js installation.
- Use follows the [Revia Technical Preview License](LICENSE).

- macOS 或 Linux `arm64`/`x86_64`：`curl`、`tar`，以及 `shasum` 或 `sha256sum`。
- Windows `arm64`/`x86_64`：Windows PowerShell 5.1 或 PowerShell 7。
- 首次运行需要网络；CLI 运行时本身不需要安装 Node.js。
- 使用受 [Revia Technical Preview License](LICENSE) 约束。

## Check, Run, Review / 检查、运行、审阅

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

On Windows, replace `./bin/revia` with `./bin/revia.ps1`.
Windows 下将 `./bin/revia` 替换为 `./bin/revia.ps1`。

`manifest.json` is the machine contract. `review.html` is the corresponding
human review view.
`manifest.json` 是机器契约；`review.html` 是对应的人类审阅视图。

## CLI Help And Exit Codes / 命令帮助与退出码

```bash
./bin/revia --version
./bin/revia --help
./bin/revia check --help
```

The launcher uses `64` for invalid launcher usage, `69` for an unsupported
platform, and `70` for launcher, download, checksum, cache, or runtime setup
failure. A structured source diagnostic exits `65`.
启动器对无效用法返回 `64`，不支持的平台返回 `69`，启动器、下载、校验、缓存或
运行时准备失败返回 `70`。结构化源码诊断返回 `65`。

## Cache And Offline Reuse / 缓存与离线复用

The launcher verifies both the archive and executable SHA-256 digest before
use. After one successful launch, the same version can run offline from:
启动器在使用前校验归档和可执行文件两份 SHA-256 摘要。首次成功运行后，同一版本可从
以下缓存位置离线运行：

```text
${XDG_CACHE_HOME:-$HOME/.cache}/revia/0.1-preview.1/<platform>/revia
%LOCALAPPDATA%\Revia\0.1-preview.1\<platform>\revia.exe
```

Delete only the version-and-platform cache directory to force a fresh verified
download. Do not replace the cached executable manually.
只删除对应版本和平台的缓存目录即可触发重新下载和校验；不要手工替换缓存可执行文件。

## Build An Inspectable Artifact / 构建可审阅产物

```bash
./bin/revia build --out out examples/agent-review/main.re
node out/run.mjs
```

`build` writes a self-contained Node demo artifact with the source, lock,
checksums, review index, and semantic view. Running `out/run.mjs` requires a
compatible Node.js runtime; the release build records Node 22 metadata.
`build` 生成包含源码、锁文件、校验摘要、审阅索引和语义视图的自包含 Node 演示产物。
运行 `out/run.mjs` 需要兼容的 Node.js 运行时；发行构建记录的是 Node 22 元数据。

`check --write` rewrites the `.re` file into canonical text. Commit or copy the
source before using it.
`check --write` 会将 `.re` 文件重写为规范化文本；执行前请提交或备份源码。

## Verify A Download / 手工校验下载

The launcher performs both checks automatically. To inspect an archive yourself,
download the matching release asset and compare it with
[`runtime/checksums.txt`](runtime/checksums.txt):
启动器会自动完成两层校验。需要手工检查时，下载对应发行资产并与
[`runtime/checksums.txt`](runtime/checksums.txt) 比对：

```bash
shasum -a 256 revia-0.1-preview.1-darwin-arm64.tar.gz
tar -xzf revia-0.1-preview.1-darwin-arm64.tar.gz
shasum -a 256 revia
```

Use `sha256sum` where `shasum` is unavailable. Windows PowerShell:
在没有 `shasum` 的系统使用 `sha256sum`。Windows PowerShell：

```powershell
Get-FileHash .\revia-0.1-preview.1-windows-x64.zip -Algorithm SHA256
Expand-Archive .\revia-0.1-preview.1-windows-x64.zip -DestinationPath .\revia
Get-FileHash .\revia\revia.exe -Algorithm SHA256
```

## Start A Project / 创建项目

Copy [`projects/_template`](projects/_template) to:
复制 [`projects/_template`](projects/_template) 到：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
```

The public template is a single-file contribution project. It supports the
documented `check -> run -> manifest -> view` loop. The package commands are
not part of the documented public surface.
公开模板是单文件贡献项目，支持已文档化的 `check -> run -> manifest -> view` 闭环。
包项目命令不属于当前已文档化的公开命令面。

Edit `main.re`, run the full loop, record results in `README.md`, and open one
focused pull request. Update `HANDOFF.md` only when continuing that same
project.
编辑 `main.re`，运行完整流程，在 `README.md` 记录结果，然后提交一个聚焦 PR。只有接续
同一项目时才更新该项目的 `HANDOFF.md`。
