# 05 · 执行规则

本文档定义 `re run` 如何把图谱跑起来。核心：执行 = 沿图的拓扑序求值节点，effect 按序边约束触发，纯节点可并行/消除，错误以值的形式沿边流动。

> 本版为规则草案；并发调度、回放、资源管理的细节见 [06-open-questions.md](06-open-questions.md)。

## 1. 求值模型

- **节点求值**：当节点所有入边（value edge + order edge）来源均已「完成」，节点可求值。
  - 纯节点（literal / 纯 call）：输入值就绪即可算，输出值。
  - effect 节点：输入就绪即可触发副作用，并按 op schema 输出 `unit`、普通命名类型或 `result<T, E>`。节点 completion event 只供调度和 order edge 使用，不是值。
  - structural 节点（region / merge / loop-header / join）：不可执行，不产出 runtime effect，仅承载控制依赖与值汇合。
- **传值即定序**：value edge 隐含的 order edge 在执行时生效——被引节点必须先完成。
- **无依赖的纯节点**：可串行、重排或并行、可消除（CSE/常量折叠）、可缓存；并行不可观察（R-det-1），不写进图谱。
- **Module artifact cache**：以 content-addressed key 保存 separate-check/compiler 输出。写入采用同目录临时目录和 rename 发布；读取必须重算 key、payload 与 artifact digest，并调用当前 compiler-owned semantic verifier。并发同 key 只有 byte-identical artifact 可 replay，different artifact、partial directory、corrupt JSON 或 stale dependency/toolchain/profile pin 均拒绝。
- **Project build transaction**：先冻结完整 project graph，再从 immutable previous build manifest 计算 `planModuleRecheck`；所有 module artifact 完整并经 semantic verifier 接受后，才以 build-key content-addressed directory 原子发布完整 project manifest。失败不会发布新 revision 或混合 graph/artifact，旧 revision 仍可验证；同 key manifest bytes 不一致稳定拒绝。
- **effect 并发**：可观察的 effect 并发须显式 `par`（R-seq-3）；`par` 外同一路径上无确定序的 effect 报 `unordered-effect`，互斥 `match` arms 除外；只有 `par` 内不同 branch 的 effect 获得 R-det-3 并发许可。
- **有 order 约束的节点**：严格按序。

## Native Server profile slice

Rust 原生工具链当前提供一个 bounded `re.native-server@0.1.0` slice，供
`revia` 在隐藏 Node/JS bundle 后进行最小服务验证：

- HTTP/1.1 只接受完整的单请求 framing，method/path/header/body 都在显式上限内
  解析；header 名按 ASCII 小写归一化，重复或控制字符拒绝；
- route registry 在构造期排序并拒绝重复 method/path，`serve_once` 只消费显式
  `TcpListener`、router、handler、limits 和 cancellation，不读取全局端口或 host
  registry；一次请求以 `Connection: close` 完成，route miss 返回确定的 404；
- cancellation 在 accept、parse、route、handler 和 response write 前检查；取消
  不调用 handler，也不留下持久 request/server 状态；
- JSON codec 只消费显式注册的 exact schema，decode 先做 bounded JSON parse，再
  拒绝未知字段、缺失字段、重复字段、非法值和非正典 number；encode 递归按 UTF-8
  key 顺序输出；
- SQLite adapter 只接受绝对 regular database path 和窄 SQL 子集，参数通过
  `sqlite3` `.parameter set` 绑定，不把值拼进 SQL；transaction 失败返回 closed
  error，query 只允许 `SELECT`，CLI 不保存数据库连接或隐式全局配置。

可复跑入口是 `cargo run -p revia-cli --offline -- server-smoke`，输出固定
`re.native-server-smoke@0.1.0` envelope。该 slice 不包含 HTTP/2/3、TLS/auth、
keep-alive、streaming/backpressure、连接池、ORM/PostgreSQL、真实部署 secret、
跨请求 scheduler、完整 `.re` source lowering 或 production backend；Node
Server profile 仍只作迁移期 oracle。

## 2. 执行入口

- 入口 = 一个 `fn`（默认 `@main`，可由 run 参数指定）。
- Demo 入口 `@main` 返回 `process.status`；`process.exit(code)` 是构造该值的 pure op，不是提前终止控制流的 effect。
- `@main` 完成后，运行器把其 `process.status` 映射为宿主进程退出码；映射规则与 host fault 的边界见 [08-demo-host-contract-0.1.md](08-demo-host-contract-0.1.md)。

## 3. 副作用与可观察行为

- 一个 RE 程序的**可观察行为** = effect 节点按 value/order/region 约束形成的偏序、对应外部影响，以及函数返回值；显式 `par` 不伪造不存在的全序。
- 确定性要求（R-det）：相同输入、相同环境下，可观察行为相同。
- 执行器**不得**引入未声明副作用（不得隐式日志、不得隐式取时）。

## 4. 错误传播（草案）

采用「错误即值」模型，避免隐式控制流跳转打乱图结构：

- `result<T, E>` 是错误传播的基础值形态；`ok(T)` / `err(E)` 都沿 value edge 正常流动。
- 可失败的 op / effect 直接声明 `result<T, E>`；无业务成功载荷时 `T = unit`，有真实响应时使用普通的 op 专属命名类型。completion event 不进入值类型，v1 不设通用 `receipt<R>`。
- 核心语义只保留 `match` 做 sum 消去与分支；V1 不提供 `handle`、`?` 或局部传播 region。
- `result` 必须被 `match`、传递或 `return` 消费，即使生产者是 effect。`after:` 只等待 completion event，不消费 result；忽略 fallible effect 的结果属于 `unhandled-result`。
- 传递或 `return` 必须保持完整的精确 `result<T,E>` 类型；只有穷尽 `match` 能消去它。`loop` / `par` 内也使用相同显式规则，不存在传播糖、异常、栈展开或 runtime jump。

示例（伪 compact，待语法敲定）：

```re
%write: result<unit, io.error> = @stdout.write("Hello\n")
%status: process.status = match %write {
  ok(_) => process.exit(0)
  err(_) => process.exit(1)
}
return %status
```

错误规则与 effect/schema 的边界见 [06 Q-err](06-open-questions.md)。

## 5. 控制流

控制流原语已收敛（见 [BOOTSTRAP.md §6 Q-cf](../BOOTSTRAP.md)），compact 层与 canonical 层分层：

- **函数调用**：V1 调用图必须为 DAG；直接或相互递归稳定拒绝，且不与 Module dependency cycle 共用诊断。需要递归遍历时使用显式 worklist + `loop(state)`，让进度、资源上限与取消点留在图中。
- **分支**：compact 唯一入口是穷尽式 `match`（可带 guard：纯 bool 谓词、first-match、必有无 guard 穷尽兜底）；canonical 用 structural `region`（每 arm 一 region）+ `merge` 汇合。guard 的 case 序是 structural priority，非 runtime order edge，不参与 R-det-3。
- **循环**：`loop(state)` 双终结器 `next(state)`（沿唯一 backedge 进入下轮，携带 loop-carried state）/ `done(value)`（汇入 loop-exit merge）。循环体不能普通 `return`；`done` 值经 merge 后由函数显式 `return` 消费。backedge 隐含迭代序（迭代 i 完成先于 i+1），跨迭代同通道 effect 不触发 R-det-3 竞争。loop-header 是 state 初值 value edge 与 backedge 汇合的 structural 节点。
- **状态机**：V1 只保留 closed `State` / `Event` 的 tooling descriptor，不新增 `machine` 源码语法。纯 transition 唯一下沉为 `match(state, event)` + `loop(state)`，产生 `next(state[, command])`、`done(value)` 或 `error(value)`；command 的 closed result variants 一一映射回 Event，effect 不得进入 transition。lowering 保留 initial state、event input、单一 state backedge 与 `result<Done, Error>` exit merge。多 command 的次序、并发和取消由 P0-06 后续裁决。
- **并发**：纯节点无依赖可自由重排/并行（不可观察）；可观察的 effect 并发用显式 `par`，结果经唯一 `join` 收集。全部 branch scope 在执行前建立，离开 region 前必须 terminal；V1 无 detach。一个 branch 内共同发生的 effect 必须显式全序，不从数组顺序猜 happens-before。互斥 `match` arm 必须由 P0-05 先投影为 branch 级 co-executable slice；P0-06 可保留 branch `control_path` 供审计，但拒绝 effect 级 match/control path union。需要 review manifest / patch / trace 回链时，所有 sibling branch identity 必须绑定同一 Graph revision 下的唯一 UID anchor。不同 branch 通过实例化后的 typed canonical read/write footprint 做 R-det-3 相交检查，任一 write 且 key prefix overlap 时拒绝并发。

