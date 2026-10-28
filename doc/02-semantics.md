# 02 · 语义规则

本文档定义图谱的**节点、边、能力、副作用、序**，是 `re audit` / 执行器共同依据的语义契约。

## 1. 节点（node）

每个节点是不可变的图实体，具备：

| 字段 | 说明 |
|---|---|
| uid | 持久稳定身份：compact 创建事务按 `re.deterministic-uid-sequence@0.1.0` 分配的固定 UID；canonical/structured 重入时已有 UID 原样保留，写入后不可变 |
| cid | 可选的内容 revision digest，不是身份，不参与 set 排序 |
| label | UID 的固定长度短写，仅作 canonical 文本内句柄 |
| alias | 人类可读别名，不参与身份或语义等价 |
| kind | 节点类别（见下） |
| type | 结果类型，canonical 必填 |
| params | 命名参数表（值边）+ 序边表 |

节点类别：

- **literal**：字面量（内联展开而成）。
- **call**：纯函数调用（无副作用），如 `text.utf8.from_int`。
- **effect**：有副作用操作，如 `@stdout.write`。effect 节点是唯一允许触达外部世界的节点；`effect` 是 node kind，不是值类型，节点仍按 op schema 产出 `unit`、普通命名类型或 `result<T, E>` 等明确类型。
- **return**：函数出口。
- **structural**：不可执行的结构节点，不产出 runtime effect，仅定义控制依赖与值汇合。包括 `region`（分支 arm 容器）、`merge`（值汇合）、`loop-header`（state 初值与 backedge 汇合，phi-like）、`join`（并发结果收集）。compact 层不直接写 structural 节点，由 `match` / `loop` / `par` desugar 生成（见 [04-translation.md](04-translation.md)）。

## 2. 边（edge）

边是**有向**的，明确两类：

| 边类型 | 来源 | 语义 |
|---|---|---|
| value edge | 实参引用 `data: %x` | 数据依赖：被引节点产出值，供当前节点使用 |
| order edge | `after: %x` | 仅序依赖：要求被引节点先发生，不消费其值 |

规则：

- **R-edge-1**：每个 value edge 隐含一条 order edge——传值即定序。即「先算出值，才能用值」。
- **R-edge-2**：`after:` 只用于纯序边。不允许 `after:` 引用一个其值正被当前节点消费的节点（语义冗余，规范器报错）。
- **R-edge-3**：order edge 不构成循环（除 loop 的 backedge 显式标记）。`re audit` 检测非法环。

这把 `after:` 从「万能序原语」收窄为「丢弃值的序边」，验证器（可达性、未处理结果）与优化器（重排/并行）都有了无歧义的图结构。

## 3. 序与求值

- **R-seq-1**：节点在其所有入边（value + order）的来源全部完成后，方可执行。每个节点都有供调度器和 order edge 使用的内部 completion event；它不是运行时值，不进入类型系统或 canonical 参数。
- **R-seq-2**：无依赖的**纯节点**没有语义执行顺序；执行器可串行、重排或并行，且不得产生可观察差异（纯节点并行不可观察，由 R-det-1 保证）。**并行许可不写进图谱**，避免把硬件调度策略固化。
- **R-seq-3**：`par` 外，同一条可执行路径上可能共同发生的 effect 必须由 value edge、order edge 或 loop 迭代序形成 happens-before；不可比较时报 `unordered-effect`，不静默猜成并发。互斥 `match` arms 中不会共同发生的 effect 无须彼此定序。**可观察的 effect 并发只能由显式 `par`** 表达；同一 `par` branch 内仍按本规则定序，不同 branch 之间按 R-det-3 审计资源相交。

## 4. 确定性（determinism）

