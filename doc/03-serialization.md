# 03 · 确定性可逆序列化规范

这是 RE 最关键、也最容易翻车的一块。它决定了 `.re` 文本能否真正「可逆、确定性、Git 友好」。任何能通过 `re check` 的实现，对同一张图谱必须输出 **byte-identical** 的 canonical 文本。

> 本规范是**强约束**：违反任一条都会让 diff 产生噪音，让 Agent 的「改图 → 重序列化」回路退化。

## 1. 不可逆输入禁止

canonical 序列化必须是从图谱到文本的**纯函数**。因此要求：

- **不依赖源文件写法**：compact 与 canonical 的两种写法，若 desugar 后图谱等价，canonical 必须相同。
- **不依赖人取名的口味**：人类别名 `%message` vs `%m` 不影响图谱身份和语义等价；需要 round-trip 的 alias 必须占用节点族明确定义的 serializer 字段，不能伪装成注释，见 §8。
- **不依赖构建环境**：不读环境变量、不读时钟、不读随机。
- **不依赖解析顺序**：解析器先读 A 后读 B，与先 B 后 A，canonical 一致。

## 2. 节点身份（identity）规范

节点身份与文本句柄分为四层：

- **UID**：v1 的 compact creation 使用 `re.deterministic-uid-sequence@0.1.0`，按固定 graph traversal 顺序分配 26 个 lowercase base32 字符的 UID；同一 compact bytes 在全新进程和目录中必须得到相同 UID。canonical/structured 重入保留已有 UID，不得重分配、重编号或根据内容重新推断身份；UID 写入后不可变。
- **CID**：可选的 revision digest，只在 schema/region 定义了可哈希规范形态时存在。CID 不参与执行、patch、诊断、canonical 可逆性或 set 排序；循环图 CID 留待 SCC/region 方案。
- **label**：UID 的固定 7 位 base32 前缀（35 bit），用于 canonical 文本内连边和人类阅读。作用域内前缀碰撞必须报 `ambiguous-label`，不得自动延长、混用或静默截断。
- **alias**：可选的人类语义名。它不参与身份、语义等价和 patch 引用；若某节点族保留它，必须由该节点族的 canonical grammar 提供显式字段。

canonical 节点定义行固定携带完整 UID 与 label，具体文法见 [01-syntax.md §8.1](01-syntax.md)。普通边引用 label，Agent patch、跨文件引用和诊断使用完整 UID。

无 UID 的 compact 输入视为创建事务：每个新节点获得新 UID；不同机器规范化同一段无 UID 文本得到不同 UID 是预期行为。确定性保证分三层：

1. 同一张带身份图谱必须输出 byte-identical canonical，且 round-trip 保留 UID。
2. 语义等价比较忽略 uid、label、alias，只比较结构、类型、边、容器和 effect 约束。
3. 增量编辑中，未触及节点的 UID 不变。

## 3. 键序（argument order）

- canonical 中所有命名参数**按名字字典序（codepoint order）排列**，不按源序。
- 例：`process.exit(code: 0, after: %u7q2mxc2)` → canonical 排为 `after, code`：
  ```re
  %u5v4r2te: process.status = process.exit(
    after: %u7q2mxc2,
    code: 0
  )
  ```
- 命名参数是 canonical 的**唯一**参数形态；位置参数只在 compact 出现，desugar 时翻成命名参数。

## 4. 空白与换行

- 缩进：由 serializer 针对每种 canonical line 固定，禁止 Tab。
- canonical 不接受自由空行；只有 serializer 实际输出的换行位置合法。
- 参数表：≤1 个参数单行；≥2 个参数强制**每参一行**，末参带尾逗号，`(` 与首参换行后开始，`)` 单独成行（见 §6 canonical 例）。
- 行尾无空格；文件以单换行结尾（LF，禁止 CRLF）。
- 注释与 annotation：V1 canonical 一律不允许；loader 只接受与 serializer 输出 byte-identical 的文本。

