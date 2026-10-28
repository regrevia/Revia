# RE Dev Demo 0.1 · 宿主契约

本文补全 [07-dev-demo-0.1.md](07-dev-demo-0.1.md) 的 P0 宿主 seam。它不规定文件系统、进程或 Agent 协议如何实现，只规定 RE 程序、schema registry 与 host adapter 之间必须保持的语义。可执行测试矩阵见 [09-host-conformance-0.1.md](09-host-conformance-0.1.md)。

## 1. 四层解析链

```text
capability instance
  → pinned capability interface
  → member effect operation schema
  → host adapter
```

- **capability interface** 是带不可变 revision 的 effect 契约集合。
- **capability instance** 是程序获得授权的局部句柄。
- **member operation schema** 决定参数、返回类型和 resource footprint。
- **host adapter** 执行该契约；本地函数、MCP server 或远程 Agent 都只能出现在这一层之后。

不得把 capability instance 直接解析为任意宿主函数名，也不得由 host adapter 临时改写 operation schema。

## 2. Revision 固定

Demo 候选在 `cap` 声明处固定整个 capability interface revision：

```re
cap @args: process.args@0.1.0
cap @input: fs.read@0.1.0
cap @output: fs.write@0.1.0
cap @stdout: process.stdout@0.1.0
```

规则：

1. `(capability identity, revision)` 对应的 canonical schema bytes 必须不可变；契约变化必须发布新 revision。
2. canonical call 保存 capability instance 与 member 名；其 `cap` 声明间接且唯一地固定 member schema，不在每个 call 重复 revision。
3. `re check` 必须在 registry 中解析精确 revision；缺失时报 `missing-schema-revision`。Registry 若为同一 `(identity, revision)` 提供两个不同的 canonical definition，必须拒绝加载并报 `schema-revision-conflict`。
4. revision 是语言级契约标识，不是 Git branch、commit 或宿主函数版本。
5. Demo 内置 registry 可以随工具链发布；完整 V1 是否增加内容 digest lock 仍属 Q-schema。

纯 op 不经 capability instance；Demo 内置 pure op 由文件头中的语言版本 `0.1` 固定，source form 另由 `compact|canonical` 明示。未来 module/package revision 另行定义。

## 3. Demo capability interfaces

| Capability reference | Member | Returns | Resource footprint |
|---|---|---|---|
| `process.args@0.1.0` | `read()` | `result<list<text.utf8>, process.args_error>` | `read process.argv` |
| `fs.read@0.1.0` | `read_file(path, encoding)` | `result<text.utf8, fs.read_error>` | `read fs.file(path)` |
| `fs.write@0.1.0` | `write_file(path, data)` | `result<unit, fs.write_error>` | `write fs.file(path)` |
| `process.stdout@0.1.0` | `write(data)` | `result<unit, io.write_error>` | `write process.stdout` |

Demo 错误类型先固定为以下闭合 variant 集：

```text
process.args_error = invalid_utf8
fs.read_error      = not_found | permission_denied | outside_sandbox | invalid_utf8 | io
fs.write_error     = parent_not_found | permission_denied | outside_sandbox | no_space | io
io.write_error     = broken_pipe | io
```

新增或删除 variant 会改变契约，必须发布新的 capability interface revision。

宿主 registry 的 capability interface definition 用独立 `types` 表保存闭合错误 sum；member 仍只在 `returns: result<T, E>` 中引用 `E`，不再重复 variant 集合：

```text
types["fs.read_error"] = {
  kind: "error-sum",
  variants: ["invalid_utf8", "io", "not_found", "outside_sandbox", "permission_denied"]
}
```

`types` 属于 pinned interface 的 canonical definition。Variant 作为集合按 UTF-8 bytewise canonicalize；空集合、重复 variant、畸形集合以及被 `result` 引用但未定义的错误类型都使 registry 原子拒绝整批加载。

Host adapter 必须返回 schema 声明的精确类型：