- **R-det-1**：纯节点（literal / 无外部 IO 的 call）的输出只依赖输入值，相同输入相同输出。
- **R-det-2**：effect 节点的「可观察副作用集合」必须是有限的、可静态列举的（同一程序在相同环境下副作用集合固定）。`@stdout.write("X")` 的可观察副作用 = {stdout 一次写入 "X"}。
- **R-det-3**：本规则只给显式 `par` 内不同 branch 的 effect 授予并发许可。每个 effect node 由 op schema 和实参实例化出 `read` / `write` resource footprint；read/read 相容，任一方为 write 且资源可能重叠时冲突。资源可证明不重叠时并发合法；无法证明时保守视为重叠，必须有显式 order 约束，否则 `re audit` 报「未约束的副作用竞争」。v1 不接受 `parallel_safe` 布尔值绕过 footprint 比较，也不得在 `par` 外援引“资源不相交”绕过 R-seq-3。
- **R-agent-concurrency-1**：project runtime 必须把每个 root/nested task 绑定到同一 `graph_revision` 下的 `task_id + scope_path + branch`；detached task、revision drift、缺失/未知 scope 在任何 runner dispatch 前 fail closed。`task_id` 是这些字段的 canonical digest，不由数组位置或路径字符串猜测。
- **R-agent-concurrency-2**：project task 的 resource footprint 在执行前做保守冲突检查。read/read 可共存；任一 write overlap 直接拒绝。声明为 mutable 的 alias 不能跨 task scope 共享，即使当前访问均为 read 也拒绝；冲突不通过 runtime race 观察来补救。
- **R-agent-concurrency-3**：project audit 是 `re.project-concurrency-audit@0.1.0`，保留既有 `re.concurrency-trace@0.1.0` 的 ordinal/lifecycle authority，并在 task event 上附加 `task_id/graph_revision/scope_path`，scheduler summary 以 task ids 重放。audit verifier 必须先校验 project identity，再剥离投影字段调用既有 trace verifier；不得把 audit projection 变成第二套并发语义。
- **R-det-4**：禁止隐式不确定性来源（无显式 RNG capability 的随机、无显式 clock capability 的取时）。需要随机/取时必须先 `cap` 声明对应能力。
- **R-det-5**：`par` 的 Program `err(E)` 是正常 completed value，不按竞速顺序选择“首个错误”或隐式取消 sibling。Join 按稳定 branch identity 产生全部 `task.outcome`；parent/deadline cancel 向下传播，host fault 在全部 child cleanup 后仍保持 host fault 分层。

Resource footprint 在进入 P0-06 overlap checker 前必须由 P0-07 归一为 exact domain digest 与层级 typed canonical segment；segment identity 同时包含类型摘要和 canonical bytes，不能把显示字符串相同但类型不同的 key 合并。相同 domain 的 prefix overlap 保守相交，动态未知 key 覆盖整个 domain；alias resolution 不由 scheduler 猜测。

R-det-3 是 Hello-World 这类直线程序之外、保证「相同程序相同可观察行为」的关键约束。

## 5. 能力（capability）

- **R-cap-1**：任何触达外部世界的能力（IO、网络、文件、时钟、随机、子进程…）必须在 `cap` 声明后才能引用。
- **R-cap-2**：未声明的 capability 引用 → `re check` 直接报错，定位到节点 + 参数。
- **R-cap-3**：`fn` 可声明所需 capability 子集（capability 传递），调用方必须持有；这是模块边界的权限模型。
- **R-cap-4**：`re audit` 的「能力清单」来自全图 `cap` + effect 节点引用核查，是可机器核对的声明，而非散文。

## 6. 副作用（effect）与回放友好

RE 把「副作用全显式 + 能力全声明」当硬约束，这一性质对**回放/录制**天然友好（呼应上层项目「请求不可伪造、副作用可控」的精神，但二者完全独立）：

