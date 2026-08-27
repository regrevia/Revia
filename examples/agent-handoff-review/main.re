re 0.1 compact
// A bounded Agent handoff workload: decide, emit, and leave a reviewable state.
// 一个受限的 Agent 接续工作负载：决策、输出并留下可审阅状态。

unit @agent_handoff_review

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %handoff = @stdout.write("case=handoff-review\nagent=ready\nnext=inspect-graph\nrisk=unverified-assumption\n")
  return match %handoff {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
