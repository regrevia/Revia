# 11 · Node-free 原生工具链里程碑 0.1

本文定义 Revia 从 Node Preview 迁移到自有原生翻译器、执行器与运行时的连续工作包。它扩展 `V1-P0-13` 的 backend seam，不改变已冻结的 `.re` 语义、canonical identity、capability authority 或 release lock 规则。

## 1. 完成定义

只有同时满足以下条件，才允许把本里程碑交给统一独立 Reviewer：

1. 单一原生 `revia` 二进制可在没有 `node`、`npm`、JavaScript bundle 或 Node shared library 的环境中完成 `check`、`translate`、`run`、`manifest`、`project-init`、`project-check`、`project-test`、`project-build` 与 `project-run`。
2. 原生翻译器从 compact `.re` source 生成版本化、digest-bound 的 `re.native-bytecode-artifact@0.1.0`；执行器在 effect 前重新验证 artifact、Graph revision、release lock 与 target profile。
3. 原生 VM 覆盖当前冻结的 literal、capability call、pure std、`result` match、function DAG、loop、`par`/join、task lifecycle 和 closed error 边界；不存在 source-order 猜测、隐式 authority、orphan task 或未声明 effect。
4. 原生 Server profile 至少提供 process args/stdout、sandboxed fs read/write、UTF-8/bytes/list/result/text 基础 std、environment/secret snapshot、monotonic time、random、logging、HTTP/1.1 与 SQLite adapter 的版本化最小实现。
5. 一个不少于 50 Module、10,000 行 `.re`、100 条 route/task、10,000 并发 task 的代表性费用与审批服务由原生路径完成 cold build、incremental build、run、retry/cancel/replay 和 bounded soak；wrong-graph、semantic mismatch 与 orphan 数均为 0。
6. native 与 Node reference 在冻结 corpus 上的 graph revision、diagnostic code/phase/rule/span、artifact semantics、outcome、receipt 和 fact set mismatch budget 均为 0；Node 只作为迁移期 oracle，不进入最终发行 gate。
7. macOS/Linux/Windows 的 arm64/x64 release archive 只含原生 executable、license、notice、release lock 和 digest metadata；泄漏扫描、source-map/JS/Node import 扫描和真实 CLI smoke 全通过。
8. 已验证的 native graph/artifact 可以打包为可移动、可离线重验的 runtime bundle；bundle
   移动后运行结果保持 exact，graph/artifact/input/sandbox authority drift 在 host effect
   前拒绝。

不在本里程碑内：UI graph、浏览器 runtime、A2A/MCP 全协议、生产 PKI/HSM、Stable V1.0 命名、P0 `ACCEPTED`、自动公开发布。统一 Reviewer 通过前只生成不可公开的 release candidate。

## 2. 架构选择

原生工具链使用 Rust 2024 edition 和标准库实现，不引入 crates.io 依赖。这样 release 构建不依赖 npm 或网络，并把 parser、diagnostic、VM value、task ownership 与跨平台 host boundary 放在有内存安全保证的实现中。现有 C11 standalone runtime 保留为 protocol/conformance oracle，不成为新工具链的核心架构。

```text
UTF-8 .re source / project manifest
  -> native lexer + parser
  -> checked graph + stable diagnostics
  -> deterministic bytecode translator
  -> artifact verifier + release lock admission
  -> native VM scheduler
  -> explicit Server capability adapters
  -> outcome + receipt + audit/manifest projection
```

原生 workspace 位于 `native/`：

- `native/revia-core`：无 host I/O 的 source、diagnostic、canonical、digest、graph、types。
- `native/revia-compiler`：checker、module linker、bytecode translator、artifact verifier。
- `native/revia-vm`：value model、interpreter、structured scheduler、receipt/trace。
- `native/revia-server`：显式 capability adapter；Core/VM 不直接读取环境或打开资源。
- `native/revia-cli`：参数、文件边界、命令 envelope 与 exit code。
- `native/revia-conformance`：Node oracle 差分和最终 Node-free gate；不被 release binary 依赖。

所有内部集合在 canonical 或 diagnostic 输出前显式按 UTF-8 bytes 排序。所有 public artifact 使用自实现、已知向量验证的 SHA-256 和 canonical JSON；不得使用 Rust `HashMap` 迭代顺序形成语义或 digest。

## 3. 连续工作包

### WP-251 · 原生 bootstrap 与确定性基础

建立无第三方依赖的 Cargo workspace、`revia` CLI skeleton、SHA-256、canonical JSON、UTF-8 byte/scalar span、稳定 diagnostic envelope 和 hermetic native test runner。退出条件：相同输入重复 build/test byte-equivalent；已知 SHA-256 向量与 diagnostic golden 通过；binary dependency scan 不含 Node；WP-250 predecessor audit 写入 Relay。

### WP-252 · 原生 lexer/parser

实现严格 header、compact ASCII trivia、comment、string/numeric/bytes token、source diagnostics 和当前 executable grammar。退出条件：所有 executable fixture 与 parser golden 同 Node exact；invalid corpus 的 code/phase/rule/span exact；100,000 mutation 无 crash、多 parse 或 fallback。

### WP-253 · 原生 checker、canonical graph 与 manifest

实现 capability registry、literal/type/result exhaustiveness、UID、canonical serializer/loader、graph revision、review manifest。退出条件：tracked canonical/check corpus byte-exact；非正典 bytes、unknown schema/member、argument/type 和 identity drift fail closed；两代 round-trip idempotent。

### WP-254 · 原生 bytecode translator 与 verifier

把 checked graph lowering 为版本化 register/region bytecode，覆盖 literal、pure/capability call、result branch、function call/return、loop、par/join 和 task op；artifact 绑定 graph/release/profile/translator digest。退出条件：任一 opcode/register/jump/type/authority 漂移在 effect 前拒绝；重复 translate byte-identical；Node/原生 semantic oracle mismatch 为 0。

### WP-255 · 原生 VM 执行器与基础运行时

实现不可变 value、closed result、call frame、loop worklist、capability bridge、bounded allocation、structured error/receipt。退出条件：当前 execution 9、std 12、fault 13、lifecycle 14 全部由同一 native executable 运行并与 oracle exact；无 expected outcome 输入。

### WP-256 · 原生 structured concurrency 与 task runtime

实现 lexical scope、par/join、FIFO admission、downward cancel、deadline、retry/replay、resource cleanup 与 first-reason terminal。退出条件：10,000 task、nested par、cancel/fault/cleanup corpus通过；orphan=0、late commit=0、trace/receipt mismatch=0；所有 queue/buffer 有显式上限。

### WP-257 · 原生基础 std 与 host adapters

实现 process、sandboxed fs、environment/secret snapshot、time、random、logging，以及 bytes/list/result/text 11 项基础 std。退出条件：memory + real adapter conformance；path/symlink escape、secret post-close、invalid UTF-8、output/resource limits fail closed；Core/VM 无直接 host access。

### WP-258 · 原生 Package/Module/project pipeline

已形成 native project pipeline 的 bounded implementation：`project.json` 是唯一目录入口，loader 对 Package/Module interface、implementation/source digest、内部/外部 exact pin、路径 containment、未列文件、重复 identity 和 DAG cycle fail closed；输出 path-free `re.native-project-graph@0.1.0`。build key 绑定 graph/package/project/profile/toolchain authority，module cache 命中仍经 semantic verifier，previous manifest 以本地已发布 bytes 为 authority，完整 build manifest 使用临时目录加 rename 原子发布。native CLI 已提供 `project-check` 与 `project-build`，并覆盖 50/500/5000 chain plan、cold/warm、implementation/interface/toolchain invalidation、corrupt cache 和失败保留旧 build 的 focused evidence。当前 artifact 仍是 bounded module metadata，不等于完整 source lowering 或 `project-run`。

### WP-259 · 原生 Server profile

实现 bounded HTTP/1.1 route/request/response lifecycle、JSON codec 和 SQLite adapter；authority 全部来自显式 binding。退出条件：真实 loopback HTTP 与 SQLite transaction/retry/cancel；request body/response/backpressure 有界；drain 无 orphan；协议错误映射 closed error。

### WP-260 · 大型代表性项目规模切片

在既有 project/build authority 上建立可复跑的 50 Module、100 route/task public symbol
enterprise fixture，覆盖至少一条长依赖链与 fan-in。退出条件：native
`project-scale` 输出 path-free deterministic report；cold/warm build、implementation-only
和 interface reverse-closure invalidation 通过；缺失/重复 inventory、source/interface
drift、错误拓扑 fail closed。该包是大型项目的规模证据，不等于 10,000 task 或完整
project runtime。

### WP-261 · Native project translate/run

把已验证的 native project graph 接入现有 translator、bytecode verifier 和 VM
executor，提供无 Node 的 `project-translate` 与 `project-run`。退出条件：每个
Module 的 artifact/manifest 绑定同一 graph/build authority；入口 task/route 的
success、closed error、artifact/request/receipt drift 与缺失入口均有 focused
evidence；CLI 输出 path-free deterministic translation/run receipt。

### WP-262 · Node-free hard gate 与性能资格

