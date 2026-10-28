re 0.1 compact
// 显式 UTF-8 encoding 的多参数 fs.read 调用。

unit @read_encoding

cap @input: fs.read@0.1.0

fn @main() -> process.status {
  %contents = @input.read_file(path: "input.txt", encoding: text.encoding.utf8)
  return match %contents {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
