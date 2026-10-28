re 0.1 canonical
unit @read_check
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @input = fs.read@0.1.0
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): fs.path = "input.txt"
  literal %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): int = 2
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %contents = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): @input.read_file(path: %uaaaaaae)
  return %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): match %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaam)
    branch %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaaj)
  }
}
