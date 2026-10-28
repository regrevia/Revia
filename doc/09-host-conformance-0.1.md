# RE Dev Demo 0.1 · Host conformance

本文把 [08-demo-host-contract-0.1.md](08-demo-host-contract-0.1.md) 变成可直接实现的 P0 测试契约。测试只穿过 schema registry 与 host adapter 的公开 seam，不断言内部缓存、类名、传输帧或文件布局。

## 1. 两个最小 interface

### 1.1 Schema registry

```text
load(sequence<capability-interface-definition>)
  -> result<schema-registry, list<registry-diagnostic>>

resolve(schema-reference)
  -> result<capability-interface, missing-schema-revision>
```

P0 不提供 `latest`、版本范围、网络下载或运行中 `register`。`load` 是一次性批处理：实现必须先验证全部定义，再原子地产生 registry；任一错误都不得留下部分可用 registry。

加载规则：

1. definition 先转为 schema canonical bytes，再以 `(identity, revision)` 分组；输入顺序不得改变结果。
2. 同一 key 只有一组 canonical bytes时接受；完全相同的重复输入幂等去重。
3. 同一 key 出现不同 canonical bytes 时，整个 `load` 返回 `schema-revision-conflict`，诊断列出 key 与来源标识，但不任选其一。
4. member 名在同一 interface 内唯一；参数名在同一 member 内唯一；`primary` 为零或一个；`returns`、`access` 与类型引用必须通过 schema validation，否则返回 `invalid-schema-definition`。
5. `resolve` 只接受精确 reference。仅存在更高或更低 revision 仍返回 `missing-schema-revision`，禁止自动 fallback。
6. registry 只保存契约，不保存 capability instance、host binding、endpoint、凭据或 adapter 状态。

### 1.2 Host adapter

```text
supported_interfaces() -> set<schema-reference>

invoke(operation-reference, typed-arguments, invocation-id)
  -> adapter-outcome<typed-value>
```

`operation-reference` 由 pinned interface reference 与 member 名组成。`adapter-outcome<T>` 是宿主 seam 的 `value(T) | host-fault`，不是 RE 程序可声明的类型。

运行器负责：

1. 把 capability instance 唯一绑定到一个声明支持完全相同 reference 的 adapter；
2. 从 registry 取得 member schema，并在调用前验证命名实参；
3. 验证 adapter 返回值精确符合 `returns`；
4. 把声明内的预期失败保留为 `err(E)`，把无法履约的失败标为 host fault；
5. 不向 adapter 暴露 interface 之外的 member，也不让 adapter 改写 footprint。

P0 至少有本地/沙箱 adapter 与内存测试 adapter 两种实现，因此该 seam 同时是生产调用面和 conformance test surface。

## 2. 诊断与 fault code

| Code | Phase | 含义 |
|---|---|---|
| `invalid-schema-definition` | registry load | definition 自身不满足 schema 规则 |
| `schema-revision-conflict` | registry load | 同一 identity/revision 对应多个不同定义 |
| `missing-schema-revision` | check/resolve | 精确 reference 不存在；不做版本 fallback |
| `missing-host-binding` | pre-run binding | capability instance 没有 adapter |
| `ambiguous-host-binding` | pre-run binding | capability instance 同时匹配多个 binding |
| `adapter-interface-mismatch` | pre-run binding | adapter 不声明支持 pinned reference |
| `unknown-capability-instance` | check | call 引用了未声明 instance |
| `unknown-capability-member` | check | pinned interface 中不存在该 member |
| `host-contract-violation` | invoke | adapter/transport 无法产出契约允许的 typed outcome |

`host-contract-violation` 的稳定 reason 最少包括：

- `return-type-mismatch`
- `undeclared-error-variant`
- `malformed-protocol-payload`
- `adapter-panicked`

自由文本和底层异常只作为受净化的非稳定 `detail`；测试与 Agent 不得依赖它，也不得在其中输出 endpoint、凭据或原始敏感 payload。

## 3. 三类语义结果的位置

| 概念 | 所在层 | 是否 `re run` 顶层 outcome | 机器表示 |
|---|---|---:|---|
| Program error | program graph | 否 | operation 的 typed `err(E)` 值；由 `match`、传递或 `return` 消费 |
| Process status | program/runner seam | 是 | `outcome.kind = "process-status"` 与 `status.code` |
| Host fault | host seam | 是 | `outcome.kind = "host-fault"` 与稳定 fault code/reason |
| Check failure | toolchain | 是 | `outcome.kind = "check-failure"` 与 diagnostics |

Program error 不是未捕获异常，也不是隐含进程结果。Demo 的 `@main() -> process.status` 要求程序把每条实际错误路径显式映射成 status；一个 `err(E)` 被恢复后，`re run` 的顶层结果仍只有最终 status。

## 4. `re run --format json`

JSON 模式向 runner stdout 写一个 UTF-8 JSON object 加换行；程序的 `process.stdout` 被捕获到 `program_stdout`，不得与 envelope 字节混写。对象 key 按 UTF-8 bytewise 排序，数组按下述规则排序，保证相同输入产生 byte-identical 输出。下列示例为阅读而缩进；实际 wire bytes 单行、无非必要空白，非 ASCII 字符直接使用 UTF-8，JSON 必须转义的字符使用最短合法转义，整数不带正号或前导零。

正常或程序决定的非零退出：

```json
{
  "outcome": {
    "kind": "process-status",
    "status": { "code": 1 }
  },
  "program_stdout": "ready\n",
  "schema": "re.run-result@0.1.0"
}
```

Host fault：

```json
{
  "outcome": {
    "fault": {
      "capability_instance": "@input",
      "capability_reference": "fs.read@0.1.0",
      "code": "host-contract-violation",
      "member": "read_file",
      "node_uid": "3kf2a2bc4de6fg7h2j4km6np7q",
      "phase": "invoke",
      "reason": "return-type-mismatch"
    },
    "kind": "host-fault"
  },
  "program_stdout": "",
  "schema": "re.run-result@0.1.0"
}
```

Check failure：

```json
{
  "outcome": {
    "diagnostics": [
      {
        "code": "missing-schema-revision",
        "column": 13,
        "file": "main.re",
        "line": 4,
        "reference": "fs.read@0.2.0"
      }
    ],
    "kind": "check-failure"
  },
  "program_stdout": "",
  "schema": "re.run-result@0.1.0"
}
```

`program_stdout` 包含 outcome 产生前所有已完成 stdout effect 的精确文本；后续 host fault 不得抹掉先前已经发生的输出。Diagnostics 依次按 `file`、`line`、`column`、`code` 排序。CLI 的宿主进程退出码可能与程序 status 数字碰撞；需要可靠区分时必须读取 JSON `outcome.kind`，不能只看 shell code。

### 4.1 `re build`

Preview build 的 artifact manifest 与 `release-lock.json` 必须声明同一 `build_key`。该值为 `re.preview-build-key@0.1.0` 对 executable grammar profile、graph revision、source digest、Module interface digest、target profile、runtime kind 与 toolchain implementation 的 canonical SHA-256；release lock 的 `language.grammar_profile`、`grammar` 与 `canonical_schema` 必须来自同一 production authority，不得混入输入文件名、输入目录、输出目录或机器私有路径。相同输入写入不同输出目录时 key 和 artifact bytes 必须稳定；精确 source bytes 或任一绑定身份变化时 key 必须变化。

Self-contained preview runtime 必须在执行任何 capability effect 前完成 artifact 内部一致性验证。`checksums.sha256` 的条目集合必须精确等于 `manifest.json`、`program.re`、`release-lock.json`、`review-index.json`、`run.mjs`、`semantic-view.json`，不得缺失、重复、Malformed 或包含未知文件，并须逐文件核对 SHA-256。随后 runtime 必须解析 manifest，核对其 `build_key` 与 runner 内嵌期望一致，且 `preview_release.release_lock` 的身份与摘要匹配实际 `release-lock.json`；最后核对 release lock 的 `re.release-lock@0.1.0`、`build_key`、canonical graph revision、runtime kind 与 target profile。任一文件缺失/不可读、非法 JSON、未知 schema、摘要或绑定不匹配都映射为 exit 70 host fault，程序 stdout 必须为空，`fs.write` 等 effect 不得发生。该门不提供签名或外部信任根；攻击者若可协调替换文件、checksum 和 runner，本门不构成真实性证明。

## 5. `re audit --format json`

Audit 不调用 adapter。其 JSON 最小字段为：

```json
{
  "capabilities": [
    {
      "binding_kind": "memory",
      "instance": "@stdout",
      "reference": "process.stdout@0.1.0"
    }
  ],
  "effects": [
    {
      "access": ["write process.stdout"],
      "capability_instance": "@stdout",
      "member": "write",
      "node_uid": "3kf2a2bc4de6fg7h2j4km6np7q",
      "result_consumers": ["7q2mxc2de4fg6h2j4km6np7r5q"],
      "returns": "result<unit, io.write_error>"
    }
  ],
  "error_paths": [
    {
      "consumer_uid": "7q2mxc2de4fg6h2j4km6np7r5q",
      "error_type": "io.write_error",
      "producer_uid": "3kf2a2bc4de6fg7h2j4km6np7q",
      "status_codes": [1]
    }
  ],
  "schema": "re.audit-result@0.1.0",
  "status_codes": [0, 1]
}
```

- capabilities 按 instance、effects 按 node UID、error paths 按 producer UID/error type/consumer UID 排序；status codes 数值升序且去重。
- 未提供 runtime binding 时 `binding_kind = "unbound"`；允许的稳定类别是 `local | memory | mcp | a2a | unbound`。
- 当前 Demo CLI 按内置 profile 把 `process.*` 归为 `memory`、`fs.*` 归为 `local`，但仍不得暴露 adapter 名、路径或 endpoint。
- Audit 可报告 adapter 类别，不得报告 adapter 名、endpoint、凭据、transport session 或环境变量。
- `error_paths` 是静态可能路径，不声称某个 `err(E)` 已在运行时发生。

## 6. `re review-index`

Project review index 不调用 adapter，也不成为第二份语义真源。它从 checked graph 的 Review manifest 投影稳定入口，输出 `re.project-review-index-result@0.1.0` envelope；成功时包含 `re.project-review-index@0.1.0`，并绑定 `graph_revision`、`module_interface_digest`、`index_revision`、稳定 `fact_id` 与 UID anchor。

- entries 按 `fact_id` 排序，分页 cursor 采用稳定 `offset:<n>`；
- `changed-since` 与 `index_revision` 比较；graph bytes 或 module interface digest 任一变化都会触发非空增量；
- `--limit` 只接受 `1..500` 的整数，非法 cursor、limit 或 stale 内核输入均 fail closed；
- CLI 读文件、UTF-8 decode 或 check 失败时仍输出 review-index JSON envelope 并返回非零退出码。

### 6.1 `re profile`

Profile preview 不调用 adapter、不执行 workload，也不产生 benchmark result。它输出 `re.profile-result@0.1.0` envelope；成功时包含 `re.profile-descriptor@0.1.0`，至少绑定：

- checked `graph_revision`；
- `module_interface_digest`；
- preview `target_profile` 与 runtime kind；
- 固定顺序的完整 workload ID 和每项 `required_axes`：`cpu-pure-graph`、`json-http`、`db-transaction`、`task-10k`、`task-100k`、`module-50-clean-incremental`、`module-500-clean-incremental`、`module-5000-clean-incremental`；
- 固定顺序的 candidate matrix：`aot-llvm`、`cranelift`、`go-lowering`、`jvm-bytecode` 为 `production-candidate`，`node-reference` 为 `semantic-reference`；candidate 只描述 bake-off 计划，不是 CLI backend 选择；
- `benchmark_profile_digest`：`re.benchmark-profile@0.1.0` 对上述 candidate/workload plan 的 canonical SHA-256；不得混入 file、graph revision、Module digest、target runtime 或测量数据；
- `measurement_status = "not-run"`。

Descriptor 自身不得包含输入文件名、输入目录、输出目录或机器私有路径。CLI envelope 可以保留用户传入的 `file` 用于诊断关联。读文件、UTF-8 decode 或 check 失败时仍输出 profile JSON envelope 并返回非零退出码。该 descriptor 只回答后续 runner 应测什么；它不是 `re.backend-bakeoff-report`，不能满足 production backend hard gate。

## 7. Registry 与 binding conformance 表

