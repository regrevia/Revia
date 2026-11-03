# 12 · Library Strategy / 库策略

Status: strategy proposal for review. This document defines how external code may
enter Revia and what evidence each route owes. It is **not** implementation
evidence: as of this writing no third-party library has been admitted under any
route below.

状态：待评审的策略提案。本文定义外部代码进入 Revia 的路径与证据义务，**不是**实现证据：
截至本版，没有任何第三方库按本文路线被接纳。

## 1. Problem / 问题

A language is adopted for what its ecosystem already does. Revia's executable
surface declares five capability schemas and no general-purpose code library
(`native/revia-core/src/graph.rs`, `is_known_schema`). Adding a library is
therefore a design decision, not a packaging decision: every candidate must
answer *where the code lives*, *where the effect boundary is*, and *what proof
admission requires*.

语言被采用，靠的是生态已经能做的事。Revia 当前只声明五个 capability schema，没有通用代码库
（`native/revia-core/src/graph.rs` 的 `is_known_schema`）。所以「加一个库」是设计决策而不是
打包决策：每个候选都要回答代码住在哪里、effect 边界在哪里、准入需要什么证明。

## 2. Three admission routes / 三条准入路线

| Route | Code lives | Language sees | Evidence owed | Use for |
|---|---|---|---|---|
| **P — pure native op** | Core (`native/revia-core`) | pure operation in an expression | unit tests + operation conformance cases | scalar/collection algorithms that must stay inside the graph and inside digests |
| **H — host adapter** | Host process (Node adapters in `src/host/`, or a Rust `HostAdapter`) | declared capability schema + member | host conformance cases, observation determinism | anything effectful or platform-bound: fs, network, DB, clock, secrets |
| **I — ingestion with equivalence corpus** | Repository, admitted source | pure operation | byte-equal output against the pinned original on a committed corpus | third-party pure libraries whose value is the algorithm, not the platform |

Route H already carries real external code today: `src/host/server-json-codec-adapter.js`
routes `data.json.encode` / `data.json.decode` to bound codec functions,
`src/host/server-db-sql-node-sqlite-driver.js` delegates SQL to `node:sqlite`, and
`src/host/server-http-client-fetch-transport.js` delegates transport to `fetch`.
None of these are admitted by this document; they are evidence that the adapter
shape works.

**Never mix routes.** A pure function must not become a host call: the host round
trip turns it into an observable effect, which pollutes the observation digest and
forbids reordering (see `doc/02-semantics.md`). An effectful operation must not be
imported as a pure op: it would hide a real effect behind a pure identity and break
the fail-closed projection contract in `doc/05-execution.md`.

## 3. Decision rule / 判定规则

1. Pure, total, deterministic, typed surface → **P**.
2. Effectful, platform-bound, or non-deterministic → **H**.
3. Pure, third-party, larger than we want to own → **I**, gated by §5.

## 4. Known blockers, measured / 已知阻塞（实测）

1. **The native operation namespace is closed.** `HostOperation` is an enum
   (`native/revia-core/src/minimal_std.rs:320-346`) and every unlisted name
   fails closed with `StdError::UnknownOperation` at both dispatch sites
   (`:573`, `:734`). An out-of-tree library adapter cannot be admitted without
   editing core. The Node host is already name-open by contrast
   (`src/host/server-json-codec-adapter.js:60-62` rejects only members outside its
   own declared pair). Opening this namespace is prerequisite §6.1.
2. **The expression surface cannot walk data.** Production syntax has no list
   indexing, iteration, or argument echo (`doc/01-syntax.md` §9), so Route I has no
   runnable target for realistic libraries. The first ingestable class is scalar
   arithmetic only.
3. **No lowering to a foreign backend.** `doc/04-translation.md` §4.1 leaves
   RE Core IR → WASM → ARM64/x86-64 undefined, so Route H's isolation story is
   "trust the host process" rather than "run in a sandbox".

## 5. Admission gates for Route I / Route I 准入条件

A candidate is admitted only when all of the following exist in the repository:

- **Pinned original.** Source URL, license, commit or version, and a content digest.
- **Corpus.** Committed inputs covering nominal, boundary, and error cases; no
  generated data that cannot be regenerated in-tree.
- **Equality.** Canonical output bytes identical to the original for every case;
  errors map onto the declared error family, never onto a silent default.
- **Determinism.** Two runs produce the same graph revision and the same
  observation digests.
- **Totality.** No panic, no unbounded recursion, and a declared budget on the
  admitted input domain.
- **License separation.** Ingested code and its license are recorded separately
  from Revia's MPL-2.0 terms.
- **Evidence artifact.** The run log and corpus live under
  `experiments/library-ingestion/<name>/` and are reproducible by one command.

Rejected candidates are recorded too: a rejection with a reason is cheaper than
re-litigating the same library later.

## 6. Prerequisites, in order / 前置条件（按顺序）

1. **Open the native operation namespace** (schema-declared, not enum-closed),
   keeping undeclared members fail-closed. Acceptance test: an adapter defined
   outside `revia-core` is reachable through a declared schema; an undeclared
   member still returns `UnknownOperation`.
2. **Expression surface for traversal**: list indexing, iteration, and text
   concatenation, with canonical form and lowering defined.
3. **Lowering skeleton** to one foreign backend, starting at `wasm32-wasip1`
   hello-world, so Route H can eventually mean sandboxed rather than trusted.
4. **Ingestion pipeline prototype** on exactly one scalar function, exercising
   §5 end to end: the first Route I artifact.

## 7. Non-claims / 非声明

- This document does not admit any library, and no Route I evidence artifact
  exists yet.
- Route H evidence in `src/host/` is bounded host conformance, not a promise of
  general third-party extensibility; blocker §4.1 explains why.
- No claim that transpilation generalizes beyond pure total deterministic
  functions with a typed surface.
- Nothing here changes the research/preview maturity statement in `README.md`.
