re 0.1 compact
// fs.read.read_file(path) 的最小可执行路径：默认 UTF-8，结果显式消费。

unit @read_check

cap @input: fs.read@0.1.0

fn @main() -> process.status {
  %contents = @input.read_file("input.txt")
  return match %contents {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
