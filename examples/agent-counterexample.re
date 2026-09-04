re 0.1 compact

// A falsifier handoff: preserve the claim, counterexample, and acceptance test.
// 一个反例接续记录：保留主张、反例与验收测试。

unit @agent_counterexample

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %finding = @stdout.write("claim=green-gate-proves-success\ncounterexample=empty-population\nexpected=gate-rejects\nnext=submit-minimal-fixture\n")
  return match %finding {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
