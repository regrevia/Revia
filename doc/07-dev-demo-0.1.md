# RE Dev Demo 0.1 冻结基线

本文档冻结的是**可供 Agent 开始开发的内部 Demo 版本**，不是完整的 RE V1 语言规范。Demo 的目标是验证：

- Agent 能否用 RE 写出简单的单文件程序；
- `re check` 能否快速发现类型、参数、能力和错误消费问题；
- `re run` 能否执行纯计算与受限文件/终端 I/O；
- `re audit` 能否输出机器可审计的 capability、effect 和错误路径摘要；
- `re view` 能否在 audit 基础上把程序翻译成人类可审计的摘要；
- 修改后，错误能否定位到具体文件、函数、节点和规则编号。

## 1. 版本标识

- Demo 名称：`RE Dev Demo 0.1`
- 文件头：第一物理行精确写 `re 0.1 compact` 或 `re 0.1 canonical`
- 源文件：严格 UTF-8、禁止 BOM；非法序列不得用 U+FFFD 静默替换
- 工作方式：单文件、单 unit、命令行执行
- 当前目标：本地开发验证，不承诺兼容性、性能或生产安全性
- 稳定范围：本文第 2–6 节
- 非稳定范围：并发运行时、完整 canonical lowering、A2A、native/WASM 后端、形式化证明

## 2. Demo 支持的语言子集

### 2.1 顶层结构

语言设计子集包含 `unit`、`cap`、`fn`、`op` 和 `effect`。当前可执行 slice 已实现 `unit`、`cap`、入口 `fn`、字面量、call、`let`、`return` 与 `result` match，并可到达 stdout、process args 和单路径 UTF-8 file read；尚未实现的节点族必须给出稳定拒绝诊断，不得被当成已执行。

Demo 先限制为单文件、单 `unit`。跨文件 import、package、schema registry 暂不支持。

### 2.2 类型

Demo 内置：

- `unit`
- `bool`
- `int`
- `text.utf8`
- `bytes`
- 命名类型
- 参数化 `list<T>`
- `result<T, E>`

不支持用户自定义 sum、trait、泛型推导、浮点和隐式类型转换。当前 Demo
parser、checked graph 与 canonical 对 `int` 使用任意精度有符号规范十进制
字符串，不经 IEEE 754 解码。有限宿主 operation 必须自行精确验界；
`process.exit` 只接受 `0..255`，并只在通过 `BigInt` 范围检查后转换为宿主
`Number`。Decimal literal 已以 `decimal<scale>` + 规范字符串进入 parser、
checked graph 与 canonical，但当前没有消费 decimal 的 Demo operation；不得隐式转
int。Decimal arithmetic/rescale、定点业务 operation 和分数仍不在当前 executable
slice。

### 2.3 表达式和控制流

Demo 0.1 必须支持字面量、命名参数调用、单一 `primary` 参数的裸参数简写、`%name = expr`、`return expr` 和 `match` 消解 `result<T,E>`。

`loop(state)`、`next(state)`、`done(value)` 先纳入静态检查。执行器第一阶段可以只执行直线代码和 `match`；不能执行的语法必须由 `re check` 明确报告，不得静默当作普通表达式。

`par`、`join` 可以被检查器识别并报告资源规则，但不列入第一版执行器的可运行范围。

### 2.4 错误规则

- `result<T,E> = ok(T) | err(E)`；
- 所有 `result` 必须被 `match`、传递或 `return` 消费；
- `after:` 只建立顺序，不消费结果；
- `?` 和 `handle` 不进入 Demo 0.1；
- 不使用异常、隐式跳转或隐式错误转换。

## 3. Demo schema 最小契约

```re
op @text.trim_left {
  param input: text.utf8 primary
  param charset: text.utf8 = " "
  returns text.utf8
}

effect @fs.read_file on fs.read {
  param path: fs.path primary
  param encoding: text.encoding = text.encoding.utf8
  returns result<text.utf8, fs.read_error>
  access read fs.file(path)
}
```

规则：

- 参数按名字识别，同一 op 内不得重名；
- `primary` 只能有零个或一个；
- 只有 `primary` 存在时才允许裸参数；
- `returns` 是结果类型唯一来源；
- 无业务载荷使用 `unit`；
- 不设通用 `receipt<R>`；
- 可审计响应使用普通命名类型；
- effect 使用 `access read|write resource-expr` 声明资源；
- resource expression 只能引用纯构造器、声明参数和规范字面量；
- Demo 暂只区分 `read` 和 `write`；
- 动态资源无法证明不重叠时，按冲突处理。

