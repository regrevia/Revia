re 0.1 compact
// re 0.1 — 并发样例：par + join
// 两个 effect 仅在显式 par 内并发，join 是后续消费的唯一汇合点。

unit @cf_concurrent
cap @users: api.users
cap @orders: api.orders

fn @main(user_id: text.utf8) -> text.utf8 {
  %summary = par {
    user: @users.fetch(user_id)
    orders: @orders.list(user_id)
  }

  return %summary
}

// canonical 待定：par 的 structural 边界和 join membership 尚未定义。
// 当前只验证 compact 的显式并发意图。