在 PATH 中隐藏 Node/npm、隔离 JS 源和现有 bundle，fresh release build 原生工具链
并重跑代表 workload。当前闭合的十四个 workload 是 `check`、`translate`、`run`、
`project-init`、`project-check`、`project-test`、`project-build`、`project-translate`、
`project-run`、`server-smoke`、`project-server-smoke`、`project-execute-plan`、
`project-execute-plan-direct`、`project-execute-plan-cached`。报告固定 cold/warm build、startup、throughput、p50/p95/p99、
peak RSS、adapter overhead 和 project overhead；三轮 semantic/workload digest
必须 exact，Node process/load/import 与 JS source count 必须为零。project overhead
定义为 project translate/run 总耗时相对 direct translate/run 总耗时的非负差值。
Go/JVM/Node 未实际测量时保持 `pending`，不生成性能资格或 production claim。10k/100k
task 与真实并发 scheduler 不在本包伪装为已完成，而作为后续 runtime evidence gap。

### WP-263 · 私有原生 release candidate

当前实现先闭合 Darwin arm64 的私有 candidate/package 路径：`release-package` 从 fresh
release binary 生成 path-free manifest、release lock、checksums 和六项 allowlist 文件；
`release-verify` 对 binary、target、source/toolchain digest、lock、manifest、checksums 和
regular-file set 做 exact validation；`release-install` 将已验证 candidate 放入 immutable
version directory 并原子更新 `current`/`previous`；`release-rollback` 只在 current 与
previous 都重新验证后交换指针；`release-matrix` 明确 measured/pending 状态。真实 smoke
在空 `PATH` 下运行已安装 Darwin arm64 `revia --version`，candidate 文件中没有 Node/npm/
JavaScript/source/private path；其他五个目标平台保持 pending，不能交叉复制或宣称已构建。

退出条件仍要求：六平台真实 runner 均无 Node/JS/source fallback；公开边界清单可验证；旧
preview byte-identical；只将 Relay 一次切换为 `awaiting-reviewer`，由用户统一安排独立
Reviewer。当前 candidate 仍不可公开，不是签名发行物、Stable V1.0 或 production backend；
代码签名、公证、external signer/freshness/custody 和跨平台性能另行 pending。Reviewer 通过
后才能另开发布动作。

当前可复核材料保存在 `release/native-release-candidate-manifest.json`、
`release/native-release-platform-matrix.json` 和 `release/native-release-evidence.json`；
Node-free 过程报告为 `release/native-node-free-hard-gate-report.json`。这些文件只记录
Darwin arm64 私有 candidate 证据，不能被解释为签名、独立物理机 custody 或完整六平台发行。

### WP-264 · native 一键编译/执行入口

为降低首次使用成本，native CLI 增加 `compile <source> <artifact>` 和
`execute <source> <input-digest>`。前者复用现有 graph/check/translator/verifier，以原子写出
bytecode artifact；后者不产生临时 artifact，直接在内存中复用同一 verifier、VM 和 receipt
serializer。`execute` 输出必须与显式 `translate` + `run` 逐字节一致，不能接收 expected outcome
或外部 receipt 作为权威。该包只覆盖当前 bounded single-module/four-instruction slice，
不扩大 `.re` 语义或宣称 production backend。

### WP-265 · native project 一键执行与 benchmark

native CLI 增加 `project-execute <project> <module> <profile-digest> <toolchain-digest>
<input-digest>`，内部使用短生命周期临时 cache/build，直接复用 project/build、trusted
translation、bytecode verifier 和 VM；输出与显式 `project-translate` + `project-run` 的
serialized run receipt byte-equivalent，临时路径不进入结果。`project-benchmark ... <report>`
固定三轮执行，绑定项目、模块、profile/toolchain/input、每轮 run/output digest 和计时样本；
stable digest 排除 `elapsed_ns`，并将 Go/JVM/Node 未测量状态保持为 `pending`。当前证据只覆盖
Darwin arm64 native bounded single-module/four-instruction slice，不代表完整多函数 lowering、
真实 scheduler、跨语言性能结论、production backend 或 Stable V1.0。

### WP-266 · native project Server loopback entry

native CLI 增加 `project-server-smoke <project> <module> <profile-digest> <toolchain-digest>
<input-digest>`，在 `127.0.0.1` 上启动一次性 bounded HTTP/1.1 loopback，仅注册显式
`GET /run -> project-run` route。请求到达后才调用既有 project/build、trusted translation、
bytecode verifier 和 VM，HTTP response body 为 path-free `re.native-project-run@0.1.0`
receipt；route miss、协议错误、取消、project/input drift 与执行失败 fail closed，内部诊断
不写入 stdout。该命令用于可直接复跑的 Server profile conformance 和 Node-free workload，
不提供 keep-alive/streaming、TLS/auth、跨请求 scheduler 或 production server claim。

### WP-267 · native project Server failure conformance

补齐 `project-server-smoke` 的负向 conformance：missing module、invalid input、
source drift、route/verb mismatch、malformed HTTP 和 request-time failure 都必须
保持 closed result；CLI 失败为非零退出、空 stdout，稳定诊断只写 stderr 的
`re.native-project-server-result@0.1.0` envelope，不把内部诊断写入 HTTP body。
该包只验证既有 Server/project authority 的错误隔离，不增加 transport 或 scheduler
能力。

### WP-268 · native explicit multi-Module execution slice

增加 canonical `re.native-project-execution-plan@0.1.0` 和
`re.native-project-execution@0.1.0`。plan 显式指定 public root entry，并以
dependency binding、目标 Module/entry、interface digest 和 contract digest
描述 bounded chain；当前 project graph verifier 逐项核对 package dependency、
exact interface pin、public export、重复 binding 和 cycle，任何不一致在 effect
前拒绝。`project-execute-plan` 按 plan 顺序复用 trusted translation、bytecode
verifier、VM 和 nested run receipt，结果 path-free 且重复运行 byte-identical。
当前只证明同一 input 的顺序执行，不证明 Module 间参数/返回值传递、完整多函数
lowering、隐式 dispatcher、真实 scheduler、production backend 或 Stable V1.0。

### WP-269 · native project execution artifact/plan cache

增加 `re.native-project-execution-artifact-cache@0.1.0` 与
`project-execute-plan-cached`。缓存 envelope 绑定当前 project/build graph、显式
execution plan、profile/toolchain 和每个 Module 的 trusted translation/artifact；
读取仍必须通过 canonical、digest、regular-file、source/interface/build authority
验证。authority drift 只产生 miss 并重建，不能由 caller 同步重签；损坏 JSON、
partial publication、symlink parent 和 semantic mismatch fail closed。direct runner
复用唯一 project/build/translation/verifier/VM authority，缓存不把 outcome 或 receipt
变成后续执行真源。Node-free workload 扩展为 11 项，并要求 cached 与 uncached
execution receipt byte-identical。当前只证明本机 bounded sequential cold miss/warm hit，
不证明远程共享缓存、分布式 build farm、完整多函数 lowering、真实 scheduler、
production backend、跨平台性能或 Stable V1.0。

### WP-270 · native direct runner authority reuse

将 `project-execute-plan` 和 cached runner 的 project/build authority 准备提升到
一次 plan 级别：先加载当前 project、构建一次 build manifest，再为每个显式 entry
生成可信 graph/artifact/translation bundle，执行阶段直接消费 bundle。native CLI
新增 `project-execute-plan-direct`，其 path-free execution receipt 与普通
`project-execute-plan` byte-identical。缓存命中仍须先通过当前 authority 验证；本包
WP-271 已提供 bounded runtime value handoff，但 Node-free gate 的单 Module 计划不
声明 handoff，因为没有前置 step 可提供真实值来源。多 Module plan 才能显式携带
`handoff`/`root_handoff`，并由 native VM 返回值、nominal type、canonical bytes、
value digest 与最大 64 KiB 边界共同验证；input digest、receipt、caller-owned value
和同步重签字段都不是 authority。当前仍是 bounded sequential execution，不代表完整
多函数 lowering、隐式 dispatcher、真实 scheduler、production backend 或 Stable V1.0。

### WP-272 · native replay conformance entry

增加 `re.native-vm-replay@0.1.0` canonical transcript 与
`conformance-run <source> <input-digest> <transcript>`。transcript 只声明 invocation
identity、canonical VM arguments 与 declared response；native binary 从当前 source
重建 checked graph/artifact/verifier/VM authority，逐调用 exact replay，完成后拒绝
missing/extra invocation。未知/重复/非 canonical 字段、malformed value/response、
identity/argument/order drift 与非法 input digest 在 effect 前 fail closed，失败只写
stderr。该入口为当前 Darwin arm64 单 Module/四指令跨语言归一化基础，不是完整
lowering、真实 scheduler、production backend、跨平台性能或 Stable V1.0。

### WP-273 · native/Node cross-language replay matrix

在 `re.native-vm-replay@0.1.0` transcript 之上增加
`re.cross-language-replay-matrix@0.2.0`。matrix 绑定当前 checked graph、input digest、
canonical transcript、backend identity、toolchain authority 和实际 result/receipt digest；
比较只使用 matrix 外部重建的 workload/result authority。native 与 Node 在真实运行过的
相同 workload 上可以标记 `measured`；Go/JVM/其他后端未具备真实 runner 时固定为
`pending`，不得用复制输出、预填 expected outcome 或同步重签改变状态。结果缺失、重复、
未知 backend、authority drift 和 measured/pending 伪造均 fail closed。当前只覆盖 Darwin
arm64 单 Module/四指令 seam，不代表完整多函数 lowering、跨平台性能、独立 custody、
production backend 或 Stable V1.0。

