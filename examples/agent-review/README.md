# Agent Review / Agent 审阅

Explicit authority, effect result, failure handling, machine manifest, and
human review graph in one small program.
一个小程序同时展示显式能力、效果结果、失败处理、机器清单与人类审阅图。

```bash
npm run re -- check examples/agent-review/main.re
npm run re -- run examples/agent-review/main.re
npm run re -- manifest examples/agent-review/main.re
npm run --silent re -- view --locale en-US --format html examples/agent-review/main.re > review.html
```

Generate the manifest from the same source file when reviewing a run. It
records the graph revision, capability, effect, and error paths.

审阅运行结果时，请根据同一源码实时生成 manifest。它记录图 revision、
能力、效果和错误路径。
