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
./bin/revia check examples/agent-review/main.re
./bin/revia run examples/agent-review/main.re
./bin/revia translate --format json examples/agent-review/main.re
./bin/revia manifest examples/agent-review/main.re
./bin/revia view --locale en-US --format html examples/agent-review/main.re
./bin/revia build --out build/agent-review examples/agent-review/main.re
```

Use `project-check` and `project-run` only with the fixtures and project
contracts included in the RC trial kit. The public template is a contribution
shape, not proof of a complete package manager or production project system.

## Generated Frontend Contract / 前端生成契约

The generated contract is derived from the checked manifest. A future client
generator may expose:

- operation names and input/output types;
- typed success and error branches;
- interface revision and graph revision;
- generated-file source path and source commit.

Hand-written DTOs, guessed dynamic JSON fields and UI framework conventions do
not define Revia semantics. A client must treat revision mismatch, unknown
error kinds and absent evidence as explicit states.

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
| Native CLI, check/run/manifest/view | measured on macOS arm64 |
| Bounded HTTP/JSON/SQLite trial | published as bounded evidence |
| Generated frontend contract | design surface, not a complete generator |
| HTTP adapter | bounded trial only |
| A2A adapter | planned / pending |
| MCP adapter | planned / pending |
| Browser profile | pending |
| TLS/OAuth/mTLS, HTTP/2/3 | pending |
| Production backend | not claimed |

Discuss a concrete proposal with a minimal example and acceptance criteria using
the [opinion template](../feedback/OPINION_TEMPLATE.md).
