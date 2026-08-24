re 0.1 compact
// Smallest runnable Revia example.

unit @hello

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("Hello, World!\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
