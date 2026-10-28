# 00 · 设计理念与定位

## 1. 它是什么

RE 是一种 **AI 原生语法**。它的正典（ground truth）不是文本，而是**带类型的语义图谱**：

```
RE 程序图谱（正典）
   ↕  确定性、可逆的序列化
.re 文本（载体）
   ├→ 执行
   ├→ 验证（check / audit）
   └→ 人类翻译（view）
```

`.re` 文本**不是给人类手写的高级语言**，而是程序图谱的文本载体。Agent 后续可以通过**结构化 API** 直接修改图谱；人类和 Git 负责保存、比较 `.re` 文本。

定位：比机器码高级，比传统高级语言更接近执行结构。未来可逐步 lowering 为：

```
RE 程序图 → RE Core IR → WASM → ARM64 / x86-64
```

## 2. 设计原则（不变量）

1. **所有值都有明确类型**（写入时可省略，规范器推断后唯一确定）。
2. **所有外部能力必须显式声明**（capability 前置）。
3. **所有副作用必须显式**（effect 节点）。
4. **副作用执行顺序必须显式**（序边）。
5. **参数尽量使用名称**，不依赖位置猜测。
6. **不允许隐式类型转换**。
7. **不允许隐式全局变量**。
8. **每个节点都有稳定身份**（身份 ≠ 人类命名，见 §4）。
9. **相同程序必须生成相同程序图谱**（确定性序列化，见 [03-serialization.md](03-serialization.md)）。
10. **错误必须精确关联到节点、参数和约束**。

## 3. 第一版样例暴露的三个核心矛盾

原始 v0.1 草案的 Hello World：

```re
re 0.1 compact
unit @hello
cap @stdout: io.write

fn @main() -> process.status {
  %message: text.utf8 = const(value: "Hello, World!\n")
  %printed: effect = io.write(channel: @stdout, data: %message)
  %status: process.status = process.exit(code: 0, after: %printed)
  return %status
}
```

它立得住的地方：capability 声明、副作用显式、序显式、稳定身份。
它暴露的矛盾：

- **① 自称 token 高效，实际反 token 效率。** 每个参数命名、每个中间值命名、每个序写 `after:`——Hello World 15 行。若 Agent 还以文本为主要读写回路，这是更重不是更轻。
- **② 「可逆、确定性序列化」只断言没给规则。** 任意实现都要 byte-identical 吐出来，必须规定键序/空白/身份/容器序/去重，否则 diff 全是噪音。
- **③ `after:` 把数据边和序边压成一个原语。** 验证器、优化 pass 会产生歧义。
- **④ 控制流/并发/错误故事完全没露面。** 直线代码任何设计都好看。

## 4. 破法：四条方向（本版据此重做）

### 方向 1：身份 ≠ 命名（最大杠杆）

「每个节点都有稳定身份」≠「每个节点都有人类名字」。

- 身份 = 持久 `UID`；内容变化摘要另由可选 `CID` 表示。
- 人类名字 = **可选 `alias`**；canonical 文本另有由 UID 派生的短 `label`。
- 只有**被跨节点引用、跨模块暴露、或人想强调语义**的节点才命名。
- 字面量、中间结果可以没有人类 alias；节点 UID 在创建事务中生成，写入后不可变。

同一张带身份图谱的 canonical 序列化仍然确定；没有 UID 的全新 compact 输入视为创建事务，不承诺跨机器生成相同 UID。

### 方向 2：传值即定序，`after:` 只用于纯序边

样例里 `io.write(data: %message)` 没写 `after: %message`，说明已隐含「传值即定序」。把规则说清楚：

- **传一个值进参数 = 自动建立 数据边 + 序边**（默认，不写 `after`）。
- `after:` **只用于「需要它先发生但不消费值」的纯序边**。

一刀切下去：直线代码里 `after:` 几乎消失；图里 value edge / ordering edge 干净区分，验证器和优化 pass 反而更好做（解掉矛盾 ③）。

### 方向 3：字面量与调用内联，不预绑定每个值

「先 `%x = const(...)` 再用 `%x`」是把 SSA 命名暴露给人。允许：

```re
%printed = @stdout.write("Hello, World!\n")
return process.exit(0, after: %printed)
```

- 字面量内联 → 新建 literal 节点，分配 UID，数据边自动接到参数。
- 调用内联 → 新建 effect/value 节点；`%name` 只是可选 alias，label 由 UID 派生。

### 方向 4：`re check` 当 gofmt，而不是再造第二门语言

不要走「再造一门高级语言编译到 .re」的路——会冲掉「.re 是图谱载体」的定位。让方向 1–3 的简写成为 **.re 自己的语法糖子集**，并保证：

- 糖的 desugar 是**纯函数、确定性**。
- `re check` 顺带做**规范化输出**：补缺名、排键序、统一空白，emit canonical .re。
- 人只 commit canonical 形态；写的时候可用糖省事，`re check` 一过就变 canonical。

「写起来轻」与「diff 稳定、可逆」不冲突：轻是糖给的，稳是规范化器给的。

## 5. compact → canonical → 图谱

四条方向合起来，可写形态（compact）变成：

```re
re 0.1 compact
unit @hello
cap @stdout: io.write

fn @main() -> process.status {
  return process.exit(0, after: @stdout.write("Hello, World!\n"))
}
```

`re check` 之后，规范化器吐回等价的 canonical 形态（节点都带身份、类型、序），图谱不失真；`re audit` 照常能说「仅 stdout.write、副作用 1 次、确定」。

→ compact / canonical 的完整语法见 [01-syntax.md](01-syntax.md)。
→ desugar 规则见 [04-translation.md](04-translation.md)。

## 6. 决定成败、必须先行拍死的两块

方向 1–4 若没有下面两块支撑，就是沙上建塔：

- **A. 确定性序列化规范**——方向 4 的前提。键序按名字、空白统一、匿名身份规则、数值格式。详见 [03-serialization.md](03-serialization.md)。
- **B. 控制流 / 并发 / 错误**——直线好看不算数。得给一组原语并在分支+循环+并发+重试的小例子上验证不膨胀。候选原语与样例见 [06-open-questions.md](06-open-questions.md) 与 [../examples/](../examples/)。

## 7. 本工作区与历史的关系

RE 设计草案**早期曾借放**于 `~/ai-coding-e2e-replay/re/`（为避免与该公司 E2E 回放测试项目混淆），现已**独立迁移**到本工作区 `~/re/`。与原上层项目**完全不相干、互不影响**。后续设计迭代与（达成共识后的）翻译器/运行器开发都在本工作区进行。
