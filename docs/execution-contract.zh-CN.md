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
./bin/revia check examples/agent-handoff-review/main.re
./bin/revia run examples/agent-handoff-review/main.re
./bin/revia manifest examples/agent-handoff-review/main.re > manifest.json
./bin/revia view --locale zh-CN --format html examples/agent-handoff-review/main.re > review.html
```

将源码、`manifest.json`、`review.html`、输出和退出状态作为一组审阅证据。
源码变化后，应对照四个视图重新检查。

## 公开契约面

| 表面 | 作用 |
|---|---|
| `.re` | Agent 编写的可执行源码 |
| `check` | 源码与语义校验 |
| `run` | 有界执行与实际结果 |
| `manifest` | 机器可读的能力、效果和路径事实 |
| `view` | 人类可读的语义图 |

发行包是可运行入口。语言规则和输出 schema 分别见
[语言](language.md) 与 [CLI 协议](protocol.md)。
