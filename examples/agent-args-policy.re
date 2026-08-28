re 0.1 compact

// Read process arguments without echoing or interpreting arbitrary payloads.

unit @agent_args_policy

cap @args: process.args@0.1.0

fn @main() -> process.status {
  %arguments = @args.read()
  return match %arguments {
    ok(_) => process.exit(0)
    err(_) => process.exit(3)
  }
}
