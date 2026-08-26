# 执行架构

Revia keeps the Agent's program executable and the human's review surface
connected by one deterministic flow:

```text
.re source
    |
    v
parse and translate
    |
    v
validation
    |
    v
runtime execution
    |
    +--> manifest: machine-readable contract
    |
    +--> view: human-readable semantic graph
```

Revia 将 Agent 编写的程序与人类审阅界面连接在同一条确定性流程中：

```text
.re 源文件
    |
    v
解析与翻译
    |
    v
校验
    |
    v
运行时执行
    |
    +--> manifest：机器可读契约
    |
    +--> view：人类可读语义图
```

## 核心边界

- `.re` 是可执行语义图的文本形式。
- `check` 在运行前校验源码。
- `run` 执行已校验程序并报告结果。
- `manifest` 暴露稳定的机器可读事实。
- `view` 将同一组事实翻译为人类审阅界面。

公开示例保持简洁，但完整走过源码到审阅的路径：

```bash
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re
./bin/revia view --locale zh-CN --format html examples/agent-review/main.re > review.html
```

生成的 `manifest` 与 `view` 均来自 Revia 翻译器对同一 `.re` 文件的直接处理。

## 审阅面

`manifest` 记录能力、效果、错误路径、当前生成的标识和图 revision；`view`
将这些事实呈现为简洁语义图。两者都不是另写的一份程序描述。