正常 join 按稳定 branch identity 填充 checker 已绑定的 exact nominal join type，每个成员为 exact generic `task.outcome<T, CancelReason>`，不生成匿名结构类型。Program `result.err` 仍是 completed value，不隐式取消 sibling；parent cancel/deadline 才向下取消。若全部 child 都由 parent/deadline 取消，region outcome 为 `cancelled`，不伪装成 `joined`。Host fault 取消未完成 sibling，等待 cleanup 后以 host fault 离开 region；若 sibling 已由 parent/deadline 取消，审计保留该真实原因而不改写为 host-fault。所有 branch 必须 completed/cancelled/host-fault terminal，不能因错误或取消跳过 join/cleanup。

Nested `par` 使用 lexical `scope_path` 明确定位：根 region 为 `[region]`，branch 内子 region 为 `[root-region, branch, nested-region]`。父 region cancel 后，子 region 必须先出现 `region-cancel(parent)`，且子 region 不能在父/祖先尚未取消时伪造 parent cancel，再让子 branch terminal；父 branch 必须等待子 region `region-exit` 后才能 completed/cancelled/host-fault terminal。Cancellation diagnostics 对 nested trace 固定返回 `region_id`、`scope_path` 与 event `ordinal`，便于 Agent 定位父子 region 的合成错误。

Reference runtime also returns `re.concurrency-scheduler@0.1.0`. It records `max_concurrent_branches` (`null` means unlimited) and, in UTF-8 `scope_path` order, the FIFO `admitted` and `queued_cancelled` branch order. This is an audit summary only: it does not add trace events, infer wall-clock fairness, expose completion timing, or claim a production scheduler.

同一 state-machine instance 的 transition 必须按 event identity 串行提交；不同 instance 可以并行。durable workflow 可由 Runtime profile 保存 event/snapshot 并重放，但必须固定 machine revision、state schema revision、event identity 与迁移函数。网络 adapter 只能声明投递语义和幂等要求，不得把“恰好一次”伪装成 Core 保证。

这块应在 [../examples/](../examples/) 的分支/循环/并发/重试样例上持续验证 compact 是否臃肿（cf-branch / cf-loop / cf-concurrent / cf-retry 已提供）。错误原语见 §4 与 [06 Q-err](06-open-questions.md)。

## 6. 内存、资源与超时

- ordinary value 构造后观察上不可变；不可变 alias 可跨 task 共享，Backend 不得把 copy 与否变成程序可观察差异。
- 可变状态只能位于 opaque resource 后面，并通过 typed handle、lifetime 与 read/write footprint 访问；普通 value 不得形成隐式共享可变单元。
- region reference 不得逃逸 owner lifetime。Backend 可自由选择 GC、region、stack/heap、copy-on-write 或内部 mutation，但必须排除 data race、use-after-free、uninitialized/torn read。
- 这些规则不在 V1 源码增加通用 ownership/borrow 方言；P0-04 固定 value/type，P0-06 固定 resource/task 边界，artifact verifier 对每个 Backend 执行同一 memory probes。

- `par` deadline 是显式 absolute `time.monotonic_instant` value input；取得 deadline 需要 clock capability。到期产生 branch `cancelled(deadline)`，不引入异常或隐式取时。
- Durable task reference runtime 的 `timeout_ms` 是显式 runtime seam，不是 `.re` 语法糖或 wall-clock Core 语义。runtime 从 parent signal 与 timeout 创建内部 `AbortSignal` 交给 performer；首个取消原因获胜，取消后返回的未提交 effect 不得 late-commit。signal/timer/resource capability 在 startup 前单次快照并绑定 receiver；registration/timer setup 失败与 checkpoint/host fault/正常 terminal 都必须完成 timer、listener、resource 全清理。已有主诊断优先，正常 terminal 的首个 cleanup fault使用稳定 task diagnostic；resource close 失败撤销本次新 effect，成功 trace 只记录一次 close。
- 单个 operation 的 timeout 是其显式参数，超时按 schema 返回 typed `err(timeout)`；V1 不提供 relative timeout 糖或隐式 runtime retry。
- Effect 的 cancellation contract 为 `cooperative` 或 `complete-before-join`。两者都不得产生 orphan；后者不会被强制中断。`re.concurrency-trace@0.1.0` 必须用 `effect-start` / `effect-complete` 暴露已启动 `complete-before-join` effect 的 progress；未启动 effect 可随 branch 取消且不伪造 completion。若 effect 在 cancel/host fault 后才 complete，`cancel_latency_ms` 必须是非负整数并进入 audit summary。

## Portable executor core

`re.portable-executor-contract@0.1.0` 冻结第一块不依赖 Node builtin
或 host adapter module 的 checked-graph 求值边界。contract 精确绑定
`executor=portable-core`、Graph revision、输入摘要和
`re.portable-reference@0.1.0` profile；未知字段、缺字段、摘要或 profile
漂移必须在执行前拒绝。

当前 portable core 只解释已冻结 Demo executable slice：按 UID/value edge
读取 literal，求值 `let`、穷尽 `result` match 与 `process.exit`，并把
capability 调用交给唯一显式 bridge。它不读取文件、网络、环境变量、
进程参数或全局 registry，也不按 source order、alias 或文本位置猜测值。
未知 statement、pure operation、producer、literal、result variant 或畸形
capability outcome 均返回稳定诊断，不尝试恢复。

`re.portable-execution-result@0.1.0` 同时返回 outcome 与独立快照的
`re.portable-execution-receipt@0.1.0`。receipt 回绑 executor/profile/graph/
input，按实际调用顺序记录 capability instance、member、invocation ID 和
闭集 outcome；执行器还向可信调用方返回不可序列化的 opaque verification
evidence token，模块私有 registry 以该 token 保存冻结 contract、每次调用的
identity/参数/完整 capability response payload 和 outcome。执行路径先对
capability response 做独立快照，再用同一快照计算 invocation 分类与程序分支，
不会继续读取 caller-owned response；`Uint8Array` payload 必须按 typed-array
internal slots 复制，Proxy/iterator spoof 不得替换 bytes authority。verifier
必须拿到调用方单独解析的 checked
graph 与原 token，以冻结 payload 重放并重建完整 invocation receipt 和 program
outcome；重建值同时与执行时 evidence、公开 receipt 和顶层 outcome 逐字节比对。
复制、克隆或伪造 token，以及共享对象、参数、response、单边、双边或 invocation
连同 outcome 的自洽重写都必须拒绝。该验证不替代跨进程/跨机器外部
capability 的签名或录制证据：opaque token 只在同一可信执行器进程内成立；
跨进程必须在更高层用 revision-pinned graph custody 与 host receipt 解决。

Node reference evaluator 继续负责 schema registry、adapter binding、文件
sandbox 和 CLI envelope，但其 statement/match 求值已复用同一 portable
core，并由差分 conformance 锁定 stdout、status、invocation identity 与错误
分支。这只建立将来原生 VM/AOT 后端可复用的语义 seam，不是独立二进制、
生产 backend、完整函数/loop/par 执行器或 Stable V1.0 证据。

`re run --format json --runtime-receipt` 是独立的 opt-in HostEnvironment 观测，
输出 `re.run-result@0.2.0`，其中 `runtime_effect_receipt` 可为 `null`（无 capability
adapter 被调用，或在调用前拒绝）。非空 `re.runtime-effect-receipt@0.1.0`
记录 capability reference/instance/member、规范化实参、HostEnvironment 验证后的
adapter response、source effect call 的 `effect_uid` anchor、调用开始 sequence，
以及不依赖 node UID 的 `demand_id` / `receipt_id`。`demand_id` 由 capability identity、
实参和相同 demand occurrence 序号派生；`effect_uid` 只回链，不作为 demand identity
输入。顶层 `receipt_digest` 与每项 ID 用于检测单边/非协调篡改，
`verifyRuntimeEffectReceipt` 会重新计算 canonical bytes；这不是签名或真实性证明。
`bytes` 以 tagged lowercase hex 保存。`process.exit` 是 pure operation，不进入回执。

回执证明 Node reference 路径发起了哪个 adapter invocation 及其返回内容；它不签名、
不提供外部信任根，也不单独证明外部副作用已持久化。文件 write 还需读取目标文件逐字节
核对，HTTP 还需服务端 transcript/响应对照。由于实参或响应可能含有 secret/个人数据，
该选项默认关闭，分享回执前必须先检查并脱敏。当前 Demo source slice 的执行能力是有界的；
回执里的 sequence 表示 HostEnvironment invocation 开始顺序，不证明未执行的图路径，也不
替代 `par` scheduler 的并发/取消证据。

并发 reference runtime 已有父取消后保留先完成 branch、取消 branch 不会伪造 completion
的 trace 回归；SQLite connection-set 集成测试还验证等待中的 lease request 在 branch
取消后不会于连接释放时迟到获批。它们是调度/lease lifecycle 证据，不扩展上述单线程
HostEnvironment receipt 的证明范围。

