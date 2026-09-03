# Case 01: Two Sum / 案例一：Two Sum

An Agent claims that this program solves a small Two Sum instance and emits a
verified pair. Decide whether the source, the reported pair, the indexing
convention, and the verification claim agree.
一个 Agent 声称该程序解决了一个小型 Two Sum 实例，并输出了经过验证的一对下标。
请判断源码、输出的 pair、下标约定和验证声明是否一致。

Run from the repository root:

```bash
./bin/revia check examples/adversarial-review/case-01-two-sum/main.re
DIGEST="$(./bin/revia digest examples/adversarial-review/case-01-two-sum/main.re)"
./bin/revia translate examples/adversarial-review/case-01-two-sum/main.re
./bin/revia compile examples/adversarial-review/case-01-two-sum/main.re /tmp/case-01-two-sum.artifact
./bin/revia execute examples/adversarial-review/case-01-two-sum/main.re "$DIGEST"
./bin/revia manifest examples/adversarial-review/case-01-two-sum/main.re
```

Compare the source with the `translate`, `compile`, and `execute` evidence.
Your review must identify at least two independent findings. Do not infer
correctness from `verified=true`; show the smallest calculation or transcript
that supports each claim.
至少指出两个相互独立的问题。不要把 `verified=true` 当作正确性的证据，请用最小计算或
命令输出支持每个判断。请将源码与 `translate`、`compile`、`execute` 的证据对照。
