re 0.1 compact

unit @agent_project

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %result = @stdout.write("project=ready\n")
  return match %result {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