## 5. 数值、字符串与 value container

- **整数**：V1 `int` 本身就是任意精度有符号数学整数；canonical 使用 base-10，无前导零（`0` 除外）、无 `+`、无负零，不另设 `int.big`。
- **十进制**：`decimal<scale>` 的 scale 为 `0..255`；canonical 必须恰有 scale 位小数，无 exponent、`+`、前导零或负零。舍入是显式 operation 语义，不由 serializer 猜测或读取宿主环境。
- **浮点**：V1 Core 不提供 binary float type/literal。外部 tensor/buffer 先通过 opaque resource；未来 float 必须另行固定 NaN、Inf、负零、比较与 canonical bit pattern。
- **字符串**：值必须是 Unicode scalar sequence；孤立 surrogate 拒绝。转义仅保留必要最小集（`\n \t \" \\ \uXXXX`），禁止裸控制字符，canonical 规范化为 NFC。
- **bytes**：canonical value protocol 使用 lowercase 偶数字节 hex；不得通过 host string 或 locale 转码。
- **map/set value**：只允许冻结的 scalar/newtype key，按 bool、数学数值或 UTF-8/原始 bytes 的类型语义总序排列；不按 JSON 文本、宿主 hash 或插入顺序。NFC/数值规范化后重复的 key 稳定拒绝。

## 6. canonical 文本骨架

```re
re 0.1 canonical
unit @hello

cap @stdout: io.write

fn @main() -> process.status {
  %u3kf2a2b: uid("3kf2a2bc4de6fg7h2j4km6np7q"): text.utf8 = text.utf8.const(
    value: "Hello, World!\n"
  )

  %u7q2mxc2: uid("7q2mxc2de4fg6h2j4km6np7r5q"): unit = @stdout.write(
    channel: @stdout,
    data: %u3kf2a2b
  )

  %u5v4r2te: uid("5v4r2te6yu2i4o2p4a6s2d7f2q"): process.status = process.exit(
    after: %u7q2mxc2,
    code: 0
  )

  return %u5v4r2te
}
```

注：本节代码是早期结构示意，不是 loader 的规范输入；其中空行不得据此进入 V1 canonical。实际合法字节只由当前 serializer 产生，loader 必须执行 load 后 byte-equal serialize。`effect` 是 node kind，不是值类型；本骨架用 `unit` 表示该示意 op 无业务成功载荷。可失败 op 必须改用 `result<T, E>` 并消费结果。

## 7. 可逆性（round-trip）

- **图 → canonical → 图**：解析 canonical 还原的图谱，必须与原图谱**结构等价**（同节点集、同边集、同类型、同身份）。
- **compact → 图 → canonical**：与「compact → canonical 直接 desugar」结果一致。
- **canonical → canonical**：幂等（再跑一次 `re check` 输出不变）。

可逆性测试是实现的验收基线：随机生成图谱 → 序列化 → 解析 → 再序列化，必须 byte-identical。

当前可执行 `0.1` slice 的 header 与 canonical schema identity 来自 `re.executable-grammar-profile@0.1.0`；serializer 和 loader 不得单独维护 `re 0.1 canonical`。支持面由 `src/toolchain/canonical.js` 导出的 `CANONICAL_GRAPH_SLICE` 明列，而不是从 loader 正则反推：身份节点为 `call/cap/function/let/literal/match/match-branch/return`，call target 为 `capability-member/pure-operation`，literal family 为 `bytes/decimal<scale>/fs.path/int/text.encoding/text.utf8`。serializer 遇到清单外 node kind、target kind、literal type 或结构槽位必须拒绝，不能丢弃或重解释；六个 compact executable fixture 固定 parser→serializer byte-exact golden，`canonical-decimal.re` 另固定 canonical source→serializer golden；corpus 强制每个 graph case 声明其 source form 和 golden。每次扩展节点族必须同时增加确定 UID 的 serializer golden、byte digest、loader round-trip 和负向 mutation。

