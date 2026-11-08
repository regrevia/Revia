# Diagnostics And Exit Codes

A rejection is a message plus an exit code. This page shows where the message
goes, how to read it, and what to include when you report it.

## Command exit codes

The source CLI exits with one of three codes:

| Code | Meaning | Reach it with |
|---|---|---|
| `0` | the command completed | `node src/cli/re.js check examples/hello.re` |
| `64` | usage error: the arguments do not name a command it runs | no arguments, or an unknown subcommand |
| `65` | the source could not be read, or the check rejected it | `check` on a missing path, or on a rejected file |

A `64` prints the usage banner to stderr and nothing to stdout. A `65` prints
the diagnostic to stderr and nothing to stdout, so a pipeline that reads stdout
only sees output from files that passed.

The native CLI and the Rust test harnesses have their own codes. This page
describes the source CLI that `npm run re --` invokes.

## Program exit codes

`run` passes the code the program asks for through unchanged. A program whose
`err` branch calls `process.exit(3)` exits `3`, and stdout and stderr stay
empty unless the program writes them. A program that fails the check never
runs, so it exits `65` and its own code is not reached.

## Reading a diagnostic line

A diagnostic is one line:

```text
scratch/broken.re:9:28: unexpected-argument (expected data, got message)
```

- The leading path is the file as the command was given it.
- `9:28` is a one-based line and column.
- `unexpected-argument` is a stable code; matching on the code is safer than
  matching on the prose.
- The parenthesized part names the slot and what it received: `write` takes
  data, and the caller passed `message:`.

`check` and `run` produce the same line for the same file, because both reject
before execution.

## Machine-readable form

`--format json` prints one object with `schema: re.check-result@0.1.0`,
`ok: false`, the `file`, and a `diagnostics` array. A rejected argument and a
missing file carry different codes in that array:

- a rejected argument: `code`, `file`, `line`, `column`, `reference`,
  `member`, `expected`, and `actual`;
- an unreadable file: `input-file-unreadable`, `reason: ENOENT`, and
  `line: 1`, `column: 1`.

Both forms exit `65`. The JSON form is for tooling; the line form is for people.

## Reporting a failure

A report is actionable when it carries:

- the command you ran, exactly as written;
- the version you ran it against: the commit (`git rev-parse HEAD`) or the
  candidate version in `native/Cargo.toml`;
- your OS and CPU architecture;
- the smallest input that reproduces it, or the bytes you changed to get there;
- what you saw and what you expected, including the exit code.

[`feedback-loop.md`](feedback-loop.md) describes where a report goes.

中文摘要：诊断是一行 `文件:行:列: 代码 (期望, 实际)`，`--format json` 给出
`re.check-result@0.1.0` 对象与 `diagnostics` 数组；源码 CLI 的退出码为 `0`
完成、`64` 用法错误、`65` 读不到源码或被拒绝；`run` 会把程序自己的退出码原样传出。
报告失败时附上命令、版本或提交、系统与架构、最小复现输入、实际与期望输出及退出码。