`re.portable-conformance-bundle@0.1.0` 是该 seam 的 backend-neutral
机器 oracle。每个 tracked case 固定 canonical graph 路径、Graph revision、
无额外 caller input 的 input digest、完整 capability invocation
identity/arguments/response，以及预期 outcome/receipt；bundle runner 重新
check graph 后只调用 portable core，不读取源码语义或宿主资源。当前 9 个 case
覆盖 `process.stdout`、`process.args`、`fs.read`、`fs.write` 的 `ok/err`
分支、named arguments 与 bytes literal，并与 Node reference 的真实
MemoryAdapter/HostEnvironment 路径逐 case 差分。bundle/case 字段、graph/input
digest、invocation identity/arguments/response 或 expected outcome/receipt
漂移必须 fail closed；重复执行结果必须 byte-equivalent。该 bundle 是未来
backend 的最低语义入场测试，不是性能资格、跨进程 receipt 签名或完整语言
runtime 证明。

`re.portable-conformance-matrix@0.1.0` 在 bundle 之上固定跨环境证据的
独立 authority：bundle/toolchain digest、portable result、tracked test
inventory、grammar fuzz report 与公开候选 tree 都由 matrix 预先给出，
不能由单个 runner receipt 自己声明后重签。每次真实运行生成
`re.portable-conformance-run-receipt@0.1.0`，绑定 exact OS、architecture、
Node major/full version 与上述 authority；matrix evidence 再把所有声明环境
精确分区为 measured 或 pending。缺失、重复、未声明环境，或任一摘要、平台、
Node、测试、fuzz、公开候选结果漂移都 fail closed。当前实际 receipt 覆盖 macOS
arm64 / Node 22.22.0、Node 24.16.0，以及同一物理 Mac 的 Docker Desktop
`linux/amd64` 虚拟化容器内 Node 22.23.2、Node 24.19.0；四环境分区完整且
pending 为空。Linux receipt 不是独立 host、多机 custody、独立 binary 或
production backend 证据。多环境更新先验证既有 evidence，只替换当前 exact
environment 并保留其他 receipt；候选 evidence 只有在完整 tracked suite 通过后
才原子提交。existing evidence 漂移、undeclared runtime/receipt、测试失败或
中断均保留上一份证据并 fail closed。

普通 release hard gate 不绑定运行测试的当前主机身份：它完整验证 matrix 与
evidence、要求 measured/pending 精确分区且至少存在一份 measured receipt。

## Native VM foundation

`re.native-vm-request@0.1.0` 是 native bytecode effect 前的请求边界，精确绑定
checked Graph revision、`re.native-bytecode-artifact@0.1.0` digest、bytecode
profile 和调用方输入摘要。Rust-owned `re.native-vm@0.1.0` 先加载 canonical
artifact，再从请求外的 checked Graph 重验证 artifact；request、graph、artifact
或 profile 任一漂移都在 capability bridge 被调用前拒绝。请求不携带 expected
outcome、receipt 或预期 trace。

当前实现只解释 WP-254 已冻结的四指令切片：`invoke-capability` 写入受限
register，`branch-result` 只接受 `ok`/`err` closed variant，`return-status`
从受验证的 `int` literal 产生 0..255 的 `process.status`。参数转换为不可变
native value（text/path/encoding、bytes、int），bridge 只能通过显式
`CapabilityBridge` 接口进入；VM 不读取文件、网络、环境变量或 Node API。
每次执行都产生确定性的 invocation 与 program-counter trace，并把相同字段
和 outcome 绑定到 `re.native-vm-receipt@0.1.0` digest。step、allocation 和
trace entry 都有显式上限；超限、畸形 capability response、缺失 register、
无效 branch 或 bridge fault 均 fail closed。

这是一块可由原生二进制加载的 VM foundation，不是完整 interpreter、structured
concurrency、scheduler、minimal std、Server adapter、AOT/WASM/Cranelift 或
production backend。loop、function DAG、`par`/join、task lifecycle 和 host
capability implementations 仍由后续 Node-free work packages 负责；Node
reference 仍只用于迁移期差分 oracle。

## Native task lifecycle core

`re.native-task-request@0.1.0` 把一个单 task 绑定到 contract、Agent/module/node
identity、revision、caller idempotency key、input digest、task identity 与显式
performer authority。request digest、task identity、performer executor、Graph
revision、artifact digest 和 profile 必须从请求外的 checked/runtime authority
重新计算并 exact 比对；request 不携带 expected terminal、receipt 或 trace。
authority、contract、input value、request schema 或 digest 任一漂移，都在
performer 被调用前返回 closed diagnostic。

Rust-owned `re.native-task-runtime@0.1.0` 目前只迁移单 task lifecycle。它提供
有限 `max_attempts` 与显式 retryable error 集，retry checkpoint 必须绑定同一
task/revision/input digest 且字段集合 exact；已提交 effect 用 effect key 去重，
同一 task replay 不再次调用 performer，不同 task 复用 key 拒绝。新 effect
只有在 performer outcome、canonical value、effect authority 和当前取消状态
全部通过后才提交。

生命周期观察通过显式 bounded plan 注入：before-start、after-start、parent 与
timeout 取消使用 first-reason-wins；取消后返回的未提交 effect 不得 late-commit。
每个 terminal path 最多清理一次 timer、listener、owned resource，顺序固定为
timer、signal、resource；已有 performer/checkpoint/setup 诊断优先于 cleanup fault，
cleanup 首 fault 使用稳定 code。resource close fault 会撤销本次新 effect。
receipt 固定 attempts、performer calls、replay、cancel reason、cleanup events、
effect count、output/trace digest 与有序 lifecycle trace。

task performer 是显式 bridge，当前唯一 native integration 会在 performer 内调用
WP-255 四指令 `execute_bytecode`；task runtime 不新增 opcode、`.re` 语法或
隐式 host access。这一节是确定性单 task conformance core，不是 `par`/join、
FIFO admission、nested region、真实 async scheduler、wall-clock watchdog、
durable checkpoint/effect store、完整 capability adapter、production task
runtime 或 Stable V1.0 证据。Node lifecycle reference 仍是迁移期 oracle。

这样一个仍 pending 的声明环境可以先运行 tracked suite，再由 matrix runner
生成自己的候选 receipt。只有 matrix runner 校验当前 OS、architecture 与
Node major 必须 exact 命中 matrix；未声明 runtime 仍 fail closed。零 receipt
的 all-pending evidence 不能满足 release gate。

## Native minimal std and host adapters

Rust-owned `re.native-minimal-std-request@0.1.0` 实现当前冻结的 11 项 pure
operation：`bytes.byte_count/concat/decode_utf8`、`list.append/concat/length`、
`result.is_err/is_ok` 与 `text.concat/encode_utf8/scalar_count`。请求只接受
exact named arguments、canonical `StdValue`、合法 lowercase SHA-256
`graph_revision`/`input_digest`，并由 request digest 绑定 schema、operation、
参数和两个摘要；invalid UTF-8 只产生
`std.bytes.decode_error.invalid_utf8`，不做 replacement 或默认编码。
输入、集合深度、集合数量和 bytes/text 输出均有上限，拼接在分配前检查结果
长度，超限或非 canonical integer 直接 closed failure。

`re.native-server-host@0.1.0` 是独立的显式 host adapter seam，支持
process args/stdout、sandboxed fs read/write、environment、secret snapshot、
monotonic clock、random bytes、log 和 trace。`HostEnvironment` 先核对
`re.native-host-request@0.1.0` 与 profile，再以 `catch_unwind` 把 adapter
panic 收口为 `host-fault`；`MemoryHost` 与 `SystemHost` 都复制输入/输出，
限制 stdout、file、random、log/trace 大小，并在 secret close 时清零并清空
snapshot。文件访问拒绝绝对路径、`..` escape、read symlink 和 write target
symlink，真实 adapter 的 root 在构造时 canonicalize。

VM 的 `CapabilityBridge` 必须在 effect 前接受请求外的 graph revision 与 input
digest authority。`MinimalStdBridge::new` 显式保存这两个摘要；VM 在加载并
重验证 graph/artifact/request 后调用 bridge authority gate，漂移返回
`native-vm-capability-authority-mismatch`。因此纯 std 不会通过固定 dummy
digest 或宿主全局状态执行。该切片仍不新增 std opcode、`.re` 语法、Module/
Package/project pipeline、HTTP/SQLite、真实 scheduler、AOT/WASM/Cranelift、
production backend 或 Stable V1.0 证据；Node std implementation 仍仅作迁移期
oracle。

