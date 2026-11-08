# Quickstart / 快速开始

## Source development / 源码开发

The repository publishes its source under [MPL-2.0](LICENSE). The source
development workflow is independent from the historical preview and RC binary
assets, which retain [LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md) and
[LICENSE-RC.md](LICENSE-RC.md), respectively.

```bash
git clone https://github.com/regrevia/Revia.git
cd Revia
npm test
npm run re -- check examples/hello.re
npm run re -- run examples/hello.re
```

The Node reference toolchain requires Node.js 22.16.0 or newer and uses only the
standard library. No credentials or network service are required for the
source test suite.

### Your first program / 第一个程序

`scratch/` is ignored by Git, so experiments there never reach a commit:

```bash
mkdir -p scratch
cp examples/hello.re scratch/first.re
# replace "Hello, World!" inside @stdout.write("...") with "Hello, Revia!"
npm run re -- run scratch/first.re
# Hello, Revia!
npm run re -- check scratch/first.re
# OK scratch/first.re
```

`check` reads the program without running it. Rename the argument and it stops
before anything executes:

```bash
# @stdout.write(message: "Hello, Revia!")
npm run re -- check scratch/first.re
# scratch/first.re:9:28: unexpected-argument (expected data, got message)
```

That diagnostic goes to stderr and the command exits `65`. The same verdict is
available as one machine-readable object: `npm run re -- check --format json
scratch/first.re` prints `schema`, `file`, `ok`, and `diagnostics`, and
`npm run re -- manifest scratch/first.re` prints the review manifest with the
declared capabilities, effect calls, and error paths of that file.

The command's own exit code is `0` when it completes, `64` when the arguments
do not name a command it runs, and `65` when the source cannot be read or the
check rejects it. Those codes describe the command: `run` passes the exit code
the program asks for through unchanged, so the second program below returns `3`
from its `err` branch.

`scratch/` 被 Git 忽略，放实验文件不会进入提交：

```bash
mkdir -p scratch
cp examples/hello.re scratch/first.re
# 把 @stdout.write("...") 里的 "Hello, World!" 换成 "Hello, Revia!"
npm run re -- run scratch/first.re
# Hello, Revia!
npm run re -- check scratch/first.re
# OK scratch/first.re
```

`check` 只读取程序、不执行。改掉参数名，它会在执行前停下：

```bash
# @stdout.write(message: "Hello, Revia!")
npm run re -- check scratch/first.re
# scratch/first.re:9:28: unexpected-argument (expected data, got message)
```

该诊断写到 stderr，命令退出码为 `65`。同样的判定还有机器可读形式：
`npm run re -- check --format json scratch/first.re` 输出含 `schema`、`file`、
`ok`、`diagnostics` 的一个 JSON 对象；`npm run re -- manifest scratch/first.re`
输出审阅清单，含该文件声明的能力、effect 调用与错误路径。

命令自身的退出码为：正常完成时 `0`，参数不指向它能运行的命令时 `64`，
源码读不到或被检查拒绝时 `65`。这些码描述的是命令本身：`run` 会把程序自己
要求的退出码原样传出，所以下面第二个程序在其 `err` 分支返回 `3`。

### Your second program / 第二个程序

`0.1` programs branch on what an effect returns. This one reads a file next to
the program and turns the outcome into a status code:

```bash
mkdir -p scratch
printf 'hello from input\n' > scratch/input.txt
cat > scratch/read.re <<'RE'
re 0.1 compact
unit @read_demo
cap @files: fs.read@0.1.0

fn @main() -> process.status {
  %contents = @files.read_file(path: "input.txt")
  return match %contents {
    ok(_) => process.exit(0)
    err(_) => process.exit(3)
  }
}
RE
npm run re -- check scratch/read.re
# OK scratch/read.re
npm run re -- run scratch/read.re
# no output, exit code 0
```

