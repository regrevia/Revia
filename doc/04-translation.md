# 04 · 翻译规则

本文档定义三类翻译：

1. **desugar**：compact → canonical（已有身份图谱的展开与规范化是确定性纯函数；无 UID 新输入先经过创建事务）。
2. **view**：图谱 → 直观人类视图（自然语言，**仅供阅读，不作审计结论**）。
3. **audit**：图谱 → 可机器核对的审计声明（结构化，作权威结论）。
4. **translation artifact**：checked graph → versioned execution artifact IR；当前只定义 Node Demo reference seam，不选择 production backend。

### 0.1 project-level accuracy contract

当输入从单文件扩大到 Agent project 时，翻译仍然只接受已检查且 revision-pinned 的 graph。准确翻译不是模型读懂后自由写一段话，而是一个可回归验证的事实投影：

```text
project source
  → checked project graph
  → authoritative audit fact ledger
  → locale-neutral Semantic View IR
  → zh-CN/en-US text, JSON, HTML, SVG
```

For the materialized Agent project, capability/error/state/task/edge review
facts originate in versioned `.re` module declarations and are lowered into the
checked graph. A manifest sidecar cannot add or replace those semantic facts;
project-level capability allowlists and resources remain explicit policy.
Task retry/checkpoint contracts, adapter capability/resource/profile contracts,
and hermetic run-case requests/outcomes are likewise source-owned graph facts.
Nominal type declarations, typed business-function signatures and bodies, and
the Agent lifecycle contract also lower from the versioned module surface. The
business body records its normalized control-flow graph, function-call DAG,
capability calls, resources, and effect edges; source and manifest Agent
contracts must have the same contract digest.
Human translation projects these typed declarations for review, while
`project-run` accepts only a graph-pinned case selection and run controls.
The run receipt binds the selected business-function declaration digest and,
for the supported single-capability result flow, each typed host invocation.
Concrete request, ok, and error values are validated against package source
declarations before they cross the host boundary or enter the receipt. An
explicit adapter injection seam does not make the default hermetic outcomes
production database, HTTP, or secret evidence.

事实账本中的每条记录至少包含 `fact_id`、`graph_revision`、`uid`、`fact_kind`、规范化值和 `evidence_anchor`。`semantic_fact_digest` 对按规范排序后的完整事实集合计算，渲染器不能自行新增、删除或重解释事实。

必须满足以下不变量：

1. **同事实集**：从任一 locale/format 提取的 fact set 与 audit fact set 完全相等；顺序差异只能由稳定 renderer order 表示，不能改变 digest。
2. **同图不漂移**：绝对路径、文件排列、声明顺序、注释、compact/canonical carrier 变化，在 graph identity 不变时不得改变事实 digest。当前 compact creation 固定使用 `re.deterministic-uid-sequence@0.1.0`；同一 compact bytes 在全新进程和目录中的首次创建必须得到同一 UID、canonical 与 revision。
3. **可回链**：每条句子、JSON record、HTML/SVG 节点都能回到 `fact_id`、UID、graph revision 和 source/canonical evidence。
4. **不完整即失败**：缺失模板、未知 fact kind、stale revision、digest mismatch、unsupported construct 都输出 versioned diagnostic 并以非零退出；不得静默省略。
5. **不执行**：translate/view/audit 只消费 checked graph，不调用 capability、不读取 secret、不触发 Agent task。
6. **语言只改表述**：locale renderer 只能替换版本固定的术语、数字/日期格式和句式；不得改变 capability、resource、retry、cancel、error、ordering 或 state transition 的值。

项目级最小覆盖必须包含：package/module map、Agent state/event transition、task identity/idempotency、retry/deadline/cancellation、capability/resource footprint、error path、execution order、patch/revision delta 和 evidence links。缺少任何一类时，项目翻译不得标记 complete。

---

## 1. desugar：compact → canonical

对已有 UID 的图谱，desugar 是**纯函数、确定性**的，给定同一身份图谱必然得到同一 canonical。没有 UID 的 compact 输入通过固定 `re.deterministic-uid-sequence@0.1.0` 创建身份，因此同一 compact bytes 的不同创建事务也得到同一 UID；结构变化必须改变其对应 canonical/revision。

### 1.1 步骤

```
compact 文本
  → parse: 解析为初始图谱（保留人类别名、内联字面量、位置参）
  → infer: 类型推断（补全可推断类型；不允许隐式转换）
  → create-or-load-uid: 已有 UID 原样保留；无 UID 节点按固定 allocator 顺序分配 UID，并由 UID 生成 label
  → expand-inline:
       字面量内联      → literal 节点 + value edge 接到原参数
       调用内联        → call/effect 节点，%name 绑定改为别名旁注
       位置参（主值参）→ 翻译为命名参数（查 op 的主值参名）
  → order-edges: implicit order edge 标注（传值即定序），显式 after 保留为纯序边
  → normalize: 键字典序 / 空白 / 数值字符串规范（按 03-serial §3–5）
  → emit canonical
```

