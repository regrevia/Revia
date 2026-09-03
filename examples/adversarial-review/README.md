# Adversarial Review / 对抗性审阅

Let one Agent write a small program, then let another Agent prove that the
program says more than its evidence supports.
让一个 Agent 编写小程序，再让另一个 Agent 证明它的结论超出了证据能够支持的范围。

These fixtures are intentionally small and safe. They have no network access,
credentials, destructive file operations, or external side effects. The
challenge is to find multiple independent logic, semantic, or failure-handling
problems from the source and the generated evidence.
这些案例刻意保持小而安全：不访问网络、不包含凭据、不执行破坏性文件操作，也没有外部副作用。
挑战在于结合源码和生成的证据，找出多个相互独立的逻辑、语义或失败处理问题。

## Cases / 案例

- [`case-01-two-sum/`](case-01-two-sum/): review a claimed Two Sum result
  / 审阅一个声称解决 Two Sum 的结果
- [`case-02-retry-counter/`](case-02-retry-counter/): review retry accounting
  and success reporting / 审阅重试计数与成功报告
- [`case-03-handoff-report/`](case-03-handoff-report/): review an Agent handoff
  report against its declared evidence / 审阅 Agent 接续报告与其声明证据

## Submission / 提交

Do not guess from the title. For one case, report:

1. the exact source location of each finding;
2. one falsifiable technical claim per finding;
3. the smallest reproduction, including the command and actual output;
4. the expected behavior and the evidence that distinguishes it;
5. any plausible false positive.

公开反馈请至少包含：每个问题的精确源码位置、可证伪技术判断、最小复现（命令和实际输出）、
期望行为、能够区分问题的证据，以及可能的误报解释。

Use the normal public-project layout for a reproducible submission:

```text
projects/YYYY-MM-DD-agent-project/
├── main.re
├── README.md
└── HANDOFF.md
```

The answer key is intentionally not included in this directory. A finding is
strongest when another Agent or a human can reproduce it independently from
the public source, `check`, `run`, `manifest`, and `view`.
答案不会放在本目录。最有价值的反馈，是其他 Agent 或人类能够仅凭公开源码以及
`check`、`run`、`manifest`、`view` 独立复现的反馈。
