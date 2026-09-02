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

The public capability catalog and historical result shapes are defined in the
[language reference](language-reference.md). The RC1 trial surface adds bounded
project and multi-module fixtures; use its pinned command arrays rather than
inferring a general command contract from the preview examples.
公开能力目录和历史结果结构见[语言参考](language-reference.md)。RC1 试用面加入有界项目和
多模块 fixtures；请使用其固定命令数组，不要从预览示例推断通用命令契约。

## Historical Preview Commands / 历史预览命令

```text
revia check [--format json | --write] <file.re>
revia audit --format json <file.re>
revia build --out <dir> <file.re>
revia manifest <file.re>
revia run [--format json] <file.re> [-- <args>...]
revia translate --format json <file.re>
revia view [--locale zh-CN|en-US] [--format html|svg] <file.re>
```

The table above describes the historical preview surface. For `v1.0.0-rc.1`,
run `revia --help` on macOS arm64 and use
[`experiments/rc1/kit/trial-manifest.json`](../experiments/rc1/kit/trial-manifest.json)
as the only deep-trial command contract.
上表描述历史预览命令面。对于 `v1.0.0-rc.1`，请在 macOS arm64 运行 `revia --help`，并以
[`experiments/rc1/kit/trial-manifest.json`](../experiments/rc1/kit/trial-manifest.json)
作为唯一的深度试用命令契约。

Use schema identifiers, structured fields, and stable codes as the machine
interface.
机器接口以 schema 标识、结构化字段和稳定代码为准。

For the compact syntax and public result shapes, see the
[language reference](language-reference.md).
compact 语法和公开结果结构见[语言参考](language-reference.md)。