### 1.2 内联展开规则

| compact | canonical 节点 |
|---|---|
| `@stdout.write("X")` | 一个带 UID/label 的 effect 节点，调用 `text.utf8.const(value: "X")` literal 节点并建立 value edge |
| `process.exit(0, after: %printed)` | 一个带 UID/label 的 `process.status` 节点，参数规范化为 `after`、`code`（`0` 按 03-serial §5 处理） |
| `%m = @stdout.write(...)` | 节点在创建事务中获得 UID；`%m` 作为 alias 旁注保留 |

### 1.3 顺序边规则

- 每条 value edge 自动衍生一条隐式 order edge（desugar 时在图上标注，canonical 文本不显式打印该隐式序，因为它由 value edge 决定）。
- `after:` 在 desugar 后**只保留为纯序边**；若检测到 `after:` 的目标值正被当前节点消费 → 报错 `redundant-order-edge`。

### 1.4 确定性保证

desugar 的每一步都不引入非确定性：

- 类型推断若存在多个合理解 → 报错 `ambiguous-type`，要求人补类型，**不猜**。
- UID 在创建事务中按 `re.deterministic-uid-sequence@0.1.0` 生成并持久化；序列化器不得重新分配 UID。label 由 UID 纯函数生成，碰撞时报 `ambiguous-label`。
- 键序按 codepoint，唯一确定。

### 1.5 desugar 不变量

- **身份图谱等价即 canonical 相同**：两张图若节点/边/类型/UID 一致，canonical byte-identical；只忽略 UID 的结构语义等价不要求文本相同。
- **round-trip**：canonical → 图 → canonical 幂等（见 03-serial §7）。

---

## 2. re view：图谱 → 直观人类视图

`re view hello.re` 输出**自然语言或可视化**视图，目标是让人快速理解程序在做什么。

> ⚠️ **定位警告**：`view` 是从结构化事实渲染的非权威表达，**不是审计结论**。任何关乎安全/权限/副作用的判断必须以 `re audit` 为准。`view` 的输出顶部须标注「此为可读翻译，非审计结论」。

V1-P0-08/10 预留的候选管线是：

```text
checked graph / audit
  → Project review index（revision、UID、cursor、changed-since）
  → Semantic View IR（locale-neutral facts + evidence anchors）
  → zh-CN / en / ... locale renderer
  → text / HTML / SVG
```

大型项目默认只返回 project/package/module 摘要，再按 symbol/path/node 展开；不得要求首次查看就扫描或输出整张 graph。不同语言和介质必须保留相同 fact ID 与 semantic-fact digest，节点可回链到 UID/evidence。WP-166 已提供 `re.project-translation@0.1.0` 的 checked-project artifact：它从同一 Semantic View IR 生成 JSON、text、HTML、SVG，缺少 project/module/Agent lifecycle/task/capability/resource/error/execution-order 任一事实类别时 fail closed；`re project-translate` 不执行 capability、不读取 secret、不触发 Agent task。实现路线和完成门见 `docs/superpowers/plans/2026-08-10-re-agent-project-roadmap.md`。

样例输出（hello）：

```
程序：hello                    [可读翻译，非审计结论]

程序目的：
  启动后输出“Hello, World!”，然后正常结束。

执行过程：
  1. 创建 UTF-8 文本“Hello, World!”。
  2. 将文本写入标准输出。
  3. 等待写入完成。
  4. 以状态码 0 结束。

所需能力：标准输出写入。
输入：无。
外部影响：写入标准输出一次。
确定性：相同运行环境下结果固定。
```

生成规则（确定模板化，避免自由生成漂移）：

1. 顶部固定标注。
2. 「程序目的」从 `fn` + 关键 effect 节点用模板渲染；不杜撰未在图中出现的语义。
3. 「执行过程」按拓扑序枚举节点，每节点一句模板描述。
4. 「所需能力 / 外部影响 / 确定性」直接引用 audit 的结构化结果，**不自行推断**。
5. locale renderer 只能替换版本固定的术语和句式；缺少模板时显式失败，不得静默漏掉事实。
6. 可选 LLM 只能在确定 view 之后生成另一个明确标注的风格化副本，不能增加、删除或改写审计事实，也不参与 check/build/run。

---

## 3. re audit：图谱 → 结构化审计

`re audit hello.re` 输出**可机器核对**的审计声明，是权威结论。

样例输出：

```
权限：
  ✓ 仅使用 stdout.write

副作用：
  ✓ 标准输出写入 1 次
  ✓ 不访问文件
  ✓ 不访问网络
  ✓ 不读取系统时间
  ✓ 不使用随机数

执行顺序：
  创建文本 → 写入文本 → 以状态码 0 结束

验证：
  ✓ 类型正确
  ✓ 能力完整（所有 effect 均有 cap 声明）
  ✓ 所有节点可达
  ✓ 无未处理结果
  ✓ 无未约束的副作用竞争（R-det-3）
  ✓ 无非法环（除显式 backedge）
```