| ID | 输入/设置 | 期望 |
|---|---|---|
| `REG-001` | 四个 Demo interface，各一份合法 definition | load 成功；精确 resolve 全部成功 |
| `REG-002` | 同一 definition 重复两次 | 幂等去重；结果与单份输入 byte-identical |
| `REG-003` | definition 顺序反转 | registry 可观察结果不变 |
| `REG-004` | `fs.read@0.1.0` 同键但 member returns 不同 | 原子失败，`schema-revision-conflict` |
| `REG-005` | 只有 `fs.read@0.2.0`，请求 `0.1.0` | `missing-schema-revision`，不 fallback |
| `REG-006` | 同一 member 两个 `primary` 参数 | `invalid-schema-definition` |
| `BIND-001` | 每个 cap instance 恰有一个 exact-ref adapter | pre-run binding 成功 |
| `BIND-002` | `@input` 无 binding | `missing-host-binding`，不执行任何 effect |
| `BIND-003` | 两个 binding 同时选择 `@input` | `ambiguous-host-binding`，不按顺序任选 |
| `BIND-004` | `@input` pinned `0.1.0`，adapter 仅支持 `0.2.0` | `adapter-interface-mismatch` |
| `BIND-005` | call 使用 `@input.delete_file` | `unknown-capability-member`，不调用 adapter |

## 8. 内置操作测试向量

测试 adapter 使用内存 argv、虚拟文件沙箱和 stdout buffer；正常值与声明内错误的向量也必须可用于本地 adapter。字符串按 UTF-8 精确比较，不做换行、Unicode normalization 或 locale 转换。要求 adapter 故意返回错误类型或畸形 payload 的向量由 conformance harness 的非合规 fixture 执行，用于验证 runner 会拒绝坏 adapter。

### 8.1 `process.args@0.1.0.read`

`re run main.re -- alpha β` 只暴露 `--` 后的参数，不包含 `re`、文件名或宿主 argv[0]。

| ID | Host input | Typed outcome |
|---|---|---|
| `ARGS-001` | `[]` | `ok([])` |
| `ARGS-002` | UTF-8 `alpha`, `β` | `ok(["alpha", "β"])` |
| `ARGS-003` | 一个非 UTF-8 argv byte sequence | `err(process.args_error.invalid_utf8)` |
| `ARGS-004` | adapter 返回 `list<bytes>` | host fault / `return-type-mismatch` |

### 8.2 `fs.read@0.1.0.read_file`

| ID | Sandbox/input | Typed outcome |
|---|---|---|
| `READ-001` | `input.txt` bytes = UTF-8 `你好\n` | `ok("你好\n")` |
| `READ-002` | `missing.txt` 不存在 | `err(fs.read_error.not_found)` |
| `READ-003` | `secret.txt` 无读权限 | `err(fs.read_error.permission_denied)` |
| `READ-004` | `../outside.txt` 解析到沙箱外 | `err(fs.read_error.outside_sandbox)` |
| `READ-005` | 文件包含非法 UTF-8 | `err(fs.read_error.invalid_utf8)` |
| `READ-006` | transport payload 无法解码，且 `fs.read_error` 未声明该 variant | host fault / `malformed-protocol-payload` |

### 8.3 `fs.write@0.1.0.write_file`

| ID | Sandbox/input | Typed outcome / observable state |
|---|---|---|
| `WRITE-001` | `out.txt`, bytes `41 00 42` | `ok(unit)`；文件精确为 `41 00 42` |
| `WRITE-002` | 目标无写权限 | `err(fs.write_error.permission_denied)`；原内容不变 |
| `WRITE-003` | `../outside.txt` 解析到沙箱外 | `err(fs.write_error.outside_sandbox)`；沙箱外不产生写入 |
| `WRITE-004` | adapter 返回未声明的 `remote_rejected` variant | host fault / `undeclared-error-variant` |

P0 只要求失败向量不产生可观察写入，不据此承诺跨平台原子替换协议。

### 8.4 `process.stdout@0.1.0.write`

| ID | Input/host state | Typed outcome / buffer |
|---|---|---|
| `STDOUT-001` | `"ready\n"` | `ok(unit)`；buffer 精确追加 UTF-8 bytes |
| `STDOUT-002` | `""` | `ok(unit)`；buffer 不变 |
| `STDOUT-003` | broken pipe | `err(io.write_error.broken_pipe)` |
| `STDOUT-004` | adapter 自行追加换行 | conformance 失败；返回值正常也不能掩盖错误输出 |

### 8.5 `process.exit`

`process.exit` 是 pure op，测试属于 runner conformance，不调用 host adapter。

| ID | Program | 期望 |
|---|---|---|
| `EXIT-001` | `return process.exit(0)` | `process-status` code `0` |
| `EXIT-002` | `return process.exit(255)` | `process-status` code `255` |
| `EXIT-003` | `return process.exit(256)` | check failure：literal 不属于 `process.exit_code`；程序不启动 |
| `EXIT-004` | stdout effect 的 result 经 match 后返回 status | stdout 完成且 result 被消费后才映射退出码 |
| `EXIT-005` | adapter 在 status 产生前 host fault | `host-fault`；不得伪造 status |

## 9. P0 通过条件

实现必须同时满足：

1. Registry/runner 通过全部 `REG-*`、`BIND-*` 与故意非合规 adapter fixture 的拒绝向量；
2. 内存 adapter 与本地/沙箱 adapter 通过全部正常值和声明内错误向量，并产生相同 typed outcome；
3. JSON golden tests byte-identical，且不含凭据、endpoint 或 transport session；
4. conformance tests 只调用 §1 interface，替换 adapter 不修改程序图或测试断言；
5. A2A/MCP adapter 尚未存在时不得标记失败；一旦实现，必须复用全部适用向量并增加协议 payload 转换测试。

满足这些条件后，P0-demo-runtime 才可从“候选宿主契约”转为“已实现基线”。

## 10. 实现检查点（2026-07-29）

首轮 Node.js 标准库实现已落在 `src/host/`，测试只穿过本文 §1 与 binding seam：

- 已实现：四份 Demo schema definition、registry exact resolve/幂等去重/顺序无关/冲突原子失败/primary validation/加载后不可变；
- 已实现：binding 成功、缺失、歧义、adapter revision mismatch、registry 缺失、unknown instance/member；调用前验证必填、额外参数与基础值类型，并在 dispatch 前展开 schema 默认值；
- 已实现：adapter throw 净化为 `adapter-panicked` host fault，畸形成功值转成 `return-type-mismatch`，声明内 `err(E)` 保持为程序值；
- 已实现：闭合 `error-sum` 进入 interface definition 与 revision canonical；缺失、空、重复或畸形 variant 集在 registry 原子拒绝，adapter 返回集合外 variant 成为 `undeclared-error-variant`；
- 已实现：memory `ARGS-001..003`、`READ-001..005`、`WRITE-001..003`、`STDOUT-001..003`，拒绝路径不产生文件或 stdout 副作用；
- 已实现：本地 file sandbox adapter 复用 `READ-001..005`、`WRITE-001..003` typed outcomes，并拒绝词法路径、目标 symlink 与父目录 symlink 的沙箱逃逸；
- 已实现：同一 conformance fixture 驱动 memory/local adapter 的全部 `READ-001..005`、`WRITE-001..003` outcome 与可观察状态；可注入 `ENOSPC` 映射为 `fs.write_error.no_space`；
- 已实现：`ARGS-004`、`READ-006`、`WRITE-004`、`STDOUT-004` 非合规 fixtures；返回类型、错误闭包、畸形 payload 与错误输出分别产生稳定拒绝；
- 已实现：`EXIT-001..005` runner seam；check failure 不启动程序，host fault 不伪造成 status，已完成 stdout 在 status 映射后保留；
- 已实现：process-status、host-fault、check-failure 与 audit 的 byte-exact JSON golden；runner JSON driver 已直接通过 process-status golden。

本文 §9 定义的 **P0 host conformance 已满足，可转为已实现基线**。这只冻结 schema registry、host adapter、runner outcome 与 JSON machine seam，不代表完整 Demo 工具链已经存在。

当前 Demo toolchain 已实现 `.re` parser/checker/evaluator 与真实 CLI 驱动，覆盖 Hello World、参数回显、文件读写、manifest、patch、`re audit --format json`、最小中/英文 `re view` 文本、HTML/SVG Semantic View IR、`re build --out` preview artifact（self-contained Node Demo runtime + checksums + Semantic View IR + project review index 摘要 + preview `release-lock.json`）、`re review-index` project review index JSON 与不执行测量的 `re profile` descriptor。后续继续补生产级优化编译器、真实 benchmark runner、安装/缓存/升级策略与更多 locale；A2A/MCP adapter 仍是后续可选实现，不影响本基线状态。

### 11.1 Agent capability adapter conformance

`re.agent-adapter-contract@0.1.0` 是 Agent-owned invocation front door，不替代 Server profile。它固定 Agent/module/node UID、`re.server-profile@0.1.0` identity（id/schema/digest）、capability instance/reference/member、request/input/output/error types、resource constructor、deadline、cancellation 与 supported feature set。`invokeAgentCapability` 在 dispatch 前拒绝 profile drift、capability mismatch、missing/out-of-range deadline、unsupported cancellation 与 extra fields。

成功和 declared error 统一输出 `re.agent-adapter-outcome@0.1.0`；cancel 是独立的 `{kind:"cancelled"}` outcome，不把 cancellation 猜成 capability 的业务 error variant。adapter throw、malformed result、undeclared error variant 和 secret/raw exception 只输出净化 `host-contract-violation`。`AgentMemoryAdapter` 使用显式 response map 做 deterministic replay；`AgentHttpAdapter` 复用已有 `ServerHttpClientTransportAdapter`，只接受构造时注入 transport，不读取全局 fetch。两者共享同一 front door 和 profile identity，memory 与 HTTP 的 typed outcomes 必须一致。

当前 corpus 覆盖 profile/capability/revision pin、success、declared error、cancellation、deadline、malformed response、undeclared error、adapter panic、extra field 与 raw secret sanitization。该切片不宣称 A2A/MCP wire protocol、secret manager、streaming/backpressure、connection pool、distributed retry 或 production scheduler 已实现。

`AgentBusinessHttpAdapter` 是 materialized `db.read` 的窄桥：构造时固定与 contract 一致的 pinned profile、无 credentials 的绝对 `http|https` endpoint 和 timeout；每次调用只发送一次 `POST`，以稳定 JSON 编码 canonical business input，并通过构造时捕获的 Node fetch transport 读取 exact `{"status":200,"body":text}`。body 只能是 exact business `ok` 或 declared `err`，transport `unavailable` 可映射为 declared `unavailable`；状态、JSON、字段、endpoint 或 error variant 漂移均净化为 `host-contract-violation`，不得携带 raw response、URL credentials 或宿主异常。真实 loopback 只证明 request/response boundary、retry 与 receipt trace，不代表 production HTTP/DB、TLS、proxy、DNS/pool、credentials、streaming 或 deployment。

## 11. 最小 Server profile conformance（2026-08-06）

首个 Server profile 切片固定 `re.server-profile@0.1.0` / `server-minimum@0.1.0`，当前包含十项 exact capability，新增 `http.server@0.1.0`：

- `get(key: text.utf8) -> result<text.utf8, config.read_error>`；
- closed error variants 为 `not_found | unavailable`；
- footprint 为 `read config.entry(key)`，`config.entry` 显式继承 `config.store`；
- profile capability entry 同时固定 schema `content_digest` 与实现无关的 `re.server-config-adapter-contract@0.1.0`；
- `profile_digest` 绑定 profile schema/id 和完整 capability entry，schema body 漂移必须改变 capability digest 与 profile digest。

config 的 memory 与 environment adapter 必须声明同一语义 contract、exact interface revision 和 resource metadata，并共享 `CONFIG-001..003` corpus。environment adapter 只接受构造时显式注入的字符串对象快照；构造后外部 mutation 不影响读取，缺键返回 `not_found`，禁用或不可用返回 `unavailable`。默认空快照不得回退读取全局 `process.env`，旧 `re.server-config-memory-adapter@0.1.0` 实现身份不得冒充共享 contract。

`clock.monotonic@0.1.0.now() -> result<int, clock.monotonic_error>` 是显式 nondeterminism seam，footprint 固定为 `read clock.monotonic`，closed error 只有 `unavailable`。memory adapter 只回放构造时给定的非递减、非负 safe integer；耗尽后返回声明内错误，不读取宿主 wall clock。