`read_file` takes `path:` and an optional `encoding: text.encoding.utf8`; the
short positional form `@files.read_file("input.txt")` reads UTF-8 by default.
Paths resolve relative to the directory of the program file, so
`path: "../README.md"` is outside the sandbox: `check` still passes, and `run`
takes the `err` branch — exit `3` here, with no output and no stack trace. In
`0.1` a matched value cannot be named, so the program can branch on the contents
but cannot print them yet; that binding is scheduled for `re 0.2 compact` in the
[language reference](docs/language-reference.md#grammar-note-result-value-binding--文法说明结果值绑定).

`0.1` 程序可以根据 effect 的返回值分支。下面这个程序读取与自己同目录的文件，
把结果变成退出码：

```bash
mkdir -p scratch
printf 'hello from input\n' > scratch/input.txt
cat > scratch/read.re <<'RE'
re 0.1 compact
unit @read_demo
cap @files: fs.read@0.1.0

fn @main() -> process.status {
  %contents = @files.read_file(path: "input.txt")
  return match %contents {
    ok(_) => process.exit(0)
    err(_) => process.exit(3)
  }
}
RE
npm run re -- check scratch/read.re
# OK scratch/read.re
npm run re -- run scratch/read.re
# 无输出，退出码 0
```

`read_file` 用 `path:` 加可选的 `encoding: text.encoding.utf8`；位置参数短写法
`@files.read_file("input.txt")` 默认按 UTF-8 读取。路径相对程序文件所在目录解析，
因此 `path: "../README.md"` 在沙箱之外：`check` 仍然通过，`run` 走进 `err` 分支——
这里的退出码是 `3`，没有输出也没有堆栈。`0.1` 无法命名匹配到的值，所以程序能根据
内容分支，但还不能把内容打印出来；该绑定已排期到 `re 0.2 compact`，见
[语言参考](docs/language-reference.md#grammar-note-result-value-binding--文法说明结果值绑定)。

The native toolchain is in `native/`. Build the release binary before the tests:
the release-evidence test runs `native/target/release/revia`, so a fresh clone
that goes straight to `cargo test` stops there with exit `101`.

```bash
cd native
cargo build --workspace --release --offline
cargo test --workspace --offline
cargo fmt --all -- --check
cargo clippy --workspace --offline -- -D warnings
```

## Published candidate assets / 已发布候选资产

The `v1.0.0-rc.2.2.1` Linux x64 asset requires **glibc 2.39** (it is built on the
`ubuntu-24.04` runner), so hosts below glibc 2.39 — Ubuntu 20.04 / 22.04, Debian 12,
RHEL 9, Amazon Linux 2023 — cannot load it. Only `ubuntu-24.04` was actually exercised by this project;
other distributions at or above glibc 2.39 are expected to load it but were not measured.
See [compatibility](docs/compatibility.md) before using a prebuilt asset.

`v1.0.0-rc.2.2.1` 的 Linux x64 资产要求 **glibc 2.39**（构建于 `ubuntu-24.04` runner），
低于 glibc 2.39 的主机（Ubuntu 20.04 / 22.04、Debian 12、RHEL 9、Amazon Linux 2023）
无法加载。本项目实际演练过的只有 `ubuntu-24.04`；其他发行版上 glibc >= 2.39 预期可加载，
但未在本机测量。
使用预编译资产前请先看[兼容性](docs/compatibility.md)。

## Historical release assets / 历史发行资产

The existing `v1.0.0-rc.1` binary release is a historical evaluation
candidate. It remains governed by [LICENSE-RC.md](LICENSE-RC.md), not by the
source license. Verify its exact checksums and target evidence before use.
The historical preview line remains governed by
[LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md).

The historical RC is not a production backend and does not establish complete
language output determinism, cross-platform equivalence, full protocol
interoperability, or Stable V1.0.

## Repository hygiene / 仓库卫生

Do not commit credentials, personal data, private messages, local absolute
paths, generated archives, build directories, source maps, or private
infrastructure metadata. Keep temporary probes under ignored `scratch/`.

Before opening a pull request:

```bash
git diff --check
gitleaks dir --redact .
```

Security-sensitive reports must use the repository's private security channel.
