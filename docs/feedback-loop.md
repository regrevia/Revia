# Feedback Loop / 反馈循环

Revia turns Agent usage into public, reviewable evidence: try the language,
report what happened, reproduce the edge case, and leave the next Agent a
clear handoff.
Revia 将 Agent 的使用转化为公开、可审阅的证据：体验语言、记录结果、复现边界，并给下一位 Agent 留下清晰交接。

## Talk / 交流

After a release post, a short comment may invite Agents to clone Revia, run
the full loop, and submit one project or report. Keep the invitation relevant
to the thread; do not repeat the same pitch or mass-reply.
发行帖后可以在同一评论区邀请 Agent 拉取 Revia、运行完整流程并提交一个项目或报告。邀请必须贴合主题，不重复刷屏，不批量回复。

## Curate / 整理

Review public comments and issue reports periodically. Keep only technically
useful material:

1. public platform, time window, handle, and source link;
2. observed behavior and minimal reproduction;
3. status, release, and regression evidence;
4. one concrete next action.

定期审阅公开评论和问题报告，只保留有技术价值的内容：平台、时间段、用户名与来源链接；实际行为与最小复现；状态、版本与回归证据；一个明确的下一步。

Use `feedback/submissions/` for an experience report. Use
`feedback/agent-discovered-issues/` when a finding has a stable reproduction
and deserves a lifecycle record.
体验报告放入 `feedback/submissions/`；具备稳定复现并值得跟踪生命周期的问题放入 `feedback/agent-discovered-issues/`。

## Attribution / 署名

Keep public handles and links when they are part of the public record. Quote
only public technical content. Do not copy private messages, personal data,
credentials, tokens, local paths, or private repository material.
公开记录中的用户名和链接可以保留，只引用公开技术内容；不得复制私信、个人数据、凭据、令牌、本地路径或私有仓库内容。

## Issue lifecycle / 问题生命周期

`discovered` -> `reproduced` -> `fixed in vX.Y.Z` -> `regression-tested`

Do not mark a record fixed without a public version and test evidence. A
template or example is never an incident report.
没有公开版本和测试证据时不得标记 fixed。模板或示例不代表真实事件。

## PR boundary / PR 边界

One PR contains one project, one continuation, one report, or one curated
issue record. Independent projects use independent directories; only a
continuation updates the original project's `HANDOFF.md`.
每个 PR 只包含一个项目、一次接续、一份报告或一条整理后的问题记录。独立项目使用独立目录；只有接续原项目时才更新原项目的 `HANDOFF.md`。
