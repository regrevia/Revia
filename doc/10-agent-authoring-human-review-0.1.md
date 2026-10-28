# 10 · Agent 写作与人类语义审阅闭环（0.1-preview）

> 状态：发布规划冻结候选；WP-243～WP-245 已有实现与 conformance，仍等待独立 Reviewer 审阅；不是 Stable 或首次公开发布声明。
>
> 目标：把 Revia 0.1-preview 的差异点收敛为可复跑闭环：外部 Agent 提出受限修改，人类审阅实际语义变化，RE 对同一 revision 完成检查、执行、翻译与 receipt 证明。

## 0. 定位与非主张

Re 不提供自然语言理解、模型推理或内置 LLM。自然语言需求由外部 Agent 或人类解释；RE 只接受其生成的结构化候选，并把候选约束为 revision-pinned、UID-pinned、可检查的图编辑事务。

因此首发的准确表述是：

> 外部 Agent 负责把意图转成候选修改；Re 负责验证该修改对应哪一张语义图、改变了哪些可审阅事实、是否可执行，以及是否留下可重放 receipt。

以下主张均不成立，且不得用于首发宣传：

- Re 能从任意自然语言自动生成正确程序；
- Re 自带大模型或替代人类审批；
- 人类翻译、HTML/SVG 页面或 Agent prose 能反向改变 checked graph；
- 当前 Preview 是完整独立 VM、production backend 或 Stable V1.0。

## 1. 端到端闭环

```text
自然语言需求
  -> 外部 Agent 读取 revision-pinned project review index
  -> 结构化 checked-edit proposal
  -> dry-run: project patch + check + semantic diff
  -> 人类审阅 before/after semantic facts
  -> approve 或 reject（均不改 graph）
  -> atomic apply 到同一 base revision
  -> check -> manifest/audit -> run -> translate
  -> revision-pinned receipt 与可重放证据
```

权威顺序固定为：checked project graph、project patch receipt、fact ledger、run receipt。自然语言、Agent 推理过程、HTML/SVG 与人工审批记录均是关联证据，不得成为第二语义真源。

`dry-run` 不得落盘；`approve`/`reject` 不得隐式 apply；apply 必须整体成功或原文件完全不变。check、manifest、audit、run、translate 必须指向 apply 后的同一 graph revision；任何 stale revision、UID 前置条件错误、未知字段、capability escalation、检查失败或 receipt authority 漂移都 fail closed。

## 2. 发布工作包

这四个工作包是 AI-native Preview 发布轨。它们依赖 WP-238 的本轮 Reviewer 结论，但不依赖 WP-239～WP-242 的 standalone runtime 后续能力；后者继续独立推进，不得被首发营销重写为已实现。

### WP-243 · Agent Authoring Loop

**范围**：把现有 project review index、`re.project-patch@0.1.0`、check/audit/run/translation/receipt 接为受控编辑循环。新增的 proposal 必须绑定 base graph revision、index revision、受影响 UID、旧值前置条件、操作集合与 capability/effect 影响声明；proposal digest 精确覆盖这些字段。

**退出条件**：

- Agent 可按需读取 project review index，而不是扫描整图；
- dry-run 输出 versioned semantic diff、候选 result revision 或稳定拒绝，并且不写入项目；
- apply 只接受已批准且 digest-exact 的 proposal，原子产生 project patch receipt；
- stale revision、错误 UID、未知/额外字段、伪造 proposal digest、越权 capability/effect、检查失败与中途失败均拒绝且原项目不变；
- 成功 apply 后，check、manifest、audit、run、translate、receipt 的 graph revision 完全一致；
- corpus 至少覆盖成功修改、stale patch、错误节点、越权 effect、伪造 digest 和原子回滚。

**不扩展**：不新增 `.re` 语法、自然语言 parser、模型 connector、自动 merge 或分布式编辑协议。

### WP-244 · Human Semantic Review

**范围**：把同一 before/after fact ledger 生成为可审阅的 JSON 权威产物，以及 zh-CN/en-US text、HTML/SVG 派生视图。审阅重点是语义事实，不是文本格式差异。

**必须显示**：新增、删除、修改的 fact；受影响 module/UID；类型；输入输出；error branch；capability/effect；resource；并发与 lifecycle；before/after graph revision；check/run/receipt 结果。新增权限、effect 或 error branch 必须显著标记。

**退出条件**：

- 注释、声明顺序、格式和等价 carrier 的变化不产生 semantic change；
- JSON、zh-CN、en-US、HTML、SVG 使用同一 semantic fact digest；
- 缺失/不支持的事实模板、过期 revision 或 renderer drift 显式失败，不得静默遗漏；
- approve、reject、stale 是版本化审阅记录，均绑定 proposal/base/result revision，且不反向写 graph；
- 人类可从任一变化回链到 fact ID、UID 与 evidence anchor。

**不扩展**：不把生成式解释作为审计权威，不在本包冻结 UI graph 或浏览器产品前端。