native 可直接使用
`cross-language-matrix <source> <input-digest> <transcript> <node-result> <output>`。
命令从当前 source 重新执行 native replay，并只接受 canonical
`re.cross-language-backend-result@0.2.0` Node 条目；输出的
`re.cross-language-replay-matrix@0.2.0` 绑定 graph/input/transcript、双方
`observed_result_digest` 和 `semantic_digest`。`result_digest` 只绑定 backend result
envelope，`receipt_digest` 只绑定 backend-local receipt，二者不直接跨 backend 比较。
严格派生函数要求 Node result 携带 runtime receipt 与 `program_stdout`（effect uid
绑定 transcript `invocation_id`）；但 matrix 与 replay-catalog CLI 只读取调用方提供的
canonical backend-result，不自行运行 Node，也不核验文件来源。固定 transcript 不能
替代实际观察结果。Go/JVM 未实际运行时保持 `pending`，不把外部 result 文件本身解释
为独立 signer/custody 证明。

WP-343 补齐该 seam 的 negative evidence：旧 0.1.0 构造器忽略调用方传入的
result/observed digest、按 invocation 列表自行重算，Node stdout 与 effect 观察无法
影响等价判断；0.2.0 拆分 `observed_result_digest` 与 `receipt_digest` 并强制
`semantic_digest` 绑定前者。逐项篡改参数/响应并重算内层身份摘要后仍被 transcript
projection 拒绝；effect uid、sequence、occurrence、graph revision、receipt id 的
篡改由对应身份校验拒绝；未重签外层摘要时由 `receipt_digest` 先拒绝。该严格派生路径
目前只有测试覆盖，CLI 接受外部 backend-result，不核验其产生方式。固定 transcript 与
合成 tamper case 只证明比较契约，不证明 Node 实际运行、独立 custody、production
backend 或跨平台等价。

WP-344 收紧该 seam 的拒绝原因与投影边界：effect uid 与 transcript
`invocation_id` 不一致单独报告为
`cross-language-node-effect-receipt-effect-uid-mismatch`，内层
`demand_id`/`receipt_id` 重算不一致为
`cross-language-node-effect-receipt-id-mismatch`，不再与 transcript projection
共用同一个 code；重签后的逐项篡改测试改为断言真正命中的 code，projection 拒绝仍由
独立用例覆盖。native stdout 投影同时改为 fail closed：`process.stdout@0.1.0`
实例上的 invocation 若成员不是 `write` 或 `data` 不是 `Text`，返回
`cross-language-observed-stdout-unsupported`，不再按零字节跳过，避免两个输出不同的
运行投影成同一摘要。该变更不改变 matrix/catalog 的字段集合与 canonical 形状，也不
证明 Node 实际运行、独立 custody、production backend 或跨平台等价。

### WP-345 · external library admission strategy

把「库从哪来」写成策略而不是继续加 schema：`doc/12-library-strategy.md` 定义三条准入
路线（core 内纯 op、host adapter、带等价语料的入库）、判定规则（纯/全/确定性走 op，
effect 或平台绑定走 adapter，第三方纯库必须过等价语料），以及 Route I 的七条准入条件
（pinned original、corpus、逐字节输出相等、determinism、totality、license 分离、
可复现证据）。

该文档记录三条实测阻塞，其中第一条与先前判断不同：adapter seam 本身是开的
（`HostAdapter:425`、`HostEnvironment<A>:430`、`HostBackedBridge<A>:752` 均为 pub），真正
关门的是散在八个点的闭合词表，按阶段分成两组。检查期：`graph::is_known_schema`
（`graph.rs:977-986`，只认五个 reference）、`graph::parameters`（`:760-786`，合法
`(schema, member)` 表与 arity，`:784` 报 `unknown-capability-member`）、
`graph::default_argument_name`（`:632-643`）、`graph::contextual_literal`（`:580-630`，
未列出的组合静默落成 `text.utf8`，`:615`）。运行期：`HostBackedBridge::host_request`
（`minimal_std.rs:909-957`）、`response`（`:959-997`）、`declared_host_error`
（`:1063-1093`）、`host_operation_name`（`:1205-1213`，未知 reference 静默记成
`"unknown"`）。两处需要纠正的读法：`host_request` 只匹配四个 reference——`process.exit`
不走 bridge，`compact_target`（`graph.rs:552-578`）把它变成 `Target::PureOperation` 并在
`:666-675` 校验；`HostOperation::Unknown(String):317-329` 与 `HostRequest::unknown:401`
今天不是 adapter 的扩展点，但理由要窄一档：`unknown` 是 pub、`HostRequest` 字段也全
pub，外部 crate 能自己构造一个交给 `HostEnvironment::invoke`（`:443`）；仓库能支撑的说法
只是没有生产路径（`graph`、VM、`HostBackedBridge::host_request`）会产出它，adapter 在
测试之外收不到，显式构造它的只有测试（`wp257_minimal_std_host.rs:277`、
`wp345_library_admission_boundary.rs:47,76,97`），`minimal_std.rs:573`、`:734` 的 unknown
拒绝只有直接调用 `invoke` 才走得到。这个构造器要保留：封死或删掉会破坏上述调用点、
并删掉前向兼容占位。另外两条：生产语法没有 list 索引/迭代/算术表达式，文本拼接也只有
`std.text.concat` 存在于 native std surface、生产语法不可达，Route I 今天没有可执行目标；
`doc/04` 的 production lowering 仍是占位（该文有两个 `### 4.1` 标题，按标题引用）。

配套测试 `native/revia-core/tests/wp345_library_admission_boundary.rs` 只钉直接调用这一
分支：未声明成员在 IO 之前以 `StdError::UnknownOperation` 失败、重复调用错误一致、host
仍可继续读写；它不测试上述八个准入点，`doc/12` §6 第 1 项落地时应重访而不是只求继续绿。
本包不接纳任何第三方库，也不改变 research/preview 成熟度声明。

### WP-346 · check-time schema declarations

`doc/12` §6 第 1 项要求用一个 registry 同时驱动八个准入点，本包只做其中三个检查期站点，
运行期四个站点明确不动：新增公开入口
`graph::check_graph_with_declared_schemas(graph, &[DeclaredSchema])`，调用方传入
`DeclaredSchema { reference, members }` / `DeclaredMember { name, parameters }` 后，三个
检查期站点改为先查声明、再落回内置词表——`is_known_schema` 的允许列表
（`graph.rs:253-259`）、`parameters` 的 `(schema, member)` 表与 arity（`:760-786`）、以及
由声明给出的参数名与类型（类型不符走 `literal-type-mismatch`，`:615` 的静默
`text.utf8` 回退不再吞掉类型不符）。运行期四个站点（`host_request`、`response`、
`declared_host_error`、`host_operation_name`）**原样关闭**：声明过的 schema 能过
`re check`，执行到 host 边界仍按 `native-host-bridge-operation-unsupported:<instance>.<member>`
失败关闭，这就是本包验收测试里最后一条断言。

仍然封闭的两处解析期助手是 `default_argument_name`（`:632-643`）与
`contextual_literal`（`:580-630`）：两者跑在 `parse_compact_graph` 内，声明表此时还不存在，
所以本包验收测试只用命名参数 + 词法器真实产出的字符串字面量；位置参数在解析期仍以
`missing-argument-name` 失败。声明也不得遮蔽五个内置 reference——冲突、空引用、零成员、
重名、空参数名或类型名一律在读写图之前以 `declared-schema-invalid` 拒绝，不静默覆盖。
`check_graph` 委托给新入口并传空列表，既有五个调用者行为不变。
测试 `native/revia-core/tests/wp346_host_schema_extension.rs` 覆盖通过、未声明 schema 与
未声明成员仍失败关闭、arity 由声明强制、内置遮蔽被拒、空/重复声明被拒、以及空声明列表
下内置图仍可检查。本包不改变 research/preview 成熟度声明，也不承诺任何第三方库可用。

### WP-347 · schema registry artifact

`doc/12` §6 第 1 项要一个 registry 同时驱动八个准入点；WP-346 只让三个检查期站点
接受程序内构造的声明列表，调用方仍要自己拼 `DeclaredSchema`。本包补上载体：新增
`revia-core` 模块 `host_schema_registry`，读一份 JSON 制品

    {"schema": "revia.host-schema-definitions@0.1.0", "definitions": [...]}

其中每个 definition 就是 `src/host/schema-registry.js` 已在校验、`src/host/demo-schema.js`
已在使用的对象形状（`identity`、`revision`、`members.<name>.params[] = {name, type}`），
reference 由 `identity@revision` 推出，与 JS 侧 `referenceOf` 完全一致——所以不需要第二个
转换器，也不需要另造一套 Rust 方言。投影只保留 identity、revision、成员名、参数名和参数
类型；`types`、`access`、`returns`、`default`、`primary`、`resource_catalog`、
`resource_parents` 原样容忍并忽略，等消费它们的站点开门。`render_registry` 经
`canonical_json` 写回同一形状，字节稳定且可被 `parse_registry` 回读。

制品在读图之前校验：顶层未知键、缺 `schema`、schema id 不符、identity/revision 为空或
带 `@`、空 `members`、缺 `params`、参数缺名/缺类型/重名等一律
`declared-schema-registry-invalid`；重复 definition、遮蔽五个内置 reference 等语义问题
仍走 WP-346 的 `declared-schema-invalid`，两种代码不混用。CLI 增加显式命令
`revia graph-check [--schema-registry <registry>] <file>`（`check` 是词法/解析路径，不能
兼任）：输出 `re.native-graph-result@0.1.0`，含 `declared_schema_count`；文件不可读 66，
source/graph/registry 无效 65。

