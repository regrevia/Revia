# 01 · 语法（re 0.1）

本文档定义两套形态：

- **compact 形态**：人/Agent 写入时用，省去可推断的命名/类型/序。
- **canonical 形态**：`re check` 规范化输出、Git 存储、可逆序列化的目标形态。

两者 desugar 后**对应同一张程序图谱**。desugar 规则见 [04-translation.md](04-translation.md)。

> 语法用 ABNF-ish 描述，`//` 行注释。canonical 节点身份字段已在 §8.1 固定；其余文法仍可在 [06-open-questions.md](06-open-questions.md) 打磨。

> 当前 production Demo 仍执行历史 S1 形态（`@unit/@cap/@fn`）；V1 冻结候选是 S2（bare semantic symbol、`$capability`、`%compact_alias`）。两者只在 grammar bake-off 中并行，不能在同一 source 中混用或由 parser 猜测迁移。

---

## 1. 顶层结构

```abnf
program      = version-header unit-decl* cap-decl* fn-decl*
version-header = "re" SP version SP source-form NL
version      = 1*DIGIT "." 1*DIGIT
source-form  = "compact" | "canonical"
unit-decl    = "unit" SP ident NL
cap-decl     = "cap" SP ident ":" SP capability-ref NL
capability-ref = type ["@" schema-revision]
schema-revision = 1*DIGIT "." 1*DIGIT "." 1*DIGIT
fn-decl      = "fn" SP ident param-list? SP "->" SP type SP block
```

`version-header` 必须是文件第一物理行，使用精确 ASCII 空格与 LF；BOM、前导空行、前导注释、Tab 和 CRLF 都不允许。注释放在 header 之后。解析器先按语法读取 version，再由 version dispatcher 报 `unsupported-language-version`，不得把未来版本误报为 header 语法错误。

- `unit @hello`：全局稳定的模块身份。
- `cap @stdout: process.stdout@0.1.0`：被授予的外部 capability interface instance，前置声明，禁止未声明使用。RE Dev Demo 的宿主 capability 必须固定 revision；早期样例中的无 revision 形式仍是待迁移的草案简写。
- `fn`：函数节点，是图的入口/可调用单元。

`ident` 前缀语义：

| 前缀 | 含义 | 命名要求 |
|---|---|---|
| `@name` | 全局稳定身份（unit / cap / fn / 导出项） | 必须 |
| `%name` | 局部节点别名（值节点 / effect 节点） | **可选** |
| `_` 或省略 | 无 alias 的节点 | UID 在创建事务中生成，label 由 UID 派生 |

> 关键修正：**身份 ≠ 命名**。`%name` 是可选 alias，不是 UID；canonical 另携带完整 UID 和由 UID 派生的短 label。无 UID 的 compact 输入视为创建事务。详见 [00-overview.md §4 方向 1](00-overview.md)。

S2 中 compact alias 必须匹配 `%` + bare symbol，且**不得以 `%u` 开头**；`%u` + 7 位 lowercase base32 全部保留给 canonical label。canonical label 出现在 compact alias 位置必须报 `reserved-canonical-label`，不得静默改义。

## 2. 字面量与内联调用

```abnf
literal      = string | number | bool
string       = %x22 ... %x22          // UTF-8，转义规则见 §6；值在 lowering 前规范化为 NFC
number       = int | decimal
int          = ["-"] ("0" | NZDIGIT *DIGIT)
decimal      = ["-"] ("0" | NZDIGIT *DIGIT) "." 1*DIGIT
bool         = "true" | "false"

inline-expr  = literal
             | ident-ref
             | call-inline
call-inline  = type "." name arg-list   // 如 @stdout.write(...)
              | cap-ident "." name arg-list
```

内联字面量 → 新建 literal 节点并分配 UID，数据边自动接到所在参数。
内联调用 → 新建 effect/value 节点；`%name =` 只绑定 alias。

V1 numeric token 不接受前导 `+`、指数、下划线、整数部分前导零、`.5`、`1.` 或负零（`-0`、`-0.0...`）。`int` 与 `decimal` 均保持原始十进制文本，不经过宿主 `Number`；decimal 的 scale 等于小数点后的位数，因此 `1.0` 与 `1.00` 的类型分别为 `decimal<1>` 与 `decimal<2>`。production parser 已共享这套 numeric surface 诊断，支持任意精度有符号 int 和 scale `1..255` 的 decimal；scale 超界报 `decimal-scale-out-of-range`。当前 Demo 没有消费 decimal 的 operation，传给 integer operation 时按 exact type mismatch 拒绝，不做隐式转换。