- 一个 RE 程序的 effect 节点序列 + 入参，构成它的「副作用脚本」，可被录制、回放、对比。
- 无 effect 的纯函数天然可缓存、可并行、可重放。
- Module artifact 缓存不改变语言语义：key 必须绑定 implementation/interface、直接依赖 interface/package pin、toolchain 和 target profile；缓存文件摘要只证明字节完整性，命中还必须由当前 compiler-owned verifier 证明 payload 与该 key/module 语义等价。损坏、旧 key、半写或同步重签但语义漂移的 payload 一律不得复用。
- Project build 必须先以 project loader 得到完整 path-free graph；不能拿旧 Module cache 或调用方自签 manifest 直接决定可复用性。版本化 build key 绑定 graph/project/package/toolchain/profile，previous manifest 必须与已原子发布的同 key bytes 完全一致；add/delete/rename、dependency/package pin、implementation/interface 与 toolchain/profile 漂移都只按当前 graph 计算失效。
- `re audit` 给出的副作用清单即回放比对基准。

## 7. 错误模型（候选规则，部分待验证）

第一版草案倾向：错误是**带类型的值**，沿 value edge 正常流动，不引入隐式异常或栈展开。

- **R-err-1**：`result<T, E>` 是内置封闭 sum：`ok(T) | err(E)`；`error` 只是 `err` 携带的普通带类型值。`match` 是 core/canonical 唯一的 sum 消去与分支原语，不另立 `fail<T>` 或核心 `handle`。
- **R-err-2**：可失败的 op / effect 声明 `result<T, E>`。`effect` 只描述 node kind；节点的 completion event 只负责定序，不充当成功值。
- **R-err-3**：成功时没有业务载荷的 op 使用 `unit`；只有外部系统确实返回可消费信息时才由 op schema 声明普通命名类型（领域可以把它命名为某种 receipt）。v1 不设通用 completion-token 或通用 `receipt<R>` 类型。
- **R-err-4**：任何 `result<T, E>` 都必须被 `match`、作为值传递或由函数 `return` 消费；effect node 不因副作用已经发生而获得豁免。`after:` 只建立 order edge，不消费 result，也不等于“错误已处理”。
- **R-err-5**：V1 不提供 postfix `?`、`handle` 或局部 `result { ... }` 传播边界。错误只能由显式穷尽 `match` 消去，或作为精确同型的 `result<T,E>` 值 pass/return；因此没有可跨越 `loop` / `par` 的隐藏控制流。表面糖只能在 V1.x 用 byte-identical 唯一 lowering 和 region barrier 反例证据重提。

Agent lifecycle 是 project-level 的 closed contract，而不是新的 `.re` machine 语法。`re.agent-contract@0.1.0` 绑定 Agent identity、module、typed identity/input/output/error references、initial/retryable/terminal states 与显式 `from + event -> to` pairs，并复用 `re.control-flow-contract@0.1.0` 生成确定性 state-machine graph。运行期事件提交必须先匹配同一 Agent identity 和当前 state 的声明 pair；unknown event、illegal pair、terminal 后 event、identity mismatch 与 malformed contract 均返回版本化拒绝诊断，不抛宿主异常、不隐式 retry、不静默推进状态。Project graph 可内联多个 lifecycle contract，但 duplicate Agent identity 或 contract module 不在 project module set 时必须在 capability/runtime 前 fail closed。

Durable task 使用独立的 `re.task-contract@0.1.0` 与 `re.task-checkpoint@0.1.0`。任务请求必须携带 Agent/module/node UID、revision、输入和 caller idempotency key；task identity 是这些字段的稳定 digest，不能只由声明顺序或运行次序决定。重试只按有限 `max_attempts` 和显式 backoff 执行，非 retryable error 不得隐式重试。checkpoint 的 task/revision/input digest、attempt、state 和声明 data fields 必须完全匹配；旧 revision、脱离 Agent 的 task、越界 retry、额外字段和取消竞态均 fail closed。外部 effect 必须携带 effect key；同一 task 的同 identity replay 只读取已提交结果，不重复 effect，不同 task 占用既有 key 则拒绝。cancel-before-start 不启动 performer；cancel-after-start 仅在主 effect 已提交时由成功结果胜出，否则得到明确 cancelled outcome。

