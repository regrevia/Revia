# Quickstart / 快速开始

Revia runs on macOS, Linux, and Windows across `arm64` and `x86_64`. The first
command downloads and verifies the matching executable. Node.js is not needed.
Revia 支持 macOS、Linux、Windows 的 `arm64` 与 `x86_64`。首次运行会下载并校验对应可执行文件，无需 Node.js。

## Check, Run, Review / 检查、运行、审阅

```bash
git clone https://github.com/tangshuang631/Revia.git
cd Revia
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-review/main.re > review.html
```

Windows PowerShell: replace `./bin/revia` with `./bin/revia.ps1`.
Windows PowerShell：将 `./bin/revia` 替换为 `./bin/revia.ps1`。

`manifest.json` records the machine contract. `review.html` renders the same
program for human review.
`manifest.json` 记录机器契约，`review.html` 将同一程序生成为人类图形审阅视图。

## Start A Project / 创建项目

Copy [`projects/_template`](projects/_template) to:
复制 [`projects/_template`](projects/_template) 到：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
```

Edit `main.re`, run the four commands, record the result in `README.md`, and
open a pull request.
编辑 `main.re`，运行以上四条命令，在 `README.md` 记录结果，然后提交 PR。