- 环境中的预期失败映射为声明的 `err(E)`；
- adapter、协议或解码失败只有在 `E` 明确包含对应 variant 时才能映射为程序错误；
- transport 无法解码 payload 时，adapter 只报告稳定 fault reason；HostEnvironment 负责补齐 capability instance/reference、member 与 invocation identity，并丢弃未声明细节；
- 无法按契约映射时产生 `host-contract-violation`，停止运行，不得伪造 `ok`、`err` 或默认值。

## 4. Capability instance 与 host binding

源程序和 canonical 只声明 capability instance 及其 interface revision。具体 adapter binding 属于运行环境，例如本地沙箱 adapter、测试用内存 adapter、MCP adapter 或 A2A adapter；endpoint、凭据和传输参数不进入 program graph。

运行前，宿主必须验证：

1. 每个 capability instance 恰有一个 host adapter；
2. adapter 声明支持完全相同的 capability reference；
3. 未声明 capability 的 effect 无法绑定；
4. adapter 不得暴露 interface 之外的 member；
5. audit 可以报告 adapter 类别与契约 revision，但不得输出凭据。

本地 adapter 与测试 adapter 都跨同一 interface seam，测试不得绕过 capability 检查直接调用实现。

## 5. `result`、`re run` 与 `re audit`

Demo 入口固定为：

```re
fn @main() -> process.status
```

- 任意 effect 的 `result<T, E>` 必须在图内被 `match`、传递或 `return` 消费；宿主不自动替程序选择错误分支。
- `process.exit(code: process.exit_code)` 在 Demo 中是 **pure op**，只构造 `process.status`；它不是 capability，也不在节点求值时提前终止宿主进程。
- `re run` 仅在 `@main` 完成并返回 `process.status` 后，把 `code` 映射为宿主进程退出码。
- Demo `process.exit_code` 是范围 `0..255` 的命名整数类型；上下文中的整数字面量由 `re check` 验证，普通 `int` 不隐式转换。完整 V1 是否提供 fallible `process.exit_code.from_int` 不属于本轮。
- check 失败时程序不启动；host fault 与程序返回的非零 status 是不同 outcome，CLI 文本必须带不同标签，机器接口也不得把两者合并。
- `re audit` 报告 capability reference、effect result 类型、每个 result 的消费点、可能的 status 分支和 host binding 类别；它不执行 effect，也不预测具体 `err` 是否发生。

## 6. A2A 与 MCP 的位置

A2A 与 MCP 都可以实现 host adapter，但不是同一种语义：

- [A2A](https://a2a-protocol.org/latest/) 面向独立 Agent 的发现、交互和协作任务，适合“把 capability 委派给远程 Agent”的 adapter。
- [MCP](https://modelcontextprotocol.io/docs/learn/architecture) 使用 host/client/server 结构暴露 tools、resources 和 prompts，适合“把 capability 绑定到工具或资源 server”的 adapter。

RE 不把任一协议的消息、任务或工具 schema 直接当作 operation schema。Adapter 必须：

1. 验证远端能力能满足 pinned capability interface；
2. 在 RE typed values 与协议 payload 之间做确定转换；
3. 将协议失败按 §3 映射，无法映射时报告 host fault；
4. 保留 effect invocation 的关联身份供诊断与回放，但不把传输会话写入 canonical。

因此“兼容 A2A/MCP”是 adapter conformance，不是 `.re` 语法开关。

## 7. P0 验收

宿主契约至少通过：

1. 同一程序分别绑定本地 adapter 与内存测试 adapter，得到相同 typed outcome；
2. capability revision 缺失、registry 定义冲突或 adapter reference 不匹配时，`re run` 在 effect 前失败；
3. 未声明 capability 的 effect 无法解析；
4. `fs.read_file` 的预期文件错误成为 `err(fs.read_error)`，而 adapter 解码错误成为 host fault；
5. `process.exit` 不要求 capability，且只有 `@main` 返回后才映射退出码；
6. audit 能区分 program error path、program status 与 host fault；
7. A2A/MCP adapter 若存在，必须复用同一 capability interface conformance tests。

详细 registry、binding、machine output 与内置操作向量见 [09-host-conformance-0.1.md](09-host-conformance-0.1.md)。本文件先作为 P0 候选；完成上述测试前，不宣称 A2A/MCP 已由 Demo 实现。