运行期四个站点仍原样关闭：经 registry 准入的图执行到 host 边界照样以
`native-host-bridge-operation-unsupported:<instance>.<member>` 失败，registry 不是运行期
准入通道，而是检查期声明的载体。测试
`native/revia-core/tests/wp347_host_schema_registry.rs` 覆盖：registry 是准入的唯一开关
（同一图无 registry 仍 `unknown-schema-reference`）、未列出成员仍
`unknown-capability-member`、JS 富字段被忽略、渲染回读相等且字节稳定、坏制品各类拒绝、
语义冲突沿用 `declared-schema-invalid`、以及多份 registry 合并；
`native/revia-cli/tests/wp347_graph_check_cli.rs` 覆盖命令四种退出行为与 help。本包不改变
research/preview 成熟度声明，也不承诺任何第三方库可用。

### WP-348 · result contract carried by the registry

WP-347 的投影只到参数层；运行期要按声明分派，还缺每个成员返回什么、失败时能命名
哪些错误变体。本包把 `returns` 与 `types[family].variants` 也投影进同一个制品，仍
不新增方言：`returns` 就是 JS 定义里的 `result<T, E>` 字符串，变体就是 `types[E]`
的 `variants` 数组。

`DeclaredMember` 增加 `returns: Option<String>` 和 `errors: Vec<String>`（后者是
家族变体按声明顺序的列表；家族没有 `types` 条目时为空，不去猜）。两侧校验：registry
解析期要求 `returns` 是非空字符串、`types` 是对象、家族条目 `kind` 为 `error-sum` 且
`variants` 是非空字符串数组、每个 `types` 条目都被某个成员的 `returns` 家族命名（否则
渲染会丢掉它，回读不相等），否则 `declared-schema-registry-invalid`；声明校验期要求
`result<...>` 恰好两个非空半段（只有深度零的逗号才是分隔符，`map<text.utf8,number.i64>`
这类含逗号的泛型半段整体保留）、变体名合法且不重复、只有 `returns` 为
`result<ok, family>` 时才允许携带变体、同一 definition 内共享同一家族的两个成员变体
表必须一致，否则 `declared-schema-invalid`。坏结果串若同时配有同名 `types` 条目，
家族名解析不出来，该条目就成了未引用条目，制品规则先触发，诊断指向
`types[family]`，`declared-schema-invalid` 只覆盖程序内声明与没有该条目的制品。

`render_definition` 在有 `returns` 时写回它、有变体时写 `types`，两者都缺时省略，
所以 WP-347 的字节稳定性与回读相等不变。本包不读这些字段，四个硬编码站点照旧
拒绝一切声明成员（WP-351 才让运行期 bridge 读它们），`access` 规则也仍不投影。新增
`native/revia-core/tests/wp348_declared_result_contract.rs`（11 例：投影、缺省返回、
无 `types` 的家族、六类坏制品、程序内声明同规则、含逗号泛型半段、未引用条目优先于
声明校验、共享家族一致性、渲染回读、无结果
契约时省略 `types`）与 `native/revia-cli/tests/wp348_graph_check_cli.rs`（3 例：带
结果契约的 registry 端到端通过、含逗号泛型半段按整串交给 WP-353 的类型词表
（拆错会在 `types` 上留下孤儿条目，报 `declared-schema-invalid`；拆对则是
`declared-type-unsupported`）、坏 `kind` 与坏结果串仍是
registry 问题）。本包不改变
research/preview 成熟度声明，也不把 registry 说成运行期准入通道。

### WP-353 · one declared-type vocabulary for check time and the bridge

WP-351a 只把类型支持（payload 类型是否可跨 host 边界、`result<ok, family>` 的错误
家族是否可用）落实在 bridge 一侧：`validate_declarations` 有意只校验形状，因此
被 graph 引用的声明可以用 `map<text.utf8,number.i64>` 通过 `graph-check`，直到构造
`HostBackedBridge` 才拿到 `native-host-bridge-declared-type-unsupported:<name>`。
本包把这份词表变成两侧共享的单一来源。

`graph.rs` 新增 `is_supported_declared_type`（`text.utf8`、`bytes`、`fs.path`、
`text.encoding`、`number.i64`、`bool`、`unit`、`list<text.utf8>`）与
`declared_return_type_supported`（payload 类型直接通过；`result<ok, family>` 要求
两半都支持且家族名非空、不含 `@` 与空白）。`check_graph_with_declared_schemas`
在原有的引用检查之后，对**被引用**的 schema 逐成员跑
`validate_declared_schema_types`，不支持就报 `declared-type-unsupported`（带
`actual` 为原拼写）。`minimal_std` 删掉自己那两份谓词，改为调用 `graph` 的实现，
bridge 侧错误串 `native-host-bridge-declared-type-unsupported:{name}` 保持不变，
供绕过 `parse_registry` 直接构造 bridge 的调用方使用。

范围是「被引用」而不是整份 registry：`declared_table` 在 bridge 侧本来就只对被
引用的条目套用类型支持，若在解析期对整份 registry 做词表校验，两侧会重新分叉，
因此未被引用的声明保持词表自由，只校验形状。已知的顺序限制照实记录：
`parse_registry` 的形状闸门先于词表校验，`result<text.utf8>`（缺错误家族）这类
形状坏串仍报 `declared-schema-invalid:<reference>`，不会走到新代码；这是既有分层，
不是被新校验掩盖的回归。

新增 `native/revia-core/tests/wp353_declared_type_vocabulary.rs`（7 例：payload
接受/拒绝矩阵、返回类型接受/拒绝矩阵、词表与 bridge 表一致、未引用声明保留自己
的词表、被支持声明仍映射请求）与
`native/revia-cli/tests/wp353_declared_type_cli.rs`（3 例：坏参数类型与坏返回
类型在 `graph-check`/`compile` 以 65 和 stdout JSON 拒绝且不产出制品、未被引用的
坏定义不阻塞检查）。本包不改变 research/preview 成熟度声明，也不声称声明成员
已经能真正执行。

### WP-352 · the registry reaches the consumption commands

WP-351 打开了 bridge 的分派，但 registry 只接在 `graph-check` 上，编译与执行两
条路仍用不带声明的 `check_graph` 复核：同一份 graph 被 CLI 检查放行后，在
`translate_graph`、`verify_bytecode_artifact`、`execute_bytecode` 三个入口被再
次拒掉（`unknown-schema-reference`）。本包把声明列表沿这三条链路传下去，且不改
任何旧入口的语义。

做法与 WP-346 相同：每个站点新增 `*_with_declarations` 变体，旧的公开函数变成
转发 `&[]` 的壳，因此 `fault_corpus`、`runtime_bundle`、`vm` 内部路径与既有
字节码测试逐字节不变。`translate_graph_with_declarations` 与
`verify_bytecode_artifact_with_declarations` 用
`check_graph_with_declared_schemas` 复核，`execute_bytecode_with_declarations`
把列表交给 `load_bytecode_artifact` 之后的校验与 VM。

CLI 侧 `compile`、`execute`、`verify`、`run` 都接受 `--schema-registry
<registry>`（帮助里逐个补了这条），先 `read_declarations` 再
`read_graph_with_declarations`，然后把声明传进上面对应的变体。`run` 不翻译，
它读制品，因此只替换执行调用。不带旗标时声明列表为空，行为仍是原来的
`unknown-schema-reference`；`compile` 的 `74`
`native-compile-write-failure` 契约不变。

可观测边界：`SystemHost`/`MemoryHost` 仍对 `Declared` 回 `UnknownOperation`，
所以带 registry 的执行命令结束在 `native-vm-capability-failed`（exit 65），
这正是「声明已经走到 host 边界」的证据，而不是又一次检查期拒绝。新增
`native/revia-cli/tests/wp352_declared_registry_cli.rs`（3 例：不带 registry 仍
是 `unknown-schema-reference`/65、带 registry 的 `graph-check` 报
`declared_schema_count:1` 且 `compile`/`verify` 成功、`run`/`execute` 带
registry 走到 host 边界并以 `native-vm-capability-failed`/65 fail closed）。
本包不改变 research/preview 成熟度声明，也不声称声明成员已经能真正执行。

### WP-351 · declared members dispatch at the runtime host boundary

WP-346 让声明驱动三个检查期站点，WP-347/348 给出制品与结果契约，运行期四个站点
仍写死。本包把运行期那一半打开，但只对「拿到同一份声明列表」的 bridge 打开：
`DeclaredSchema` 本来就作为参数与 graph 同行（`Graph` 上不存声明），所以新增
`HostBackedBridge::new_with_declarations` 与 `new_for_graphs_with_declarations`，
构造时把列表摊成 `reference -> member -> DeclaredMember` 表；`new` /
`new_for_graphs` 签名不变，转发空列表，内建行为逐字节不改。

分派顺序是先声明后内建：`cap` 的 `reference` 命中声明表时，`host_request` 投影为
`HostOperation::Declared { reference, member }`，不再落进内建 `_` 分支；
`response` 对声明成员走自己的映射——返回 `result<ok, family>` 时，`Ok(payload)`
给出**裸** `CapabilityResponse::ok`（`ok` 包装由 VM 加，和内建 `fs.read` 的框法
一致），`HostOutcome::DeclaredFailure(variant)` 给出
`CapabilityResponse::err(VmValue::ResultErr { type_name: family, variant })`，
变体不在 `DeclaredMember.errors` 里则拒绝而不是照单命名；其它返回类型按声明逐类
核对（`text.utf8`/`fs.path`/`text.encoding`、`bytes`、`number.i64`、`bool`、
`unit`、`list<text.utf8>`），不符仍是 `native-host-return-type-mismatch`。

