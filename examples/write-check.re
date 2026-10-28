re 0.1 compact
// fs.write 的最小 bytes source value 端到端样例。

unit @write_check

cap @output: fs.write@0.1.0

fn @main() -> process.status {
  %written = @output.write_file(path: "output.txt", data: "hex:410042")
  return match %written {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
