re 0.1 canonical
unit @canonical_multi
cap %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @args = process.args@0.1.0
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @stdout = process.stdout@0.1.0
fn %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): text.utf8 = "café\n"
  literal %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): text.utf8 = "second\n"
  literal %uaaaaaan: uid("aaaaaanaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaaq: uid("aaaaaaqaaaaaaaaaaaaaaaaaaa"): int = 1
  let %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): %first = call %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): @stdout.write(data: %uaaaaaaf)
  let %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): %second = call %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): @stdout.write(data: %uaaaaaai)
  return %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): match %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): %uaaaaaag {
    branch %uaaaaaao: uid("aaaaaaoaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaap: uid("aaaaaapaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaaq)
    branch %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaan)
  }
}
