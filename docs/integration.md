# Integration Guide / 集成指南

Revia separates program semantics from transport and UI concerns:

```text
.re source
  -> checked semantic graph
  -> manifest and generated contract
  -> adapter or client
```

The public RC exposes the checked graph, manifest, human view and bounded
runtime trials. HTTP, A2A and MCP adapters are extension points for the
upcoming development work; they are not complete protocol implementations in
this release.

## Developer Workflow / 开发流程

```bash
npm run re -- check examples/agent-review/main.re
npm run re -- run examples/agent-review/main.re
npm run re -- translate --format json examples/agent-review/main.re
npm run re -- manifest examples/agent-review/main.re
npm run re -- view --locale en-US --format html examples/agent-review/main.re
npm run re -- build --out build/agent-review examples/agent-review/main.re
```

Use `project-check` on checked project examples. Projects with Agent or
business facts can also use `project-translate`. Its native and Node reference
signatures differ; use `revia help project-translate` to select the intended
surface. Native
`project-build`/`project-run` remain bound to versioned candidate contracts;
the public source tree does not present them as a complete package manager or
production project system.

The checked example project runs one bounded preview execution from its
checked-in fixture; see
[the expense-review verification path](../examples/agent-expense-review/README.md#verify--验证).

## Generated Frontend Contract / 前端生成契约

The public source tree includes a bounded interface projection command:

```bash
node src/cli/re.js project-projection \
  --routes examples/agent-expense-review/interface-routes.json \
  --out /tmp/revia-expense-client \
  examples/agent-expense-review
```

It writes `types.ts`, `client.ts`, and `projection.json`. Measured on
`examples/agent-expense-review`, the exit status is `0`, and
`projection.json` is a `re.interface-projection-manifest@0.1.0` envelope with
four top-level keys: `contract`, `files`, `projection_digest`, `schema`.
`files` lists the two generated sources with their digests, and
`contract.operations` carries one routed operation, `POST /v1/expense/review`,
whose `authority.graph_revision` equals the project's pinned revision.

A consumer outside this repository needs only `projection.json` and plain
Node to read the shape of that contract:

```bash
node -e 'const p = require("/tmp/revia-expense-client/projection.json");
console.log(p.schema);
console.log(p.files.map((f) => f.path).join(","));
const operation = p.contract.operations[0];
console.log(operation.route.method, operation.route.path)'
```

```text
re.interface-projection-manifest@0.1.0
client.ts,types.ts
POST /v1/expense/review
```

中文摘要：`project-projection` 写出 `types.ts`、`client.ts` 与
`projection.json`，退出码 `0`；`projection.json` 是
`re.interface-projection-manifest@0.1.0` 信封，顶层键为 `contract`、`files`、
`projection_digest`、`schema`。`files` 列出两个生成文件及其摘要，
`contract.operations` 带路由 `POST /v1/expense/review`，其
`authority.graph_revision` 等于项目固定的 revision。仓库外的消费者只需
`projection.json` 与 Node 即可读取契约形状。

The contract is
derived from the checked manifest and route input; it is intentionally bounded
and does not claim to be a complete frontend generator or production SDK.

The generated contract exposes:

- operation names and input/output types;
- typed success and error branches;
- interface revision and graph revision;
- checked fact IDs, adapter authority, profile and idempotency policy.

Hand-written DTOs, guessed dynamic JSON fields and UI framework conventions do
not define Revia semantics. A client must treat revision mismatch, unknown
error kinds and absent evidence as explicit states.

公开源码包含一个有界的 interface projection 命令，生成 `types.ts`、`client.ts` 和
`projection.json`。契约由 checked manifest 与 route 输入派生，并绑定 fact ID、adapter
authority、profile 和幂等策略；不代表完整前端生成器或生产 SDK。手写 DTO、猜测式动态
JSON 和 UI 框架约定不构成 Revia 语义。

## Built Artifact / 构建产物

`build` turns one checked source file into a directory that runs on plain
Node, with no Revia checkout and no network:

```bash
node src/cli/re.js build --out /tmp/revia-hello examples/hello.re
node /tmp/revia-hello/run.mjs
```

The first command exits `0` and writes a `re.build-result@0.1.0` envelope on
stdout. The directory holds seven files: the five the envelope lists
(`program.re`, `release-lock.json`, `run.mjs`, `review-index.json`,
`semantic-view.json`) plus `manifest.json` and `checksums.sha256`.
`manifest.json` is `re.build-artifact@0.1.0` with
`target_profile: node-demo-self-contained-preview@0.1.0` and a runtime of
`kind: self-contained-node-demo-runtime`, `entrypoint: run.mjs`. The second
command prints the program's output and exits with its code:

```text
Hello, World!
```

Measured on a copy outside this repository, run from another working
directory with a PATH-only environment: `run.mjs` reads only files beside it,
so the artifact travels without the source tree or a Revia binary. Verify a
copy with `shasum -a 256 -c checksums.sha256` (that file lists the other six,
not itself).

`--out` must name a directory that is absent or empty. A path whose parent
does not exist, or a directory that already holds files, exits `65` with a
`build-write-failed` diagnostic (`reason` `ENOENT` or `ENOTEMPTY`), so a
rebuild starts by removing the previous directory.

中文摘要：`build --out <dir> <file.re>` 把单个已检查的源文件打包成可在纯 Node
下运行的目录，退出码 `0`，stdout 是 `re.build-result@0.1.0` 信封；目录共七个
文件，另有 `manifest.json`（`re.build-artifact@0.1.0`，target profile
`node-demo-self-contained-preview@0.1.0`）和 `checksums.sha256`。在仓库外、
换工作目录、只留 PATH 的环境里跑 `node run.mjs` 仍输出程序结果，不读源码树
或 Revia 二进制。`--out` 必须是空目录或不存在：父目录缺失或目录非空时退出 `65`，
诊断码 `build-write-failed`。

## HTTP Adapter / HTTP 适配器

The current public evidence is bounded HTTP/JSON/SQLite conformance using the
trial kit. It does not establish TLS, OAuth, mTLS, HTTP/2, HTTP/3, production
database lifecycle, scheduler semantics or a production backend.

Open questions for the next implementation work:

- route and interface version defaults;
- request-id, deadline, cancellation, retry and idempotency behavior;
- stable error envelope and typed error mapping;
- how interface revision and graph revision are surfaced to clients.

## A2A Adapter / A2A 适配器

A2A remains a planned adapter boundary. The public design surface should
separately define Agent Card, task submission, status, cancellation, events and
artifact references. No complete A2A interoperability claim is made here.

Questions for Agent experiments:

- which Agent Card fields are semantic versus transport metadata;
- whether task state and cancellation belong in the generated contract;
- how event ordering, replay and artifact provenance should be represented.

## MCP Adapter / MCP 适配器

MCP remains a planned adapter boundary. The intended mapping questions are
tools, resources, prompts, generated schemas, resource URIs and error handling.
MCP names and provider behavior do not become Revia semantics automatically.

Questions for Agent experiments:

- which tools/resources/prompts should be generated from capabilities;
- how schema revisions and resource URIs should be pinned;
- how provider errors remain distinct from Revia typed failures.

## Status Matrix / 状态矩阵

| Surface / 表面 | Public RC state / 公开 RC 状态 |
|---|---|
| Revia `1.0.0-rc.2.2.1` native CLI | measured-native on Linux x64 and Windows x64; other targets pending |
| Node reference CLI, source-oriented run/view/audit/build | Node conformance-tested; not native release evidence |
| Bounded HTTP/JSON/SQLite trial | published as bounded evidence |
| Generated frontend contract | bounded TypeScript projection, not a complete generator |
| HTTP adapter | bounded trial only |
| A2A adapter | planned / pending |
| MCP adapter | planned / pending |
| Browser profile | pending |
| TLS/OAuth/mTLS, HTTP/2/3 | pending |
| Production backend | not claimed |

Discuss a concrete proposal with a minimal example and acceptance criteria using
the [opinion template](../feedback/OPINION_TEMPLATE.md).
