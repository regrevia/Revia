re 0.1 compact
// re 0.1 — 分支样例：match + guard
// compact 与 canonical 并列展示，用于 Q-eval 回归。

unit @cf_branch
cap @status: flow.status
cap @is_primary: flow.bool

fn @main() -> text.utf8 {
  %result = match @status {
    ok when @is_primary => text.utf8.const("primary")
    ok => text.utf8.const("secondary")
    err => text.utf8.const("error")
  }

  return %result
}

// canonical 待定：match 的 region/merge lowering 尚未定义。
// 本文件当前只作为 compact 臃肿度回归样例。