`random.bytes@0.1.0.fill(length: int) -> result<bytes, random.bytes_error>` 是显式 nondeterminism seam，footprint 固定为 `read random.entropy`，closed error 为 `invalid_length | unavailable`。memory adapter 只回放构造时给定的 `Uint8Array` chunks；每次请求必须与下一个 chunk 的精确长度相等，耗尽返回声明内 `unavailable`，长度非法返回 `invalid_length`，不读取宿主 OS entropy。

`secret.read@0.1.0.get(name: text.utf8) -> result<bytes, secret.read_error>` 是部署注入的 secret seam，footprint 固定为 `read secret.entry(name)`，并显式继承 `secret.store`；closed error 为 `not_found | unavailable`。`re.server-secret-adapter-contract@0.1.0` 是 memory/deployment 双实现共享的语义 contract。两者都只接受 `text.utf8 -> Uint8Array` 映射，构造时复制输入，成功返回再次复制，避免注入快照、adapter 内部状态与调用者之间的可变别名；deployment adapter 只消费构造时显式注入的 snapshot，不读取全局环境、OS keychain 或 secret manager。secret bytes 不进入 canonical、manifest 或日志。

macOS platform adapter `ServerSecretMacosKeychainAdapter` 实现同一 shared contract，但 authority 只来自构造时复制的 `Map<RE name, {service, account, absolute keychain path}>`。每个调用使用绝对 security executable、`shell:false`、参数数组和最小 locale environment 执行 `find-generic-password -g`，始终附带显式 keychain path，禁止默认搜索列表。输出只接受唯一规范 `password:` 行：简单 printable ASCII 为 quoted，其他 UTF-8 值为明确 `0xHEX`；不得把无前缀 hex-like secret 猜成 bytes。读取前后 keychain regular file 的 device/inode 必须相同；只有该身份稳定时 security 退出 44 为 `not_found`，文件缺失/替换、spawn/nonzero、非法 UTF-8、畸形或多 password 输出均为 `unavailable`。stdout、stderr、path、命令和异常不得进入 typed result；成功 bytes 每次复制。真实临时 keychain test 必须 finally 删除 fixture，并覆盖同 service 多 account、hex-like、Unicode、换行、缺失 item、unknown mapping、registry mutation 和参数注入。该 adapter 不提供任意二进制 secret、Touch ID/access-control prompt、iCloud/synchronizable item、ACL/partition list、rotation/versioning、write/delete、Linux secret-service、Windows Credential Manager 或审计 transport。

WP-199 补充真实 macOS Keychain test 的宿主可用性分类：Darwin 且 `/usr/bin/security` 可执行仍不足以证明当前 session 可创建 fixture；测试必须先尝试 create + unlock 隔离临时 keychain。bootstrap 任一步失败时清理已创建材料并明确 skip，含义只能是“本次无真实 Keychain evidence”，不得计作 pass；一旦 bootstrap 成功，后续 add/read/parser/adapter 命令失败仍为 conformance failure。宿主不可用分支与 bootstrap 后回归分支均有注入式测试，且错误不得泄漏 stderr、password 或 keychain path。

`log.event@0.1.0.emit(...) -> result<unit, log.write_error>` 固定 `level/message/node_uid/task_id/attempt/request_correlation` 六个字段，footprint 为 `write log.stream`，closed error 只有 `unavailable`。memory adapter 按调用顺序保存完整结构化 entry，不追加文本、不猜测上下文。

`trace.event@0.1.0.record(...) -> result<unit, trace.write_error>` 固定 `event/span_id/parent_span_id/node_uid/task_id/attempt/request_correlation` 七个字段，footprint 为 `write trace.stream`，closed error 只有 `unavailable`。memory adapter 按调用顺序保存完整结构化 event；空 parent span 必须显式传入空文本，不由 adapter 推断。

`data.json@0.1.0` 固定 `encode(schema: text.utf8, value: text.utf8)` 与 `decode(schema: text.utf8, payload: text.utf8)`，均返回 `result<text.utf8, data.json_error>`；调用者必须显式提供 schema reference，`re.server-json-adapter-contract@0.1.0` 由 memory/codec 双实现共享。memory adapter 只按 exact text mapping 回放；codec adapter 只从构造时显式注入并复制的 registry 选择 exact schema codec，encode 的 JSON object keys 递归排序，decode 先执行宿主 `JSON.parse` 再交 schema codec 校验/投影，不猜测对象类型。未知 schema 为 `invalid_schema`；parse、schema codec、非 JSON-compatible encode value 或非 text decode result 为 `invalid_json`；不可用为 `unavailable`。encode footprint 为 `read data.schema(schema)` + `write data.json`，decode footprint 为 `read data.schema(schema)` + `read data.json`。这不是完整 JSON Schema compiler、canonical JSON、streaming codec、远端 registry 或真实 transport。

`http.client@0.1.0.request(...) -> result<text.utf8, http.client_error>` 固定 `method/url/headers/body/deadline/redirect_policy` 六类请求字段，response 以 typed text boundary 返回，footprint 为 `read network.http(url)`，closed error 为 `invalid_request | deadline_exceeded | redirect_rejected | unavailable`。`re.server-http-client-adapter-contract@0.1.0` 由 memory/transport 双实现共享。memory adapter 只按完整请求 key 回放；transport adapter 每次调用至多一次显式注入的 driver，复制 body 并精确传递其余字段，不读取全局 `fetch`、不静默重试或改写 redirect/deadline。driver 返回 text 或声明内 closed error；throw 收口为 `unavailable`，畸形 outcome 收口为 `invalid_request`。真实 socket/TLS/DNS/proxy/connection pool、streaming 与 async cancellation 属于后续 platform driver。

Node platform transport `createServerHttpClientFetchTransport` 在构造时显式捕获 fetch/timer；默认值只在构造边界读取当前 Node global。它校验 `http|https` URL、HTTP token method、LF 分隔 `name:value` headers、非负 deadline 和 `follow|reject`，复制 body 后至多调用 fetch 一次。`follow` 使用 fetch redirect follow；`reject` 使用 manual 并把 3xx 映射为 `redirect_rejected`；AbortController deadline 映射 `deadline_exceeded`。成功 response 固定为 `{"status":int,"body":text}`，无效输入为 `invalid_request`，fetch/response failure 为 `unavailable`。共享 transport adapter 可规范化 Promise outcome，但同步 HostEnvironment 仍不等待。loopback test 是真实 Node HTTP/fetch 证据，不代表 TLS trust、proxy、DNS/pool、streaming 或 production cancellation 已闭合。

`db.sql@0.1.0` 固定 `query/execute/begin/commit/rollback`。query/execute 同时携带 database、transaction、statement 与独立 `bound_parameters: bytes`，禁止 adapter 把参数拼入 statement；begin 返回显式 transaction token，commit/rollback 关闭它，关闭后复用稳定返回 `invalid_transaction`。query 返回 typed text rows，execute 返回 affected-row int；closed error 为 `conflict | invalid_statement | invalid_transaction | unavailable`。footprint 按 database 分段：query 为 read，其余成员为 write。`re.server-db-sql-adapter-contract@0.1.0` 由 memory/driver 双实现共享。memory adapter 回放 exact operation key 并维护确定性事务状态；driver adapter 复制 bound parameters、精确传递 operation fields，每个 member 至多调用显式 driver 一次，并按 query=text、execute=int、begin=text、commit/rollback=unit 校验 success；driver throw、缺 member 或畸形 outcome 收口为 `unavailable`，closed error 原样透出。真实 connection/pool/isolation/deadlock retry/streaming rows 与 typed decimal-record decode 属于后续 platform driver。

Node SQLite platform driver `createServerDbSqlNodeSqliteDriver` 只接受构造时显式提供且不重复的 `Map<text, DatabaseSync>` 句柄；不打开数据库路径，不读取环境或全局连接配置。`bound_parameters` 是 UTF-8 JSON array，成员只允许 null、text 和 finite safe number，并通过 SQLite prepared statement 绑定。query 只接受首 token 为 `SELECT` 且有 result columns 的 statement；execute 只接受 `INSERT|UPDATE|DELETE|REPLACE` 且无 result columns 的 statement，因此 CTE write/RETURNING 不能借 query 获得 read footprint。每个 database 最多一个活动 transaction；begin 使用 `BEGIN IMMEDIATE`，commit busy 为 `conflict` 并保留 token 以便 rollback，成功 commit/rollback 关闭 token。query rows 只允许 JSON scalar，拒绝会覆盖字段的重复列名，并按列名排序后编码为稳定 JSON text；blob、bigint/unsafe int、非数组参数、未知 database、无效 SQL/transaction 分别收口为声明内错误。该证据覆盖真实内存 SQLite 和 `bindServerProfile + invokeAsync`，不代表文件生命周期、pool、多连接、PostgreSQL、可选 isolation、retry、streaming rows、typed record decode、migration 或 ORM。

`http.server@0.1.0` 以 `accept(listener)` 取得 request token；method/path/headers/route_params 分开读取，`body(request, limit)` 的首个合法 limit 冻结该 request 的物理读取 authority，后续并发/重复调用只按各自 limit 投影成功 bytes，返回独立 copy；首读已超限为 terminal `body_too_large`，后续更大 limit 不恢复被丢弃的 bytes。invalid limit 不冻结 authority。旧 `respond(body, headers, status)` 仍是单次 terminal；新增 `respond_start(headers, status)`、`respond_chunk(body)`、`respond_drain()`、`respond_end()` 形成显式三段式 response stream。`respond_chunk` 返回 `ready|blocked`；blocked 时不得再次写 chunk，`respond_drain` 由 async host seam 等待当前 Writable drain，memory/socket 无阻塞并立即返回 unit。adapter 构造时固定正 safe integer 的 `maxResponseBytes` 与 `maxResponseChunkBytes`，每个 chunk 和累计 bytes 都必须过上限；超限返回 `body_too_large` 并关闭 token，重复 terminal/未 start 的 chunk/end/drain 返回 `invalid_request`。取消后的读取或 drain waiter 返回 `cancelled`，响应后的读取返回 `invalid_request`；closed error 还含 `unavailable`。accept/body/response drain 的 cancellation 固定 cooperative。footprint 为 listener read、request read/write。memory adapter 只回放预置请求并复制 body/response，不监听真实端口。

`http.server@0.1.0` 的 `re.server-http-server-adapter-contract@0.1.0` 由 memory/socket 双实现共享。socket adapter 规范化显式 lifecycle driver 的同步或 Promise outcome；throw/reject、缺 member或畸形 outcome 收口 `unavailable`，closed errors 原样透出；response bytes 在 adapter 边界复制。Node driver 只捕获显式 listener Map，不开关端口；有界 waiter 只配对 matched request，400/404/503 不缓存请求。route registry 固定 exact method、静态/`:name` segments、strict decode/NFC、静态优先与同级歧义拒绝，params 稳定 JSON。token 隔离 fields/body/respond/cancel。Node body 在 data listener 前解析 canonical `Content-Length`，已知长度超过首个 limit 直接 `body_too_large`；chunk overflow 停止缓存并 drain，仍可显式 respond 413。response stream 使用 `writeHead → write* → end`，每个 chunk 与累计 bytes 都受显式构造上限约束，`Writable.write=false` 返回 blocked，后续必须通过 async `respond_drain` 等待 FIFO drain；cancel/disconnect/overflow 收口 drain waiter，避免 orphan。额外 control-plane `drain({deadline})` 停止新 accept/request并解决 pending accept，等待活动 token terminal；注入 monotonic deadline 到期取消剩余 request，summary 只为 `drained|deadline|closed` 加 cancelled count。close 可抢占 drain、解绑 request listeners，但不拥有 `server.close()`。loopback/fake-clock 覆盖正常 drain、deadline、close race、重复调用、多 listener 与无 orphan。OS signal wiring、server-close ownership、wildcard/host routing、TLS、keep-alive policy、跨请求调度与 HTTP/2/3 仍 deferred。

Deployment helper `createServerHttpShutdownCoordinator` 显式接收 signal emitter、signal allowlist、driver、server Map、grace period 与 monotonic clock。它不读取全局 process；start/stop 幂等，首个允许 signal 才启动一次 shutdown并移除 listeners。coordinator 启动 driver absolute-deadline drain，同时对全部 server 调用 close；只有 deadline/closed/control failure 才调用 closeAllConnections，随后 driver close。driver drain outcome 必须精确匹配 `{cancelled_requests, outcome}`，未知字段、非法 closed outcome 或非有限计数 fail closed；server snapshot 与后续 summary 使用 UTF-8 byte order。summary 固定 signal、cancelled_requests、closed/failed server counts 与 completed/partial-failure，不泄漏 close error。loopback 与 fake emitter/server 覆盖自然完成、signal race、deadline force、多 server、stop/restart 和错误收口。process exit/exitCode、cluster/workers、readiness、TLS 与 production orchestration 仍 deferred。

