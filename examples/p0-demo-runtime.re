re 0.1 compact
// re 0.1 — P0-demo-runtime 对照样例
// cap instance 固定 interface revision；effect 通过 instance.member 调用。

unit @p0_demo_runtime

cap @args: process.args@0.1.0
cap @input: fs.read@0.1.0
cap @output: fs.write@0.1.0
cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %written: result<unit, io.write_error> = @stdout.write("ready\n")
  %status: process.status = match %written {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
  return %status
}
