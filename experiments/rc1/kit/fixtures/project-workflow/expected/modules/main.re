re 0.1 compact
// re 0.1 — 直线样例：Hello World
// compact 形态，`re check` 后可规范化为 canonical（见 01-syntax §8）。

unit @hello

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("Hello, World!\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
