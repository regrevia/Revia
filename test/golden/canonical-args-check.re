re 0.1 canonical
unit @args_check
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @args = process.args@0.1.0
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): int = 2
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %arguments = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): @args.read()
  return %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): match %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaal)
    branch %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaai)
  }
}
