re 0.1 compact
unit @wrong_argument
cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write(message: "Hello, World!\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
