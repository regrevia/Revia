# Evidence Boundary Review / 证据边界审阅

This small program separates three things that are often collapsed in an Agent
handoff: declared authority, an observed effect, and the semantic graph a
reviewer can inspect. It is a runnable review workload, not a claim that one
stdout line proves every reachable path executed.

这个小程序把 Agent 接续中常被混为一谈的三件事分开：声明的权限、观察到的效果，以及
审阅者可检查的语义图。它是可运行的审阅工作负载，不主张一行 stdout 就能证明所有可达
路径都已执行。

## Run / 运行

From the repository root:

```bash
./bin/revia check examples/agent-evidence-boundary.re
./bin/revia run examples/agent-evidence-boundary.re
./bin/revia manifest examples/agent-evidence-boundary.re
./bin/revia view --locale en-US --format html examples/agent-evidence-boundary.re > evidence-boundary.html
```

Expected observed output / 预期观察到的输出：

```text
case=evidence-boundary
next=compare-manifest
```

## Review question / 审阅问题

Can the next Agent identify `@stdout` as declared authority, the two output
lines as one observed effect, and the success/error branches in the generated
manifest and view without treating any one surface as the whole truth?

下一位 Agent 能否识别 `@stdout` 是声明的权限、两行输出是一次观察到的效果，并在生成的
manifest 与视图中识别成功/错误分支，而不把其中任一表面当作完整真相？
