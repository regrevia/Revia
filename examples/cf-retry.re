re 0.1 compact
// re 0.1 — 错误重试样例：result + loop + match
// 最多尝试三次；错误作为值被显式观察，不使用跨 loop 的 `?`。
// 本样例不含退避；加入退避须显式 clock/timer capability。

unit @cf_retry
cap @http: net.http

fn @fetch(url: text.utf8) -> result<text.utf8, net.error> {
  %outcome = loop(state: 0) |%attempt| {
    match @http.get(url) {
      ok(body) => done(ok(body))
      err(error) when int.lt(%attempt, 2) =>
        next(int.add(%attempt, 1))
      err(error) => done(err(error))
    }
  }

  return %outcome
}

// canonical 待定：result arm 绑定、loop-exit merge 和错误传播 lowering 尚未定稿；
// 本样例当前只验证 compact 的显式重试边界与臃肿度。