### 7.1 Revision-pinned project patch

`re.project-patch@0.1.0` 是已检查 project graph 的结构化变更载体，不是自由文本替换。patch 必须携带当前 `graph_revision`；每个受影响的既有 module 或 nested identity 必须携带 UID precondition。实现必须在结构化 clone 上按声明顺序 apply，再完整检查 module identity、依赖 DAG、capability allowlist、fact ledger 和可选 checked-graph hook；任一步失败都不得部分写回原 project。rename/move 只能改变名称或路径字段并保留历史 UID；新增 identity 只能由本次 transaction 的 UID factory 分配，不能由调用方伪造或复用既有 identity。

成功结果必须返回新的 graph revision、canonical operations、稳定 `re.project-patch-receipt@0.1.0`、patch digest 和 changed fact IDs。digest 只绑定 base revision、operations 和 result revision，不绑定 host path 或声明顺序之外的隐式状态；changed fact IDs 必须来自同一 revision-pinned fact ledger。stale revision、missing/stale UID、duplicate identity、dependency cycle、capability escalation、check failure 和任何 operation error 都必须 fail closed。此 patch seam 不定义 distributed merge、translator backend、UI DSL 或自然语言审阅 authority。

## 8. label / alias / CID

canonical 中同时保留三种不同职责的文本句柄：

- **label**：`UID` 的固定 7 位 base32 前缀（35 bit），只用于文本内连边与人类阅读；若短写碰撞，`re check` 报 `ambiguous-label` 硬错误，不自动延长或混用。
- **alias**：人类可读别名；它不参与身份、等价判断或 patch 引用。需要保留时必须位于 serializer 为对应节点族定义的显式字段，不能用 `// alias:` 旁注承载。
- **CID**：可选派生 revision digest，仅在 schema/region 明确定义可哈希规范形态时存在；它不参与 set 排序，也不替代 `UID`。

- `label` 与 `alias` 分工不同：`label` 是规范短句柄，`alias` 是人类旁注。
- 删除 alias 不影响语义等价；若节点族声明 alias 参与 round-trip，serializer/loader 必须显式、对称地携带它。`label` 碰撞则必须显式失败。
- `UID` 不能放进普通注释中冒充句柄，必须作为 canonical 的语义字段存在。
- V1 普通 `//` 注释只存在于 compact 输入并由 lexer 丢弃；不进入图谱正典，也不建立 source sidecar。未来 source-preserving tooling 必须另行定义 revision/anchor 失效规则。

## 9. annotation 的序列化

V1 不接受 annotation。`#[` 只保留为未来词法域，compact 输入稳定报 `unsupported-v1-annotation`，canonical serializer 不输出 annotation，loader 也拒绝含 annotation 的字节。annotation placement、参数、身份和 canonical 表达必须在 V1.x 以独立 schema、corpus 与 round-trip 规则重新进入讨论，不能沿用旧的 `@annotation(...)` 草案。

## 10. 待定项汇总（影响序列化）

Q-num/Q-type 的 V1 value 规则已经由 `V1-P0-04` 收敛，numeric source token 由 P0-02 固定为无前导 `+`、无指数/下划线/前导零/负零的任意精度 int 与 fixed-scale decimal；decimal scale 等于小数位数，解析阶段保留原始十进制文本且不得经过宿主 float。当前 executable canonical slice 已覆盖任意精度 `int` 与 `decimal<0..255>` literal family，manifest、serializer、loader、两代 byte-idempotence 和 canonical-decimal golden 同步扩展；尚未冻结的 decimal operation、规范样例和完整 canonical 节点族仍未覆盖。V1 canonical 的空白、comment、annotation、numeric value 与 container key 边界均由 serializer/corpus 固定；每个新增节点族仍须增加 byte-identical golden，不能以通用 fallback 扩大接受面。
