re 0.1 compact
// Intentionally invalid: stdout.write accepts data, not message.

unit @diagnostic_error

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write(message: "This argument name is invalid.\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
