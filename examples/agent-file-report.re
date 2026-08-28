re 0.1 compact

// Read a UTF-8 report from the source-directory sandbox.

unit @agent_file_report

cap @input: fs.read@0.1.0

fn @main() -> process.status {
  %report = @input.read_file(path: "agent-file-report.txt", encoding: text.encoding.utf8)
  return match %report {
    ok(_) => process.exit(0)
    err(_) => process.exit(2)
  }
}
