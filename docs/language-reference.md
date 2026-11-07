# Re Language Reference / Re 语言参考

This reference describes the public `re 0.1 compact` surface implemented by
the current native and Node reference toolchains. The source is a text
projection of an executable semantic graph; each CLI's evidence boundary is
identified separately below.

本参考描述当前发行二进制实现的公开 `re 0.1 compact` 表面。源码是可执行语义图
的文本投影；下文会分别说明各 CLI 的证据边界。

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

### Grammar Note: Result Value Binding / 文法说明：结果值绑定

Version gate: the productions above are `re 0.1 compact`, the surface every
current native and Node toolchain accepts. The value-binding productions below
are `re 0.2 compact`, scheduled and **not accepted by any current toolchain**.

版本门限：上面的产生式是 `re 0.1 compact`，当前所有 native 与 Node 工具链都接受
这一表面。下面的值绑定产生式属于 `re 0.2 compact`，已排期，**任何当前工具链都不接受**。

```text
# scheduled for re 0.2 compact / 已排期到 re 0.2 compact
branch ::= "ok" "(" wildcard ")" "=>" effect-call
         | "err" "(" wildcard ")" "=>" effect-call
         | "ok" "(" binding ")" "=>" effect-call
         | "err" "(" binding ")" "=>" effect-call
```

In `0.1` the wildcard has no binding position, so a matched value cannot be
named or rendered; a branch body must also be an effect call, and every
`process.status`-returning body is what makes the shape executable today.
Measured: `revia check` on `ok(%data) => …` exits 65 with
`re.native-parser-result@0.1.0`, `code:"unexpected-token"`, `expected:"_"`.
The scheduled change moves the payload through `BranchResult` into a register,
bumps the bytecode artifact schemas to `@0.2.0`, and leaves `ok(_)` / `err(_)`
programs parsing and executing exactly as they do now.

`0.1` 中通配符没有绑定位置，匹配到的值无法命名或渲染；分支体也必须是效果调用，
返回 `process.status` 的效果调用正是当前可执行形状的前提。实测：对
`ok(%data) => …` 执行 `revia check`，退出码 65，
`re.native-parser-result@0.1.0`，`code:"unexpected-token"`，`expected:"_"`。
排期中的变更会把 payload 经 `BranchResult` 送入寄存器，把字节码产物 schema 提到
`@0.2.0`；现有 `ok(_)` / `err(_)` 程序的解析与执行保持不变。

A non-`result` return (for example `number.i64` from `clock.monotonic_nanos`)
has no value position either, and `0.1` cannot type it: the response is a plain
`ok`, so `match` on it silently takes the `ok` branch and the value is dropped
(measured: compile and execute exit 0, `outcome.code:0`). The `0.2` work covers
the binding-type rule as well. Impact analysis and schedule:
[`work-packages/result-value-interface.md`](work-packages/result-value-interface.md).

非 `result` 返回（例如 `clock.monotonic_nanos` 的 `number.i64`）同样没有值位置，
`0.1` 也不给它类型：响应是普通 `ok`，因此对它 `match` 会静默走进 `ok` 分支，
值被丢弃（实测：compile 与 execute 均退出 0，`outcome.code:0`）。`0.2` 的工作
同样覆盖该绑定类型规则。影响分析与排期见
[`work-packages/result-value-interface.md`](work-packages/result-value-interface.md)。

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
`ok` field. For RC1, [`scripts/test-json-contract.sh`](../scripts/test-json-contract.sh)
executes the RC1 binary with `check` and `manifest` fixtures and validates their
native schemas. It does not treat static JSON files as execution evidence or
claim that the broader Node-preview envelope is an RC1 interface.

`check --format json` 返回稳定、独立的命令契约；`audit --format json` 也有自己的
版本化契约，并不共享一个强制封装，`audit` 输出刻意不包含 `ok` 字段。对于 RC1，
[`scripts/test-json-contract.sh`](../scripts/test-json-contract.sh) 执行实际发行版二进制的
`check` 与 `manifest`，而不是只读取静态 JSON 后返回成功。更宽的 Node preview JSON
surface 不会被倒灌成 RC1 承诺。

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

The source-oriented examples below use the Node reference CLI (`npm run re --`).
The versioned `bin/revia` launcher exposes the native release command surface;
its `run` signature is `run <graph> <artifact> <input-digest>`.

```bash
npm run re -- check examples/agent-workflow-brief.re
npm run re -- run examples/agent-workflow-brief.re
npm run --silent re -- manifest examples/agent-workflow-brief.re > manifest.json
npm run --silent re -- view --locale en-US --format html examples/agent-workflow-brief.re > review.html
```

`check` validates, `run` observes execution, `manifest` exposes machine facts,
and `view` renders the same facts for human review.

`check` 负责校验，`run` 观察执行，`manifest` 暴露机器事实，`view` 将同一事实
渲染为人类审阅界面。

The [`examples`](../examples/README.md) directory also includes verified
argument and source-directory file-read paths.
[`examples`](../examples/README.md) 目录还包含已验证的参数读取和源目录文件读取路径。
