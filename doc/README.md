# RE 语言设计文档

> RE 是一套独立的「AI 原生语法」语言设计草案。完整 V1 仍在打磨；RE Dev Demo 0.1 宿主基线已冻结，Hello World 工具链切片已经可运行。
>
> 设计目标：一种**以程序语义图谱为正典（ground truth）、`.re` 文本是图谱的确定性可逆序列化载体**的语言。
> 既是程序，又能被人读、被 Git diff、被 Agent 通过结构化 API 直接改图。

## 文档索引

V1.0 P0 的讨论状态、冻结门与实现工作包统一见 [../V1-DESIGN.md](../V1-DESIGN.md)；本目录承载冻结后的分篇规范与详细证据。

| 文档 | 内容 |
|---|---|
| [00-overview.md](00-overview.md) | 设计理念、定位、核心矛盾与破法 |
| [01-syntax.md](01-syntax.md) | 第一版语法（compact 可写形态 + canonical 规范形态） |
| [02-semantics.md](02-semantics.md) | 语义规则：节点、边、能力、副作用、序 |
| [03-serialization.md](03-serialization.md) | 确定性可逆序列化规范（决定 Git/diff 友好性） |
| [04-translation.md](04-translation.md) | 翻译规则：compact → canonical desugar，re view / audit 生成规则 |
| [05-execution.md](05-execution.md) | 执行规则：图遍历、求值序、错误传播、终止 |
| [06-open-questions.md](06-open-questions.md) | 待打磨项（控制流/并发/类型系统/标准能力清单等） |
| [07-dev-demo-0.1.md](07-dev-demo-0.1.md) | 可供 Agent 开发的 Demo 0.1 冻结基线 |
| [08-demo-host-contract-0.1.md](08-demo-host-contract-0.1.md) | Demo 0.1 capability revision、host adapter 与运行结果契约 |
| [09-host-conformance-0.1.md](09-host-conformance-0.1.md) | Registry/binding 规则、机器输出与内置宿主操作测试向量 |
| [10-agent-authoring-human-review-0.1.md](10-agent-authoring-human-review-0.1.md) | 0.1-preview 的 Agent 写作、人类语义审阅、评估与公开演示闭环 |
| [11-node-free-milestone-0.1.md](11-node-free-milestone-0.1.md) | WP-251..262 自有原生翻译器、执行器、运行时与大型项目里程碑 |
| [../release/README.md](../release/README.md) | 专利候选、个人权益、开源许可、品牌与发布闸门 |
| [../examples/](../examples/) | 样例（Hello World、控制流、错误重试、op schema） |

## 当前进度

- 版本：re 0.1 草案
- 阶段：Demo 0.1 host conformance 已冻结，最小 `check/run` Hello World 垂直切片已实现
- 完整 V1 退出条件：主要规则经过多 Agent 评审和样例回归后，再扩展到完整翻译器/运行器
