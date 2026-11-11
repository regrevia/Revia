# Diagnostics And Exit Codes

A rejection is a message plus an exit code. This page shows where the message
goes, how to read it, and what to include when you report it.

## Command exit codes

The source CLI exits with one of four codes:

| Code | Meaning | Reach it with |
|---|---|---|
| `0` | the command completed | `node src/cli/re.js check examples/hello.re` |
| `64` | usage error: the arguments do not name a command it runs | no arguments, or an unknown subcommand |
| `65` | the source could not be read, or the check rejected it | `check` on a missing path, or on a rejected file |
| `70` | host fault: a host input named on the command line could not be used | `run --format json --authority-pin` with a pin that is missing, not JSON, or not a pin |

A `64` prints the usage banner to stderr and nothing to stdout. A `65` prints
the diagnostic to stderr and nothing to stdout, so a pipeline that reads stdout
only sees output from files that passed.

A `70` is not the program failing: a host input it needs to start cannot be
used. Under `--format json` the run result on stdout names the phase and the
fault, and no program code runs:

```text
{"outcome":{"fault":{"code":"load-time-authority-pin-json-invalid","phase":"load-time-authority"},"kind":"host-fault"},"program_stdout":"","schema":"re.run-result@0.1.0"}
```

The measured codes on that path are `load-time-authority-pin-unreadable` for a
missing file, `load-time-authority-pin-json-invalid` for bytes that are not
JSON, and `load-time-authority-pin-invalid` for JSON that is not a pin. Asking
for a pin without `--format json` is a usage error instead: stderr starts with
`Usage error: --authority-pin requires --format json` and the exit is `64`.

The native CLI and the Rust test harnesses have their own codes. This page
describes the source CLI that `npm run re --` invokes.

## Native CLI exit codes

`native/target/release/revia` is the compiled CLI, so its codes are its own:
`0` success, `64` usage or unknown command, `65` source, project, or contract
failure, `66` input file unreadable, and `101` an internal panic.

A `66` names the read that failed instead of exiting silently. It prints one
diagnostic object on stdout, the same shape `check` uses, and leaves stderr
empty:

```text
{"byte_end":0,"byte_start":0,"code":"input-unreadable","column":1,"end_column":1,"end_line":1,"file":"missing.re","lexeme":"","line":1,"phase":"source","repair":"inspect","rule":"source.read","schema":"re.source-diagnostic@0.1.0","severity":"error"}
```

`file` is the path the command was given and `rule` is `source.read`, so a
caller can report which input was unreadable without parsing the message. A
file that reads but does not parse is a different outcome: it exits `65` and
prints the diagnostic that names the offending token.

## Launcher exit codes

`bin/revia` is a launcher around a released binary, not the source CLI, so it
adds codes the table above does not cover:

| Code | Meaning | Reach it with |
|---|---|---|
| `69` | the candidate has no release asset for this platform | any command on a `pending` target |
| `70` | a release record it reads is missing or damaged | an unreadable `runtime/checksums.txt`, or a record with no rows for this version |

A `69` prints `pending target` and points at the
[compatibility matrix](compatibility.md). Rebuild `native/` and run it
directly to get past it; the launcher itself has nothing to download.

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

## Repairing a rejected edit / 修复被拒绝的修改

An edit is rejected before execution, so the diagnostic is the whole reply:
exit `65`, one line naming the file, the position and a stable code. Each pair
below is measured on a copy of `examples/hello.re`; the repair is the smallest
edit that makes the same file exit `0`.

Changing the header version:

```bash
node src/cli/re.js check scratch/re-0.2.re
```

```text
scratch/re-0.2.re:1:4: unsupported-language-version (expected 0.1, got 0.2; phase header; rule header.language-version; repair choose 0.1)
```

The parenthesized clause names the rule and the value to choose; restore
`re 0.1 compact` and the check passes. A version this release does not accept
is not a forward-compatible extension.

Deleting the `cap` line while the body still calls it:

```text
scratch/no-cap.re:8:14: unknown-capability-instance
```

The position is the call site, not the missing declaration. Restore the
`cap @stdout: process.stdout@0.1.0` line and the check passes; `manifest`
then reports that reference under `capabilities`.

Naming a capability revision the target does not provide, such as
`process.stdout@9.9.9`:

```text
scratch/bad-revision.re:6:1: missing-schema-revision
```

The position is the `cap` line. Use the reference the target provides —
`process.stdout@0.1.0` here — and the check passes.

中文摘要：被拒绝的修改不会运行，回复就是退出码 `65` 加一行诊断，指出文件、
位置和稳定诊断码。上面三组都在 `examples/hello.re` 的副本上实测：改头部版本
得到 `unsupported-language-version`，括号里已写明该选的 `0.1`；删掉 `cap` 行
得到指向调用点的 `unknown-capability-instance`，补回声明即可；写目标不提供的
能力版本得到指向 `cap` 行的 `missing-schema-revision`，改用目标提供的能力引用
即可。每处修复都只是把那一行改回去或改对。

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

If you can open an issue, the repository's bug report form
([`.github/ISSUE_TEMPLATE/bug.yml`](../.github/ISSUE_TEMPLATE/bug.yml)) asks for
exactly these fields, so the report starts actionable.
[`feedback-loop.md`](feedback-loop.md) describes the other report paths.

中文摘要：诊断是一行 `文件:行:列: 代码 (期望, 实际)`，`--format json` 给出
`re.check-result@0.1.0` 对象与 `diagnostics` 数组；源码 CLI 的退出码为 `0`
完成、`64` 用法错误、`65` 读不到源码或被拒绝、`70` host 故障（程序没有运行，
故障原因写在 stdout 的 run 结果里）；`run` 会把程序自己的退出码原样传出。
报告失败时附上命令、版本或提交、系统与架构、最小复现输入、实际与期望输出及退出码。
