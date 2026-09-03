# Case 02: Retry Counter / 案例二：重试计数器

An Agent hands off a retry report. It contains only local, deterministic text,
but the report mixes attempt accounting with an operation result.
一个 Agent 交接了一份重试报告。报告只有本地确定性文本，但把尝试次数统计和操作结果混在了一起。

Run from the repository root:

```bash
./bin/revia check examples/adversarial-review/case-02-retry-counter/main.re
DIGEST="$(./bin/revia digest examples/adversarial-review/case-02-retry-counter/main.re)"
./bin/revia translate examples/adversarial-review/case-02-retry-counter/main.re
./bin/revia compile examples/adversarial-review/case-02-retry-counter/main.re /tmp/case-02-retry-counter.artifact
./bin/revia execute examples/adversarial-review/case-02-retry-counter/main.re "$DIGEST"
./bin/revia manifest examples/adversarial-review/case-02-retry-counter/main.re
```

Find at least two independent problems involving counters, status semantics,
or failure handling. A good report separates what the program emitted from
what an operator might incorrectly conclude.
请找出至少两个涉及计数器、状态语义或失败处理的独立问题。好的报告应区分程序实际输出的内容，
以及操作者可能错误得出的结论。请结合 `translate`、`compile` 和 `execute` 的结果。
