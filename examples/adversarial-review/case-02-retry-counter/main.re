re 0.1 compact

// Adversarial fixture: retry accounting that reports a stronger guarantee
// than the observable result supports.
// 对抗性案例：重试计数报告的保证强于可观察结果。
//
// Review attempt numbering, the meaning of "success", and whether the output
// distinguishes a completed operation from a planned retry budget.
// 请审阅尝试次数编号、“success”的含义，以及输出是否区分已完成操作与计划重试预算。

unit @case_02_retry_counter

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %report = @stdout.write("case=retry-counter\nattempt=3\nmax_attempts=3\noperation=not-observed\nstatus=success\nretry_budget=exhausted\n")
  return match %report {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
