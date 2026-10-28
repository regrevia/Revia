re 0.1 canonical
unit @hello
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @stdout = process.stdout@0.1.0
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): text.utf8 = "Hello, World!\n"
  literal %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): int = 1
  literal %uzzzzzzz: uid("zzzzzzzzzzzzzzzzzzzzzzzzza"): decimal<5> = -9007199254740993.00100
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %printed = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): @stdout.write(data: %uaaaaaae)
  return %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): match %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaam)
    branch %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaaj)
  }
}
