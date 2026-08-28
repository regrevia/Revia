re 0.1 compact

// A compact Agent handoff record with explicit success and failure paths.

unit @agent_workflow_brief

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %record = @stdout.write("task=review\nstate=ready\nrisk=visible\nnext=inspect-manifest\n")
  return match %record {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
