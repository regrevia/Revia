# Re Language Reference / Re 语言参考

This reference describes the public `re 0.1 compact` surface implemented by
the current release binary. The source is a text projection of an executable
semantic graph.

本参考描述当前发行二进制实现的公开 `re 0.1 compact` 表面。源码是可执行语义图
的文本投影。

## Minimal Grammar / 最小语法

```text
program    ::= header unit capability* function
header     ::= "re 0.1 compact"
unit       ::= "unit" identifier
capability ::= "cap" identifier ":" reference
function   ::= "fn" identifier "(" ")" "->" type "{" statement return "}"
statement  ::= binding "=" effect-call
return     ::= "return" "match" binding "{" branch+ "}"
branch     ::= "ok" "(" wildcard ")" "=>" effect-call
           | "err" "(" wildcard ")" "=>" effect-call
```

公开语法使用 `@name` 作为 unit、能力和函数标识，使用 `%name` 作为局部值标识。
当前示例使用字符串字面量，并显式处理 `ok`/`err` 结果分支。

## Capability Contracts / 能力契约

| Capability | Signature | Result / 结果 |
|---|---|---|
| `process.stdout@0.1.0` | `write(data: text.utf8)` | `result<unit, io.write_error>` |
| `process.args@0.1.0` | `read()` | `result<list<text.utf8>, process.args_error>` |
| `fs.read@0.1.0` | `read_file(path, encoding)` | `result<text.utf8, fs.read_error>` |

Capabilities must be declared before use. An undeclared capability or
unsupported argument is rejected by `check`.

能力必须先声明后使用。未声明能力或不支持的参数会被 `check` 拒绝。

## Result And Exit Status / 结果与退出状态

Effects return typed results. `match` makes both branches visible in the
semantic contract:

效果返回带类型的结果。`match` 使两个分支都出现在语义契约中：

```re
%printed = @stdout.write("ready\n")
return match %printed {
  ok(_) => process.exit(0)
  err(_) => process.exit(1)
}
```

| Status | Meaning / 含义 |
|---:|---|
| `0` | Program completed successfully / 程序成功完成 |
| `1` | Example-level effect failure / 示例效果失败 |
| `2` | Example-level input failure / 示例输入失败 |
| `3` | Example-level argument failure / 示例参数失败 |
| `65` | Source or project check failed / 源码或项目检查失败 |
| `69` | No executable for the platform / 当前平台无可执行文件 |
| `70` | Runtime or integrity failure / 运行或完整性失败 |

## Machine Output / 机器输出

`check --format json` and `audit --format json` have independent, versioned
contracts. They do not share a required envelope: `audit` deliberately has no
`ok` field. The shipped binary contract is exercised by
[`scripts/test-json-contract.sh`](../scripts/test-json-contract.sh).

`check --format json` 返回稳定、独立的命令契约；`audit --format json` 也有自己的
版本化契约，并不共享一个强制封装，`audit` 输出刻意不包含 `ok` 字段。仓库通过
[`scripts/test-json-contract.sh`](../scripts/test-json-contract.sh) 直接运行发行版二进制
来验证这两个契约。

### `check` result / `check` 结果

`check --format json` 返回稳定的结果封装：

```json
{
  "schema": "re.check-result@0.1.0",
  "ok": true,
  "file": "examples/agent-review/main.re",
  "diagnostics": []
}
```

For rejected source, `ok` is `false` and each diagnostic contains `code`,
`file`, `line`, `column`, `expected`, `actual`, `member`, and `reference` when
applicable. Agents should branch on `schema`, `ok`, and stable `code` values.

源码被拒绝时，`ok` 为 `false`；每条诊断在适用时包含 `code`、`file`、`line`、
`column`、`expected`、`actual`、`member` 和 `reference`。Agent 应按 `schema`、
`ok` 与稳定 `code` 分支。

The `check` object has these required fields: `diagnostics` (array), `file`
(string), `ok` (boolean), and `schema` (the literal
`re.check-result@0.1.0`). Diagnostic members are extensible; consumers should
branch only on the documented stable members.

`check` 对象要求 `diagnostics`（数组）、`file`（字符串）、`ok`（布尔值）和
`schema`（固定为 `re.check-result@0.1.0`）字段。诊断成员允许扩展；调用方只应依赖
文档列出的稳定成员。

### `audit` result / `audit` 结果

For a successful audit, the object contains the required fields
`capabilities` (array), `effects` (array), `error_paths` (array), `schema`
(`re.audit-result@0.1.0`), and `status_codes` (integer array):

```json
{
  "capabilities": [
    { "binding_kind": "memory", "instance": "@args", "reference": "process.args@0.1.0" }
  ],
  "effects": [
    {
      "access": ["read process.argv"],
      "capability_instance": "@args",
      "member": "read",
      "node_uid": "…",
      "result_consumers": ["…"],
      "returns": "result<list<text.utf8>, process.args_error>"
    }
  ],
  "error_paths": [
    {
      "consumer_uid": "…",
      "error_type": "process.args_error",
      "producer_uid": "…",
      "status_codes": [3]
    }
  ],
  "schema": "re.audit-result@0.1.0",
  "status_codes": [0, 3]
}
```

`node_uid`, consumer identifiers, and list ordering are data-dependent. The
published contract intentionally does not require an `ok` member for `audit`;
the process exit code reports command success or failure. The remaining
project/build command schemas are not generalized here until their runtime
output is captured and tested in the same way.

`node_uid`、consumer 标识和列表顺序取决于输入数据。已发布契约不会为 `audit` 要求
`ok` 字段；命令成功或失败由进程退出码表示。其余 project/build 命令在完成同等的
运行时采样与测试前，不在这里泛化描述。

## One Source, Four Projections / 一份源码，四种投影

```bash
./bin/revia check examples/agent-workflow-brief.re
./bin/revia run examples/agent-workflow-brief.re
./bin/revia manifest examples/agent-workflow-brief.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-workflow-brief.re > review.html
```

`check` validates, `run` observes execution, `manifest` exposes machine facts,
and `view` renders the same facts for human review.

`check` 负责校验，`run` 观察执行，`manifest` 暴露机器事实，`view` 将同一事实
渲染为人类审阅界面。

The [`examples`](../examples/README.md) directory also includes verified
argument and source-directory file-read paths.
[`examples`](../examples/README.md) 目录还包含已验证的参数读取和源目录文件读取路径。
