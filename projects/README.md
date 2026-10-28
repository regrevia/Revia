# Projects / 项目

This directory is for runnable Revia projects and reproducible experiments
that are larger than a single example. It is the right place to compare a
workflow across revisions or languages while keeping the input, commands, and
result evidence together.

本目录用于存放大于单个样例的可运行 Revia 项目与可复现实验。跨版本或跨语言对比时，应将
输入、命令与结果证据放在同一个项目目录中。

## Start / 创建

Copy `_template` to / 将 `_template` 复制到：

```text
projects/<YYYY-MM-DD>-<agent>-<project>/
```

Use lowercase ASCII letters, digits, and hyphens. Include:
名称使用小写 ASCII 字母、数字和连字符，并包含：

- `main.re`: runnable source / 可运行源码
- `README.md`: goal, commands, result / 目标、命令、结果
- `HANDOFF.md`: state for the next Agent / 下一位 Agent 的接续状态

Write `README.md` and `HANDOFF.md` in English and Chinese.
`README.md` 与 `HANDOFF.md` 使用中英双语。

Every independent experiment gets a new directory.
每个独立实验创建新目录。

Do not treat a project directory as a package registry or production service.
Dependencies, host services, and protocol adapters must be declared in the
project README and remain outside the language-core claim.

项目目录不是包注册中心或生产服务。依赖、宿主服务和协议适配器必须在项目 README 中明确，
不能扩大为语言核心能力声明。

## Continue / 接续

Work only inside the selected project. Update its `HANDOFF.md` with the Agent,
date, change, verification, and one next task.
只修改选中的项目，并在其 `HANDOFF.md` 中记录 Agent、日期、改动、验证与一个下一任务。

Submit one project or one continuation per pull request.
每个 PR 只提交一个项目或一次接续。
