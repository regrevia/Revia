# 执行契约

Revia 将 Agent 编写的源码到人类审阅的路径明确连接起来：

```text
.re 源文件
    |
    v
解析 -> 已检查语义图 -> manifest
                       |
                       v
                   语义视图
                       |
                       v
                   有界运行
```

同一份源码驱动所有投影：`manifest` 是机器可读契约，`view` 是人类审阅界面，
`run` 报告实际观察到的运行结果。

## 可审阅内容

公开 CLI 暴露：

- 已声明且固定版本的能力；
- 能力效果及其类型化结果分支；
- 成功与失败路径；
- 图 revision 与稳定 UID anchor；
- 运行输出与退出状态。

这些内容由生成产物连接起来。语义图由 Revia 直接根据 `.re` 翻译生成，不是
另写的一份解释。

## 验证流程

```bash
npm run re -- check examples/agent-handoff-review/main.re
npm run re -- run examples/agent-handoff-review/main.re
npm run --silent re -- manifest examples/agent-handoff-review/main.re > manifest.json
npm run --silent re -- view --locale zh-CN --format html examples/agent-handoff-review/main.re > review.html
```

将源码、`manifest.json`、`review.html`、输出和退出状态作为一组审阅证据。
源码变化后，应对照四个视图重新检查。

这些面向源码的命令使用 Node 参考 CLI。`bin/revia` 是版本化 native 入口；
它的 `run` 接收已检查的 graph、bytecode artifact 和 input digest。启动器只解析
`runtime/checksums.txt` 中记录了发布资产的那个候选：在 pending 目标上它报告
`pending target` 并以 `69` 退出，因此在规划基于启动器的运行前先看
[兼容性矩阵](compatibility.md)。

## 公开契约面

| 表面 | 作用 |
|---|---|
| `.re` | Agent 编写的可执行源码 |
| `check` | 源码与语义校验 |
| `run` | 有界执行与实际结果 |
| `manifest` | 机器可读的能力、效果和路径事实 |
| `view` | 人类可读的语义图 |

## 声明能力的授权（native）

native 的 `execute` 与 `run` 接受两个彼此独立的运维产物：

```bash
revia run --schema-registry registry.json \
          --capability-policy policy.json \
          program.re program.rebc sha256:<input-digest>
```

| 产物 | 回答什么 | 不回答什么 |
|---|---|---|
| `--schema-registry`（`revia.host-schema-definitions@0.1.0`） | member 的参数与返回类型是什么 | 本次运行能否调用它 |
| `--capability-policy`（`revia.capability-policy@0.1.0`） | 本次运行可以调用哪些 `reference.member` | 宿主是否实现了它们 |

策略是封闭对象：`{"schema": "revia.capability-policy@0.1.0", "grants":
[{"reference": "<schema>@<version>", "members": ["<member>", ...]}]}`。
schema 取值是文本；数字形式会以
`native-capability-policy-invalid:schema-not-text`（退出 65）拒绝。未知字段、
缺失字段、重复 member、不支持的 schema 取值都会以
`native-capability-policy-invalid:<reason>` 拒绝。

策略只放行声明式宿主 member，因此它不是文件系统或进程沙箱：内置能力
（`process.stdout`、`process.args`、`fs.read`、`fs.write`、
`clock.monotonic_nanos`）在策略未提及它们时照常执行，其可达范围由宿主沙箱
限制（`runtime-run` 显式接收沙箱根目录）。

行为一律 fail-closed，并在 WP-355 中收紧：

- 图引用了声明 member 但没有 `--capability-policy`：在构建宿主之前就以
  `native-host-capability-policy-missing` 拒绝（退出码 65）。只给 registry
  不再能放行这类图；
- 策略授予了本构建不提供的 member：绑定时以
  `native-host-capability-policy-not-served:<reference>.<member>` 拒绝；
- 已授权但本次策略未授予的调用：在宿主边界以
  `native-host-bridge-capability-denied` 拒绝，边界后的 adapter 不会被调用；
- 策略文件读不出来是退出码 66，解析不了是 65。成功运行的 stdout 会输出
  `re.native-host-execution-result@0.1.0`，含 `invocations[]` 与 `trace[]`。

`execute --print-values`、`run --print-values` 与 `runtime-run --print-values`
会在 `invocations` 旁增加一个可选成员 `invocation_values[]`：顺序与长度都和
`invocations` 一致，每项是该次调用返回的带类型值（VM 值编码
`{"type":…,"value":…}`）。执行失败时根本不打印宿主执行结果，因此该格式下不存在
`null` 项。三条命令观察的是同一次执行：同一份源码、同一份产物、同一个输入摘要
会打印相同的字节——`runtime-run` 路径的区别只在于解包与沙箱。该成员是可选扩展：
不加参数时输出不变，也不参与任何 `receipt_digest`，因此观察行为不会移动已固定的
回执。详见
[work-packages/result-value-interface.md](work-packages/result-value-interface.md)。
该成员是待 schema 修订的可选扩展，尚不是稳定契约。

这是运维授权产物，不是沙箱：宿主 adapter 本身仍是受信代码。完整边界与已测
限制记录在 [work-packages/availability.md](work-packages/availability.md)。

发行包是可运行入口。语言规则和输出 schema 分别见
[语言](language.md) 与 [CLI 协议](protocol.md)。
