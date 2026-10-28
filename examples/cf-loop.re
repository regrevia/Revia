re 0.1 compact
// re 0.1 — 循环样例：loop(state) + next/done
// loop 体内不使用 return；backedge 固定跨迭代 effect 的顺序。

unit @cf_loop

fn @count_to_three() -> int {
  %result = loop(state: 0) |%count| {
    match %count {
      3 => done(%count)
      _ => next(int.add(%count, 1))
    }
  }

  return %result
}

// canonical 待定：loop-exit merge、backedge 和 next/done 的 lowering 尚未定义。
// 不在样例中伪造 loop.body、裸赋值或未定义的 structural 节点语法。
