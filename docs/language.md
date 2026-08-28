# Re Language / Re 语言

Re is a compact textual form of an executable semantic graph. Agents write the
text; Revia checks, runs, identifies, and renders the graph.
Re 是可执行语义图的紧凑文本形式。Agent 编写文本，Revia 检查、运行、标识并生成人类审阅图。

## Program / 程序

```re
re 0.1 compact

unit @agent_review

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %handoff = @stdout.write("agent=ready\n")
  return match %handoff {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
```

## Rules / 规则

1. `re 0.1 compact` is the first physical line. / `re 0.1 compact` 位于首个物理行。
2. `unit` names the program. / `unit` 命名程序。
3. External capabilities use revision-pinned declarations. / 外部能力使用固定版本声明。
4. Effects return typed values; success and failure are explicit. / 效果返回类型化值，成功与失败均显式表达。
5. The semantic graph is authoritative; `.re` is its text form. / 语义图是权威表示，`.re` 是其文本形式。

## Capabilities / 能力

- `process.stdout@0.1.0`
- `process.args@0.1.0`
- sandboxed source-directory file read and write / 源码目录沙箱内的文件读写

## Commands / 命令

```text
revia check [--format json | --write] <file.re>
revia audit --format json <file.re>
revia build --out <dir> <file.re>
revia manifest <file.re>
revia run [--format json] <file.re> [-- <args>...]
revia translate --format json <file.re>
revia view [--locale zh-CN|en-US] [--format html|svg] <file.re>
```

`revia --help`, `revia help <command>`, and `revia <command> --help` describe
the launcher command surface. `check --write` rewrites the source into
canonical text.
`revia --help`、`revia help <command>` 与 `revia <command> --help` 展示启动器命令面；
`check --write` 会将源码重写为规范化文本。

Use schema identifiers, structured fields, and stable codes as the machine
interface.
机器接口以 schema 标识、结构化字段和稳定代码为准。
