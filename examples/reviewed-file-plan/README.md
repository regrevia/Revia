# Reviewed File Plan / 人审文件计划

This is a bounded executable example, not an autonomous risk scorer. The plan
is the actual `.re` program. It declares one `fs.write@0.1.0` effect and writes
one known file inside an explicit sandbox. A human decision binds the exact
source SHA-256, so changing the plan makes the old approval stale.

这是一个有边界的可执行案例，不是自动风险评分器。计划就是实际的 `.re` 程序；它声明
一次 `fs.write@0.1.0` effect，并且只在显式 sandbox 内写入一个已知文件。人类决定绑定
源码的精确 SHA-256，因此计划变化后旧批准会失效。

From the repository root, first exercise denial. The sandbox stays empty:

```bash
sandbox="$(mktemp -d)"
REVIA_EXECUTABLE=./bin/revia ./scripts/run-reviewed-file-plan.sh \
  examples/reviewed-file-plan/plan.re \
  examples/reviewed-file-plan/decision.denied.json \
  "$sandbox"
test -z "$(find "$sandbox" -mindepth 1 -print -quit)"
```

Then use the approval bound to the current source:

```bash
REVIA_EXECUTABLE=./bin/revia ./scripts/run-reviewed-file-plan.sh \
  examples/reviewed-file-plan/plan.re \
  examples/reviewed-file-plan/decision.approved.json \
  "$sandbox"
test "$(cat "$sandbox/reviewed.txt")" = reviewed-plan
```

To test stale approval and recovery, copy `plan.re`, change even a comment or
byte, and run it with the old approved decision. The gate exits before
`runtime-package` and the sandbox remains empty. Re-review the changed source,
record its new SHA-256 in a new decision, and rerun against an empty sandbox.

This evidence shows source-bound approval, denial before effects, explicit
sandbox execution, exact output verification, and recovery through fresh
approval. It does not show that the closed runtime enforces every security
boundary correctly, that Revia infers business risk, or that an Agent performs
better in Revia than in another language.
