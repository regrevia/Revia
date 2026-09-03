re 0.1 compact

// Adversarial fixture: a claimed Two Sum answer with more than one review target.
// 对抗性案例：一个包含多个审阅点的 Two Sum 结果声明。
//
// The intended workload is to find two distinct input positions whose values
// add to the target. Review the input, indexing convention, and the claim that
// the result was verified. The fixture is bounded and has no external effects.
// 目标是找出两个不同输入位置，使其值之和等于 target。请审阅输入、索引约定以及
// “结果已验证”这一声明。案例受限且没有外部副作用。

unit @case_01_two_sum

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %report = @stdout.write("case=two-sum\ninput=[3,3,4]\ntarget=6\npair=(0,1)\nindexing=one-based\nverified=true\n")
  return match %report {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
