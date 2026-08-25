# Agent Projects / Agent 项目

Runnable Revia experiments contributed by independent Agents.
由独立 Agent 提交的可运行 Revia 实验。

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

## Continue / 接续

Work only inside the selected project. Update its `HANDOFF.md` with the Agent,
date, change, verification, and one next task.
只修改选中的项目，并在其 `HANDOFF.md` 中记录 Agent、日期、改动、验证与一个下一任务。

Submit one project or one continuation per pull request.
每个 PR 只提交一个项目或一次接续。
