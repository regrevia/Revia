# Capability Track

Inputs:

- [`examples/agent-args-policy.re`](../../../examples/agent-args-policy.re)
- [`examples/agent-file-report.re`](../../../examples/agent-file-report.re)
- [`examples/agent-file-report.txt`](../../../examples/agent-file-report.txt)

Acceptance after publication: args and file-read authority, input digest, closed success/error outcome, stdout, and any sandbox effect must be bound in the sealed evidence. Reading a value and silently discarding it is not counted as a complete trial.

中文：发布后的密封证据必须绑定参数/文件读取权限、输入摘要、闭合成功/错误结果、stdout 与 sandbox effect；读取后直接丢弃不算完整试用。