## 4. Demo CLI 契约

```text
re check <file.re>
re check --format json <file.re>
re check --write <file.re>
re run [--format json] [--runtime-receipt] <file.re> [-- <args>...]
re manifest <file.re>
re patch --patch <patch.json> <file.re>
re audit --format json <file.re>
re view [--locale zh-CN|en-US] [--format html|svg] <file.re>
re build --out <dir> <file.re>
re module-surface --manifest <manifest.json> <file.re>
re review-index [--changed-since <revision>] [--cursor <cursor>] [--limit <n>] <file.re>
re profile <file.re>
re translate --format json <file.re>
re project-translate [--locale zh-CN|en-US] [--format json|text|html|svg] <project-dir>
```

- `re check`：解析、类型检查、能力检查、错误消费检查、schema 检查；
- `re check --format json`：输出确定的机器结果；成功和失败都只写 runner stdout，失败仍返回非零退出码；
- `re check --write`：检查通过后写回 canonical；
- `re run`：先执行 `check`，失败则不运行；本地 CLI 以输入 `.re` 文件所在目录的 real path 作为 file sandbox root，只把 `fs.read`/`fs.write` capability 绑定到 file adapter，process args/stdout 使用独立 adapter；`--format json` 输出稳定的 `re.run-result@0.1.0` envelope，统一承载 process status、check failure、host fault 和程序 stdout，默认文本模式不变。显式增加 `--runtime-receipt` 时输出 `re.run-result@0.2.0` 和独立 HostEnvironment invocation receipt；receipt 只证明 validated adapter response，不是外部副作用证明，并可能包含敏感实参/响应；
- `re manifest`：输出绑定 graph revision 的机器 Review manifest；
- `re patch`：只对 canonical 输入应用 revision-pinned structured patch，失败原子回滚；
- `re audit --format json`：静态输出 capability、effect、错误路径和 status code 摘要，不调用 adapter；
- `re view`：基于 audit / Semantic View IR 输出当前 Demo 支持的能力、effect、错误路径和 status code 文本摘要；默认 `zh-CN`，`--locale en-US` 输出同一 fact 集的英文摘要，`--format html` 输出同一 fact 集的 deterministic HTML 审阅页，`--format svg` 输出绑定 fact/evidence 的 deterministic SVG 审阅图；
- `re build --out <dir>`：生成 deterministic `program.re`、`manifest.json`、`release-lock.json`、`semantic-view.json`、`review-index.json`、`checksums.sha256` 和内嵌 checked graph 的 self-contained Node Demo runtime；manifest 绑定 graph revision、source digest、target profile、Module interface digest、required capabilities、离线审阅摘要与 preview release lock 摘要，并与 release lock 共享 `re.preview-build-key@0.1.0` canonical SHA-256；build key 不包含 file/out_dir/private path。runtime 在任何程序 effect 前要求 checksum 清单精确覆盖六个 artifact 文件并逐文件验证 SHA-256，再核对 manifest 的 build/release-lock 身份及 release lock schema/build key/graph/runtime/profile；缺失、Malformed 或 mismatch 均以 host-fault 退出且不产生程序副作用。该门只提供 artifact 内部一致性，不是签名或外部信任根；写入失败不留下半成品；
- `re module-surface --manifest <manifest.json> <file.re>`：读取 revision-pinned `re.package-manifest@0.1.0`，将现有 exact-pin Module surface lowering 接入稳定的 `re.module-surface-result@0.1.0` JSON envelope；成功结果绑定 Module interface、interface digest 与 package manifest digest。manifest/source 不可读、非法 JSON、缺失或过期 import pin、未知 export 和未支持 surface construct 均返回 JSON diagnostic、exit 65；该命令不生成 implementation graph、不执行 capability，也不修改输入文件；
- `re review-index`：输出 deterministic project review index JSON，绑定 graph revision、module interface digest、index revision 与稳定 fact ID，支持 cursor、`changed-since` 和 limit；提供 `--fact-id <id> --index-revision <revision>` 时只展开一个 revision-pinned、有 UID evidence 的 bounded fact detail，缺少任一锚点或 stale/unknown 锚点均以 JSON diagnostic 失败；
- `re profile`：输出 `re.profile-result@0.1.0` JSON envelope；成功时包含 path-free `re.profile-descriptor@0.1.0`，绑定 checked graph revision、Module interface digest、preview target/runtime、完整八项 workload/required-axis 计划：`cpu-pure-graph`、`json-http`、`db-transaction`、`task-10k`、`task-100k`、`module-50-clean-incremental`、`module-500-clean-incremental`、`module-5000-clean-incremental`，以及 `aot-llvm`、`cranelift`、`go-lowering`、`jvm-bytecode`、`node-reference` 五项待测 candidate。`benchmark_profile_digest` 由 `re.benchmark-profile@0.1.0` 的 candidate/workload canonical bytes 计算，不绑定输入路径或 graph identity。`node-reference` 仅为 semantic reference，其余 candidate 不代表已选 backend。`measurement_status` 固定为 `not-run`；该命令不执行计时、不填充测量值、不选择 production backend；
- `re translate --format json`：将 checked graph 投影为 `re.execution-artifact@0.1.0`，绑定 canonical bytes/digest、graph revision、unit、`node-demo-reference` runtime 与 `node-demo-translator@0.1.0` target profile；复合 `artifact_sha256` 对 graph/runtime/profile 变化敏感，compact 同源换绝对路径仍产生相同 artifact。该命令不执行 capability、不生成 production backend、不修改输入；source/check/unsupported graph failure 均以 `re.translation-result@0.1.0` + exit 65 fail closed；
- `src/toolchain/portable-executor.js`：提供无 Node builtin/host adapter import 的最小 checked-graph 求值核心；Node reference evaluator 通过唯一显式 capability bridge 复用该核心。`re.portable-executor-contract@0.1.0` 绑定 executor/profile/graph/input，`re.portable-execution-result@0.1.0` 与独立 receipt 快照锁定 outcome 和 capability invocation 摘要；私有 opaque evidence 还冻结调用参数与完整 response payload，用独立 graph 重放完整 outcome。当前它仍由 Node 测试/CLI 装载，不是独立 native runtime 或 production backend；
- `src/toolchain/portable-conformance.js` + `test/fixtures/portable-conformance.json`：提供 9-case backend-neutral semantic oracle，覆盖 stdout/args/read/write 的成功和声明错误、named arguments、bytes 与 receipt/invocation 漂移拒绝；同一 case 同时经 portable core 与 Node reference host binding 差分，不扩展 Demo 语法或宣称 native backend；
- `src/toolchain/portable-conformance-matrix.js`：提供跨 Node/OS 的 matrix、run receipt 与 evidence validator；matrix 独立固定 bundle/toolchain、portable、tracked tests、grammar fuzz 与 public candidate authority，每个真实 runner 只能提交 exact environment receipt，聚合时先验证既有 evidence、只替换当前环境并保留其他 receipt，完整 tracked suite 通过后才原子提交。当前 toolchain authority 已重新实测 macOS arm64 / Node 24；Darwin Node 22 与 Linux Node 22/24 保持 pending，旧 toolchain receipt 不复制或重签；
- release hard gate 对已验证 evidence 要求至少一份 measured receipt，但不要求执行普通测试的当前主机已经 measured；当前 runtime 是否属于 matrix 只在生成新 receipt 的 private runner 中 exact 校验。该规则允许 pending runner 先完成 suite，不会把 all-pending 或 undeclared runtime 当成通过；
- `src/toolchain/portable-bytecode.js` + `portable-bytecode-core.js`：把 9-case 已冻结的 checked graph slice deterministic lowering 为 capability invoke/result branch/process exit 四指令 artifact；wrapper 必须从可信 checked graph 重编译并 exact 比较 artifact，expected artifact digest 仅作附加一致性检查，拒绝同步重签的 literal/argument/opcode/jump/register 漂移和额外 statement/function，零 import core 只执行该重编译 artifact 并经显式 capability bridge 执行。正式 conformance 要求 bytecode、portable core、Node reference 三方 outcome/receipt 等价；这仍是 Node 装载的 JS 最小解释器，不是独立 VM 或 native backend；
- `src/toolchain/portable-bytecode-process.js` + `portable-bytecode-process-worker.js`：把可信 checked graph、canonical artifact、digest 与完整 scripted capability invocation 固定为有摘要的 exact request；父进程先本地重放 expected result，再用 `process.execPath`、无 shell、有界单行 JSON 和 timeout 启动 Node worker，只接受 canonical exact 相同的 child result。字段/digest/identity/arguments/order、缺失/重复 invocation、malformed/超大 JSON、提前退出、timeout 与伪造输出均 fail closed并回收 child。正式 9-case oracle 现包含 Node 子进程路径；这不是独立 binary、跨进程签名、完整 VM 或 production backend；
- `src/toolchain/portable-fault-protocol.js` + `test/fixtures/portable-fault-protocol.json`：把 core/bytecode/process 的 13 个既有 fault 场景冻结为 deterministic request/error/ordered trace authority；preflight rejection 不启动 child，spawn fault 无 close，已启动 child 的 timeout/超限必须 kill+close，malformed/multi-line/forged output 均拒绝。verifier 从可信 graph/artifact/transcript 或受控 child fixture 重跑，不接受同步重签；这仍是同机 Node child protocol，不是敌对进程隔离、物理 watchdog 或 native backend；
- `src/toolchain/portable-runtime-abi.js` + `test/fixtures/portable-runtime-abi.json`：把 9-case execution、13-case fault 与 14-case task lifecycle 固定成未来 portable VM 的三域 versioned ABI authority；report 每域回绑既有可信 oracle 的 exact request/result/receipt，且同步重签嵌套 report 仍由重新执行拒绝。当前是 Node reference oracle 的冻结协议，不是独立 VM、native/AOT/WASM 或 production backend；
- `src/toolchain/portable-vm-core.js` + `src/toolchain/portable-vm.js`：最小 VM core 不导入 Node builtin、host adapter 或 toolchain，只消费已准入的四指令 artifact 与 WP-221 execution request；受信 adapter 每次从 checked graph 重建 artifact、校验 request/graph/artifact identity，并以 9-case Node oracle conformance 约束 outcome/receipt。fault/task lifecycle 只是冻结 ABI 域，不是此 core 的执行能力；它仍由 Node 装载，不是独立 VM、native/AOT/WASM 或 production backend；
- `src/toolchain/backend-feasibility.js` + `release/backend-feasibility-report.json`：固定 WASM、LLVM AOT、Cranelift 的 graph identity、semantic oracle、memory contract、release lock、target toolchain/runtime 六项 probe；probe 只能是 external runner provenance 绑定的 `reported` 或明确 `pending`，禁止 artifact、metrics、pass 与 eligibility 字段。当前仅 `aot-llvm` 由 WP-228 真实 evidence 报告六项 probe，WASM/Cranelift 保持 pending；
- `src/toolchain/llvm-aot-external-evidence.js` + `release/llvm-aot-external-evidence.json`：从 trusted graph 重编译四指令 artifact，用真实 `/usr/bin/clang` 无 shell生成 Darwin arm64 executable；executable 自行核对 transcript invocation/arguments、执行 result branch，并输出 9-case outcome/receipt。evidence 绑定 compiler bytes/version、target、host provenance、source/executable/stdout 与 request/artifact identity；build/run 时钟样本只进入 evidence digest，不进入 stable digest。该 slice 尚未执行 fault/task lifecycle 或 minimal std，也不是完整独立 VM、WASM/Cranelift、production backend 或 Stable V1.0；
- `src/toolchain/portable-runtime-package.js` + `release/portable-runtime-package*.json`：将已验证 LLVM AOT slice 封装为 canonical JSON source archive；18 个 allowlisted 条目仅含 C core/header、9 个 generated C driver、冻结 ABI、许可证和 metadata。manifest 逐文件、tree、release/ABI authority、target 和 pending digest-pin；verifier 从权威输入重建并拒绝重排、path escape、symlink、authority 漂移和伪造 `eligible` claim。conformance 以真实 `/usr/bin/clang` 编译和重编译九例，结果与 Node reference/LLVM evidence exact；这不是完整独立 VM、fault/task native、minimal std native、WASM/Cranelift、Linux/Windows 或 production backend；
- `src/toolchain/external-runner-matrix.js` + `release/external-runner-matrix*.json`：以 probe→challenge request→receipt→matrix 固定离线 runner handoff。request 从外部绑定 package/release/toolchain、exact runner 与 23-case authority；runner 只编译 package source，不读取 expected；collector 拒绝 stale request、跨 request replay、target/provenance/result/metric/workload 同步重签。当前真实 receipt 覆盖 Darwin arm64 / Apple Clang 21 与同机只读断网 Docker `linux/amd64` / Clang 14；WASM/Cranelift、独立物理机 custody与跨平台性能继续 pending；
- `src/toolchain/minimal-std-abi.js` + `minimal-std-subset.js` + `minimal-std-cache.js`：冻结并执行四个 std Module 的 11 个 pure operation。参数先成为 JSON-safe inert witness，Proxy/accessor/sparse 输入 fail closed 且不执行 getter；check/manifest/run/translate/receipt 同时绑定 ABI、witness、空 capability 与 runtime package digest，translation 只相对 trusted checked authority 重放。现有 external dependency cache key 对 50/500 Module 证明 warm hit、单 implementation isolation 与 runtime drift 全失效。canonical `.re` 仍只接入 `std.bytes.decode_utf8`，没有新增 Module schema、list/result literal、opcode 或 capability；
- `src/toolchain/portable-vm-std.js`：受信 adapter 从 std invocation 重建 checked/translation/Node receipt，再核对 digest-bound caller request；12 workload 覆盖全部 11 operation 与 invalid UTF-8，结果回绑原 receipt。它绑定但不修改 `portable-vm-core.js`，不新增 opcode、语法或 host capability；
- `re project-translate`：加载 revision-pinned project graph，经 fact ledger 与 Semantic View IR 生成 `re.project-translation@0.1.0`；JSON 同时携带完整 facts、UID/evidence anchors、semantic digest 与 text/HTML/SVG rendering，非 JSON format 只输出对应 rendering。缺少 project/module/Agent event-transition/task/capability/resource/error/execution-order 任一类别、digest mismatch、未知模板或非法 revision 均 exit 65；不执行 capability、secret、task 或 runtime；
- `test/agent-expense-review-e2e.test.js`：以六模块 `test/fixtures/agent-expense-review/` 为 checked source，补齐 graph-level expense facts 后验证 project patch、human translation、retry/replay/cancel 与 bounded concurrency audit 的共同 graph revision。该测试是 Agent-project candidate 证据，不替代 WP-168 的 production backend/release 证明；
- 诊断至少包含稳定 code、文件、行列、函数、规则编号和错误节点 label/UID（如果已有）；参数错误还应包含 actual/expected、member 与 pinned schema reference。能由一个根因解释的错误不得同时产生派生 missing/unknown 噪声。