仍然处处 fail-closed：声明不能影子内建（建表时
`native-host-bridge-declaration-invalid`），拿不到类型检查的声明类型是
`native-host-bridge-declared-type-unsupported:<name>`，adapter 答
`UnknownOperation` 仍是
`native-host-bridge-operation-unsupported:<instance>.<member>`，未知成员、缺参、
多参、参数类型不符分别沿用 `-declared-member-unknown:<reference>.<member>`、
`-argument-missing`、`-argument-unknown:<name>`、`-argument-type-mismatch`；
声明调用不记 `effect_committed`。新增
`native/revia-core/tests/wp351_declared_host_dispatch.rs`（18 例，用 stub
`HostAdapter` 覆盖成功/失败/`unit` 结果成功、整数/`bool`/`unit`/列表返回、
未知成员、三类参数错误、未知错误变体、`UnknownOperation`、参数按字节序规范化
（`argument_digest` 与 registry 顺序无关）、adapter 回 `StdError` 时仍是边界故障而非
伪造的声明变体、未被引用的声明不参与构造校验、
两个 graph 的构造入口、声明调用不记 `effect_committed`、内建引用在带声明时行为
不变、影子与不支持类型的构造期拒绝）。

边界：`SystemHost` 与 `MemoryHost` 尚未实现声明成员，仍以
`StdError::UnknownOperation` 回答 `Declared` 请求，所以运行期分派目前只能由测试
stub 观察到；把 registry 接到 `run` 上会得到一串必然失败的
`operation-unsupported`，因此留到下一包（WP-352）连同 CLI 旗标一起做。本包不改变
research/preview 成熟度声明。

### WP-350 · exit-code legend matches the codes the CLI returns

公开反馈 PF-20261104-01 指出：`--help` 的 exit code 图例只列 0/64/65，而 `check`
等读文件的命令在输入不可读时实际返回 66，`check --help` 也只写了 65。核对属实
（`check absent.re` 与 `check <directory>` 都是 66，缺参数是 64），于是图例补
`66 input file unreadable`，`check` 帮助补 `Unreadable file: exit 66.`，与
`graph-check` 的既有措辞一致。

同一条反馈建议为 panic 与 SIGPIPE 各留一行。只记 101（`internal panic (a defect;
report the input)`）：Rust 运行时把 SIGPIPE 设为忽略，管道关闭会以写失败 panic
收场，因此本二进制不会以 141 退出，也没有任何代码重置 SIGPIPE；把 141 写进图例
会描述一个不存在的出口。新增
`native/revia-cli/tests/wp285_cli_help.rs` 的一例回归：图例五行齐全、缺文件与目录
都是 66、缺参数是 64，`check --help` 同时给出 65 与 66。

### WP-274 · native replay workload catalog

增加 `re.native-replay-workload-catalog@0.1.0`、
`re.native-replay-workload-report@0.1.0` 与
`replay-catalog <catalog> <output>`。catalog 内嵌 path-free canonical source 和
canonical replay transcript，不携带 source 路径；native runner 对每个 workload
重新构建 checked graph、artifact、verifier 和 VM。至少三项 workload 才能生成报告，
每项绑定 graph/input/transcript/native result/toolchain authority；可选 Node result
经过 exact authority 核对后生成 semantic-equivalent matrix，否则 node/go/jvm 保持
`pending`。重复 ID、非法 canonical、source/transcript/Node authority drift 和
measured/pending 伪造在写报告前 fail closed。当前证据覆盖 `hello-ok`、
`args-err`、`read-encoding-ok` 三个 Darwin arm64 workload，其中只有 hello 条目
接入实际 Node oracle；不宣称完整 lowering、跨平台性能、production backend 或
Stable V1.0。

### WP-275 · native replay fault catalog

在 workload catalog 之上增加
`re.native-replay-fault-catalog@0.1.0`、
`re.native-replay-fault-result@0.1.0` 和
`re.native-replay-fault-report@0.1.0`。fault result 与成功
`process-status`/receipt 分离，只允许 `replay-mismatch`、`check-failure` 和
`host-fault`，并禁止 `receipt_digest`。native CLI
`replay-fault-catalog <catalog> <output>` 真实重建 source、transcript、checked
graph、artifact、verifier 和 VM，覆盖三类 failure path；success/failure 混淆、
missing/extra/identity/argument drift、authority 同步重签和错误 expectation
均在 report 写入前拒绝。

catalog 可以收录 native check 明确拒绝的 versioned source，以保留
`unsupported-language-version` 等共同 check failure。Node fault result 必须由
test-support Node reference oracle 实际调用 `runSource` 观察得到；当前只对一条
`unsupported-language-version` 完成 native 同码比较，Node host-fault/replay-
mismatch 仍未测量。首码不一致的 Node/native source 不做猜测归一，未实测的
Go/JVM/其他 backend 继续 `pending`。本包仍是 Darwin arm64 单 Module/四指令
fault seam，不是完整 native fault runtime、production backend 或 Stable V1.0。

### WP-276 · native fault observation corpus

在 WP-275 之上增加 `re.native-fault-corpus@0.1.0`、
`re.native-fault-observation@0.1.0` 与
`re.native-fault-observation-report@0.1.0`，把 fault case 的 source、
input、canonical transcript 和 stage expectation 固定为可复跑 corpus。runner
只写入 native 实际观察到的首个 failure；expected kind/code 不会进入运行时，
`checked-error`、`replay-mismatch`、`host-observation` 与
`evidence_scope=exercised` 明确分层。合法 source 的 graph revision 由 source
重算，reachable-but-unexercised、成功 execution、receipt 注入、case/authority
drift、重复/缺失 case 和同步重签均 fail closed。失败 observation 不含
`receipt_digest`，Node/Go/JVM 没有真实 runner 时保持 `pending`。本包仍是
Darwin arm64 单 Module/四指令 fault seam，不是完整 fault coverage、
production backend 或 Stable V1.0。

### WP-277 · native fault corpus release evidence

增加 `re.native-fault-corpus-release-evidence@0.1.0` 与
`replay-fault-corpus-gate <corpus> <evidence>`，使用当前 release binary 在
`env_clear`、空 `PATH` 和隔离工作目录下重新运行五个 fault corpus case。Gate
重新解析 canonical corpus/report，并把 binary、toolchain、corpus、report、
source、transcript、graph revision 与 observation digest 链绑定到 path-free
evidence；debug binary、Node/JS 依赖、非零 runner、stdout/report 不一致、
成功伪装、receipt 注入或 authority drift 均 fail closed。相对 corpus 路径会在
隔离前解析，避免子进程把工作目录误当成 authority。当前 Darwin arm64 release
gate 的 `release_build=true`、`empty_path=true`、Node process/load/import 为 0，
重复运行 stable/evidence bytes exact；Node、Go、JVM 仍 `pending`。这只是五-case
native fault evidence，不是独立 signer/custody、跨平台 runner、完整 fault
coverage、production backend 或 Stable V1.0。

### WP-278 · native minimal_std host-backed executor

将 native `execute` 与 `run` 从 `CliBridge` 占位路径提升为
`HostBackedBridge<SystemHost>`。bridge 绑定 checked graph revision 与 input digest，
只把 capability 的 exact schema/member/argument 转换为 `HostRequest`，并复用
`HostEnvironment` 的 authority check 与 panic-to-`HostFault` 边界。当前
`SystemHost` 为 source-directory sandbox 提供受限 process args、stdout、fs.read
和 fs.write；stdout/文件大小有界，路径逃逸和写入 symlink 拒绝，程序输出与显式
translate/run 共用 VM receipt authority。

WP-278 已以 native core 5-case、CLI 2-case、workspace、release、fmt、clippy、
空 `PATH` smoke 验证 stdout、文件存在/缺失、host response shape 与 panic boundary。
证据范围仍是 Darwin arm64 单 Module/four-instruction slice；environment/secret、
clock/random/log、project entry、write atomicity、panic-hook stderr、完整多平台
和 production claim 均未闭合。

### WP-283 · native release evidence expansion

新增 `re.native-release-evidence@0.2.0` 与 `release-evidence-gate`。fresh release
binary 在清空环境、空 `PATH` 和隔离目录中重跑 node-free、fault corpus，并通过
两个独立子进程执行双目录 `project-build`。实际发布的 manifest 与完整 cache/build
tree digest 必须 exact；evidence 绑定 binary/toolchain/source/project/fault/build
authority，native 为 `measured`，Node/Go/JVM 未测量时保持 `pending`。复制 debug
binary 到 `release/` 目录也会在执行前拒绝。

本包只证明当前 Darwin arm64 bounded native slice，不推导跨平台、独立签名 custody、
完整多函数 lowering、真实 scheduler、production backend 或 Stable V1.0。

### WP-284 · comparison/conformance workload catalog

