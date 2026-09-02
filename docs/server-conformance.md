# Bounded Server Conformance / 有界 Server 一致性

`v1.0.0-rc.1` includes public evidence for a measured native bounded Server
slice. The public evidence describes the previously reviewed `WP-299` scope;
it is shown here as bounded conformance, not as a complete production backend.

`v1.0.0-rc.1` 包含已实测 native 有界 Server 切片的公开证据。本页将其作为有界一致性结果
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

The sealed public evidence is bound to the Darwin arm64 RC candidate. The public
repository does not include compiler or runtime implementation source.

密封公开证据绑定到 Darwin arm64 RC 候选。公开仓库不包含 compiler 或 runtime 实现源码。

## Not Established / 尚未证明

- TLS, authentication, HTTP/2, or HTTP/3
- Production database lifecycle, pooling, ORM, migrations, or PostgreSQL
- Cross-platform native runner equivalence
- A general scheduler, distributed runtime, or production SLA
- A complete language backend or Stable V1.0

## Release Boundary / 发行边界

The public `v1.0.0-rc.1` Darwin arm64 asset contains this bounded trial surface.
It is not evidence for any other target or for a production Server profile.

公开 `v1.0.0-rc.1` Darwin arm64 资产包含该有界试用面；它不构成其他目标或生产 Server profile 的证据。