Task reference runtime 的 lifecycle 只消费显式 parent signal、relative timeout、timer functions 与 owned resource。performer 看到的是 runtime 内部 signal；parent/timeout first-reason-wins，取消后返回的未提交 success 不得写 effect。signal add/remove/aborted、timer functions 与 resource close 在 startup 前单次快照并 intrinsic-bind；setup rollback 与每条 terminal path 都必须尝试清 timer、移除 listener、关闭 resource，不能因首个 cleanup fault 遗留后续资源。已有 host/checkpoint 主诊断不被 cleanup fault 覆盖；否则首个 cleanup fault映射为稳定 task diagnostic。close 失败撤销本次新 effect，replay 和旧静态 cancellation 兼容语义不变。

V1 函数调用图必须为 DAG，直接与相互递归均拒绝；递归算法用显式 worklist + `loop(state)` 表达。`match` guard 是 pure bool value subgraph；effect、环、悬空节点或无 guard fallback 均拒绝。`loop` 只有 `next(state)` / `done(value)` 两种 terminator 与一条显式 backedge，没有 `return` / `break` / `continue`。这些规则的有界机器 oracle 见 `re.control-flow-contract@0.1.0`；它不是 source grammar。

## 8. 可达性与未处理结果

- **R-reach-1**：从 `fn` 入口经 value/order 边可达所有节点；不可达节点 `re audit` 报「死节点」。
- **R-reach-2**：产出了值但无任何消费者（也不被 return 消费）的节点，`re audit` 报「未处理结果」。effect 节点仅当结果类型为 `unit` 时可因“副作用即目的”省略值消费者；若结果类型为 `result<T, E>`，必须遵守 R-err-4。order edge 不是值消费者。
- **R-reach-3**：`return` 必须消费与函数声明返回类型一致的节点。

## 9. V1 类型与 canonical value

- **R-type-1**：Core 类型闭包为 `unit/bool/text.utf8/bytes/int/decimal<scale>`、nominal record/closed sum/newtype、`option/result`、immutable `list/map/set`、opaque resource handle 和显式参数化类型。类型相同由 exact nominal contract 与类型实参决定，不按字段结构猜测；V1 无隐式转换、float、trait、继承或反射。
- **R-type-2**：`int` 是任意精度有符号数学整数。`decimal<scale>` 的 scale 为 `0..255`、系数为任意精度整数。Rescale 必须显式携带 rounding；scale 不减只允许 `exact`，有损路径只允许 `exact/toward_zero/floor/ceiling/half_even/half_away_from_zero`，且不得继承宿主 rounding/locale。
- **R-type-3**：record 必须恰好提供全部字段，sum 必须使用声明 variant。泛型实例在 checked/canonical graph 中携带 declaration digest 与完整有序类型实参；compact 推断只有唯一解时才可省写。
- **R-type-4**：递归只通过当前 declaration 的 `self`，保持当前 nominal identity 与泛型实参，并且声明必须 productive。跨 declaration 只接受 exact digest reference，不提供 mutual digest cycle。Canonical payload 嵌套深度上限为 128；它不是 runtime collection length 或 graph size 限制。
- **R-type-5**：`text.utf8` 必须是 Unicode scalar sequence 并 canonicalize 为 NFC。Map/set key 只允许 `bool/int/decimal/text.utf8/bytes` 及其 newtype，按类型语义总序排序去重；禁止使用宿主 hash、locale collation 或插入顺序。Opaque resource handle 可沿 checked value edge 流动，宿主对象本身不得进入 canonical value。

可执行契约由 `src/toolchain/type-contract.js` 的 `re.type-declaration@0.1.0`、`re.canonical-value@0.1.0` 与对应 corpus 固定。它们是 checker/serializer 的共同 interface，不是 source grammar。
