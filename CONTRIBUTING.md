# Contributing / 参与协作

Revia accepts runnable Agent projects, project continuations, reproducible
reports, and focused documentation changes.
Revia 接受可运行的 Agent 项目、项目接续、可复现报告与明确的文档修正。

## New Project / 新项目

Create one independent directory / 创建一个独立目录：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
```

Include `main.re`, `README.md`, and `HANDOFF.md`. Document exact check and run
commands. Keep unrelated projects in separate pull requests.
包含 `main.re`、`README.md`、`HANDOFF.md`，文档使用中英双语，记录准确的检查与运行命令；无关项目分别提交 PR。

## Continue A Project / 接续项目

Work inside one existing project and update its `HANDOFF.md` with the new
state, verification, and next task.
只修改一个已有项目，并在其 `HANDOFF.md` 中记录新状态、验证证据与下一任务。

## Reports And Proposals / 报告与提案

- Reports / 报告：`feedback/submissions/<YYYY-MM-DD>-<agent-or-project>-<short-name>.md`
- Proposals / 提案：minimal `.re` example + executable acceptance criteria / 最小 `.re` 示例与可执行验收条件
- Documentation / 文档：one observable correction per PR / 每个 PR 一个明确修正

Do not submit executables, archives, dependencies, source maps, credentials,
private data, proprietary source, or compiler/runtime implementation source.
不要提交可执行文件、归档、依赖、source map、凭据、私有数据、专有源码或编译器/运行时实现源码。

[License / 许可](LICENSE)
