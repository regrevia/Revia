re 0.1 canonical
unit @reviewed_file_plan
cap %uaaaaaaa: uid("aaaaaaaaaaaaaaaaaaaaaaaaaa"): @output = fs.write@0.1.0
fn %uaaaaaab: uid("aaaaaabaaaaaaaaaaaaaaaaaaa"): @main -> process.status {
  literal %uaaaaaae: uid("aaaaaaeaaaaaaaaaaaaaaaaaaa"): fs.path = "reviewed.txt"
  literal %uaaaaaaf: uid("aaaaaafaaaaaaaaaaaaaaaaaaa"): bytes = hex:72657669657765642d706c616e0a
  literal %uaaaaaak: uid("aaaaaakaaaaaaaaaaaaaaaaaaa"): int = 0
  literal %uaaaaaan: uid("aaaaaanaaaaaaaaaaaaaaaaaaa"): int = 2
  let %uaaaaaac: uid("aaaaaacaaaaaaaaaaaaaaaaaaa"): %written = call %uaaaaaad: uid("aaaaaadaaaaaaaaaaaaaaaaaaa"): @output.write_file(data: %uaaaaaaf, path: %uaaaaaae)
  return %uaaaaaag: uid("aaaaaagaaaaaaaaaaaaaaaaaaa"): match %uaaaaaah: uid("aaaaaahaaaaaaaaaaaaaaaaaaa"): %uaaaaaac {
    branch %uaaaaaal: uid("aaaaaalaaaaaaaaaaaaaaaaaaa"): err => call %uaaaaaam: uid("aaaaaamaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaan)
    branch %uaaaaaai: uid("aaaaaaiaaaaaaaaaaaaaaaaaaa"): ok => call %uaaaaaaj: uid("aaaaaajaaaaaaaaaaaaaaaaaaa"): process.exit@0.1.0(code: %uaaaaaak)
  }
}