### WP-245 · AI Writing Evaluation Corpus

**范围**：建立公开、固定、可复跑的 Agent 写作评估任务，而不是模型排行榜。每个任务固定初始 revision、可用 review-index query、允许的编辑边界、oracle 与 human-review expectation。

**最小任务集**：修改业务规则、添加错误分支、修改 closed type、调整 retry policy、修改 HTTP 契约、stale revision 攻击、capability 越权尝试、无语义重排、跨 module 修改、receipt replay 检查。

**记录字段**：首次生成是否通过、修复轮数、wrong-graph 数、危险修改是否被拒绝、semantic diff 是否足够人工审阅、命令耗时与诊断阻塞点。允许比较不同 Agent/模型，但不得将样本外推为通用智能或安全结论。

**退出条件**：任务、oracle、输入边界和结果 schema 版本化且 digest-pinned；所有正常/攻击样本可在无 API key 的固定 proposal 模式复跑；任何结果缺少命令、commit、revision 或 receipt 证据时只能记为无效，不能计为成功。

**当前实现**：`re.agent-writing-evaluation@0.1.0` 固定 10 个任务与
`fixed-proposal` 模式。6 个正常任务真实执行
proposal→dry-run→approval→apply→human semantic review；无语义重排要求
zero semantic change；stale revision、capability 越权与 receipt replay 三类攻击
稳定拒绝。报告记录 `first_generation_pass`、`repair_rounds`、
`wrong_graph_count`、`dangerous_modification_rejected`、
`human_review_sufficient`、`command_duration_ms` 与 diagnostic，并绑定 corpus、
project、source authority 和 toolchain digest。该结果只证明固定结构化候选在当前
冻结协议下可复跑，不能外推为自然语言生成质量、通用 Agent 安全性或模型排名。

### WP-246 · Public AI-Native Demo

**范围**：以 `examples/agent-expense-review/` 交付一个 60 秒、无需 API key 的确定性公开演示。演示预置 proposal，允许任何 Agent 在相同约束下重做，但不要求项目携带模型凭据。

**主路径**：

```text
需求：5000 元以上需要二次审批
  -> 读取局部 review index
  -> 生成或加载 checked-edit proposal
  -> dry-run + semantic diff
  -> 人类批准
  -> atomic apply
  -> project check/run/translate
  -> replay receipt
```

**负路径**：同一公开包必须可演示 stale proposal 拒绝、capability 越权拒绝，以及 before/after 审阅页。发布说明必须把“固定 proposal 可复跑”与“外部 Agent 自主产出候选”分开陈述。

**退出条件**：fresh clone 内的脚本、文档、fixture 和展示产物相互一致；一个不持有 API key 的评估者可运行成功与两条失败路径，并提交结构化评估报告；公开树不得含 relay、scratch、内部治理材料、机器状态或凭据。

## 3. 费用审批参考项目

`examples/agent-expense-review/` 是受控业务验收项目和发布演示场景，不是自然语言处理 benchmark。

它模拟一个可审计 Agent 后端：员工提交费用，系统校验金额和凭证，按政策决定审批，持久化结果，并覆盖 retry、deadline、cancel、replay、错误与 capability/resource 边界。六个 module 分别承担 domain、policy、persistence、intake、approval 和 API 角色。

它用来证明四件事：

1. Re 能表示并检查多 module 的业务语义图；
2. 外部 Agent 能借由索引定位局部语义并提出受限编辑；
3. 人类能审阅业务行为、权限、错误和 lifecycle 的变化；
4. 同一 graph revision 可贯穿 check、manifest、audit、translation、run 与 replay receipt。

它不证明 Re 具备自然语言理解、内建大模型、完整 Web 前端或可直接部署的生产费用系统。该项目中的自然语言需求只是外部 Agent 的输入；真正被 Re 检查的是结构化 proposal 及其对语义图的影响。

## 4. Revia 0.1-preview 首发硬门

首次公开发布前必须同时具备：

1. WP-238 得到本轮独立 Reviewer 结论，且未发现阻塞性 wrong-graph、authority 或 release 问题；
2. WP-243～WP-246 通过独立复审；
3. 完整 `npm test`、grammar fuzz、release hard gate 与公开树 fresh-clone 验证均有当前 revision 的证据；
4. 当前公开包明确保留已测 Darwin/Linux 证据与 Windows pending 边界，不复制旧 receipt；
5. 商标注册或最终法律清查完成；
6. 公开树不含 relay、scratch、凭据、内部治理材料或未公开权益资料；
7. 对外版本固定为 `Revia 0.1-preview`，不称 Stable V1.0、production compiler/backend、完整独立 runtime 或“AI 自动写对程序”。

首发的讨论重点应是：结构化 Agent 编辑是否比文本 patch 更易验证，语义 diff 是否足以支持人类审批，以及 receipt/replay 是否让复现与反馈更可靠。性能、独立 runtime、完整 Server deployment 与 Browser/UI profile 继续按照既有工作包和证据门推进。