`re.portable-bytecode-artifact@0.1.0` 是从 checked graph 到未来自有执行器的
最小中间执行协议。当前 compiler 只接受已由 9-case oracle 覆盖的单 capability
result-flow：稳定 literal table，随后是 `invoke-capability`、
`branch-result` 与两个 `process-exit` 终点。artifact 绑定 graph revision、
`re.portable-bytecode@0.1.0` profile 与 canonical SHA-256；digest、profile、
opcode、jump、register、literal 或 argument table 漂移均在 host 调用前
fail closed。执行入口必须持有可信 checked graph，重新 compile canonical artifact 并
与待执行 artifact exact 比较；expected artifact digest 只是附加一致性检查，不能由
调用方换锚。同步重算 artifact 内部 digest 也不能把 literal/argument/opcode/jump/
register 漂移伪装成合法 artifact。
compiler 同时拒绝冻结切片之外的额外 statement/function。解释循环单独位于无
import、无 Node builtin/host adapter 的 JS core，只消费验证后的 artifact 与
显式 capability bridge。9-case conformance
同时比较 bytecode interpreter、portable core 与 Node reference 的 outcome 和
invocation receipt。该协议不是完整 bytecode ISA、独立 binary、JIT/AOT、
LLVM/Cranelift 或 production runtime。

## Native Package, Module, and project pipeline

Rust-owned `re.project-manifest@0.1.0` 是 native project 的唯一入口。它把
`project.json` 中的 source path/digest 与 `re.package-manifest@0.1.0` 的
Package/Module interface、implementation digest 和 exact dependency pin 绑定在
同一输入中。loader 先 canonicalize 根目录，再拒绝 symlink、路径逃逸、未列文件、
重复 module identity、source/implementation 漂移、未知字段、内部 cycle，以及找不到
或 digest 不一致的 external package interface；依赖图使用稳定的字节序拓扑序，不能由
manifest 原始数组顺序改变。

loader 输出 path-free `re.native-project-graph@0.1.0`，其 `graph_revision` 同时
绑定 package digest、project/module identity、interface/implementation/source digest
和拓扑序。implementation 变化只标记该 module；interface 变化沿内部反向依赖闭包
传播；profile/toolchain authority 变化使全部 module 失效。`re.native-project-build-key@0.1.0`
绑定 graph、package、project、profile 和 toolchain digest。

module artifact 使用 `re.native-module-artifact-cache-key@0.1.0` 的 content-addressed
目录。缓存命中仍要重新解析 payload、重算 payload/artifact/key，并与当前 module
authority exact 比较；损坏、部分写入、不同内容的同 key 并发发布、旧依赖 pin 或同步
重签均 fail closed。完整 build manifest 只有在所有 module artifact 通过 semantic
verifier 后，才写入 build-key 目录的临时目录并 rename 发布。previous manifest 必须
同时通过请求内校验和本地已发布 bytes 校验，失败不能污染上一份 build。

当前 native CLI 提供 `project-check <project>`、
`project-init <directory>`、`project-test <project>` 与
`project-build <project> <cache> <build> <profile-digest> <toolchain-digest>`；这些命令
只输出稳定、无本地路径的 JSON。`project-init` 只接受不存在或空目录，生成固定的
`revia.app` 单 Module starter（`modules/main.re` + canonical `project.json`），写入
失败会清理本轮创建的文件，不覆盖非空目录。`project-test` 重新加载 project authority，
按拓扑序对每个 Module 运行 native translation/check gate，输出
`re.native-project-test@0.1.0`；它是当前 bounded slice 的项目测试门，不是完整测试框架。
两个独立目录初始化结果逐字节相同，source digest、unlisted file、路径和 symlink
检查仍由既有 loader fail closed。该包已经覆盖 50/500/5000 module chain plan、cold/
warm cache、implementation-only/interface-dependent/toolchain invalidation、外部 pin、
corrupt cache 与 atomic publication；它仍只生成当前 bounded module artifact，不是
完整 `.re` multi-function lowering、project-run、远端 build farm 或 production compiler。

WP-260 在同一 native project authority 上增加
`re.native-enterprise-project-scale@0.1.0`。规模报告只从已校验的 Package/Module
interface 统计固定的 50 Module、`route_000..route_049`、`task_000..task_049` 与
100 个 public symbol，并要求至少 49 条依赖边和一个 fan-in；报告绑定 path-free
`graph_revision` 与 canonical `summary_digest`。`revia project-scale <project>` 只
输出这些稳定字段，不输出本地路径。50 Module fixture 的声明顺序改变不改变
graph/report bytes；cold build 为 50 miss/build，warm build 为 50 hit，单一
implementation 变化只重建目标 Module，interface 变化重建其反向依赖闭包。缺少或
重复 public inventory、短依赖拓扑、source/interface authority 漂移均 fail closed。
这是大型项目的第一段 native scale evidence，不把 bounded metadata artifact 伪装成
完整 source lowering、project-run、10,000 task workload、production compiler 或
Stable V1.0；project translate/run 继续由后续工作包闭合。

WP-261 在该 authority 之上增加 Rust-owned
`re.native-project-translation@0.1.0` 与 `re.native-project-run@0.1.0`。native
project runtime 先重新加载当前 path-free project graph，并执行当前 profile/toolchain
下的 project build；随后只读取选定 Module 的 source，走 checked Graph →
`re.native-bytecode-artifact@0.1.0` → VM verifier/executor。translation 同时绑定
source graph revision、project graph revision、project/build digest、目标 Module
cache key/artifact digest、profile/toolchain authority 和 canonical artifact bytes。
project-run 不接受 expected outcome 或 receipt；它从当前 project/build 重建 trusted
translation，要求调用方 translation exact 一致，之后才构造 `re.native-vm-request`
并进入 capability bridge。缺失 Module、source drift、entry symbol 不在显式 interface、
translation/artifact/request drift 均在 effect 前 fail closed。

native CLI 提供 `project-translate <project> <cache> <build> <profile-digest>
<toolchain-digest> <module>` 与同 authority 参数加 `<input-digest>` 的
`project-run`；输出只含 digest、module、outcome code、VM receipt digest 等
path-free 字段。当前仍是单 Module/四指令 executable slice，不是完整多函数 project
lowering、真实 Server request dispatcher、structured scheduler、production backend
或 Stable V1.0。

WP-268 在该 authority 之上增加
`re.native-project-execution-plan@0.1.0` 与
`re.native-project-execution@0.1.0`。execution plan 必须显式给出 public root
`module`/`entry`，以及按调用方声明顺序排列的 `binding`、目标 Module/entry、
interface digest 和 contract digest；plan 本身以 canonical JSON 和 `plan_digest`
固定。verifier 从当前 project graph 开始，只沿 `scope=package` 的 dependency
binding 解析目标，并逐项核对 Module/interface exact pin、public export、contract、
重复 binding 与 cycle。fixture 名称、route、manifest 数组顺序和 metadata 不参与
调用推断；未知、私有、漂移、循环或错误 binding 均在 effect 前 fail closed。

`project-execute-plan <project> <plan> <profile-digest> <toolchain-digest>
<input-digest>` 对每个显式 step 和 root entry 重新生成 trusted translation，
按固定顺序进入既有 bytecode verifier/VM，并输出嵌套的 path-free project-run
receipts。当前 slice 是 bounded sequential execution：各 step 共享同一显式 input，
尚未实现函数参数/返回值在 Module 间传递，也不把顺序列表解释为隐式 scheduler 或
完整多函数 lowering。outer execution digest 依赖每个经过验证的 nested receipt；
任何 nested authority error 必须透传为具体诊断，不能被空字符串或泛化 digest
替代。该命令加入 Node-free workload，重复执行的 plan、run 与 outer receipt
必须 byte-identical。

WP-269 增加 `re.native-project-execution-artifact-cache@0.1.0`。它保存显式 plan、
当前 project/build graph authority、profile/toolchain 和 ordered trusted
translation envelope；读取时先拒绝 symlink/non-regular path、损坏/非 canonical
source、digest 或 semantic mismatch。当前 authority drift 只产生 cache miss 并
重建，不能通过同步重签让旧缓存命中；写入先完成同目录临时文件，再 rename 发布。
`project-execute-plan-cached <project> <plan> <execution-cache> <profile-digest>
<toolchain-digest> <input-digest>` 复用缓存候选，但执行仍调用唯一的
project/build、translation、bytecode verifier 和 VM authority，并输出与
`project-execute-plan` 相同的 path-free receipt。缓存不保存 outcome/receipt 作为
后续执行真源；当前只覆盖 bounded sequential cold miss/warm hit 和 invalidation，
不代表远程共享缓存、分布式 build farm、完整多函数 lowering 或 production backend。

