re 0.1 compact

// A compact review packet: state the task, evidence boundary, and next action.
// 一个紧凑的审阅包：明确任务、证据边界与下一步动作。

unit @agent_review_packet

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %packet = @stdout.write("task=review-packet\nobserved=bounded-preview\nrisk=unverified-assumption\nnext=run-counterexample\n")
  return match %packet {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
