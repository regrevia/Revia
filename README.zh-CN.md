# Revia

> 面向 Agent 编写与人类语义治理的、以语义图为核心的开源研究实现。

Revia 将已检查的程序结构转换为确定性的机器契约和面向人类的语义投影。
本仓库包含参考工具链、Rust 原生实现、一致性测试、语言文档以及有界对比实验
fixture。

源码按 [MPL-2.0](LICENSE) 发布。历史预览版和候选发行版二进制继续分别受
[LICENSE-PREVIEW-0.1.md](LICENSE-PREVIEW-0.1.md) 与
[LICENSE-RC.md](LICENSE-RC.md) 约束；公开源码不会追溯改变这些历史条款。

## 当前状态

开源开发线仍处于研究与预览阶段，包含有界 native 翻译器/VM、项目与模块检查、
确定性语义产物、受限 Server profile、接口投影以及一致性和实验基础设施。

这些内容是有边界的实现证据，不代表 production backend、完整语言实现、跨平台
等价、完整 A2A/MCP 互操作或 Stable V1.0。详见
[开发状态](docs/development-status.md) 和
[Stable V1.0 门禁](docs/stable-release-gate.md)。

## 快速开始

按目标选择入口：

- **试用 Revia：** [快速开始](QUICKSTART.md) 与
  [样例索引](examples/README.md)。
- **了解语言：** [语言规范索引](doc/README.md)。
- **查看实现状态：** [开发状态](docs/development-status.md) 与
  [兼容性](docs/compatibility.md)。
- **运行已发布试验：** [实验索引](experiments/README.md)。
- **创建项目：** [项目模板说明](projects/README.md)。
- **参与开发：** [贡献指南](CONTRIBUTING.md)。

在仓库根目录运行 Node 参考工具链：

```bash
npm run re -- check examples/hello.re
npm run re -- run examples/hello.re
```

运行参考工具链一致性测试：

```bash
npm test
```

Rust 原生实现位于 `native/`：

```bash
cargo test --workspace --offline
cargo fmt --all -- --check
cargo clippy --workspace --offline -- -D warnings
```

Node 工具链仍是参考和开发实现；它的存在不意味着语言语义依赖 Node。

## 仓库结构

```text
doc/             语言、语法、语义与执行规范
docs/            兼容性、集成、发行、证据与状态
examples/        小型程序、Agent 工作流与审阅挑战
experiments/     历史发行试验与对比记录
projects/        贡献者项目模板与样例项目
src/             Node 参考工具链与宿主适配器
native/          Rust 翻译器、VM、CLI 与原生一致性测试
test/            Node 测试、fixture 与逐字节 golden
test-support/    共享测试适配器与 fixture
scripts/         开发、一致性与证据脚本
runtime/         历史打包运行时与发行证据
```

公开仓库是开源开发线的源码和测试真源。`runtime/` 与 `experiments/rc1/`
记录历史评估资产，与当前源码工具链分开理解。

## 设计方向

Revia 以已检查语义图为核心：

- 能力、效果、错误和资源显式表达；
- canonical 序列化和图身份保持确定性；
- 生成式投影派生自 checked interface，不形成第二语义权威；
- 协议适配器位于语言核心之外；
- 证据明确区分 measured、verified-only、pending 和 fault-observed。

语言和实现仍在演进。测试通过或有界实验成功时，必须结合对应的范围和限制
阅读，不能扩大解释为生产能力。

## 社区协作

可复现的实现问题请使用 GitHub issue，设计提案请使用 Discussions。不要公开
凭据、个人数据、私信、本机路径、私有基础设施细节或专有材料。安全问题应通过
仓库提供的私密安全渠道提交。

## 许可

新公开源码按 [MPL-2.0](LICENSE) 发布。许可迁移范围及其与历史发行资产的关系
见 [SOURCE-LICENSE.md](SOURCE-LICENSE.md)。