WP-270 增加 `project-execute-plan-direct <project> <plan> <profile-digest>
<toolchain-digest> <input-digest>`。plan execution 先一次性建立当前
project/build authority，再按 plan 顺序生成 trusted translation/artifact bundle；
执行阶段直接消费该 bundle，避免每个 entry 再次加载和构建同一 authority。普通
`project-execute-plan` 与 direct 命令共享同一实现并输出 byte-identical receipt；
cached 命中仍先用当前 authority 校验 envelope，不能由缓存或 caller translation
绕过 verifier。WP-270 只闭合 authority reuse，不把 digest/receipt 元数据当作
WP-271 已增加 bounded runtime value handoff：plan 的 step 可显式声明
`handoff`，root 可声明 `root_handoff`。声明只绑定前一显式 step 的真实 VM 返回值、
nominal `type_name`、canonical bytes 的 `value_digest` 和 `max_bytes`（当前上限
64 KiB）；执行器在目标 capability effect 前重新核对这些字段，输出
`handoffs` 证据并由 serializer 再验证 canonical value。首 step handoff、零 step
root handoff、missing/oversized/malformed/type-or-digest drift 均 fail closed。
`input_digest`、receipt、caller-owned value 和同步重签字段不是 handoff authority。
当前仍只覆盖显式 bounded sequential slice，不是通用函数参数/返回值 lowering、隐式
dispatcher、真实 scheduler、production backend 或 Stable V1.0。

WP-272 增加 `re.native-vm-replay@0.1.0` 与
`conformance-run <source> <input-digest> <transcript>`。transcript 是 canonical
JSON，根对象只含 `schema`、`invocations`；invocation 只提供顺序、instance/member/
invocation_id、canonical VM arguments 和 declared response。runner 不读取 transcript
中的 expected outcome、receipt、artifact、graph、profile 或 input authority，而是从
当前 source 重新 checked、translate、verify 并执行既有 VM。`ReplayBridge` 在模拟
capability response 前 exact 比较当前 VM invocation；调用完成后还检查 transcript
没有 missing/extra entry。未知/重复/非 canonical 字段、malformed VM value/response、
成员/参数/顺序漂移与非法 input digest 均 fail closed，失败诊断走 stderr，成功 stdout
仍是既有 `re.native-vm-result@0.1.0`。这是单 Module/四指令 replay conformance seam，
不代表 transcript authority、完整 lowering、真实 scheduler、production backend、
跨语言性能或 Stable V1.0。

WP-273 在该 transcript 之上建立 `re.cross-language-replay-matrix@0.1.0`
比较入口。matrix 只接受从当前 checked graph、input digest、canonical transcript
和真实 backend result 重建的条目；每个 backend 必须明确为 `measured` 或 `pending`，
且 `measured` 需要真实 runner、toolchain、result/receipt digest 和 exact workload
authority。native 与 Node 可在同一 workload 上比较，Go/JVM/其他后端没有真实 runner
时只能保持 `pending`，不得复制 native/Node 输出或由 caller 同步重签。该包只提供
跨语言语义比较基础，不宣称后端性能、完整语言覆盖、独立机器 custody、production
backend 或 Stable V1.0。

可直接复跑的 native 入口为：
`cross-language-matrix <source> <input-digest> <transcript> <node-result> <output>`。
它从 source 重新构建 native checked graph/artifact/VM，并把外部 Node oracle 的
`re.cross-language-backend-result@0.1.0` canonical JSON 作为第二个 measured 条目；
输出 `re.cross-language-replay-matrix@0.1.0`，包含 native/node 各自的
`result_digest`、`receipt_digest`，以及共同的 `semantic_digest`。该命令不接收
expected outcome，输出 path-free，Go/JVM 当前固定为 `pending`；Node result 的真实
runner/custody 仍属于更高层证据，不由本地 matrix 自行宣称。

WP-274 增加 `replay-catalog <catalog> <output>`。catalog 是 path-free canonical
JSON，根对象为 `re.native-replay-workload-catalog@0.1.0`，每个 workload 包含
`workload_id`、canonical `source`、`input_digest`、canonical `transcript` 和可选
`node_result`。runner 不从路径猜测 source，也不接收 expected outcome；它在内存中
逐项重新执行 native replay，再生成 `re.native-replay-workload-report@0.1.0`。
三项 workload 是最低 catalog 边界；有 Node result 的条目生成
`re.cross-language-replay-matrix@0.1.0`，没有 Node result 的条目明确把 node、go、
jvm 标为 `pending`。报告绑定 catalog digest、graph/input/transcript、backend
result/receipt 和 report digest，失败只写 stderr，结果不包含本地路径。

WP-275 增加 `re.native-replay-fault-catalog@0.1.0`、
`re.native-replay-fault-result@0.1.0` 和
`re.native-replay-fault-report@0.1.0`。fault catalog 仍是 path-free canonical
JSON，但允许收录由 native check 明确拒绝的 versioned source，例如
`re 1.0`，以便对比闭合的 `check-failure`。fault result 不携带
`receipt_digest`，只记录 backend、`replay-mismatch`/`check-failure`/`host-fault`、
稳定 code 和 graph/input/transcript/toolchain/semantic/result digest；成功
process-status 不能被包装成 fault。native `replay-fault-catalog` 从 source、
transcript 重新建立 graph/artifact/verifier/VM，至少真实覆盖 replay mismatch、
check failure 和 host fault，missing/extra/identity/argument drift、authority
同步重签和 failure/success 混淆均在写报告前 fail closed。

Node fault result 不是 caller 预填的可信声明：当前 conformance test 通过
`test-support/replay-fault-node-oracle.js` 实际调用 Node reference `runSource`，
只把观察到的 closed check/host fault 转为无 receipt fault result，success 直接拒绝。
目前只有 `unsupported-language-version` 与 native 形成真实同码比较；若 Node 与
native 对同一输入产生不同首个诊断码，不做猜测式归一，该 workload 不得标为
failure-equivalent。Go/JVM/其他后端没有真实 runner 时继续 `pending`。该包仍是
Darwin arm64、单 Module/四指令 fault seam，不代表完整 fault runtime、跨平台性能、
独立 custody、production backend 或 Stable V1.0。

WP-276 增加 `re.native-fault-corpus@0.1.0`、
`re.native-fault-observation@0.1.0` 和
`re.native-fault-observation-report@0.1.0`。每个 corpus case 固定
canonical source、input digest、replay transcript 与预期 stage/kind/code；
预期字段只做 observed-vs-expected 验收，不能注入运行时 fault。native runner
从 source 重建 graph/artifact/verifier/VM，记录真实首个 `checked-error`、
`replay-mismatch` 或 `host-observation`，并把 `evidence_scope` 固定为
`exercised`；reachable-but-unexercised 不能标为 measured。合法 source 的
graph revision 必须由 source 重算，失败 observation 不带 receipt；成功
execution、case/source/input/transcript/stage/code drift、重复/缺失 case、同步
重签和 pending 分区伪造均在报告写入前拒绝。没有真实 runner 的 Node/Go/JVM
继续 `pending`。该包仍是 Darwin arm64 单 Module/四指令证据，不代表完整 fault
coverage、生产 scheduler、跨平台性能或 Stable V1.0。

WP-277 增加 `re.native-fault-corpus-release-evidence@0.1.0` 与
`replay-fault-corpus-gate <corpus> <evidence>`。Gate 只允许当前 release binary，
在清空环境并设置空 `PATH` 后重新启动同一 `replay-fault-corpus`，再解析并校验
corpus/report 的 source、transcript、graph revision、observation、binary 和
toolchain authority。evidence 记录五个 case 的 digest 链、process 与 Node
process/load/import 计数，报告和 evidence 均为 path-free；debug binary、成功伪装、
stdout/report 不一致、非 canonical 或 case authority drift 在写入前拒绝。相对
corpus 路径在隔离前转为绝对输入，但路径本身不进入 evidence。重复运行的
stable/evidence bytes 必须一致。该 gate 只证明当前 Darwin arm64 release binary
的五-case fault evidence，不扩展完整 fault coverage、独立 custody、外部签名、
跨平台 runner、production backend 或 Stable V1.0。

WP-278 将 native `execute` 与 `run` 的 capability bridge 接入受控
`minimal_std` host adapter。`HostBackedBridge<A>` 先绑定当前 checked graph revision
与 input digest，再按 capability 的 exact schema/member/argument 生成
`HostRequest`；未知 capability、参数名/类型、encoding 或 host response shape 都
fail closed。当前 `SystemHost` 只在 source 所在目录建立 sandbox，提供 process
args、stdout、fs.read、fs.write 的受限实现；stdout 有 1 MiB 上限，文件读写拒绝
路径逃逸和写入 symlink，host panic 只能变成 `HostFault`。`execute` 与显式
`translate` + `run` 共用 graph/artifact/request/verifier/VM authority 和 receipt
字段，程序 stdout 不再由 CLI bridge 占位数据代替。

WP-278 的证据只覆盖 Darwin arm64 单 Module/four-instruction slice，已实跑
stdout、sandbox file read success/missing、wrong host response、panic boundary，
并保留 `process.args`、environment/secret、clock/random/log、server/project
入口、write atomicity、panic-hook stderr 和大规模 effect evidence 作为后续闭环。
这不代表完整 host contract、生产 backend、Stable V1.0 或跨平台能力。

后续 native 工作包按依赖推进：