## 5. Demo 内置宿主操作

为便于第一个 Agent 开发，Demo 暂固定以下 capability effect：

```text
process.args.read       -> result<list<text.utf8>, process.args_error>
fs.read.read_file       -> result<text.utf8, fs.read_error>
fs.write.write_file     -> result<unit, fs.write_error>
process.stdout.write    -> result<unit, io.write_error>
```

以上 effect 必须通过固定 revision 的 `cap` instance 调用。`process.exit(process.exit_code) -> process.status` 是纯 op，不要求 capability，也不会在求值时提前终止进程；宿主只在 `@main` 返回后映射 status。精确 revision、解析链、host fault 与 adapter 规则见 [08-demo-host-contract-0.1.md](08-demo-host-contract-0.1.md)。真实权限、沙箱和平台适配属于 Demo 宿主层，不属于语言语义。

## 6. 验收任务

Demo 0.1 至少通过：

1. Hello World：写 stdout 并正常退出；
2. 参数回显：读取命令行参数并输出；
3. 文件转换：读取 UTF-8 文件、做纯文本转换、写入目标文件；
4. 参数错误：缺少参数时返回明确错误；
5. 文件错误：输入不存在或无权限时通过 `match` 输出错误并返回非零状态；
6. 修改定位：把一个参数类型改错后，诊断能定位到具体调用和规则。

## 7. 明确不承诺

Demo 0.1 不承诺 native/WASM、跨文件项目、`par` 真实并行、A2A、完整 canonical structural 文本、`?`、`handle`、用户自定义 sum、第三方生态和长期语法兼容。

## 8. 冻结解除条件

只有在验收任务无法表达、`re check` 无法发现高风险错误、程序无法确定性执行，或 Agent 连续三次在同一规则上生成错误时，才修改本基线。任何修改必须记录为新的 Demo 版本，不直接改写 `0.1` 的既有语义。

2026-07-28 澄清：§5 将 effect 与纯 status 构造器分类，并由独立宿主契约补足 revision/binding seam；这不扩大 §2 的语言子集。
