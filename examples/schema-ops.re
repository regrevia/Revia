re 0.1 compact
// re 0.1 — Q-schema / capability interface 候选
// revision 固定整个 capability interface；member 不重复写 revision。

unit @schema_ops

op @text.trim_left {
  param input: text.utf8 primary
  param charset: text.utf8 = " "
  returns text.utf8
}

capability fs.read@0.1.0 {
  effect read_file {
    param path: fs.path primary
    param encoding: text.encoding = text.encoding.utf8
    returns result<text.utf8, fs.read_error>
    access read fs.file(path)
  }
}

capability fs.write@0.1.0 {
  effect write_file {
    param path: fs.path primary
    param data: bytes
    returns result<unit, fs.write_error>
    access write fs.file(path)
  }
}

capability process.stdout@0.1.0 {
  effect write {
    param data: text.utf8 primary
    returns result<unit, io.write_error>
    access write process.stdout
  }
}

capability process.args@0.1.0 {
  effect read {
    returns result<list<text.utf8>, process.args_error>
    access read process.argv
  }
}

op @process.exit {
  param code: process.exit_code primary
  returns process.status
}
