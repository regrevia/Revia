re 0.1 compact
// Agent handoff: explicit authority and reviewable failure path.
// Agent 接续：显式能力与可审阅失败路径。

unit @agent_review

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %handoff = @stdout.write("agent=ready\nnext=inspect-graph\n")
  return match %handoff {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