Connection policy helper `applyServerHttpConnectionPolicy` 只消费显式唯一 server Map 与 exact 六项整数 policy，不读取 environment 或全局 defaults。它快照每个 server 的 requestTimeout、headersTimeout、keepAliveTimeout、connectionsCheckingInterval、maxRequestsPerSocket、maxHeadersCount，验证 timeout 关系后原子写入并回读；任一点失败回滚全部。server summary 与 drift names 均按名称 UTF-8 bytes 排序。restore 只有在所有属性仍等于 applied policy 时才原子恢复，外部 drift 返回排序 server names 且零写入；中途 setter 失败保持 applied 值并返回 `restore-failed`，后续 restore 可重试，成功后 apply/restore summary 幂等，输入 policy mutation 不影响 frozen copy。真实 Node server 通过 maxRequestsPerSocket=1 观察到 Connection: close 并验证完整恢复。adaptive tuning、socket metrics、proxy/LB、TLS/HTTP2/3 与 production budgets 仍 deferred。

`bindServerProfile` 是十 capability 绑定前门：每项 adapter contract、exact revision 与 resource catalog 必须匹配，缺少任一 adapter invocation 前 fail closed。

跨 adapter conformance 还要求十项 capability 可以在同一个 profile 中混合绑定不同实现：memory、显式 environment/deployment snapshot、codec registry、transport、SQL driver 与 socket lifecycle driver 都必须通过各自共享 contract。绑定后的 invocation 只能由显式 capability instance 路由，resource footprint 必须来自该 instance 对应的 schema；缺失、legacy contract、contract/revision/resource metadata drift 与 profile schema digest drift 均不得静默降级或调用其他 adapter。该门只证明 profile 控制面和 adapter 语义边界，不证明真实端口、TLS、数据库连接、OS secret manager 或 deployment runtime 已接入。

dispatch isolation 进一步要求固定 profile 的 instance 是唯一 dispatch key：每个 instance 只能调用其绑定 adapter，错误 member 在 schema/dispatch 前门返回 `check-failure`，不触发任何 adapter；`resourceFootprint` 从 pinned registry 解析资源，也不调用 adapter 或跨 capability alias。该规则不提供多实例同 capability 注册，也不代表真实平台 scheduler。

host-fault boundary 要求 adapter throw、Promise/异步 outcome、错误 success 类型、越界 closed error 与 adapter 自造 host fault 都由 HostEnvironment 重新上下文化为稳定 `host-contract-violation`。结果只包含 capability instance/reference、member、invocation ID、phase 与闭集 reason，不得包含原异常文本、stack 或 driver object；失败只允许目标 adapter 被调用一次。当前 Server profile 是同步 contract，Promise 不得被等待或解释为成功。

invocation front door 还必须对十 capability 一致：unknown instance/member、unexpected/missing argument 与 argument type mismatch 返回 `check-failure`，diagnostic 固定绑定 instance/member/reference，并在任何 adapter.invoke 之前结束；错误请求不得跨 capability alias 或通过另一个 adapter 猜测恢复。

reference binding 前门要求每个 profile capability reference 解析到唯一 exact identity/revision schema；unknown identity、revision drift 或 definition removal 返回稳定 `missing-schema-revision`，保留 requested reference，不回退其他 revision/interface，也不调用 adapter。正常 profile 仍必须保持 deterministic digest 与 binding 结果。

instance binding 还要求 host adapter resolution 唯一：同一 instance 的多个候选返回 `ambiguous-host-binding`；唯一候选不声明 exact reference 返回 `adapter-interface-mismatch`；同一 instance 不能同时作为不同 capability 的 alias。任何歧义都必须在产生 bound HostEnvironment 前失败，不选择候选、不调用 adapter。

所有 binding diagnostics 必须按 `instance → reference → code → member → parameter` 稳定排序；同一 alias/ambiguity 输入仅改变 capability declaration 顺序时，机器 JSON envelope 不得改变。

显式多实例 binding 允许同一 exact reference 注册到多个不同 instance；每个 instance 独立绑定唯一 adapter，invoke、resource footprint 与 lineage 只按 instance 路由。完全重复的 instance/reference declaration 返回 `duplicate-capability-instance`，不生成 bound environment；同一 instance 的不同 reference 仍按 alias ambiguity 失败。missing binding、unknown reference 与 adapter interface mismatch 必须在 adapter invocation 前 fail closed，且 capability declaration 顺序不改变诊断结果。该规则不提供多实例同 capability 的 scheduler 生命周期，也不改变 `bindServerProfile` 当前固定十实例入口。

异步 adapter 只能通过显式 `HostEnvironment.invokeAsync` 等待。async 与 sync 入口共享相同的 capability/member/argument 前门、default expansion、return type、closed error 与 host-fault 校验；Promise resolve 后才验证 outcome，throw/rejection 统一收口为 `host-contract-violation` 的 `adapter-panicked`，不得暴露 message/stack。同步 `invoke` 不自动等待 Promise，继续把 Promise 作为 `return-type-mismatch`。多个 instance 的 async completion order 不参与 dispatch，每个 invocation 只调用显式目标 adapter 一次。该 contract 不实现 scheduler、deadline/cancellation、backpressure 或 platform event loop。

WP-57 socket adapter conformance：typed argument faults 必须返回 `invalid_request`，不能把非法 body limit 伪装成 `body_too_large`；driver 的 closed outcome 只接受 exact `{error}` 记录，未知或额外字段收口 `unavailable`。同步/Promise lifecycle outcome、throw/reject sanitization 与 request/response bytes copy 仍保持既有 contract；不扩展 routing、TLS、HTTP/2/3、keep-alive 或 production orchestration。

WP-58 Node HTTP driver conformance：response header value 的 C0/DEL 控制字符必须在宿主写入前被识别为 `invalid_request`，不得销毁 request；解析通过但 `writeHead`/response host operation 失败才收口 `unavailable` 并取消 token。status range、bounded response、disconnect/cancellation cleanup 与 socket adapter integration 保持既有规则。

WP-59 route registry conformance：route compilation、decoded parameter JSON 与 request header serialization 均按 UTF-8 bytes 排序；percent-decoded path segment 含 C0/DEL 控制字符时返回 malformed/400，且不消耗 accept waiter。NFC normalization、strict decode、static specificity 与 ambiguity rejection 保持既有规则。

WP-60 memory adapter conformance：`body(request, limit)` 的非法 limit 返回 `invalid_request`，不冻结首读 authority；实际 bytes 超过已冻结 limit 才返回 terminal `body_too_large`。该错误边界与 socket/Node driver 共享，request/response bytes 仍在 adapter 边界复制。

WP-61 Node driver conformance：非法 `body` limit 同样返回 `invalid_request` 且不冻结物理读取 authority；只有 request payload 超过首个合法 limit 时才返回 terminal `body_too_large`。memory/socket/Node 三实现共享该 error boundary。

WP-62 Node shutdown conformance：`drain({deadline})` 只在显式 absolute monotonic deadline 与当前 injected clock 均为有限、非负值时进入 draining；非法 clock 在状态改变或 timer 创建前 fail closed，随后修正 clock 可重试，close race 与 deadline/drained terminal outcomes 保持不变。

WP-63 Node HTTP client conformance：fetch response 必须先通过整数 status 范围与 callable `text()` 校验，之后才按 `reject` policy 将合法 3xx 映射为 `redirect_rejected`；类型/shape/status 越界的 response 一律为 `unavailable`。

WP-64 Node SQLite conformance：query result row keys 必须按 UTF-8 byte order 排序后编码为 deterministic JSON text；UTF-16 与 UTF-8 顺序不同的 Unicode 列名不得改变 row value types、SQL validation 或 transaction semantics。

WP-65 Node SQLite conformance：`bound_parameters` 必须是有限参数数组经 `JSON.stringify` 生成的 exact UTF-8 bytes；BOM、非必要 whitespace 与非 canonical number spelling 一律为 `invalid_statement`，不改变 prepared binding 或参数类型闭集。

WP-66 concurrency conformance：`maxConcurrentBranches` 缺失或显式 `undefined` 才能表示 unlimited；显式 `null` 必须返回 `invalid-concurrency-max-concurrent-branches`，正 safe integer 的 FIFO admission 与 scheduler summary 保持不变。

WP-67 Node HTTP server conformance：request `headers` 只接受合法 token 名与 string/string[] 值；null、非字符串、重复大小写名和 C0/DEL 控制字符必须返回 `invalid_request`，合法 headers 统一小写并按 UTF-8 byte order 序列化。

WP-68 Node HTTP server conformance：request `method` 必须是 HTTP token，request URL/path 必须是非空且不含 C0/DEL 的 text；malformed metadata 必须返回 `invalid_request`，不改变 route matching 或 request lifecycle。

WP-69 structured-concurrency runtime conformance：`executeConcurrencyPlan(plan, options)` 的 options 必须是非数组 object；`null`、数组和 primitive 必须在任何 property access 前返回 `invalid-concurrency-options`，不改变 runner、FIFO admission、cancellation、scheduler summary 或 trace semantics。

WP-70 Node HTTP server conformance：request path 与 header value 必须是可精确编码的 UTF-8 text；unpaired UTF-16 surrogate 必须返回 `invalid_request`，不得通过宿主编码替换为 U+FFFD。合法 surrogate pair/astral text 保持原值，不改变 routing 或 request lifecycle。

WP-71 Node HTTP server conformance：response header value 中的 unpaired UTF-16 surrogate 必须在宿主 `writeHead` 前返回 `invalid_request`，不得收口为 `unavailable` 或取消 request。合法 header/status、bounded response 与 stream lifecycle 保持不变。

WP-72 Node HTTP client conformance：fetch transport request header value 中除 HTAB 外的 C0/DEL 与 unpaired UTF-16 surrogate 必须在 fetch 调用前返回 `invalid_request`，不得收口为 `unavailable`。method/url/body/deadline/redirect 与 response semantics 保持不变。

WP-73 Node HTTP client conformance：raw request URL 中的 C0/DEL 与 unpaired UTF-16 surrogate 必须在 `new URL` 和 fetch 调用前返回 `invalid_request`，不得通过 percent-encoding 或 U+FFFD replacement 改写 caller 输入。protocol allowlist 与其余 request/response semantics 保持不变。

WP-74 Node HTTP client conformance：`response.text()` 返回值中的 unpaired UTF-16 surrogate 必须返回 `unavailable`，不得通过 JSON escaping 进入成功 response envelope。合法 Unicode body、status/redirect/deadline 与 request semantics 保持不变。

WP-75 Node HTTP client conformance：case-insensitive duplicate request header names 必须在 fetch 调用前返回 `invalid_request`，不得由宿主 Headers silent merge。合法 header order/value text 与其余 request/response semantics 保持不变。

WP-76 structured-concurrency conformance：存在显式 deadline 时，首次 injected `now()` 必须在 timer 创建、branch spawn 与 runner 启动前返回有限非负值；NaN、Infinity 或负数统一返回 `invalid-concurrency-clock`。合法 endpoint、FIFO admission、cancellation、scheduler summary 与 trace semantics 保持不变。

WP-77 structured-concurrency conformance：存在显式 deadline 时，首次 injected `now()` throw 必须在 timer、branch 与 runner 启动前返回 `invalid-concurrency-clock`，不得泄漏异常或退化为 `concurrency-runtime-failure`。合法 clock/deadline 与调度语义保持不变。

WP-78 structured-concurrency conformance：injected `setTimeoutImpl` throw 必须返回 `invalid-concurrency-clock`、不得启动 runner，并移除在 timer 前已安装的 parent abort listener。合法 timer/deadline、admission、cancellation、scheduler summary 与 trace semantics 保持不变。

WP-79 structured-concurrency conformance：injected `clearTimeoutImpl` throw 必须在 runner cleanup 完成后返回 `invalid-concurrency-clock`、不得退化为 `concurrency-runtime-failure`，且 parent abort listener 仍必须移除。合法 timer/deadline、runner completion、admission、cancellation、scheduler summary 与 trace semantics 保持不变。

WP-80 structured-concurrency conformance：injected parent signal 的 `addEventListener` throw 必须返回 `invalid-concurrency-parent-signal`、尽力移除可能已注册的 listener，且不得创建 deadline timer 或启动 runner。合法 parent cancellation、deadline、admission、scheduler summary 与 trace semantics 保持不变。

