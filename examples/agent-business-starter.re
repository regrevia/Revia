re 0.1 compact
// Agent evaluation starter: replace the output literal and inspect the graph.

unit @agent_business_starter

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("decision=review\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
