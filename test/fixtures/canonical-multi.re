re 0.1 compact
unit @canonical_multi
cap @stdout: process.stdout@0.1.0
cap @args: process.args@0.1.0
fn @main() -> process.status {
  %first = @stdout.write("café\n")
  %second = @stdout.write("second\n")
  return match %second {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