新增 `re.native-comparison-catalog@0.1.0`、
`re.native-comparison-catalog-report@0.1.0` 和
`comparison-catalog <catalog> <project> <output>`。仓库固定 fixture
`test/fixtures/native-comparison-catalog.json` 覆盖 `success`、`closed-error`、
`host-boundary`、`project-workflow` 四个域；每项绑定 canonical source、input
digest、canonical replay transcript、project/module authority，以及 semantic、
result、receipt 的适用性。native 执行复用现有 graph/check/translation/verifier/VM
和 replay bridge，不创建第二套执行或 serializer。

catalog/report 的 JSON 是 canonical、path-free、digest-bound 的；缺失/重复域、
未知 backend、source/transcript/project drift、不适用的 Node 结果、复制 result/
receipt digest 和把 pending backend 晋级为 measured 均 fail closed。release evidence
现在直接消费仓库 fixture，并在 fresh empty-PATH release 子进程中重新核对 direct
source、project source、project digest 和 module authority。当前 fixture 尚未提供
Node/Go/JVM measured result，因此这些后端仍是 pending；本包不产生性能资格、
production claim 或 Stable V1.0 结论。

WP-343 改变内嵌 Node result 的摘要推导，但不改 catalog/report 的字段集合与
canonical 形状；内嵌结果仍按自身 schema（现为
`re.cross-language-backend-result@0.2.0`）校验，旧版本结果会被该 authority 检查
拒绝。因此 catalog/report 继续使用 `@0.1.0` 表示 envelope 未变，版本变化由内嵌
payload 携带，而不是漏升版本。

### WP-285 · native CLI usability and help/version contract

native `revia` 现在提供统一的 `--help`、`help`、`help <command>` 和
`<command> --help` 入口，覆盖当前支持的全部命令，包括 comparison、project、
release 和 Node-free evidence 命令。帮助输出是固定、path-free 的文本，不读取 source、
project、环境或缓存，也不创建文件；未知帮助主题返回 exit 64，source/project/contract
失败仍保持 exit 65，`--version` 继续在空 `PATH` 和任意工作目录下可用。

本包只补齐 native 开发者入口的可发现性，不改变 `.re` 语义、translator/executor、
comparison authority 或未测量 backend 的 pending 状态。它不是完整 SDK、通用项目测试
框架、production backend 或 Stable V1.0 证据。发行仓库仍需单独恢复 Quickstart 的安装、
依赖、缓存、离线和重装信息，并处理许可证、安全渠道、PowerShell、launcher、发布前
gate 与签名；这些不写入私有 native 实现。

### 后续工作包规划

1. **WP-279 · project host-backed execution（实现完成，待内部全量门禁）**：同一
   `HostBackedBridge<SystemHost>` 已接入 `project-run`、`project-execute`、
   `project-server-smoke` 与 plan/direct/cached runners；复用
   project/build/translation/verifier/VM authority，真实执行 project sandbox 内的
   stdout/fs effect。多 graph plan 按成功验证的 graph revision 激活对应 capability
   集合，拒绝跨 graph capability 访问；nested receipt、route 和 project-level
   effect 仍须由 WP-280 的 observation/partial-effect corpus 完整固化。
2. **WP-280 · host observation and effect boundary**：覆盖 args、fs.read/write、
   environment/secret snapshot、time/random/log；当前 graph-reachable capability 的
   observation 只保留 operation、参数/载荷 digest、结果分类和 occurrence 顺序，
   不保留 secret、原始路径或原始 payload，并绑定实际 VM invocation id。host-request
   在 effect 前被拒绝时仍记录 path-free error observation，`effect_committed=false`；
   固定权限、输出分层、panic-hook 净化、原子 fs.write、effect 前 fail-closed 和
   partial-effect 证据；尚未进入 graph registry 的 Server capability 不宣称已可由
   `.re` source 调用。
3. **WP-281 · deterministic identity and reproducible build（已完成待审阅）**：
   compact creation 固定使用 `re.deterministic-uid-sequence@0.1.0`，并将
   `re.identity-allocator@0.1.0` 同时绑定到 build key、artifact manifest、
   release lock 和生成的 `run.mjs`。两个全新进程、两个不同目录首次
   `check --write` 后，canonical、manifest 语义、text/HTML/SVG view、build
   tree 与所有 checksums 已有逐字节回归；random UID、路径/时间注入和同步重签
   manifest/lock/checksum 均 fail closed。该证据是 Node preview toolchain 的
   当前边界，不等于 native 跨平台或 production 结论。
4. **WP-282 · external project developer workflow（已完成）**：`project-init <directory>`
   在不存在或空目录中生成固定、canonical、无本机路径的 `revia.app` starter，
   `project-test <project>` 重新加载 project authority 并按拓扑序对每个 Module
   执行 native translation/check。非空目录、symlink、source digest drift 和写入
   失败均不覆盖已有内容；初始化结果在两个目录逐字节一致。该 test command 是
   当前 bounded slice 的 conformance gate，不是通用测试框架；后续 native
   `project-build`、`project-translate`、`project-run` 仍复用同一 authority。
5. **WP-283 · release evidence expansion（已完成）**：把 project host execution、
   fault corpus 和 deterministic build 纳入 fresh release/empty-PATH gate；以相同
   fixture 建立 Node/Go/JVM 对比入口，未真实运行的后端保持 `pending`。
6. **WP-284 · comparison/conformance workload catalog（已完成）**：
   固定四域 path-free catalog，复用 native authority 生成报告，并把 fixture
   digest/authority 校验纳入 release evidence。下一包继续补可复跑的 native
   conformance/developer workflow，不扩展未验证的 backend 或语法能力。
7. **WP-285 · native CLI usability and help/version contract（已完成）**：
   统一顶层与子命令帮助，覆盖全部当前 native 命令，保持未知主题 exit 64、业务失败
   exit 65、`--version` path-free；focused、workspace、release 和空 PATH smoke 均通过。
   根级 `npm test` 的 7 个失败仍是隔离公开生成树缺少 cargo 的环境缺口，不改变 native
   私有工具链证据。该包不改变执行 authority，完成后继续 native developer
   workflow/conformance gate。
8. **WP-286 · native developer conformance and reproducible workflow gate（实现完成，待
   完整内部门禁）**：新增 `developer-gate <project> <module> <input-digest> <report>`。
   它在空 `PATH`、清空环境和 fresh native child process 中依次执行
   `project-check`、全模块 `project-test`、两个独立目录的 cold `project-build`、
   `project-translate` 与 `project-run`；实际发布的 `build.json` 和完整 cache/build
   tree 必须逐字节一致。输出 `re.native-developer-gate@0.1.0` canonical、
   path-free、无 `elapsed_ns` 的报告，绑定 project/graph/module/input/profile/toolchain
   和各阶段 stdout digest。报告路径落在 project 内会在写入前拒绝，避免门禁结果污染
   project authority；source/module/build/run drift、阶段失败和 report write failure
   均 fail closed。该 gate 只证明当前 Darwin arm64 bounded native slice 的仓库外
   开发可复跑性，不代表完整 SDK、多函数 lowering、跨平台性能、production backend
   或 Stable V1.0。
9. **WP-287 · native standalone toolchain gate（已完成，待完整内部门禁）**：
   新增 `toolchain-gate <source> <project> <module> <input-digest> <report>`，先对
   direct source 与 project module 重建 checked canonical graph，要求 canonical bytes
   和 graph revision exact 一致；随后在空 `PATH`、清空环境和 fresh native child
   processes 中执行 direct `check/canonical/translate/compile/verify/run`，并调用
   WP-286 `developer-gate` 完成 project 链。`translate` 与 `compile` artifact、
   artifact 与 `verify/run` 输入、developer report 与 stdout 均逐字节核对。报告为
   `re.native-toolchain-gate@0.1.0`，canonical、path-free、无计时，绑定 binary、
   dependency scan、source/project/graph/module/input/profile/toolchain authority、
   阶段 digest 和 debug/release 边界；source/project、artifact、report、依赖或路径
   漂移均 fail closed。当前只证明 Darwin arm64 bounded native translator/executor
   与 project workflow，不代表完整 SDK、多函数 lowering、跨平台性能、production
   backend 或 Stable V1.0。
10. **WP-288 · native movable offline runtime bundle（已完成内部验证）**：
    新增 `re.native-runtime-bundle@0.1.0`、`runtime-package <source> <bundle>` 和
    `runtime-run <bundle> <input-digest> <sandbox>`。bundle 由 checked canonical graph
    和 verified bytecode artifact 生成，保存 canonical source、graph/artifact digest 与
    profile/release/translator authority；run 在显式 sandbox 中离线重建并 exact 验证后，
    复用现有 native VM/`SystemHost`。compact/canonical 输入 bundle 逐字节相同，移动 bundle
    后 stdout/result 与 source+artifact run 相同；非 canonical JSON、同步重签、payload drift、
    symlink/非目录 sandbox、非法 input digest 和 partial write 均 fail closed。focused、
    workspace、fmt、clippy、release、empty-PATH smoke、fuzz 与 diff-check 是本包退出门禁。
    当前仍只支持 Darwin arm64 bounded single-Module/four-instruction slice，不代表完整
    独立 VM、scheduler、跨平台 runner、签名发行物、production backend 或 Stable V1.0。