- WP-279：已把真实 host-backed bridge 接入 `project-run`、`project-execute`、
  `project-server-smoke` 和 plan/direct/cached runners；project root 作为 sandbox，
  多 graph execution 按 graph revision 激活 capability 集合，并以真实 fs.write
  fixture 验证占位 bridge 已移除。nested receipt、explicit route 和 project-level
  observation 的完整证据继续由 WP-280 固化。
- WP-280：完成当前 graph-reachable args、fs.read/write、stdout capability 的
  path/secret-free observation，保留 environment/secret snapshot、time/random/log
  的 HostEnvironment closed primitive conformance；补权限、stdout/stderr/transport
  分层、panic hook 净化、原子 fs.write 和 effect 前/partial-effect closed boundary。
  每条 bridge observation 绑定 invocation id，并按 VM invocation 顺序编号；参数和
  payload 只进入 digest，host-request 拒绝也记录为未提交 effect。尚未进入 graph
  registry 的额外 Server capability 不伪装成可执行 source 能力。
  尚未进入 graph registry 的额外 Server capability 不伪装成可执行 source 能力。
- WP-281：冻结 compact identity 的确定性算法，做 fresh-process、双目录 build、
  manifest/view/check-write 的 byte comparison，并把 identity 输入纳入 release
  lock；不接受随机 UID 或同步重签作为修复。
- WP-282：已建立仓库外可创建的最小 project manifest、module/test workflow 与
  native-only build/run 入口。`project-init`、`project-check`、`project-test`、
  `project-build`、`project-translate` 和 `project-run` 共享既有 project/build/
  translation/verifier/VM authority；初始化 starter 固定为可直接检查和翻译的
  `re 0.1 compact` Hello slice，失败不覆盖用户目录。`project-test` 只证明当前
  bounded Module translation/check，不宣称通用 test runner、完整多函数 lowering
  或 Stable V1.0。
- WP-283：把 project host execution、fault corpus 和 deterministic build 纳入
  fresh release/empty-PATH gate，再以相同 fixture 提供 Node/Go/JVM comparison
  seam；没有真实 runner 的后端保持 `pending`。

WP-262 增加 native `node-free-gate <source> <project> <module> <report>`。gate 从
当前 release binary 读取 binary digest，递归检查 source/project inventory 的 JS、
bundle、lockfile 和 symlink 边界，再以空环境和空 `PATH` 启动同一 native binary。
每轮都会真实执行 direct 与 project 的 check/translate/run/build，以及 loopback
server smoke；三轮结果的 workload output/semantic digest 必须相同。报告 schema
`re.native-node-free-report@0.1.0` 绑定 binary、source inventory、profile、
toolchain、workload 和 evidence digest；sample schema 同时保存 cold/warm build、
startup、throughput、p50/p95/p99、peak RSS、adapter overhead 与 project overhead。
其中 project overhead 是 project translate/run 与 direct translate/run 总耗时的非负
差值，仅作为有限 benchmark 轴。

gate 的空 `PATH` 约束只影响被测 native 子命令；依赖扫描和 RSS 采集使用平台明确的
绝对系统工具，并把它们作为 host-boundary evidence，不把系统工具伪装成 RE
capability。报告要求 Node process/load/import=0、JS source count=0、semantic
mismatch=0，native candidate 至少三轮 measured；Go/JVM/Node 未实际运行则显式
`pending`。该 evidence 不是性能资格、production backend 或 Stable V1.0 证明。

WP-254 在私有 native toolchain 中建立同一语义边界的首个 Rust-owned
`re.native-bytecode-artifact@0.1.0`。`revia translate <graph>` 只接受
WP-253 checked Graph 当前可表达的单 `@main`、一次 capability member call、
`result` 的 `ok/err` 分支和两个 `process.exit` 终点，输出确定的
`re 0.1 bytecode` canonical artifact；artifact 同时绑定 graph revision、
canonical graph digest、bytecode profile、release identity、translator identity
和自身 digest。`revia verify <graph> <artifact>` 必须先 canonical load 和
shape-check，再以当前 checked Graph 重译并 exact 比较；opcode、literal、
argument、register、jump、函数/statement/control shape 或 authority 漂移均在
任何 effect 前 fail closed。该 native slice 只生成和验证 artifact，不执行
bytecode，也不是独立 VM、scheduler、server adapter、AOT/WASM/Cranelift 或
production backend。

`re.portable-bytecode-process-request@0.1.0` 把上述最小 bytecode slice 固定到
Node 子进程单行 JSON 边界。request exact 绑定 checked graph、canonical artifact、
graph/artifact digest 与完整 scripted invocation identity/arguments/response；
父进程在启动 child 前先本地重放并得到 expected
`re.portable-bytecode-process-result@0.1.0`。child 由 `process.execPath` 参数数组
无 shell 启动，只消费不超过 1 MiB 的单条 stdin JSON，并只返回一条有界 stdout
JSON；父进程要求 child envelope 与本地 expected result canonical exact 相等。
malformed/额外字段、digest、调用 identity/arguments/order、缺失/重复调用、
提前退出、timeout、超大输出和伪造结果都 fail closed，终止路径等待 child close。
9-case conformance 将 request digest 纳入 portable result authority，并把 child
execution 与同进程 bytecode exact 比较。该协议只证明同机 Node 跨进程装载、
序列化和回收，不是独立 binary、跨进程签名、真实 host adapter、完整 VM 或
production runtime。

`re.portable-fault-protocol-report@0.1.0` 进一步固定当前 portable
core/bytecode/process 的失败协议。13 个 workload 覆盖 checked-graph rejection、
capability fault、process preflight、spawn、timeout、early exit、
malformed/multi-line/oversized stdout/stderr 和 forged output；每个 result 带
closed diagnostic、normalized `check/capability/preflight/process` phase 与
ordered trace。preflight rejection 不得记录 child 启动，spawn fault 不得伪造
close；已启动 child 的 timeout/超限必须经过 kill 和 close 才能终态返回。该报告
仍依赖 Node 同机 child 与受控 fixture，不构成敌对进程隔离或 native runtime。

`re.portable-runtime-abi@0.1.0` 把未来 portable VM 的入场边界冻结为三个
不可混用的 ABI 域：9-case checked-graph execution（Node reference、portable
core 与 Node process 三方 outcome/receipt 等价）、13-case core/bytecode/process
fault protocol，以及 14-case task lifecycle（retry、replay、parent cancel、timeout
first-reason 与 resource close）。每个域的 request/result/receipt 继续由既有
可信 graph、artifact、transcript、task contract 和 lifecycle corpus 重跑得出；ABI
report 仅绑定其 exact report digest、域顺序和 workload count，不能靠同步重签
嵌套 JSON 伪造通过。它是给 WP-222 最小 VM core 的版本化输入/输出契约，不是
新的 `.re` 语法、opcode、跨进程签名、独立二进制、WASM/AOT 或 production runtime。

`re.portable-vm-core@0.1.0` 只消费受信 adapter 准入的四指令 artifact 与
`execution` 域 request，且没有 Node builtin、host adapter 或 toolchain import。
adapter 必须从 checked graph 重编译 artifact，并逐项比对 graph/artifact/request
identity 后才交给 core；core 通过显式 capability bridge 返回 outcome/invocation
receipt。`re.portable-vm-conformance@0.1.0` 每次先重跑完整 WP-221 ABI，再以
execution 域的 9 case 对照 Node oracle。fault 与 task lifecycle 在此仅为冻结 ABI
域，尚未成为 VM core 的执行能力；该 core 仍由 Node 装载，不是独立 VM、native、
WASM/AOT 或 production runtime。

`re.backend-feasibility@0.1.0` 只记录未来脱离 Node 路径的可行性边界。候选顺序
固定为 WASM、LLVM AOT、Cranelift，probe 固定为 graph identity、semantic
oracle、memory contract、release lock、target toolchain 与 target runtime。
每个 probe 只能是带 exact external runner provenance 和 evidence digest 的
`reported`，或固定原因的 `pending`；reported 不表示 pass、eligible 或
production backend 已存在。报告绑定 graph revision、release lock、toolchain
与 canonical digest，并拒绝 artifact、metrics、eligibility、伪造 synthetic
runner 和身份漂移。

WP-228 的 `re.llvm-aot-external-evidence@0.1.0` 是当前唯一真实 external
backend evidence：Apple Clang 21 将 trusted 四指令 artifact 降为 Darwin arm64
native executable，executable 核对 invocation/arguments、执行 result branch，
并输出与 Node reference exact 的 9-case outcome/receipt。evidence 绑定 compiler
bytes/version、target、host provenance、source/executable/stdout、request/artifact
和 build/run samples；时钟样本不进入 stable digest。feasibility 因此只把
`aot-llvm` 六项 probe 标为 `reported`，WASM/Cranelift 继续 `pending`。该切片
尚未执行 fault/task lifecycle 或 minimal std，不等于完整独立 VM、production
backend 或 Stable V1.0。

