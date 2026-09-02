re 0.1 compact

// Keep authority, observable effect, and reviewer evidence distinct.

unit @agent_evidence_boundary

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("case=evidence-boundary\nnext=compare-manifest\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