生成规则（纯结构推导）：

- 「权限」= 全图 `cap` 集合 ∪ effect 节点核对。
- 「副作用」= 遍历 effect 节点，按 capability 分类计数；未出现的能力显式标 ✓ 不访问。
- 「执行顺序」= 拓扑序的稳定序列（无 order 边并列时）。
- 「验证」项逐条对应 [02-semantics](02-semantics.md) 的 R-* 规则；任一未满足改为 ✗ 并定位节点。
- audit 输出本身**也可序列化为结构化 JSON/YAML**，供 CI 二次核对；文本版只是渲染。

### 3.1 audit 的退出码

- 全部 ✓ → exit 0。
- 任一 ✗ → exit 非 0，供 CI 阻断（呼应：出错必须精确到节点/参数/约束）。

---

## 4. translation artifact

`re translate --format json <file.re>` 只消费 checked graph，不执行 capability，也不重新解释已经检查过的调用绑定。成功输出 `re.translation-result@0.1.0`，其中的 `re.execution-artifact@0.1.0` 固定：

- `graph_revision`：canonical graph bytes 的 SHA-256；
- `canonical.bytes/schema/sha256`：可再次加载的 canonical RE 及其精确摘要；
- `runtime.kind` 与 `target_profile`：当前为 `node-demo-reference` / `node-demo-translator@0.1.0`；
- `artifact_sha256`：绑定 schema、unit、graph revision、canonical digest、runtime kind 与 target profile 的 canonical identity；
- `unit`：checked graph 的语义单元名。

 compact 输入使用 deterministic UID allocation，因此同一 source bytes 换绝对路径仍得到相同 artifact。source/check failure 和 unsupported graph construct 均 fail closed；CLI 统一输出 versioned JSON diagnostic 并返回 exit 65。该 artifact 不是签名、release lock、production backend 或性能证明。

### 4.1 project translation artifact

`re project-translate [--locale zh-CN|en-US] [--format json|text|html|svg] <project-dir>` 先调用 project loader，再把已检查 graph 送入 `re.fact-ledger@0.1.0` 与 `re.semantic-view-ir@0.2.0`。成功的 `re.project-translation@0.1.0` 包含完整 facts、`graph_revision`、`semantic_fact_digest`、UID/evidence anchors、changed-since baseline 和 `translation_digest`。JSON 是机器 authority；text、HTML、SVG 只是同一 facts 的 locale/media 表达，HTML/SVG 每个节点必须带 `data-fact-id`、revision、UID 和 evidence anchor。

locale 只影响固定术语与句式，`translation_digest` 不随 locale 或媒体变化；绝对路径、声明顺序、注释和等价 carrier 不进入 digest。缺少模板、未知 fact kind、semantic view digest mismatch、非法 revision 或不完整项目分类均返回稳定 diagnostic，不输出伪完整摘要。该 artifact 是人类审阅投影，不是 audit authority、patch authority、LLM 自由改写、执行产物或 production backend。

### 4.1 production lowering（占位）

未来 RE 程序图 → RE Core IR → WASM → ARM64/x86-64。本版不定义。但语义规则（[02](02-semantics.md)）的「纯/effect 分离、序边、确定性」已为 lowering 留好接口：

- 纯节点可自由重排/内联/消除。
- effect 节点按 order 边约束重排。
- 确定性约束保证 lowering 前后可观察行为一致。

---

## 5. 命令总览

```
re run    hello.re     验证并执行
re check  hello.re     只验证；顺带规范化输出 canonical（gofmt 语义）
re translate --format json hello.re  生成 revision-bound execution artifact IR
re view   hello.re     翻译为直观人类视图（非审计结论）
re audit  hello.re     展示完整结构化审计信息（权威结论）
```

`re check` 的规范化输出行为（是否就地写回 .re、是否需 `--write`）见 [06 Q-cli](06-open-questions.md)。
## WP-164 project facts and semantic view

Project review output consumes one `re.fact-ledger@0.1.0` authority. Each fact is
bound to the checked `graph_revision`, deterministic `fact_id`, source digest,
and either a UID or explicit evidence anchor. Project, package, module, Agent,
state, task, capability, error, resource, and concurrency-event facts use the
same canonical ordering and digest.

`re.project-review-index@0.2.0` exposes stable pagination, `changed-since`, and
revision-pinned local fact expansion. `re.semantic-view-ir@0.2.0` is a
projection of that same fact set; locale changes do not change
`semantic_fact_digest`. Missing or unsupported locale coverage fails closed.
The index and semantic view are review projections, not audit authority and
not the structured patch or translator backend.