WP-229 的 `re.portable-runtime-package@0.1.0` 把这一已测 slice 固定为
`re.canonical-json-source-archive@0.1.0`：archive 只允许 C core/header、由
trusted graph/transcript 生成的 9 个 C driver、冻结 ABI、许可证和 metadata。
manifest digest-pin 每个条目、tree、WP-221/222/227/228 authority、Darwin arm64
LLVM AOT target 与明确 pending；不得携带 Node modules、临时 executable、时钟
样本、绝对/宿主私有路径。verifier 必须从权威输入重建 archive，拒绝缺失、额外、
重排、path escape、symlink、文件或 authority 同步漂移及 `eligible` backend claim。
package conformance 使用真实 `/usr/bin/clang` 编译并重编译九例 driver，与 Node
reference/LLVM evidence 的 outcome exact。它是 portable source authority，
不是完整独立 VM、fault/task native lifecycle、minimal std native、WASM/Cranelift、
Linux/Windows runner、production backend 或 Stable V1.0。

WP-231 的 `re.external-runner-request/receipt/matrix@0.1.0` 在 source package
之上增加离线 runner 交接。probe 先记录 exact OS/architecture、Node full
version、compiler bytes/version、target triple 与 host identity；可信调用方再用
request 外部 challenge 绑定 probe、package、release lock、toolchain 与 workload
authority。runner 只编译 package 内 9 个四指令和 14 个 lifecycle C11 source，
不接收 expected；collector 从 trusted request/package/reference 核对 workload
集合、source/request、outcome/stdout、executable digest、provenance 与 metric，
并拒绝 stale request、跨 request replay 和同步重签。当前 measured 为 Darwin
arm64 / Apple Clang 21 与同一物理 Mac 上 Docker `linux/amd64` / Clang 14；
容器断网、非 root、rootfs/repository 只读，只允许 tmpfs 构建执行。WASM 与
Cranelift 没有真实 compiler/runtime receipt，继续 pending。该协议不提供恶意
runner 的签名认证，也不证明独立物理机 custody、production backend 或 Stable V1.0。

WP-232 的 `re.portable-execution-hard-gate-policy/report@0.1.0` 将上述分散证据
收敛为一个 admission contract。候选固定为 Node reference、portable core、
portable process、LLVM AOT、Cranelift；域固定为 execution 9、fault 13、
task lifecycle 14。semantic/artifact/receipt/error mismatch 阈值均为零，
cold start、p99、peak RSS、throughput 阈值固定但 measurement status 当前全部
pending。报告必须从 execution/fault/lifecycle/runtime ABI/external matrix
authority 重建；候选、域、预算、receipt/report digest、同步重签以及
`eligible`/`production` claim 漂移都 fail closed。LLVM 当前只在 execution 域
reported，Cranelift pending；该 hard gate 不证明性能资格或 production backend。

`re.minimal-std-abi@0.1.0` 冻结首个 host-independent 标准库契约，但不提供
operation 实现。package 固定为 `std`，Module 固定为 `std.bytes`、
`std.list`、`std.result`、`std.text`。11 个 pure operation 固定为：
`bytes.byte_count/concat/decode_utf8`、`list.append/concat/length`、
`result.is_err/is_ok`、`text.concat/encode_utf8/scalar_count`。所有参数均为
named parameter；generic 只使用显式 `t` 或 `t,e`，不得推断新的 hidden type
parameter、overload、conversion 或 host value。`decode_utf8` 的结果是
`result<text.utf8, std.bytes.decode_error>`，唯一 closed error variant 为
`invalid_utf8`；非法 UTF-8 不允许 replacement、locale 或宿主默认解码。

每个 operation contract 绑定 exact schema、Module、类型参数顺序、按名字
canonical 的参数、result 与 error variants；Module interface 使用现有
`re.module-interface@0.1.0` digest，`re.std-package-manifest@0.1.0` 只投影四个
Module/interface digest，不伪造尚不存在的 implementation digest。tracked corpus
和 release report 必须重建相同 package/report digest；缺失、重复、未知
Module/operation/type/error/parameter，或加入 capability/effect/host adapter、
同步重签 contract/interface/package/report 均 fail closed。WP-224 只冻结 ABI。

WP-225 的 `re.minimal-std-invocation@0.1.0` 为上述 11 项 operation 提供
host-independent API 执行边界。请求字段固定为 graph revision、operation、
std package manifest、named parameters、schema 与显式 type arguments；check、
invocation manifest、operation receipt 与 translation 共享同一个
`invocation_digest`，该 digest 绑定 graph、operation、package、参数和类型实例。
任何字段、operation、参数、类型参数、package 或 capability/host 注入漂移均
fail closed。bytes/list/generic payload 和 result 输出必须复制；`int` 保持
canonical decimal string；text 拒绝 lone surrogate；UTF-8 decode 使用 fatal
语义，非法 bytes 只产生 nominal `std.bytes.decode_error.invalid_utf8`。

现有 canonical graph 只接入当前 literal/result-match 能完整表达的
`std.bytes.decode_utf8@0.1.0`。它与 review manifest、Node reference run 和
translation artifact 共享 graph revision/std package identity，valid/invalid
结果分别进入显式 `ok/err` 分支。其余十项只通过 graph/API invocation contract
执行；WP-225 不增加 list/result literal、compact syntax、opcode、capability 或
effect。witness/package/cache/capability denial 与跨平台 evidence 由 WP-226 闭合。

WP-226 把 named parameters 先编码为
`re.minimal-std-parameter-witness@0.1.0`，再从 witness materialize 后执行。
witness 只接受 JSON-safe primitive、bytes hex、list 与按字段名排序的 record；
源对象必须是 own enumerable data descriptor，Proxy、accessor、symbol、稀疏数组
和额外字段均在执行前拒绝，且不得触发 getter。check、manifest、run、
translation 与 receipt 同时携带 witness 本体、witness digest、
`re.minimal-std-capability-manifest@0.1.0` 的空能力摘要，以及
`re.minimal-std-runtime-package@0.1.0` 摘要。translation replay 必须提供 exact
trusted checked authority；同步重签 changed witness 不能取得旧 invocation 权限。

std runtime package 固定 implementation identity
`re.minimal-std-subset@0.1.0`，绑定 frozen ABI package 与空 capability digest。
Module schema 不变：使用现有 external dependency 的 std Module interface digest
与 runtime package digest 作为 cache key authority。正式 50/500 Module
conformance 要求 cold 全 miss、warm 全 hit、单 implementation 变更仅一项 miss、
runtime package drift 全 miss。该证据仍由 Node 装载，不是独立 VM 或
native/WASM/AOT/production backend。

WP-227 不把 std operation 降成新 bytecode opcode。受信 Node adapter 使用
`re.portable-vm-std-request@0.1.0` 接收 invocation、checked、translation 与
receipt，并从 invocation 重新执行 frozen check/translate/reference operation；
四份 authority exact 相同才生成不可复制的 admission。执行结果使用
`re.portable-vm-std-result@0.1.0` 回绑 request digest 和原
`re.minimal-std-operation-receipt@0.1.0`。12 个 workload 覆盖全部 11 个
operation、valid/invalid UTF-8 与 generic list/result；caller 即使同步重签
changed authority 也不能绕过重建。正式 conformance 绑定 std ABI/runtime/
capability digest 与 `portable-vm-core.js` source digest；core 仍只有既有四指令。

- Bounded stream/channel 不进入 V1 Core；首个 Server profile 使用显式大小上限的 bytes/list 与分页，禁止无界默认队列。

### Native developer gate

WP-286 增加 `re.native-developer-gate@0.1.0` 与
`developer-gate <project> <module> <input-digest> <report>`，作为仓库外项目和 CI
的最小 native conformance 入口。Gate 先用当前 binary 在空 `PATH`、清空环境的
fresh child processes 中重新执行 `project-check`、全模块 `project-test`、两个不同
临时目录的 cold `project-build`、`project-translate` 和 `project-run`。它只接受每个
阶段真实 stdout/exit/stderr 成功，读取实际发布的 `build.json`，并对两个 workspace
的完整 cache/build inventory 做 canonical path + bytes digest 比较；不使用 caller
expected outcome、同进程 build 对象或 Node。

成功报告为 canonical JSON，包含 project/graph/module/input/profile/toolchain authority、
各阶段 stdout digest、两份 build manifest/tree digest 和 `report_digest`，不包含本机
路径、临时目录或 `elapsed_ns`。报告不能写进 project 目录，否则会成为未登记文件并
污染下一次 project authority；该路径在 gate effect 前 fail closed。当前 gate 仍只覆盖
Darwin arm64 bounded single-Module/four-instruction native slice，不能推导完整多函数
lowering、通用测试框架、跨平台性能资格、production backend 或 Stable V1.0。

### Native standalone toolchain gate

