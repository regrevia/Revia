re 0.1 compact
// process.args.read() 的最小可执行路径：成功与 UTF-8 错误都显式消费。

unit @args_check

cap @args: process.args@0.1.0

fn @main() -> process.status {
  %arguments = @args.read()
  return match %arguments {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
