re 0.1 canonical
unit @read_encoding
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @input = fs.read@0.1.0
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): fs.path = "input.txt"
  literal %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): text.encoding = text.encoding.utf8
  literal %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaan: uid("aaaaaanaaaaaaaaaaaaaaaaaaa"): int = 2
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %contents = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): @input.read_file(encoding: %uaaaaaaf, path: %uaaaaaae)
  return %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): match %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaan)
    branch %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaak)
  }
}
