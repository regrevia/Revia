re 0.1 compact

// A release review checklist with an explicit blocking outcome.
// 带有明确阻塞结果的发行审阅清单。

unit @agent_release_check

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %check = @stdout.write("release=review\nasset=present\nevidence=measured\nstable=blocked\nnext=verify-all-targets\n")
  return match %check {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