11. **WP-289 · native runtime bundle comparison gate（已完成内部验证）**：
    新增 `re.native-runtime-bundle-comparison@0.1.0` 与
    `bundle-comparison <catalog> <project> <output>`。gate 在空 `PATH` 的 fresh native
    child process 中逐 workload 重新 package/verify bundle；`success` 与
    `project-workflow` 的 bundle run 与 direct native source/artifact execution 逐字节
    比较并标记 `executed`，`closed-error` 与 `host-boundary` 只做真实 bundle/offline
    authority 验证并标记 `verified-only`，不把 ReplayBridge 注入 fault 冒充真实 host
    fault。报告 canonical、path-free、自带 digest；同 catalog fresh 重跑 exact、报告
    round-trip、project authority drift 和 report-in-project 均有回归。当前仍是 Darwin
    arm64 bounded single-Module/four-instruction slice，不代表完整跨平台 runner、
    production backend 或 Stable V1.0。
12. **WP-290 · native release evidence for movable runtime bundles（已完成内部验证）**：
    将 `bundle-comparison` 接入 `release-evidence-gate`。当前 release binary 在空 `PATH`
    的 fresh child process 中重新生成并解析 bundle comparison report，要求 stdout/report
    exact、catalog/project authority exact、canonical self-digest 通过；`re.native-release-
    evidence@0.3.0` 额外绑定 bundle comparison schema 与 report digest。schema、report、
    authority drift、debug binary、partial write 和同步重签均 fail closed。当前仍只证明
    Darwin arm64 bounded native slice，不代表完整独立 runtime、跨平台 runner、production
    backend 或 Stable V1.0。
13. **WP-291 · native runtime bundle verify entry（已完成内部验证）**：
    新增 `runtime-verify <bundle>`，仅复用 `verify_runtime_bundle` 做 canonical graph、
    bytecode、profile/release/translator 和 bundle digest 校验，输出
    `re.native-runtime-bundle-verification@0.1.0` 的确定性 path-free 摘要。不需要 sandbox
    或 input digest，不创建 host bridge，不执行程序 effect；重复输出 exact，bundle drift
    在 stdout 前 fail closed。当前仍只覆盖 Darwin arm64 bounded native slice。
14. **WP-323 · native runtime load-time authority pin（当前工作包）**：
    新增 `re.native-runtime-load-authority@0.1.0` 与
    `runtime-authority-pin <bundle> <input-digest> <pin>`；可选的
    `runtime-run --authority-pin <pin> <bundle> <input-digest> <sandbox>` 在 host effect
    前校验 reviewed source、graph、build artifact、bundle envelope、实际 loaded bytes、
    runtime/interpreter、command、environment input、hash/canonicalization/load-process。
    clean control 成功；bundle byte replacement、runtime/input drift 返回 `DRIFTED` 且没有
    文件 effect。pin 是 consistency receipt，不是签名或 trust root；post-run result receipt
    由下一个工作包绑定，未来 loader 的消费 byte guarantee 保留为 non-blocking gap。
15. **WP-324 · native runtime result authority receipt（当前工作包）**：
    新增 `re.native-runtime-load-receipt@0.1.0` 与
    `runtime-run --authority-pin <pin> --authority-receipt <receipt> <bundle>
    <input-digest> <sandbox>`。receipt 绑定 pin、loaded bytes、runtime、command、input、
    result digest、VM artifact digest、VM receipt digest 与真实 stdout digest；result、
    stdout、receipt self-digest drift 均由重放验证返回 `DRIFTED`。当前仍是 native bounded
    runtime bundle slice，不等于签名、独立 trust root 或完整跨平台 runtime attestation。
16. **WP-325 · native runtime receipt verification entry（当前工作包）**：
    新增 `runtime-receipt-verify <pin> <receipt> <result> <stdout>`，只读取 pin、receipt、
    result 和 stdout，复用同一 receipt verifier，不加载 bundle、不创建 sandbox、不执行
    effect。成功输出 `re.native-runtime-load-receipt-verification@0.1.0`；receipt/result/
    stdout drift 在输出前 fail closed。当前仍是 native bounded runtime bundle slice。
17. **WP-326 · native CLI receipt verification discoverability（当前工作包）**：
    修复顶层 fallback usage 与 native command help inventory 遗漏
    `runtime-receipt-verify` 的问题。未知顶层命令的 usage failure、`--help` 和
    `help <command>` 均能发现该离线验证入口，不改变运行语义或 authority。
18. **WP-327 · native release evidence runtime receipt binding（当前工作包）**：
    `release-evidence-gate` 由同一 release binary、空 `PATH` 和 fresh child process 重新执行
    runtime package、authority pin、带 receipt 的 runtime run 与离线 receipt verify，
    并把 `runtime_receipt_schema`、`runtime_receipt_digest` 和
    `runtime_receipt_verification_digest` 纳入
    `re.native-release-evidence@0.5.0`。receipt 缺失、验证 drift、路径泄漏或同步重签均
    fail closed；未测量后端仍保持 `pending`。
19. **WP-328 · release receipt verification semantic binding（当前工作包）**：
    release evidence gate 现在解析并核对 receipt verification envelope 的 schema、`ok`、
    loaded bytes、receipt、result 和 stdout digest，不能只凭 verification stdout 的摘要
    标记 measured。verification envelope 与实际 receipt authority 不一致时，release
    evidence 在写出前 fail closed；未测量后端仍保持 `pending`。
20. **WP-292 · project-run authority comparison（已完成内部验证）**：
    修复 `project-workflow` comparison 不经过项目运行权威链路的问题。现在 gate 在空
    `PATH` 的 fresh native child process 中依次运行 `project-build`、`project-translate`
    和 `project-run`，将 project/module/build/translation/graph/artifact/input/
    `vm_receipt_digest`/outcome 与 bundle `runtime-run` 的 canonical result exact 对齐；
    报告保存完整 `project_run` authority，并区分 verified bytecode artifact digest 与
    bundle envelope digest。project/source/build/translation/result/receipt drift、同步重签、
    report-in-project 和非 canonical output 均 fail closed。当前仍只覆盖 Darwin arm64
    bounded single-Module/four-instruction slice，不代表完整 SDK、独立 scheduler、跨平台
    runner、production backend 或 Stable V1.0。
15. **WP-295 · native capability release evidence（已完成内部验证）**：
    `release-evidence-gate` 现在由同一 release binary 在清空环境、空 `PATH` 和 fresh
    child processes 中重新构造固定 project capability catalog/project manifest，两次
    调用 `capability-project-comparison`，并校验 report schema、catalog/project digest、
    self-digest、stdout/file exact 和重复输出 exact。`re.native-release-evidence@0.5.0`
    绑定 project capability schema/catalog/project/report 四项 authority；debug binary、
    fixture/project/report drift、路径泄漏、非 canonical output、同步重签和部分写入均
    fail closed。因为新增字段是协议不兼容变更，不能继续使用 `0.3.0`。当前仍只覆盖
    Darwin arm64 bounded single-Module/four-instruction project workflow，不代表完整跨
    平台 runner、签名/custody、production backend 或 Stable V1.0。
15. **WP-293 · native capability comparison（已完成内部验证）**：
    新增 `re.native-capability-comparison-catalog@0.1.0`、
    `re.native-capability-comparison-report@0.1.0` 与
    `capability-comparison <catalog> <output>`。catalog 固定真实
    `process.args.read`、`fs.read.read_file`、`fs.write.write_file` 的 canonical source、
    operation、input digest、sandbox 初始/最终文件 bytes 和程序 outcome；gate 在空
    `PATH` 的 fresh native child processes 中分别运行 direct `execute` 与 movable
    bundle `runtime-run`，比较完整 result、receipt、program stdout 和 sandbox file tree。
    缺失文件的 typed error、write payload drift、operation/source/path authority drift 和
    report 写入失败均 fail closed，已有报告不会被失败覆盖。当前证据仍只覆盖 Darwin arm64
    bounded single-Module/four-instruction capability slice，不代表完整 Server profile、
    独立 scheduler、跨平台 runner、Node/Go/JVM 对等实测、production backend 或 Stable V1.0。
16. **WP-294 · native capability project workflow（已完成内部验证）**：
    新增 `re.native-capability-project-comparison-catalog@0.1.0`、
    `re.native-capability-project-comparison-report@0.1.0`、
    `capability-project-comparison` 和 `project-run-sandbox`。每项 workload 显式绑定
    project module、relative path、source digest、operation、input、sandbox bytes 和
    outcome；gate 在空 `PATH` 的 fresh native child processes 中执行
    `project-build`、`project-translate`、`project-run-sandbox`，再与 direct execute、
    movable bundle runtime-run 三方比较 artifact、graph、translation、receipt、真实
    stdout、outcome 和 sandbox tree。project cache/build/report 不得落入 project，
    module/path/source drift、reserved project path、symlink/escape 和 partial write
    均 fail closed。当前仍只覆盖 Darwin arm64 bounded single-Module/four-instruction
    project workflow，不代表完整多模块 lowering、跨平台 runner、production backend
    或 Stable V1.0。
17. **WP-298 · native multi-module execution（已完成内部验证）**：
    新增 `re.native-multi-module-gate@0.1.0` 与
    `project-multi-module-gate <project> <plan> <profile-digest> <toolchain-digest>
    <input-digest> <report>`。gate 先从 trusted project authority 完成全项目
    `project-build`，再按项目拓扑为全部 Module 生成 graph/project/build/profile/toolchain
    绑定的 verified translation/artifact，最后只沿显式 dependency/interface/contract pin
    执行 plan。报告聚合每个 Module 的 source、implementation、interface、main contract、
    artifact、translation 与 project execution authority，使用 canonical self-digest，输出
    不含路径。source/interface/build/translation/plan/input drift、缺失 Module、隐式解析和
    report 写入失败均在 effect 或报告替换前 fail closed；同一两模块 `core -> api` DAG 在
    空 `PATH` fresh release children 中重复运行 stdout/report 逐字节一致。证据仍只覆盖
    Darwin arm64 bounded translator/VM 与显式顺序 DAG，不代表完整多函数 lowering、通用
    scheduler、跨平台 runner、production backend 或 Stable V1.0。