## 3. 语句

```abnf
block        = "{" NL stmt* "}" NL
stmt         = bind-stmt | return-stmt | control-stmt
bind-stmt    = [ident SP "=" SP] expr NL          // %name = ... 或裸 expr
return-stmt  = "return" SP expr NL
expr         = inline-expr | typed-const
typed-const  = type ".const" arg-list             // 类型显式字面量的等价显式写法
```

- `%printed = @stdout.write("Hello, World!\n")`：绑定别名 + effect 节点。
- `return process.exit(0, after: %printed)`：返回节点。
- 裸 `expr`（不绑定、不 return）：节点仍入图，结果未被引用时 `re audit` 报「未处理结果」。

## 4. 参数与命名调用

```abnf
arg-list     = "(" [arg ("," SP arg)*] ")"
arg          = name SP ":" SP expr
             | expr                       // 位置参数：仅限约定好的“主值参”，见 §5
```

- **命名参数为主**：`channel: @stdout, data: %message`。
- **位置参数受限**：只为「主值参」这一个约定槽位允许裸 `expr`，避免位置猜测泛滥。是否保留位置参，见 [06](06-open-questions.md) 的 Q-arg。

## 5. `after:` 与序边（关键修正）

两条规则（详见 [02-semantics.md §3](02-semantics.md)）：

1. **传值进参数 = 自动建立 数据边 + 序边**。例如 `io.write(data: %message)` 隐含 `%message` 先于写入完成，**无需** `after: %message`。
2. **`after: e` 只用于「需要 e 先发生但不消费 e 的值」的纯序边**。例如 `process.exit(code: 0, after: %printed)`——exit 不消费 printed 的值，只要求写入先完成。

图里两种边显式区分：
- `value edge`：数据依赖，来源 = 实参引用。
- `order edge`：仅序依赖，来源 = `after:`。

`after:` 在直线代码里几乎消失。

## 6. 类型

```abnf
type         = ident ("." name)*            // 如 io.write, text.utf8, process.status
             | type "<" type-list ">"       // 参数化，如 list<text.utf8>
```

- 写入时类型可省（靠推断），canonical 形态**必填**。
- 不允许隐式类型转换；转换必须显式节点（如 `text.utf8.from_int(...)`）。
- V1 类型语义已固定为 primitive、`decimal<scale>`、nominal record/closed sum/newtype、`option/result`、immutable collection、opaque resource 与显式泛型；trait、继承、反射、float 和隐式协议解析不进入 V1，详见 [02-semantics.md §9](02-semantics.md)。
- 本节 ABNF 仍只是 type reference 的公共骨架；numeric token 已由 §2 固定，但 nominal declaration 与完整 expression grammar 仍须由 P0-02 的单一 production grammar 回填，不能从 type contract prototype 反推第二套 parser。

## 7. 注释与 annotation

```abnf
comment      = "//" ... NL
annotation-reserved = "#[" ...                  // V1 保留前缀但不接受任何形态
```

- V1 compact lexer 在检查 ASCII trivia 后直接丢弃注释；注释不进入 token stream、CST、Program graph、canonical 或 sidecar，插入/删除注释不得改变 normalized CST。
- `#[` 是为未来 annotation 保留的独立词法前缀；V1 在任何位置都报稳定 `unsupported-v1-annotation`，不得当作 comment、普通 atom 或未知节点静默忽略。
- annotation placement、参数和语义整体推迟到 V1.x；V1 canonical serializer 不输出 annotation。

### 7.1 Source diagnostic 契约

Header、compact lexer 与 parser 的 source error 使用 `re.source-diagnostic@0.1.0`。每条诊断至少包含：

- `code`、`severity`、`phase` 与 `rule`；
- `file`、zero-based half-open UTF-8 `byte_start/byte_end`；
- one-based Unicode-scalar `line/column/end_line/end_column`；
- 原始 `lexeme` 与 machine-readable `repair`。

同一 source bytes、grammar profile 与 release lock 必须产生相同 primary diagnostic。新增字段允许前向扩展，但未知 schema major 必须 fail closed；Agent 不应从自然语言 message 反推位置或修复动作。

