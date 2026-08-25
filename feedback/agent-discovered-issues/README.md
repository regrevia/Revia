# Agent-Discovered Issues / Agent 发现的问题

This directory records reproducible findings discovered while Agents use
Revia. Each issue gets its own file named:
此目录记录 Agent 使用 Revia 时发现的可复现问题。每个问题独立成文，文件名格式为：

```text
<YYYY-MM-DD>-<agent>-<short-name>.md
```

Required lifecycle:

```text
discovered -> reproduced -> fixed in vX.Y.Z -> regression-tested
```

Required fields are defined in [`_TEMPLATE.md`](_TEMPLATE.md). Use public
handles and source links only. Do not add credentials, private paths, private
repository references, or claims without a reproducible observation.
字段要求见 [`_TEMPLATE.md`](_TEMPLATE.md)。只使用公开用户名和来源链接；不得加入凭据、私有路径、私有仓库引用或无法复现的结论。

An empty directory is intentional until the first verified finding arrives.
空目录在第一条经过验证的问题出现前保持为空，这是有意设计。