WP-81 structured-concurrency conformance：injected parent signal 的 `aborted` getter 在 shape validation 或 listener registration 后 throw 均必须返回 `invalid-concurrency-parent-signal`；registration 后的 fault 必须回滚 listener，且两条路径都不得创建 deadline timer 或启动 runner。合法 parent cancellation、deadline、admission、scheduler summary 与 trace semantics 保持不变。

WP-82 structured-concurrency conformance：injected parent signal 的 `removeEventListener` 在 timer setup rollback 中 throw 不得覆盖 primary `invalid-concurrency-clock`；在正常 final cleanup 中 throw 必须于 runner cleanup 完成后返回 `invalid-concurrency-parent-signal`，不得退化为 `concurrency-runtime-failure`。合法 parent cancellation、deadline、runner completion、admission、scheduler summary 与 trace semantics 保持不变。

WP-83 structured-concurrency conformance：root/nested effect 的 start timestamp 或取消后 completion timestamp 读取 injected `now()` throw 均必须返回 `invalid-concurrency-clock`；start fault 不得启动 operation，所有路径必须移除 effect abort listener并按 fatal diagnostic 逐层传播，不得错分 host fault 或生成 invalid trace。合法 effect lifecycle、cancellation latency、admission、scheduler summary 与 trace semantics 保持不变。

WP-84 structured-concurrency conformance：root/nested effect 的 start 与取消后 completion `now()` 读数必须为有限非负值；NaN、Infinity 与负数必须返回 `invalid-concurrency-clock`，不得被 `nonNegativeLatency` 静默归零或写入 trace。合法 effect lifecycle、cancellation latency、admission、scheduler summary 与 trace semantics 保持不变。

WP-85 structured-concurrency conformance：`options.maxConcurrentBranches` 必须在 runner/timer/trace startup 前只读取一次并冻结；getter 首次读取 throw 返回 `invalid-concurrency-options`，不得退化为 `concurrency-runtime-failure`，且 validation/runtime 不得重复读取 accessor。合法 unlimited/FIFO admission、scheduler summary 与 trace semantics 保持不变。

WP-86 structured-concurrency conformance：`options.deadline` 必须在 runner/timer/trace startup 前只读取一次并冻结，供 validation 与 runtime 复用；getter 首次读取 throw 返回 `invalid-concurrency-options`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取 accessor。合法 deadline endpoint、parent cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-87 structured-concurrency conformance：`options.parentSignal` 必须在 runner/timer/trace startup 前只读取一次并冻结，供 validation、registration、cancellation 与 cleanup 复用；getter 首次读取 throw 返回 `invalid-concurrency-options`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取 accessor。合法 parent cancellation、deadline endpoint、admission、scheduler summary 与 trace semantics 保持不变。

WP-88 structured-concurrency conformance：`options.branches` 必须在 runner/timer/trace startup 前只读取一次并冻结，供 shape validation 与 root runtime 复用；getter 首次读取 throw 返回 `invalid-concurrency-options`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取 accessor。合法 unknown/missing runner diagnostics、nested runner authority、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-89 structured-concurrency conformance：`options.now`、`options.setTimeoutImpl` 与 `options.clearTimeoutImpl` 必须在 runner/timer/trace startup 前读取并冻结；任一 getter throw 返回 `invalid-concurrency-options`，不得退化为 `concurrency-runtime-failure`。缺失值继续使用默认实现，合法函数或非函数 shape 的 `invalid-concurrency-clock`、调用期 clock/timer faults、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-90 structured-concurrency conformance：root plan 的 `schema`、`construct`、`nodes`、`edges`、`output` 必须在 validation 前单次 snapshot；任一 root getter throw 返回 `invalid-concurrency-plan`，不得退化为 `concurrency-runtime-failure`，且冻结字段同时供 shape validation 与 runtime trace verification 使用。合法 plan lowering、runner authority、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变；nested node object accessor faults deferred。

WP-91 structured-concurrency conformance：`plan.nodes` 中参与 shape validation/runtime verification 的 `kind`、`id`、`members`、`policy`、`deadline`、`cancellation`、`effect` 字段必须在 root validation snapshot 阶段单次读取并冻结；任一 nested node getter throw 返回 `invalid-concurrency-plan`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取原始 node accessor。合法 plan lowering、runner authority、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变；未使用的扩展 node 字段与新的 node schema deferred。

WP-92 structured-concurrency conformance：`plan.edges` 中参与 shape validation/runtime verification 的 `kind`、`from`、`to`、`branch` 字段必须在 root validation snapshot 阶段单次读取并冻结；任一 edge getter throw 返回 `invalid-concurrency-plan`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取原始 edge accessor。合法 plan lowering、runner authority、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变；未使用的扩展 edge 字段与新的 edge schema deferred。

WP-93 structured-concurrency conformance：join node 的 `members` 为数组时必须在 root validation snapshot 阶段复制元素；任一 collection getter/index/iterator fault 返回 `invalid-concurrency-plan`，不得退化为 `concurrency-runtime-failure`，且后续不得重复读取原始 collection。合法 plan lowering、runner authority、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-94 structured-concurrency conformance：par-region policy 的 `branch_error`、`cancel_propagation`、`detach`、`host_fault`、`retry` 必须在 root validation 阶段单次读取、冻结并匹配现行 fixed policy；任一 policy getter fault 或不匹配在 runner/timer/trace startup 前返回 `invalid-concurrency-plan`，不得退化为 `runtime-generated-invalid-trace`。合法 plan lowering、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-95 structured-concurrency conformance：par-region `deadline` 必须为 `null` 或 exact `{endpoint:'request.deadline',type:'time.monotonic_instant'}`；字段在 root validation 阶段单次读取并冻结，畸形值或 getter fault 在 runner/timer/trace startup 前返回 `invalid-concurrency-plan`。合法 deadline option、cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-96 structured-concurrency conformance：`plan.nodes` 与 `plan.edges` snapshot 不得调用输入数组实例上的 `map` 等可覆写方法；必须捕获 collection length 后逐项读取并重建普通数组，使 WP-91/WP-92 的 node/edge 字段冻结无法被 collection method override 绕过。首次合法、后续 throw 的字段 accessor 只允许读取一次；首次读取 fault 仍返回 `invalid-concurrency-plan`。合法 lowering、deadline/policy、cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-97 structured-concurrency conformance：root `options.branches` 与每层 nested `childRunnerMap` 必须在对应 branch startup 前通过 `Map.prototype.entries` intrinsic entries 复制为内部 Map；输入 Map 的 `get`、`Symbol.iterator`、`size` 覆写不得替换已验证 runner 或改变 nested runner authority。malformed/不可读取 Map 返回 `invalid-concurrency-runners`；合法 runner identity、effect/nested ordering、parent/deadline cancellation、admission、scheduler summary 与 trace semantics 保持不变。

WP-98 structured-concurrency conformance：`options.parentSignal` 的 `addEventListener`、`removeEventListener` 与初始 `aborted` state 必须在 runner/timer startup 前单次读取并绑定为 capability record；registration、rollback、deadline rollback 与 final cleanup 只消费该 record，不得重读动态 signal accessor。首次 capability fault 返回 `invalid-concurrency-parent-signal`；合法 parent cancellation、deadline cleanup、runner/effect ordering、admission、scheduler summary 与 trace semantics 保持不变。

WP-99 structured-concurrency conformance：已读取的 parent signal `addEventListener` 与 `removeEventListener` method 必须使用 intrinsic `Function.prototype.bind.call` 绑定 signal receiver；method 自身覆写或抛出的 `bind` 属性不得替换真实 listener authority、制造 false `invalid-concurrency-parent-signal` 或改变 cleanup。WP-98 的单次 capability snapshot 与合法 cancellation、deadline、admission、scheduler summary、trace semantics 保持不变。

WP-100 HTTP server socket conformance：socket adapter 读取的 lifecycle driver method 必须使用 intrinsic `Function.prototype.bind.call` 绑定 driver receiver；method 自身覆写或抛出的 `bind` 属性不得替换真实 driver authority、制造 false `unavailable` 或改变 request cleanup。既有 request/response copy、同步/Promise outcome normalization、closed errors 与 Node driver lifecycle 语义保持不变。

WP-101 HTTP server socket conformance：socket adapter 构造期对每个 lifecycle driver member 必须单次读取并立即使用 intrinsic bind 固定 callable；同一 member getter 的后续 spoof 或 fault 不得替换已选 driver method、改变 supported lifecycle surface 或改变 invocation outcome。WP-100 的 bind authority、request/response copy、closed errors 与 Node driver lifecycle 语义保持不变。

WP-102 JSON codec conformance：codec registry 必须使用 intrinsic `Map.prototype.entries.call` 单次快照；每个 codec 的 encode/decode method 必须只读取一次并使用 intrinsic `Function.prototype.bind.call` 绑定原始 codec。registry iterator、method getter 或 method-owned bind 的 spoof/fault 不得改变 schema dispatch、canonical key ordering、decode projection 或 closed JSON errors。

WP-103 HTTP shutdown conformance：shutdown coordinator 必须在构造期单次读取并 intrinsic-bind driver drain/close、signal source on/off 与每个 server close/closeAllConnections；后续 host getter、method-owned bind、replacement 或 fault 不得改变 first-signal-wins、drain deadline、server close race 或 sanitized cleanup result。
WP-147 HTTP shutdown conformance：`driver.drain()` outcome 必须在 exact-key 校验时单次读取并冻结 `cancelled_requests` 与 `outcome`；force-close 分支、driver close 与 summary 只消费该内部 record。Proxy ownKeys/getter fault 或后续 mutation 必须 fail closed 为 partial-failure，不得改变 cancelled count、terminal classification 或泄漏异常。
WP-148 FileSandbox conformance：构造期必须单次读取并使用 intrinsic bind 固定注入 filesystem 的 `realpathSync`、`readFileSync` 与 `writeFileSync`，root 解析、sandbox path checks 与 read/write dispatch 只消费内部 capability record；getter、method-owned bind、receiver mutation 或缺 member不得替换 authority，构造 capability fault 必须为稳定 TypeError。既有 path/symlink escape、typed outcomes 与 profile binding 保持不变。
WP-149 Demo process-args conformance：`MemoryAdapter` 构造期必须捕获 argv length，按 index 单次读取并复制 string/Uint8Array values；`process.args.read` 只消费内部 argv snapshot，不调用输入 iterator或 array methods。index/iterator spoof、构造后 replacement、genuine bytes mutation 与 typed-array Proxy/copy fault不得替换结果；Proxy/copy fault构造期稳定 TypeError，invalid UTF-8仍返回 `process.args_error.invalid_utf8`。
WP-150 FileSandbox write conformance：`fs.write_file` 必须先以 genuine typed-array internal slots snapshot data，再执行任何 realpath/write dispatch；frozen `writeFileSync` 只接收内部 plain bytes。Proxy typed-array/copy fault、shadowed iterator/length与调用后 mutation不得替换写入结果，fault在 filesystem 零调用前收口 `fs.write_error.io`；既有 path/symlink/permission/no-space classification保持不变。
WP-151 HTTP server memory bytes conformance：constructor request body、`respond` body 与 `respond_chunk` body 必须先以 genuine typed-array internal slots snapshot 为内部 plain Uint8Array，再以内部分配 length 执行 body/response limits、replay 与 response storage。Proxy/copy fault、shadowed iterator/length与调用后 mutation不得替换 request、limit outcome 或 recorded bytes；request Proxy 在构造期稳定 TypeError，respond/respond_chunk fault 返回 `http.server_error.invalid_request`，既有 lifecycle、headers/status、backpressure 与 schema/profile identity保持不变。
WP-152 Demo `MemoryAdapter` write conformance：`fs.write_file` 必须先以 genuine typed-array internal slots snapshot data，再执行 sandbox path、permission 与 file record mutation；frozen record 只消费内部 plain bytes。Proxy/copy fault、shadowed iterator/length与调用后 mutation不得替换写入结果，fault在任何文件变化前收口 `fs.write_error.io`；既有 outside_sandbox/permission_denied classification 与 Demo schema/profile identity保持不变。
WP-153 Demo `MemoryAdapter` files conformance：constructor 必须使用 intrinsic `Map.prototype.entries.call` 单次快照 files，并在同一遍校验 path/file record、以 genuine typed-array internal slots 复制每个 bytes；外部 Map replacement/get/iterator mutation与原始 bytes mutation不得替换 `fs.read`/`fs.write` authority，invalid record 或 Proxy/copy fault 构造期稳定 TypeError。write 仍可更新既有外部 observation，但后续读取只消费内部 file snapshot；sandbox path、permission 与 Demo schema/profile identity保持不变。
WP-154 FileSandbox read conformance：`readFileSync` 返回值必须在 UTF-8 decode 前以 genuine typed-array internal slots snapshot 为内部 plain Uint8Array；Proxy/copy fault必须稳定返回 `fs.read_error.io`，不得泄漏宿主 TypeError或误归类 `invalid_utf8`；genuine valid/invalid UTF-8 bytes 的既有分类、path/symlink、filesystem capability 与 schema/profile identity保持不变。
WP-155 Node SQLite direct-driver parameter conformance：`decodeBoundParameters` 必须在 UTF-8 decode 与 JSON parse 前以 genuine typed-array internal slots snapshot `bound_parameters` 为内部 plain Uint8Array；Proxy/copy fault 与 iterator spoof必须稳定返回 `invalid_statement`，不得静默采用宿主 iterable 或 shadowed authority；genuine shadowed-length subclass按 internal bytes执行 exact UTF-8 canonical JSON 校验。SQL statement/transaction、database/statement method snapshot、schema/profile identity保持不变。
WP-156 Node SQLite query-row conformance：`stableRowsText` 必须在 JSON serialization 前以捕获 length/index descriptors复制 `all()` rows，并在同一遍以 enumerable own descriptors快照每个 row field/value；不得调用覆写 `map`/array methods或重复读取动态 getter，非数组、缺失 index、descriptor fault、非法 row shape/value稳定返回 `invalid_statement`。既有 UTF-8 column ordering、null/text/finite number validation、SQL transaction与schema/profile identity保持不变。
WP-157 Node SQLite statement-column conformance：query/execute 在 statement dispatch 前必须以捕获 length/index descriptors复制 `columns()` collection，并在同一遍以 own `name` descriptor 单次读取每个列名；不得调用覆写 `map`/iterator、shadowed length或重复读取动态 name getter。非数组、缺失 index、descriptor fault、非 text name与 spoofed collection稳定返回 `invalid_statement`；query仍要求非空且唯一列名，execute仍要求零列，既有 SQL/parameter/row/transaction/method snapshot 与 schema/profile identity保持不变。

