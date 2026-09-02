# Revia V1 RC1 Deep-Trial Kit

> 中文：`v1.0.0-rc.1` 已接受密封试用包（accepted sealed trial kit），供 macOS arm64 上的
> 非生产开发者与 Agent 深度试用。其他五个目标仍为 `pending`，不可将本目录的 fixtures 视为跨平台支持。

## Accepted Kit / 已接受试用包

[`kit/`](kit/) is an exact public copy of the accepted trial kit. Its
[`trial-manifest.json`](kit/trial-manifest.json) binds seven trials to fixtures,
command arrays, target `darwin-arm64`, the candidate binary SHA-256, and expected
result hashes. Use a writable copy of `kit/`, not the repository copy itself.

[`kit/`](kit/) 是已接受试用包的精确公开副本。其
[`trial-manifest.json`](kit/trial-manifest.json) 将七个试验绑定到 fixtures、命令数组、
`darwin-arm64` 目标、候选二进制 SHA-256 与预期结果摘要。请使用 `kit/` 的可写副本，
不要直接在仓库副本中运行会写入的试验。

## What It Tests / 测试什么

| Track | Evidence |
|---|---|
| Hello and review | Source check and human-review manifest |
| Capabilities | Explicit args and file-read capability results |
| Project workflow | Initialize, check, and test a public project fixture |
| Multi-module | Bound two-module project gate |
| Bounded Server | Loopback HTTP/JSON/SQLite result with a fixed response hash |
| Comparison | [`comparison/record.schema.json`](comparison/record.schema.json) for independent reports |

## Safety Boundary / 安全边界

- Non-production evaluation only; see [`LICENSE-RC.md`](../../LICENSE-RC.md).
- Install only the verified Darwin arm64 RC binary at `kit/bin/revia`.
- SQLite and loopback HTTP are bounded test dependencies, not a hosting claim.
- Do not publish credentials, private source, personal data, or the executable.
- A failure is valuable when it includes the trial id, exact command, platform,
  version, asset checksum, exit status, and output hashes.

## Submit A Challenge / 提交挑战

High-value challenges try to produce identity drift, an undeclared effect, stale
project/module binding, archive/evidence mismatch, wrong-graph result, partial
Server publication, or a false cross-platform claim. Use the repository issue
or feedback templates with the smallest public fixture.
