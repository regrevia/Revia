# Bounded Server Conformance / 有界 Server 一致性

WP-299 adds a measured native server slice to the development evidence. It is
shown here as bounded conformance, not as a complete production backend.

WP-299 将一段已实测的 native Server 切片加入开发证据。本页将其作为有界一致性结果
展示，不将其表述为完整生产后端。

## Verified Slice / 已验证切片

| Area / 领域 | Result / 结果 |
|---|---|
| Project shape / 项目结构 | Two-module project DAG / 两模块项目 DAG |
| Transport / 传输 | Native loopback HTTP/1.1 / 原生 loopback HTTP/1.1 |
| Route / 路由 | Explicit `GET /run` route / 显式 `GET /run` 路由 |
| JSON / JSON | Schema-driven canonical response / Schema 驱动的规范响应 |
| Database / 数据库 | Parameterized SQLite transaction and query / 参数化 SQLite 事务与查询 |
| Authority / authority | Project, module, build, translation, plan, input and outcome bindings |
| Reproducibility / 可复现性 | Two fresh processes, empty `PATH`, cleared environment, path-free receipt |
| Failure boundary / 失败边界 | Input drift and partial publication rejected before effect / 输入漂移与部分发布在 effect 前拒绝 |

The evidence was produced from reviewed development baseline `9288c9d`.
The public repository does not include the compiler, runtime implementation, or
private build artifacts.

证据来自已完成审阅的开发基线 `9288c9d`。公开仓库不包含 compiler、runtime 实现或
私有构建产物。

## Not Established / 尚未证明

- TLS, authentication, HTTP/2, or HTTP/3
- Production database lifecycle, pooling, ORM, migrations, or PostgreSQL
- Cross-platform native runner equivalence
- A general scheduler, distributed runtime, or production SLA
- A complete language backend or Stable V1.0

## Release Boundary / 发行边界

The public `0.1-preview.1` download does not contain this Server slice. It
becomes a capability of a particular release asset only after that asset is
rebuilt, sealed, and executed by the native gate for its declared target.

公开 `0.1-preview.1` 下载包不包含该 Server 切片。只有某个发行资产完成重新构建、密封，
并在其声明目标的原生门禁中执行通过后，它才成为该资产的公开能力。