18. **WP-299 · stable Server profile gate（已完成内部验证）**：
    新增 `re.native-project-server-gate@0.1.0`、
    `re.native-project-server-response@0.1.0` 与
    `project-server-gate <project> <plan> <profile-digest> <toolchain-digest>
    <input-digest> <database> <report>`。gate 复用多模块 project build/translation/
    execution authority，通过固定 `GET /run` 的真实 loopback HTTP 返回由
    `JsonSchemaRegistry` 验证的 canonical JSON，再以显式 absolute database path、固定
    parameterized SQL 和查询 cardinality 完成 SQLite transaction。报告绑定 project/graph/
    package/module/build/translation/plan/input、HTTP request/response、JSON schema、SQL
    statement/parameters/database、module evidence 和 self-digest；重复 release binary、
    `env_clear`、空 `PATH` 执行逐字节一致，input/route/response/path/SQL/transaction drift
    与 report-in-project 均 fail closed。当前证据只覆盖 Darwin arm64 bounded HTTP/JSON/SQLite
    adapter 与显式顺序 DAG，不代表 TLS/auth、HTTP/2/3、跨请求 scheduler、生产数据库、
    完整 lowering、跨平台 runner、production backend 或 Stable V1.0。
19. **WP-304 · RC2 cross-platform Server/export authority（已完成内部验证）**：
    `project-server-gate` 升级为显式
    `<sqlite-executable> <database> <report>`，在任何 SQLite effect 前解析实际
    executable 并把其 path-free SHA-256 绑定进
    `re.native-project-server-gate@0.2.0`。RC2 trial kit 只在受限 PATH 中暴露
    `sqlite3`/`sqlite3.exe`，公开 command、report 和 sealed export 不携带宿主路径。
    seal builder 使用 mtime=0 的 ustar payload 和 gzip mtime=0；跨秒 fresh export
    必须完整逐字节一致。Windows/Linux runner 只有各自真实 hosted artifact 完成
    inventory、checksum、trial、leak 与 target 验收后才能标 `measured-native`。
20. **WP-305 · RC2 source-free hosted delivery verifier（已完成内部验证）**：
    新增正式 source-free delivery verifier，重新验证下载后的 export/trial manifest、
    精确 inventory、canonical JSON、archive 六文件、LICENSE/NOTICE、checksums、target/
    version/status、regular executable、七项 trial、CRLF 和私有路径/凭据/Relay 泄漏。
    verifier 在失败时不替换旧输出，并拒绝空/重复 population、缺文件、archive drift、
    checksum path-order、非 canonical 文本和同步重签；hosted workflow 已把它前移到
    上传前门禁。Windows x64 run `33637154349` 与 Linux arm64 run `33637162122` 的下载
    artifact 均通过正式 CLI verifier。该包不证明签名/custody、SBOM/attestation、
    production backend、完整语言后端或 Stable V1.0。
21. **WP-306 · cross-language comparison experiment kit（已完成内部验证）**：
    新增 `re.cross-language-experiment-kit@0.1.0`、`re.cross-language-experiment-backend-result@0.1.0`
    与 `experiment-kit <catalog> <project> <output>`。kit 固定四类非空 workload，绑定
    canonical source/graph/input/replay transcript、catalog digest、comparison report digest、
    target/toolchain authority；backend 顺序固定为 `native`、`node`、`go`、`jvm`。native
    success/closed-error/project-workflow 为真实 bounded result，host-boundary 只为
    `fault-observed`；Node 无真实 oracle 时 pending，Go/JVM 固定 pending，semantic、
    result/receipt、timing applicability 分开表达。每个 backend 的 evidence digest 与
    kit digest 均由 canonical envelope 重算，`validate_experiment_kit_against_report`
    会从可信 catalog/report 重建期望 kit，拒绝同步修改 payload/evidence/顶层 digest。
    双次 fresh empty-PATH CLI 输出逐字节一致且 path-free。证据仍只覆盖 Darwin arm64
    bounded native comparison harness，不代表跨语言性能、公平 benchmark、其他平台、
    production backend、签名/custody 或 Stable V1.0。
22. **WP-329 · native project-run offline verification（当前工作包）**：
    新增 `project-run-verify <run>` 与
    `re.native-project-run-verification@0.1.0`。入口只读取 canonical
    `re.native-project-run@0.1.0`，重算 `run_digest`，核对固定字段和 VM receipt digest，
    不重新执行项目或创建 host effect；result drift、未知字段、非 canonical bytes 和同步
    重签均 fail closed。该包只证明 envelope 完整性，不替代当前 project/build authority
    的重新构建。
23. **WP-330 · project-run authority reuse in comparisons（当前工作包）**：
    `bundle-comparison` 与 project-workflow comparison 在解析 `project_run` authority
    时复用 `verify_project_run_serialized`，先重算 canonical `run_digest`，再进入
    artifact/graph/input/receipt/outcome 对齐；project-run 同步重签或非 canonical bytes
    在 comparison report 写出前 fail closed。
24. **WP-331 · project-run nested VM receipt integrity（当前工作包）**：
    `serialize_project_run` 在输出前复用 native VM receipt verifier，重算嵌套
    `re.native-vm-receipt@0.1.0` digest，并拒绝 schema/executor/profile/receipt digest drift。
    project-run、execution plan 和 comparison 不再接受 caller 构造的伪造 VM receipt；当前
    project-run envelope 仍只携带 receipt digest，不宣称离线重建完整 trace/invocation。
25. **WP-332 · project-run authority receipt output（当前工作包）**：
    增加可选 `--project-receipt <receipt>`，默认 project-run 输出保持兼容；显式 receipt
    绑定 project/graph/module/input/translation/VM receipt/run digest，并使用 canonical
    self-digest。receipt 写失败 fail closed，当前仍不扩展为完整 trace/invocation 归档。
26. **WP-333 · project-run receipt offline verification（当前工作包）**：
    新增 `project-run-receipt-verify <receipt> <run>` 与
    `re.native-project-run-receipt-verification@0.1.0`。入口只读取 receipt/run，核对
    receipt self-digest 及 project/graph/run/VM receipt authority，不执行项目或产生 effect；
    receipt/run drift 在 stdout 前 fail closed。
    比较同时核对 module、input digest 和 translation digest，防止 self-consistent receipt
    借较粗粒度 project/run digest 伪装为当前模块 authority。
27. **WP-336 · project receipt verification error contract（当前工作包）**：
    project-run receipt verifier 的 unreadable、malformed、drift 和 authority mismatch
    使用稳定 `re.native-project-run-receipt-verification@0.1.0` error envelope，不再复用
    泛 project-runtime schema，便于 AI 按 schema/diagnostic 自动分流。
27. **WP-335 · multi-step project execution offline verification（当前工作包）**：
    新增 core `verify_project_execution_serialized`，复用 project-run verifier 逐步校验
    `re.native-project-execution@0.1.0` 的 canonical execution digest、plan/profile/
    toolchain/project/input authority 与嵌套 steps。多步 envelope 的同步重签、嵌套 run
    drift、缺失 step 和非 canonical bytes 在消费前 fail closed；当前 CLI 输出兼容不变。
28. **WP-338 · native project-check location diagnostics（当前工作包）**：
    `unlisted-project-file` 在 native `project-check`/`project-surface-check` envelope
    中返回 root-relative `diagnostics[].path`，不泄漏绝对路径；多个未列文件按完整相对路径
    UTF-8 字节序选择首个。共享 `re.project-check-diagnostic-corpus@0.1.0` 同时约束 Node/native
    的根路径、嵌套路径、多候选确定性与 clean control。

## 4. 执行纪律

- WP-251 到当前工作包期间 Relay `status` 按当前工作包推进；V0.9 前连续实现阶段保持 `working`，不等待外部审阅，最终统一 Reviewer 再审阅完整链路。Relay 只更新 `work_package`、scope、exit criteria、evidence 和 next step。
- 每个行为变更严格 RED→GREEN→REFACTOR；测试必须先证明缺口，再写实现。
- 每个 WP 到达退出点后提交并推送，但在 V0.9 前不交给 Reviewer、不切换为 `awaiting-reviewer`，直接进入下一 WP 的 predecessor audit；最终阶段才切换为待审阅。
- 日常只跑 focused native tests、相关 Node differential 和 `git diff --check`；WP-262/263 才执行完整里程碑 gate，避免把全量测试成本摊到每个小循环。
- 任何语义差异以冻结 Node/canonical corpus 为迁移 oracle；若发现规范冲突或 wrong-graph，停止依赖该规则并在当前 `working` 状态内修订设计与 corpus。

## 5. 统一审阅材料

最终交付包含：WP-251..277 commit 链、原生 source inventory、translator/VM/runtime schema、差分 corpus、Node-free fresh-build transcript、代表项目结果、性能报告、六平台 archive/digest、replay workload/fault catalog、fault observation corpus/report/release evidence、已知非阻塞边界和逐项 completion audit。任何一项证据缺失都不得把长目标标为完成。
