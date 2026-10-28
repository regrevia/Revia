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
`re.cross-language-replay-matrix@0.1.0`。matrix 绑定当前 checked graph、input digest、
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
`re.cross-language-backend-result@0.1.0` Node 条目；输出的
`re.cross-language-replay-matrix@0.1.0` 绑定 graph/input/transcript 和双方
semantic digest。Go/JVM 未实际运行时保持 `pending`，不把外部 result 文件本身解释为
独立 signer/custody 证明。

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
14. **WP-292 · project-run authority comparison（已完成内部验证）**：
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
    self-digest、stdout/file exact 和重复输出 exact。`re.native-release-evidence@0.4.0`
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

## 4. 执行纪律

- WP-251 到当前工作包期间 Relay `status` 按当前工作包推进；V0.9 前连续实现阶段保持 `working`，不等待外部审阅，最终统一 Reviewer 再审阅完整链路。Relay 只更新 `work_package`、scope、exit criteria、evidence 和 next step。
- 每个行为变更严格 RED→GREEN→REFACTOR；测试必须先证明缺口，再写实现。
- 每个 WP 到达退出点后提交并推送，但在 V0.9 前不交给 Reviewer、不切换为 `awaiting-reviewer`，直接进入下一 WP 的 predecessor audit；最终阶段才切换为待审阅。
- 日常只跑 focused native tests、相关 Node differential 和 `git diff --check`；WP-262/263 才执行完整里程碑 gate，避免把全量测试成本摊到每个小循环。
- 任何语义差异以冻结 Node/canonical corpus 为迁移 oracle；若发现规范冲突或 wrong-graph，停止依赖该规则并在当前 `working` 状态内修订设计与 corpus。

## 5. 统一审阅材料

最终交付包含：WP-251..277 commit 链、原生 source inventory、translator/VM/runtime schema、差分 corpus、Node-free fresh-build transcript、代表项目结果、性能报告、六平台 archive/digest、replay workload/fault catalog、fault observation corpus/report/release evidence、已知非阻塞边界和逐项 completion audit。任何一项证据缺失都不得把长目标标为完成。