当前 production executable slice 的 header authority 是 `re.executable-grammar-profile@0.1.0`：版本 `0.1`，source form 闭合为 `compact|canonical`。Parser header dispatch、canonical serializer/loader 与 preview release lock 必须共同消费该 profile，不得各自复制版本或 header；它不提前冻结尚未进入 production grammar 的 type/loop/par source。

## 8. canonical 形态示意

compact：

```re
re 0.1 compact
unit @hello
cap @stdout: io.write

fn @main() -> process.status {
  return process.exit(0, after: @stdout.write("Hello, World!\n"))
}
```

canonical（由 `re check` 规范化产出，示意为展开后形态，真实规范见 [03-serialization.md](03-serialization.md)）：

```re
re 0.1 canonical
unit @hello

cap @stdout: io.write

fn @main() -> process.status {
  %u3kf2a2b: uid("3kf2a2bc4de6fg7h2j4km6np7q"): text.utf8 = text.utf8.const(value: "Hello, World!\n")

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

- 以上 `%u...` 是 UID 派生的 label；完整 UID 字段使用 `uid("...")` 携带。
- 匿名字面量 `"Hello, World!\n"` → 一个带 UID 的 literal 节点，label 仅作文本短写。
- 内联调用 `@stdout.write(...)` → 一个带 UID 的 effect 节点。
- `effect` 是节点类别而不是值类型；本直线示意把无业务成功载荷、且 capability contract 不暴露失败的 `@stdout.write` 写成 `unit`。若 op 可失败，其类型必须是 `result<unit, io.error>`，并显式消费结果，见 [02-semantics.md §7](02-semantics.md)。
- `0` 字面量 → canonical 里 inline 仍可保留为字面量，或等价展开为匿名数字节点（取决于数值规范，见 [03](03-serialization.md)）。
- 键序按名字排序：`after` < `channel` < `code` < `data`（字典序）。

## 8.1 canonical 节点身份字段

canonical 节点定义行固定使用以下形态：

```abnf
canonical-node = label ":" uid-field ":" type SP "=" SP expr NL
label          = "%" "u" base32{7}
uid-field      = "uid(" DQUOTE base32{26} DQUOTE ")"
uid-ref        = label | uid-field
base32         = %s"abcdefghijklmnopqrstuvwxyz234567"
```

- `label` 是 UID 的前 7 个 base32 字符，必须在同一 `unit` 内唯一；冲突报 `ambiguous-label`。
- `%u` 前缀整体保留给 canonical label；compact alias 不得使用 `%u`、`%user` 或其他 `%u...` 形态。
- 同一 `unit` 内的普通边使用 `label`；跨 unit 引用、Agent patch 和诊断使用完整 `uid-field`。
- `uid-field` 是身份字段，不是运行时参数；解析后还原为节点 UID。
- 26 位 UID 必须能解码为恰好 16 bytes；最后一个 base32 字符的两位 padding bits 必须为零，不能只检查字符数。
- 本段只是身份字段约束，不是完整 canonical body grammar；具体节点族由 serializer 唯一决定。需要 round-trip 的 alias 必须使用该节点族的显式字段，不能用 `// alias:` 旁注承载。
- 不允许自动延长 label、同一文件混用短长引用或把 UID 放入普通注释。

## 9. 文法待打磨清单

写入效率与确定性的取舍集中在以下几点，详见 [06-open-questions.md](06-open-questions.md)：

- Q-arg：位置参数是否只保留「主值参」一个槽位？
- numeric token 已固定为 §2 的任意精度 int / fixed-scale decimal；production parser、checked graph 与 canonical value family 已迁移，现有 executable fixtures 与 canonical-decimal golden 已固定。剩余工作是冻结并接入 decimal operation、后续规范样例 golden；不再开放宿主 Number、指数或 float 语法。
- production executable slice 已支持参数基数为零的 `process.args@0.1.0.read()`，并以 `args-check.re` + canonical golden 固定 compact → checked graph → runtime → serializer 路径；当前仍不提供 list 索引、遍历或参数回显表达式，不能从零参数调用完成推断出更宽的 expression grammar。
- Q-syntax：完成 S2 grammar 真源与 production migration；`@x` 历史 S1 只作为迁移输入证据。
- Q-string：字符串转义、多行串、原始串。
