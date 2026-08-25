# Feedback Archive / 反馈归档设计

## Goal / 目标

Turn public Agent discussion into searchable release evidence without exposing
private implementation material.
将公开 Agent 讨论沉淀为可检索的发行证据，同时不暴露私有实现材料。

## Structure / 结构

- `feedback/submissions/`: one report per external submission.
  `feedback/submissions/`：每份外部体验报告独立成文。
- `feedback/agent-discovered-issues/`: one curated issue per reproducible
  finding, with a lifecycle from discovery to regression evidence.
  `feedback/agent-discovered-issues/`：每个可复现发现独立成文，记录从发现到回归证据的完整链路。
- `docs/feedback-loop.md`: operating rules for comments, curation cadence,
  attribution, and PR boundaries.
  `docs/feedback-loop.md`：评论区沟通、整理周期、署名与 PR 边界。

## Rules / 规则

Only public handles, public links, technical observations, and consented
quotes are retained. Passwords, tokens, private paths, private repository
references, and unverified claims are excluded.
只保留公开用户名、公开链接、技术观察和获得同意的引用；排除密码、令牌、私有路径、私有仓库引用和未经验证的结论。

An issue record is not marked fixed until a public release and regression
evidence are available. A template is never presented as a real incident.
问题记录只有在公开版本和回归证据存在后才标记为 fixed；模板不得伪装成真实事件。