WP-104 HTTP client fetch conformance：fetch response 返回后必须单次读取 status 与 text，并对 text 使用 intrinsic bind 固定 response receiver；后续 response getter、method-owned bind、replacement 或 fault 不得改变 redirect rejection、status/body serialization 或 closed transport errors。

WP-105 db.sql SQLite driver conformance：DatabaseSync handle 的 exec/prepare 必须在 driver 构造期单次读取并 intrinsic-bind；每个 prepared statement 的 columns/run/all 必须在对应 operation 使用前单次读取并 intrinsic-bind。后续 database/statement getter、replacement、method-owned bind 或 fault 不得改变 transaction/query dispatch 或 closed db.sql errors。既有 SQL validation、parameter copying、transaction lifecycle、row normalization 与 busy/unavailable semantics 保持不变。

WP-106 db.sql generic driver conformance：ServerDbSqlDriverAdapter 构造期必须按可信 operation members 单次读取 driver method 并 intrinsic-bind；invoke 只消费内部 capability table。后续 driver getter、replacement、method-owned bind 或 fault 不得改变 request dispatch、typed outcome normalization 或 closed db.sql errors。既有 request validation、parameter copying 与 sync/async boundary 保持不变。

WP-107 secret memory conformance：secret values Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 text name/`Uint8Array` value 与复制 bytes；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 selected secret bytes、not_found/unavailable classification 或 caller mutation isolation。

WP-108 secret deployment conformance：secret values Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 text name/`Uint8Array` value 与复制 bytes；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 selected secret bytes、not_found/unavailable classification 或 caller mutation isolation。

WP-109 macOS Keychain secret conformance：entries Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 text name 与 account/service/keychain target 后复制为内部 records；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 selected Keychain target、spawn arguments 或 not_found/unavailable classification。既有 executable/stat identity checks、output parsing 与 closed errors 保持不变。

WP-110 HTTP client memory conformance：responses Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 request key 与 text/closed-error outcome 后复制为内部 records；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 request dispatch、replay result、invalid_request/unavailable classification 或 closed transport errors。既有 request key canonicalization 与 shared corpus 保持不变。

WP-111 db.sql memory conformance：outcomes Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍解析 operation key、校验 query text/execute integer/closed-error outcome 后复制为内部 records；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 SQL replay authority、invalid_statement/unavailable classification 或 transaction lifecycle。既有 commit conflicts、transaction queue 与 parameter canonicalization 保持不变。

WP-112 db.sql memory commit-conflicts conformance：commitConflicts Set 必须使用 intrinsic `Set.prototype.values.call` 单次快照，并在同一遍校验 transaction text 后复制为内部 Set；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 commit conflict authority、commit/rollback classification 或 transaction lifecycle。既有 outcomes snapshot、transaction queue 与 parameter canonicalization 保持不变。

WP-113 db.sql memory transaction queue conformance：transactions 数组必须捕获 length 后按 index 单次读取，并在同一遍校验非空 transaction text 与重复项后复制为内部普通数组；覆写 `Symbol.iterator`、array method、index replacement 或 fault 不得改变 begin transaction authority、conflict classification 或 transaction lifecycle。既有 outcomes/commit-conflicts snapshot 与 parameter canonicalization 保持不变。

WP-114 clock.monotonic memory conformance：instants 数组必须捕获 length 后按 index 单次读取，并在同一遍校验 nonnegative safe integer 与 nondecreasing order 后复制为内部普通数组；覆写 `Symbol.iterator`、array method、index replacement 或 fault 不得改变 monotonic reading authority、exhaustion classification 或 resource metadata。既有 shared clock contract 与 closed errors 保持不变。

WP-115 random.bytes memory conformance：chunks 数组必须捕获 length 后按 index 单次读取，并在同一遍校验 `Uint8Array` 与复制 bytes 后重建内部普通数组；覆写 `Symbol.iterator`、array method、index replacement 或 fault 不得改变 random replay chunk authority、invalid_length/unavailable classification 或 resource metadata。既有 shared random contract 与 closed errors 保持不变。

WP-116 data.json memory conformance：顶层 schemas 与每个 schema 的 encode/decode Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 reference 与 text-to-text mappings 后重建内部 Maps；覆写 registry/nested `Symbol.iterator`、entry replacement 或 fault 不得改变 schema dispatch、encode/decode replay authority、invalid_schema/invalid_json/unavailable classification。既有 shared JSON contract、resource metadata 与 closed errors 保持不变。

WP-117 http.server memory conformance：requests 数组必须捕获 length 后按 index 单次读取，并在同一遍校验 request shape、复制 body 与字段后重建内部普通数组；覆写 `Symbol.iterator`、array method、index replacement 或 fault 不得改变 accept request authority、request lifecycle、body/response bounds 或 closed error classification。

WP-118 config.read memory conformance：values Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验 text key/value 后重建内部 Map；覆写 `Symbol.iterator`、entry replacement 或 fault 不得改变 config key authority、not_found/unavailable classification、resource metadata 或 parent lineage。

WP-119 HTTP server connection policy conformance：servers Map 必须使用 intrinsic `Map.prototype.entries.call` 单次快照，并在同一遍校验非空 text name、物理唯一 server handle 与原始六字段值后重建内部 records；覆写 `Symbol.iterator`、size/get、entry replacement 或 fault 不得替换 apply/restore authority、UTF-8 summary order、rollback 或 drift classification。exact policy validation、ordered write/readback、atomic rollback、restore retry 与真实 Node loopback 语义保持不变。

WP-120 Node HTTP server startup registry conformance：listeners 与 routes Map 必须分别使用 intrinsic `Map.prototype.entries.call` 单次遍历；每个 route definitions 数组必须捕获 length 后按 index 单次读取、编译并重建内部 records。覆写 registry `Symbol.iterator`/size/get、definitions array method/index replacement 或 fault 不得替换 listener handle、route dispatch、request lifecycle 或 cleanup authority。listeners 与 routes 必须在注册 request listener 前按 name 完成解析与冻结；route ambiguity、UTF-8 specificity order、bounded accept/body/response、drain/cancel 与 real loopback 语义保持不变。

WP-121 Node HTTP server listener capability conformance：startup listener registry 单次遍历时必须各只读取一次 server `on`/`off` method，并使用 intrinsic `Function.prototype.bind.call` 固定原始 server receiver；request listener registration 与 close cleanup 只消费内部 capability records。getter 后续 spoof/fault 或 method-owned bind override/fault 不得替换注册/清理 authority、listener identity、request lifecycle 或 shutdown classification。listener/route registry snapshot、bounded lifecycle、drain/cancel 与 real loopback 语义保持不变。

WP-122 Node HTTP server route definition conformance：route registry startup compile 必须各只读取一次 definition `method` 与 `pattern`，并只消费冻结 text values完成 token/path validation、segment compilation、specificity、ambiguity 与排序 identity。字段 getter 后续 spoof/fault 或 source object mutation 不得替换 route dispatch、ambiguity classification、UTF-8 order、request lifecycle 或 cleanup authority。registry/definitions collection snapshot、bounded lifecycle、drain/cancel 与 real loopback 语义保持不变。

WP-123 Node HTTP server request metadata conformance：`matchRoute` 必须在每次 route dispatch 各只读取一次 request `method` 与 `url`，并只消费冻结 text values完成 metadata validation、query stripping、strict decode/NFC、route matching 与 malformed classification。字段 getter 后续 spoof/fault 或 source object mutation不得替换 route dispatch、400/404 classification、request token identity 或 response lifecycle。compiled route snapshot、bounded lifecycle、drain/cancel 与 real loopback 语义保持不变。

WP-124 Node HTTP server accepted request metadata conformance：route dispatch 已冻结的 request method/url 必须写入内部 request record；`http.server.method/path` 只消费该 snapshot，不得重新读取原 IncomingMessage metadata。字段 getter 后续 spoof/fault 或 source mutation不得替换 accepted request identity、method/path result、route params、request lifecycle 或 response authority。compiled route snapshot、bounded lifecycle、drain/cancel 与 real loopback 语义保持不变。

WP-125 Node HTTP server accepted request headers conformance：matched request 的 `headers` 必须在 dispatch boundary 固定为内部 serialized outcome；`http.server.headers` 只消费该 snapshot，不得重新读取原 IncomingMessage headers。headers getter、object mutation、entry spoof/fault 后续不得替换 accepted request identity、header validation/classification、route params、request lifecycle 或 response authority。method/path snapshot、bounded lifecycle、drain/cancel 与 real loopback 语义保持不变。

WP-126 Node HTTP server Content-Length conformance：body first-read preflight 必须只消费 dispatch boundary 已冻结的 canonical `content-length` value，不得重新读取原 IncomingMessage headers。headers getter/object mutation/entry spoof/fault 后续不得替换 body read authority、`body_too_large`/`invalid_request` classification、request lifecycle 或 response authority。accepted headers snapshot、bounded body、drain/cancel 与 real loopback 语义保持不变。

WP-127 Node HTTP server accepted request capability conformance：matched IncomingMessage 的 `destroy/off/on/once/resume` 必须在 dispatch boundary 各读取一次，并使用 intrinsic `Function.prototype.bind.call` 固定原 request receiver；dispatch abort registration、body data/end/aborted/error registration and cleanup、overflow resume、explicit cancel 与 shutdown cancel 只消费内部 capability record。getter 后续 spoof/fault 或 method-owned bind override/fault 不得替换 body bytes、`body_too_large`/`cancelled` classification、listener cleanup 或 request destruction authority。metadata/headers/content-length snapshot、response capability、bounded lifecycle 与 real loopback 语义保持不变。

WP-128 Node HTTP server accepted response capability conformance：matched ServerResponse 的 `destroy/end/once/writeHead` 必须在 dispatch boundary 各读取一次，并使用 intrinsic `Function.prototype.bind.call` 固定原 response receiver；close registration、single/stream response completion、explicit/shutdown cancel 与 response-limit failure 只消费内部 capability record。getter 后续 spoof/fault 或 method-owned bind override/fault 不得替换 status/header/body emission、`cancelled`/`body_too_large` classification 或 response destruction authority。pre-accept rejection、mutable `writableEnded` state、injected write/drain transport hooks 与 streaming redesign 保持现行边界。