WP-287 增加 `re.native-toolchain-gate@0.1.0` 与
`toolchain-gate <source> <project> <module> <input-digest> <report>`。Gate 先独立加载
direct source 与 project module，要求两者产生 exact canonical graph 和 graph
revision；这阻止 direct 示例通过但 project 实际运行另一张图的静默分叉。

同一个 native `revia` binary 随后在空 `PATH`、清空环境和 fresh child processes 中
执行 direct `check`、`canonical`、`translate`、`compile`、`verify`、`run`，并调用
WP-286 `developer-gate` 完成 project check/test、双目录 cold build、translate/run
链。`translate` stdout 必须与 `compile` 写出的 artifact 逐字节相同；该 artifact
必须再由独立 `verify` 和 `run` 消费。developer report 文件必须与 child stdout
逐字节相同，任何 stage failure 或 stderr 均使总 gate 失败且不写最终 report。

成功报告只记录 binary/source/project/graph/module/input/profile/toolchain authority、
静态 Node/JS dependency scan、各阶段 digest、debug/release 边界与 report digest；
不记录本机路径、临时目录、计时或 caller expected outcome。报告路径落入 project、
direct/project semantic mismatch、canonical drift、artifact drift、developer report
drift、project authority drift 或写入失败均 fail closed。当前证据只支持 Darwin
arm64 bounded native translator/executor/project workflow，不外推完整多函数 lowering、
独立 scheduler、未实测平台、跨语言性能资格、production backend 或 Stable V1.0。

## 7. 确定性回放（占位）

由于副作用全显式 + 能力全声明，RE 程序天然可「录制 effect 节点的入参 + 外部响应 → 回放」：

- 录制：执行时捕获每个 effect 节点的入参与外部响应（外部响应需 capability 提供 mock/录制支持）。
- 回放：替换 effect 的外部响应为录制值，纯节点正常求值，验证可观察行为一致。
- 这与上层「请求回放」项目**精神相通但实现独立**，不在 RE v1 必须项内，作为语义红利记录。

## 8. 执行的安全边界

- 执行器以 `cap` 声明的最小能力集运行；超能力操作直接拒绝（运行时 + audit 双重）。
- 涉及外部能力的节点，在测试/只读环境以 mock 或只读 capability 提供，禁止真实副作用——除非显式 `cap` 授予。

### WP-283 · native release evidence expansion

增加 `re.native-release-evidence@0.3.0` 与
`release-evidence-gate <source> <project> <module> <fault-corpus> <evidence>`。
该 gate 只接受真实 release 编译的 native binary，并在空 `PATH`、清空环境和隔离
工作目录中复跑 node-free workload、fault corpus 与两个独立的 `project-build`
子进程。两个 build 分别使用新的 cache/build 目录；gate 读取实际发布的
`build.json` 和完整 cache/build tree，要求 manifest 与 tree digest 都逐字节相等，
不能用同进程内存对象或同步重签替代 fresh-process 证据。

Evidence 固定绑定 binary、toolchain、source/project inventory、project digest、
node-free stable/workload、fault corpus/report/stable、deterministic build 和统一
comparison fixture。comparison 顺序固定为 `native`、`node`、`go`、`jvm`；当前只把
同一 native workload 标为 `measured`，Node 仅为迁移 oracle，Go/JVM 为 `pending`，
不得复制 native digest 或同步重签后晋级。输出使用 canonical JSON、不含本机路径，
stdout 与 evidence 文件必须 exact；debug binary、authority drift、build 漂移和
写入失败均 fail closed。

当前实测为 Darwin arm64 bounded single-Module/four-instruction slice；该 evidence
扩展不代表完整多函数 lowering、真实 scheduler、跨平台 runner、独立 signer/custody、
production backend 或 Stable V1.0。

WP-290 将可移动 bundle comparison 纳入同一 release gate。release binary 在空 `PATH` 的
fresh child process 中重新执行 `bundle-comparison`，要求 report 文件与 stdout exact、
catalog/project authority exact、`re.native-runtime-bundle-comparison@0.1.0` report
canonical 且 self-digest 有效；生成的 `re.native-release-evidence@0.3.0` 额外绑定
`bundle_comparison_schema` 与 `bundle_comparison_report_digest`。缺少 bundle 运行、报告
漂移、schema/report digest drift 或同步重签均不得写出 release evidence。

WP-295 将 project capability comparison 纳入同一 release gate。gate 在清空环境、空
`PATH` 和 fresh child processes 中重新构造固定 project capability catalog/project
manifest，两次调用 `capability-project-comparison`，并逐项核对 project capability
schema、catalog digest、project digest、report self-digest、stdout/file bytes 和重复
输出。`re.native-release-evidence@0.4.0` 绑定
`project_capability_schema`、`project_capability_catalog_digest`、
`project_capability_project_digest` 与 `project_capability_report_digest`；debug binary、
fixture/project/report drift、路径泄漏、非 canonical output、同步重签和 partial write
均 fail closed。新增必需字段属于不兼容 evidence 协议升级，因此不能沿用
`re.native-release-evidence@0.3.0`。当前仍只证明 Darwin arm64 bounded native
project/capability slice，不代表跨平台 runner、签名/custody、production backend 或
Stable V1.0。

### Native movable offline runtime bundle

WP-288 增加 `re.native-runtime-bundle@0.1.0`、`runtime-package <source> <bundle>` 和
`runtime-run <bundle> <input-digest> <sandbox>`。package 只接受当前 graph/check 与
verified bytecode artifact authority，写出 canonical JSON bundle，内容包括 canonical
source、source digest、graph revision、artifact、artifact digest、profile/release/
translator authority 和 bundle digest。bundle 不保存输入路径、sandbox、计时样本或
expected outcome；显式 sandbox 是每次运行的宿主输入。

`runtime-run` 不信任 bundle 中的 graph/artifact 声明：它先做 canonical JSON round-trip，
从 canonical source 重建 checked graph，从 artifact 重建并验证 bytecode，再核对 graph
revision、artifact digest、profile/release/translator 和 bundle digest，最后才创建
`SystemHost` 并复用现有 native VM。input digest 在 host 初始化前校验；sandbox 必须是
已存在的真实目录，最终 symlink 或普通文件均拒绝。运行结果和程序 stdout 与显式
source + artifact `run` 逐字节相同，bundle 移动到其他目录不改变结果。

`runtime-verify <bundle>` 复用同一 `verify_runtime_bundle` authority，只做上述离线校验并
输出 `re.native-runtime-bundle-verification@0.1.0` 的 canonical、path-free 摘要。它不需要
input digest 或 sandbox，不创建 host bridge，不产生程序 stdout、文件写入或其他 effect；
重复运行必须逐字节相同，损坏和同步重签 bundle 在输出前 fail closed。

当前证据覆盖 Darwin arm64 的 bounded single-Module/four-instruction slice。该 bundle
是可移动、可离线验证的 native runtime artifact，不是发行仓库 release package，不等于
完整多函数 lowering、独立 scheduler、签名/custody、公证、跨平台 runner、production
backend 或 Stable V1.0；Node 继续只作迁移期 oracle。

### Native runtime bundle comparison gate

WP-289 增加 `re.native-runtime-bundle-comparison@0.1.0` 与
`bundle-comparison <catalog> <project> <output>`。该 gate 从同一 canonical comparison
catalog 逐 workload 重新生成 bundle，在空 `PATH` 的 fresh native child process 中执行
`runtime-package`、离线 bundle verification 和适用的 `runtime-run`，不接受 caller 提供的
expected result、bundle digest 或 project authority 作为事实来源。

`success` 由 bundle `runtime-run` 与 direct native source/artifact execution 逐字节比较
stdout/result；`project-workflow` 不得用 direct execution 代替项目 authority，而由 WP-292
在 fresh child 中依次执行真实 `project-build`、`project-translate`、`project-run`，将
project/module/build/translation/graph/artifact/input/receipt/outcome authority 与 bundle
`runtime-run` 的 canonical result exact 对齐，报告同时保存完整 `project_run` authority，
并明确区分 bytecode artifact digest 与 bundle envelope digest。两类成功 workload 均报告
`execution_mode=executed`；`closed-error`
与 `host-boundary` 当前只验证 bundle package/offline authority，因真实 `SystemHost` 不
能表达 catalog 注入的 replay fault，报告明确标为 `execution_mode=verified-only`，不伪造
成功 receipt。报告为 canonical、path-free、自带 digest 的 JSON；schema round-trip、同一
catalog 的两次 fresh run、project digest drift、report-in-project 和 authority mismatch
均有 fail-closed 回归。

该 gate 只证明当前 Darwin arm64 bounded single-Module/four-instruction slice 的 bundle
与 native comparison authority 一致，不代表完整 fault host、独立 scheduler、跨平台
runner、production backend 或 Stable V1.0。Node 仍只作迁移期 oracle，Go/JVM/其他后端
没有真实运行证据时继续保持 `pending`。