WP-129 Node HTTP server accepted response transport conformance：matched ServerResponse 的 `write` 必须与 WP-128 capability record 在 dispatch boundary 单次读取并 intrinsic-bind；`respond_chunk` 与 default drain wait 只接收内部 capability record，不得重新读取或向 transport hooks 暴露 raw response。getter 后续 spoof/fault 或 method-owned bind override/fault 不得替换 chunk bytes、`ready|blocked` classification 或 drain listener authority。mutable `writableEnded` state、custom scheduling semantics 与 general streaming redesign 保持现行边界。

WP-130 Node HTTP server pre-accept response capability conformance：每次 request dispatch 入口必须单次读取并 intrinsic-bind ServerResponse `setHeader` 及既有 destroy/end/once/write/writeHead；400/404/503 rejection 与 accepted lifecycle 共用同一 capability record，不得在 mode/route/waiter/request-snapshot failure 分支重新读取 raw response methods。getter 后续 spoof/fault 或 method-owned bind override/fault 不得替换 rejection status/header/completion 或 accepted response authority。mutable status/state 与 general streaming redesign 保持现行边界。

WP-131 Node HTTP server accepted response `writableEnded` observer conformance：dispatch boundary 必须从 ServerResponse property descriptor chain 固定 boolean getter并 intrinsic-bind 原 receiver；异步 close callback 只调用内部 observer，不得重新解析 raw response property。dispatch 后 own-property shadow/getter mutation、getter-owned bind spoof/fault 不得替换 `cancelled` classification；真实 Node prototype accessor 的 mutable state继续可观察。statusCode writes、response methods与 general streaming redesign 保持现行边界。

WP-132 Node HTTP server pre-accept `statusCode` writer conformance：dispatch boundary 必须在读取 response method getters 前从 property descriptor chain 固定 writable data descriptor 或 setter，并为 accessor intrinsic-bind 原 receiver；400/404/503 rejection 只调用内部 writer。method getter cross-side-effect 重写 statusCode setter、setter spoof/fault 不得替换 rejection classification；真实 Node writable data property与 accessor setter保持可写。writableEnded observer、response methods与 accepted streaming保持现行边界。

WP-133 Node HTTP server accepted request envelope descriptor conformance：open dispatch 必须先从 IncomingMessage property descriptor chain 固定 method/url/headers readers，再读取任何 response/request capability getters；route matching、accepted method/path、serialized headers与 Content-Length preflight只消费同一 envelope snapshot。cross-field/cross-object getter property replacement、getter-owned bind spoof/fault不得替换 request identity或body classification。closed-mode rejection、request stream methods与 response lifecycle保持现行边界。

WP-134 Node HTTP server accepted request stream capability descriptor conformance：dispatch boundary 必须先从 IncomingMessage property descriptor chain 固定 destroy/off/on/once/resume readers，再调用任一 capability getter并 intrinsic-bind 原 receiver；cross-method getter side effects、property replacement、getter-owned/method-owned bind spoof/fault不得替换 abort registration、body listener cleanup、overflow resume或cancel destruction authority。request envelope、response lifecycle与body semantics保持现行边界。

WP-135 Node HTTP server response method capability descriptor conformance：dispatch boundary 必须先从 ServerResponse property descriptor chain 固定 destroy/end/once/setHeader/write/writeHead readers，再调用任一 method getter并 intrinsic-bind 原 receiver；cross-method getter side effects、property replacement、getter-owned/method-owned bind spoof/fault不得替换 rejection completion、accepted response emission、drain或destruction authority。statusCode writer、writableEnded observer与 request lifecycle保持现行边界。

WP-136 Node HTTP server accepted request header field descriptor conformance：`snapshotHeaders` 必须先固定全部 enumerable own string field descriptors/readers，再调用任一 header getter；cross-field getter side effects、property replacement、getter-owned bind spoof/fault不得替换 serialized headers、Content-Length preflight或 `invalid_request` classification。request envelope、stream capabilities、duplicate/header text validation与body semantics保持现行边界。

WP-137 Node HTTP server request header string-list conformance：array-valued header fields 必须捕获 length与全部 own index descriptor readers并重建内部 string list，不得调用输入 array 的 `some`/`join`/iterator或受 cross-index getter side effects影响；覆写 array methods、holes/index replacement、getter fault不得替换 serialized headers、Content-Length classification或body preflight authority。header field descriptors、request envelope与body semantics保持现行边界。

WP-138 Node HTTP server response bytes conformance：`respond` 与 `respond_chunk` 必须先从 caller genuine typed-array internal slots 复制为内部 plain `Uint8Array`，再以内部分配的 length执行单 chunk/total limits、responseBytes accounting与写出；subclass shadowed length、Proxy iterator/length、构造后 mutation不得绕过 `body_too_large` 或替换 chunk bytes。`Proxy<Uint8Array>` 不具备 typed-array internal slots，必须稳定拒绝为 `invalid_request`。response headers/capabilities/drain lifecycle与 socket adapter contract保持现行边界。

WP-139 Node HTTP server request chunk bytes conformance：`readBody` 的 data listener 只接受 genuine `Uint8Array`/Buffer host chunks，并先从 typed-array internal slots 复制为内部 plain `Uint8Array`，再以内部分配 length执行 body limit accounting与chunk storage；subclass shadowed length、Proxy iterator/length、`Buffer.from` typed-array overload或 emit 后 mutation不得静默丢弃、替换或放大 request bytes。malformed host chunk/copy fault收口 `unavailable`，真实内部 bytes 超限仍为 `body_too_large`。首读 authority、Content-Length preflight与 request lifecycle保持现行边界。

WP-140 HTTP server socket adapter bytes conformance：`respond`/`respond_chunk` caller body 与 `body` driver outcome 必须从 genuine typed-array internal slots 复制为内部 plain `Uint8Array`；`Proxy<Uint8Array>`、shadowed iterator/length 与调用后 mutation不得替换 response request 或 driver outcome bytes。caller proxy/copy fault收口 `invalid_request`，driver proxy/copy fault收口 `unavailable`；genuine subclass internal bytes保持可复制。Node driver、memory adapter、schema identity与 lifecycle normalization保持现行边界。

WP-141 HTTP client request bytes conformance：`httpClientRequestKey`、transport adapter 与 memory invocation 必须从 genuine typed-array internal slots 复制 caller body，使 lookup key hex 与 transport request 消费同一可信 bytes；Uint8Array subclass shadowed length不得造成 key 按空 body、network 按真实 body 的 identity split，Proxy/copy fault必须稳定收口 `invalid_request`。共享 snapshot helper返回 plain `Uint8Array`，调用后 mutation不得改变 key 或 transport body。response string contract、fetch transport、memory registry与 profile identity保持现行边界。

WP-142 Node fetch transport request body conformance：`prepareRequest` 必须先从 genuine typed-array internal slots 单次复制 body，再以内部分配 length执行 GET/HEAD empty-body validation并把同一内部 bytes交给 fetch；Uint8Array subclass shadowed length不得让非空 body 绕过 method/body rule，Proxy/copy fault收口 `invalid_request` 且 fetch 零调用。transport adapter/key/memory、headers/url/deadline/redirect与 response snapshot保持现行边界。

WP-143 db.sql bound parameters conformance：`sqlOperationKey`、memory invocation 与 driver adapter `copyRequest` 必须从 genuine typed-array internal slots 复制 `bound_parameters`，使 operation key hex 与 driver request 消费同一可信 bytes；Uint8Array subclass shadowed length不得造成 lookup key 空值与 driver真实参数的 identity split，Proxy/copy fault收口 `invalid_statement` 且 driver零调用。Node SQLite driver、statement/database/transaction与 outcome schema保持现行边界。

WP-144 random.bytes memory chunk conformance：constructor 必须以 genuine typed-array internal slots 复制每个 replay chunk；Proxy、shadowed iterator/length 与构造后 mutation不得替换随机 bytes，Proxy/copy fault稳定抛出 `TypeError`，genuine subclass按真实 internal bytes复制。queue、exact length、closed errors与 output copy保持现行边界。

WP-145 secret.read memory/deployment value conformance：两个 constructor 必须以 genuine typed-array internal slots 复制 Map value；Proxy、shadowed iterator/length 与构造后 mutation不得替换 secret bytes，Proxy/copy fault稳定抛出 `TypeError`，genuine subclass按真实 internal bytes复制。registry/name、not_found/unavailable、output copy与 Keychain adapter保持现行边界。

WP-146 macOS Keychain stderr bytes conformance：成功的 `spawnSync` stderr 必须先从 genuine typed-array internal slots 复制为内部 bytes，再由 password parser消费；Proxy、shadowed iterator/length 与返回后 mutation不得替换 secret output，Proxy/copy fault收口 `unavailable`。entry/path/stat/command policy与 password grammar保持现行边界。

WP-185 project-local currency boundary conformance：语言核心只提供 nominal closed sum，不得内置货币/国家白名单。reference expense project 在源码内声明 `currency = usd | cny`，内部 value 使用 exact `{variant}`；business executor 必须在 HTTP/DB host 调用前拒绝 text、undeclared variant 与 extra payload，保持 host 零调用。系统边界仅传普通 text variant name，adapter 不做 locale、大小写、ISO-4217 或 FX 推断；返回 text 包装为 nominal value 后必须再次通过项目 declaration，未声明值稳定 `business-function-output-invalid`。

WP-186 project-local currency SQLite boundary conformance：`AgentBusinessSqliteAdapter` 只消费 checked canonical input 与显式 `DatabaseSync`，通过现有 `ServerDbSqlDriverAdapter`/Node SQLite driver 执行固定 parameterized `SELECT`，不得接受 caller SQL 或内置币种白名单。数据库 bound parameter 的 currency 必须是普通 text variant name；结果必须是唯一 exact row，`approved` 仅允许 `0|1`，`outcome` 仅允许 `ok|err`，error variant 必须在 Agent contract closed sum 内，result currency text 包装回 `{variant}` 后仍由 project declaration 校验。缺失/重复/畸形 row、invalid SQL/transaction/driver fault 不泄漏 raw row、SQL、路径或宿主异常；只证明本机内存 SQLite read transaction 与 receipt trace，不证明生产 DB、写事务、pool、migration/ORM、credentials 或 Stable V1.0。

WP-187 SQLite file lifecycle conformance：`createServerDbSqliteFileHandle` 只接受显式绝对 `database_path` 与受控绝对 `root`，先验证 root/parent containment、regular file 与 symlink policy，再打开 `DatabaseSync` 并固定 `close` method；不得读取环境、当前目录或 URL-like path。handle 的 close 只执行一次，重复 close 返回稳定 closed outcome；损坏/外部篡改文件收口为不泄漏路径的 `invalid SQLite file handle`。真实文件经关闭、重开后继续由 `AgentBusinessSqliteAdapter` 以普通 text currency 完成 checked project-run 与 receipt verify；该证据不代表 pool、多连接、migration/ORM、PostgreSQL、生产部署或 Stable V1.0。

WP-188 SQLite connection-set conformance：`createServerDbSqliteConnectionSet` 只接受已创建的显式 file handle 与固定 1..8 `connection_count`，构造期打开唯一 `DatabaseSync` handles，不接受路径、环境或默认连接配置。`acquire` 超容量返回 `capacity`，lease 只属于创建它的 set；重复/跨 set release、close 后 acquire/release 均稳定拒绝。`close` 一次性关闭全部连接；串行 lease 可继续复用既有固定 SELECT 与普通 text currency boundary。该证据不代表生产 pool 调度、并发安全、隔离级别、busy/deadlock retry、migration/ORM、PostgreSQL 或 Stable V1.0。

WP-189 SQLite lease half-close conformance：file handle 的外部 `close` 必须通知并关闭依赖的 connection-set；set 后续 `acquire`、active lease `release` 与 lease-bound business adapter `invoke` 均 fail closed。lease 的 exact enumerable surface 只有一次性 `release`，不得暴露 `DatabaseSync`、`exec`、`prepare` 或 `close`；业务读取通过 set 创建的 lease-bound `AgentBusinessSqliteAdapter`，继续保持固定 parameterized SELECT 与普通 text currency projection。该证据不代表生产 pool/并发/隔离、busy/deadlock retry、migration/ORM、PostgreSQL 或 Stable V1.0。

WP-190 SQLite bounded wait-queue conformance：connection-set 构造必须显式限制 `wait_queue_limit` 为 0..32 并在构造期快照 timer methods；`acquireWait` 的 `timeout_ms` 必须是 0..60000 safe integer。连接可用时立即返回 opaque lease；满载时 waiter 严格 FIFO，队列超限返回 `capacity`。release 只向队首移交连接；timeout 必须原子移除 waiter 并返回 `timeout`，manual/file close 必须使全部 waiter 返回 `closed` 且清理 timer，禁止 timeout 后补发 lease。该证据不代表线程并发安全、写事务隔离、busy/deadlock retry、PostgreSQL 或 production SLA。

WP-191 SQLite default-Node-timer conformance：在不注入 `timers` 的真实默认 Node timer authority 下，满载 `acquireWait({timeout_ms:20})` 必须实际返回 `timeout`，释放 active lease 后后续 acquire 必须成功且不得出现 late lease；较长 waiter 在同步 release 后必须获得 opaque lease，等待超过原 timeout 后不得重复结算，证明 release 清除了默认 timer。该证据只证明单进程本机真实 wall-clock timer scheduling，不代表线程/进程并发、production scheduler/SLA、DB pool、隔离、PostgreSQL 或 Stable V1.0。

WP-192 SQLite wait cancellation conformance：`acquireWait` 只接受 exact `timeout_ms` 与可选 AbortSignal-like `signal`；signal 的 `aborted/addEventListener/removeEventListener` 必须在调用时单次读取并绑定。预取消返回 `cancelled` 且不得占连接；排队取消必须原子移除 waiter，禁止后续补发 lease。release、timeout、cancel、manual/file close 都必须单次结算并清理 timer 与 abort listener，signal capability 后续 mutation 不得改变结果。该证据不代表通用 backpressure/streaming、线程/进程并发、production scheduler/SLA、PostgreSQL 或 Stable V1.0。

WP-193 SQLite busy-timeout conformance：`createServerDbSqliteConnectionSet` 的 `busy_timeout_ms` 必须是 0..5000 safe integer，默认 0；构造期必须在任何 lease 发放前对首连接与全部新增连接应用同一固定 numeric `PRAGMA busy_timeout`，配置失败统一收口为 `TypeError('invalid SQLite connection set')`，且不得关闭 file handle 自有首连接。真实文件 `BEGIN EXCLUSIVE` 锁竞争必须在配置预算附近经既有 driver 映射为 `conflict`，再由 lease-bound business adapter 返回声明内 `transient`，不得泄漏 SQLite message；rollback 解锁后同一 set 必须恢复 typed result。不得自动 retry、接受 caller SQL、改变 isolation、维护币种/国家白名单或改变 DB/API 普通 text currency boundary。该证据不代表线程/进程并发、deadlock recovery、production pool/SLA、PostgreSQL 或 Stable V1.0。

WP-194 SQLite cross-process lock conformance：tracked test 必须以 `process.execPath` 参数数组启动独立 Node 子进程，不经过 shell；子进程只消费显式数据库路径，执行 `BEGIN EXCLUSIVE` 后通过 bounded line protocol 报告 ready。父进程通过 WP-193 的 lease-bound adapter 访问同一文件时，必须在 busy budget 内返回不含 raw SQLite/path/SQL 的 declared `transient`；父进程发送 exact release 后，子进程 rollback、close、报告 released 并以 code 0 退出，同一父 set/lease 随后恢复 project-local typed result。协议超时或提前退出必须终止/回收子进程并关闭 line reader，不得遗留后台进程或文件锁。货币 closed sum 仍由项目源码局部声明，DB/API 仍只传普通 text，不增加语言级币种/国家白名单。该证据只覆盖同机两个 Node 进程，不代表 production pool、scheduler/SLA、隔离选择、deadlock recovery、PostgreSQL 或 Stable V1.0。

WP-195 SQLite repeated-busy conformance：WP-194 子进程保持同一 EXCLUSIVE 锁且未接收 release 时，父进程必须在同一 lease-bound adapter 上连续执行至少两次显式 business invoke；每次都必须按配置的 busy timeout 独立等待并返回 byte-equivalent declared `transient`，不得因前一次失败路径遗留 transaction/token 而变为 `host-fault`、`invalid_transaction` 或无等待的 poisoned result。随后 exact release、子进程 rollback/close/code-0 exit 后，同一父 set/lease 必须恢复 project-local typed result。该测试不是 runtime 自动 retry；语言核心与 adapter 仍不维护币种/国家清单，DB/API currency 保持普通 text。该证据不代表 production deadlock recovery、pool scheduler/SLA、PostgreSQL 或 Stable V1.0。

WP-196 SQLite cross-lease busy-isolation conformance：同一 `connection_count=2` set 必须同时发放两个 opaque lease；WP-194 子进程保持 EXCLUSIVE 锁时，两个 lease-bound adapter 按确定顺序分别显式 invoke，每次都必须在配置的 busy-timeout 窗口返回 byte-equivalent declared `transient`。一个 lease 的 begin/query/rollback failure 不得改变另一 lease 的 transaction/token authority；exact release 与子进程 rollback/close/code-0 exit 后，两个 lease 都必须恢复 project-local typed result。该测试只证明两个物理 SQLite 连接的串行隔离，不声称真正并行调用或 production pool；语言核心与 adapter 仍不维护币种/国家清单，DB/API currency 保持普通 text。

WP-197 module-local closed-sum conformance：tracked project fixture 必须让同一项目的两个模块各声明 local name `currency`，但使用不同 variants；project loader 输出必须同时保留两个全限定声明及各自 exact declaration digest，不得报 package-global duplicate name。将两项声明放入同一 canonical value registry 后，每个 declared reference 只接受自身 variants，交叉 variant 稳定返回 `unknown-sum-variant`。该规则适用于任意业务枚举，不为货币、国家或 ISO-4217 增加语言核心清单；DB/API currency 仍是普通 text。

WP-219 real host adapter evidence conformance：`re.real-host-adapter-evidence@0.1.0` 必须绑定当前 platform/architecture/Node version 与实际参与实现、fixture、test 的逐文件 SHA-256。Measured workload 固定为三项且顺序不可漂移：(1) `sqlite-cross-process-lock` 复用 WP-194 的无 shell 独立 Node 子进程与显式数据库路径，必须观察 declared `transient`、子进程 rollback/close/exit 0 及同一父 lease typed recovery；该拓扑只能记为 `same-host-two-node-processes`。(2) `loopback-tls-bearer-auth` 使用运行时临时生成、测试结束即删除的自签测试 CA/server key，只监听 loopback；Node TLS transport 仅接受 `https:`、无 URL credentials、显式 CA、`redirect=reject` 和有界 deadline，显式 `Authorization: Bearer ...` 必须产生可信 CA 200 与错误 token 401，trust/deadline/connection fault 不得泄漏 URL credential、token、证书路径或宿主错误。(3) `deployment-secret-lifecycle` 只证明构造时注入 Map 的 bytes snapshot 被复制，close 清零内部副本并清空 registry，关闭后读取为 declared `unavailable`，重复 close 为 `closed`，不得改变 caller bytes。`external-secret-manager` 与 `independent-physical-host` 必须保持 pending，reason 固定说明缺少外部 endpoint/credentials 与第二物理 host custody；不得用 loopback、Docker、同机进程、memory fixture 或同步重签 report 冒充 measured。该证据不证明生产 PKI、公共 CA、mTLS、OAuth/OIDC、token rotation、HSM、跨机器 DB/secret custody、production SLA 或 Stable V1.0。

WP-220 real host evidence file authority conformance：报告的 `files` 不得由调用方传入可复制的 digest 数组充当 authority。`createRealHostAdapterEvidenceFileAuthority({root})` 必须只接受显式绝对 repository root，先 realpath root，再按固定、顺序严格的 11 路径清单读取 regular file；每个 candidate realpath 必须仍在 root 内，缺文件、非 regular file、路径越界或 symlink escape 均拒绝。该 authority 只以模块私有 `WeakMap` token 表示；create/verify 只接受 exact `{fileAuthority}`，缺省、raw digest array、clone 或 object forgery 必须以 `real-host-evidence-file-authority-required` fail closed。verifier 还必须拒绝 report file path inventory 漂移，即使攻击者同步重签 `report_digest`。该 token 是同一 Node 进程内从真实磁盘重算的 authority，不是跨进程签名、宿主公证或环境真实性证明；environment 自报自证、同机虚拟化 Linux、loopback/self-signed CA、显式内存 secret snapshot、外部 secret manager 与第二物理 host pending 边界均保持不变。

WP-211 task lifecycle conformance：`executeTask` 可显式接收 parent signal、`timeout_ms`、timer functions 与一个 owned resource，performer 只接收内部 `AbortSignal`。parent/timeout race 必须 first-reason-wins；取消在 performer 返回前发生时，未提交 success effect 不得落盘。signal 的 add/remove/aborted、timer functions 与 resource close 必须 startup 前单次读取并用 intrinsic bind 固定；registration/timer setup fault 要回滚 listener并关闭 resource，后续 getter/method replacement不得替换 authority。每条 terminal、checkpoint 拒绝与 host fault路径都必须按 timer、listener、resource 全部尝试一次 cleanup，包含 `null` timer handle；已有主诊断优先，正常 terminal 的首个 cleanup fault稳定收口 `invalid-task-timeout|invalid-task-signal|task-resource-close-failure`。resource close fault撤销本次新 effect，replay effect和旧 `cancel_at=after_start` 已提交主 effect语义不变。该 seam 不是 detached task、distributed cancellation、持久 scheduler、OS process supervisor 或 Stable V1.0。

## 12. Node structured-concurrency reference runtime

`executeConcurrencyPlan(plan, options)` 是 runtime conformance seam，不是新的 `.re` source grammar，也不是 Server adapter。它只接受单根 `re.concurrency-plan@0.1.0`，通过显式 `Map<branch, runner>` 建立全部 branch；runner 只能用 `runEffect(effect, operation)` 按 plan order edge 调用一次当前 effect。trace 使用 `re.concurrency-trace@0.1.0`：所有 `branch-spawn` 必须先发生，随后记录 effect lifecycle、branch terminal 和唯一 `region-exit`。

`parentSignal` 与显式 monotonic `deadline` 通过注入的 `now/setTimeout/clearTimeout` 触发向下取消；runtime 等待 runner cleanup 后才退出。cooperative in-flight effect 在取消后记录 `effect-cancelled`，不得伪造 completion；`complete-before-join` 允许 operation 在取消后完成，并记录非负 `cancel_latency_ms`。host fault 先记录 active branch 的稳定 `fault_ref`，再取消/等待 siblings；错误文本与 stack 不进入结果。生成 trace 必须由 `verifyConcurrencyTrace` 通过。

当前实现与 conformance 覆盖正常 join、显式 effect dependency、parent/deadline cleanup、host-fault sibling cleanup、malformed/unknown runner/effect fail-closed 和 10,000 empty branch soak。

WP-41/42 增加 recursive nested par runtime：每层父 runner 通过 `runNested(region_id, childRunnerMap)` 显式绑定 plan 中当前位置的 child region；child scope 使用完整 `scope_path` 记录 branch/effect/region 事件。root cancellation 通过直接父 `AbortSignal` 逐层传播，每个 child region 先记录 `region-cancel(parent)`，等待 descendant terminal/exit 后父 branch 才能 terminal。深层 host fault 先记录 fault branch，再取消同层 siblings，并经每层 `region-exit(host-fault)` 逐级传播到 root；cooperative 与 complete-before-join effect 在任意层复用同一 lifecycle/latency contract。每层可用 `maxConcurrentBranches` 设 FIFO admission 上限；queued branch 只收口为既有 `branch-cancelled`，不执行 runner、不新增 trace kind。Reference runtime 的 `re.concurrency-scheduler@0.1.0` summary 按 `scope_path` 暴露 `admitted` 与 `queued_cancelled` 顺序，供 conformance/audit 验证，不宣称 wall-clock fairness 或 production scheduler。plan 最多 32 层 region，超限在 runner 启动前 fail closed。detached task、stream/channel、OS scheduler、persistent handles、fairness/priority、distributed cancellation、retry 与 production latency budget 仍 deferred。`

该 runtime 不读取全局环境、wall clock、entropy 或默认 OS keychain 搜索列表；它只在显式 options seam 中接收 parent signal、deadline、clock/timer 和 runner Map。`re.concurrency-scheduler@0.1.0` 只记录确定的 FIFO admission/cancel summary，不证明 wall-clock fairness。

该切片不宣称 secret rotation/write/audit、跨平台或外部 secret store、真实日志/trace transport、sampling、自动 span lifecycle、JSON schema compiler/validator、生产 TLS/PKI/OAuth/mTLS、HTTP streaming、跨机器 SQLite/生产 pool、PostgreSQL、隔离级别选择、deadlock retry 或 ORM 已实现。
