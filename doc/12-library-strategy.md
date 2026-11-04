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

## 4. What actually blocks admission, measured / 已知阻塞（实测）

### Blocker 1 — the gate is a closed vocabulary spread over eight sites, not the adapter trait

The adapter seam is already public and generic: `HostAdapter`
(`native/revia-core/src/minimal_std.rs:425`), `HostEnvironment<A>` (`:430`), and
`HostBackedBridge<A>` (`:752`) accept any out-of-tree implementor. But that seam
alone admits nothing, because the set of legal schema references and members is
hardcoded in eight places, split by phase:

| Phase | Site | What it fixes | Failure code when unmatched |
| --- | --- | --- | --- |
| check | `graph::is_known_schema` (`graph.rs:977-986`) | exactly five schema references | `unknown-schema-reference` |
| check | `graph::parameters` (`graph.rs:760-786`) | the legal `(schema, member)` table and arity | `unknown-capability-member` (`:784`) |
| check | `graph::default_argument_name` (`graph.rs:632-643`) | positional argument name per member | `missing-argument-name` |
| check | `graph::contextual_literal` (`graph.rs:580-630`) | literal type per member; unlisted pairs fall back to `text.utf8` at `:615` | — (silent default) |
| runtime | `HostBackedBridge::host_request` (`minimal_std.rs:909-957`) | maps a member onto a `HostRequest` | `native-host-bridge-operation-unsupported:<instance>.<member>` |
| runtime | `HostBackedBridge::response` (`:959-997`) | maps a `HostOutcome` back onto the declared result type | `native-host-return-type-mismatch` |
| runtime | `declared_host_error` (`:1063-1093`) | maps a `StdError` onto the member's declared error family | `native-host-bridge-error-reference-unknown` |
| runtime | `host_operation_name` (`:1205-1213`) | observation label for the effect log | none — silently `"unknown"` |

Two corrections to the obvious reading of that table:

- `host_request` matches **four** references, not the same five as the allowlist.
  `process.exit@0.1.0` never reaches the bridge: `compact_target`
  (`graph.rs:552-578`) turns it into a `Target::PureOperation`, validated at
  `:666-675`.
- `HostOperation::Unknown(String)` (`:317-329`) and `HostRequest::unknown`
  (`:401`) are not an adapter extension point today, but the reason is narrower
  than "adapters cannot construct one": `unknown` is `pub` and every
  `HostRequest` field is `pub`, so an out-of-tree crate can build one and pass
  it to `HostEnvironment::invoke` (`:443`). What the repo actually supports is
  that no production path (`graph`, the VM, `HostBackedBridge::host_request`)
  ever produces an `Unknown` request, so adapters never receive one outside the
  tests that construct it explicitly (`wp257_minimal_std_host.rs:277`,
  `wp345_library_admission_boundary.rs:47,76,97`). The `Unknown` rejection arms
  (`:573`, `:734`) are reachable only through a direct `invoke` call. The
  constructor stays: sealing or deleting it breaks those call sites and drops
  the forward-compatibility placeholder, so treat it as reserved surface rather
  than as an admission path.

Partial progress, measured (WP-346): `graph::check_graph_with_declared_schemas`
takes a `DeclaredSchema` list and lets it drive the three check-time sites — the
allowlist (`graph.rs:253-259`), the member table and arity (the declared branch
at the top of `parameters`, `:766-768`), and argument names/types (declared types
are enforced, so the silent `text.utf8` fallback at `:615` no longer absorbs a
type mismatch). The four runtime sites stay closed on purpose: a declared schema
passes `re check` and still fails closed at the host boundary with
`native-host-bridge-operation-unsupported:<instance>.<member>`. Two parse-time
helpers stay closed too (`default_argument_name`, `contextual_literal`, both run
inside `parse_compact_graph` where no declaration list exists), so a declaration
cannot yet drive positional arguments. Declarations cannot shadow the five
built-in references; a conflicting or malformed declaration is rejected with
`declared-schema-invalid` before the graph is read.

Partial progress, measured (WP-347): the declaration list now travels as a file.
`host_schema_registry::parse_registry` reads one JSON artifact,
`{"schema": "revia.host-schema-definitions@0.1.0", "definitions": [...]}`, whose
definitions are the objects `src/host/schema-registry.js` already validates
(`identity`, `revision`, `members.<name>.params[] = {name, type}`); the reference
is derived as `identity@revision`, exactly as `referenceOf` does, so no second
converter is needed. WP-348 extends the projection with each member's declared
`returns` type and the variants of the error family it names
(`types[family].variants`, with `kind: "error-sum"` required); `access`,
`default`, `primary`, `resource_catalog` and `resource_parents` are tolerated and
ignored until the sites that consume them open. `render_registry` writes the same shape
through `canonical_json`, so the artifact is byte-stable and round-trips through
the reader. Malformed artifacts are rejected with
`declared-schema-registry-invalid` before the graph is read; duplicate,
shadowing, empty or otherwise invalid declarations keep their
`declared-schema-invalid` code. A `returns` value that is not a non-empty
string, a family that is not an `error-sum` (`kind` mismatch, empty or
ill-formed `variants`), and a `types` entry no member names are rejected
immediately as `declared-schema-registry-invalid`, because rendering would drop
them; a malformed result string is rejected one step later, when the parsed
declarations are validated, as `declared-schema-invalid`. The CLI exposes it as
`revia graph-check [--schema-registry <registry>] <file>` (output schema
`re.native-graph-result@0.1.0`, unreadable file exit 66, invalid source, graph or
registry exit 65) — a new command because `check` is the parser path. Runtime
admission is unchanged: a registry-admitted graph still fails closed at the host
boundary.

Partial progress, measured (WP-348): the artifact also states what a member
returns. `DeclaredMember.returns` carries the definition's `result<T, E>` string
(or a plain type name) and `DeclaredMember.errors` carries the ordered variants
of the family that string names, read from the definition's `types` table. A
family with no `types` entry keeps an empty variant list rather than a guess.
A `returns` value that is not a non-empty string, a family that is not an
`error-sum`, an empty or ill-formed variant list, and a `types` entry no member
names are rejected with `declared-schema-registry-invalid` (rendering would drop
such an entry, so the artifact would not round-trip); a member whose result names
no family cannot carry variants, `result<...>` must have exactly two non-empty
halves (only a depth-zero comma separates them, so a `map<text.utf8,number.i64>`
half stays whole), and members sharing one family
must agree on its variants, all under `declared-schema-invalid`. A malformed
result string that leaves its would-be family unnamed makes the matching
`types` entry unreferenced, so the artifact rule fires first and the diagnostic
points at `types[family]`; `declared-schema-invalid` only covers programmatic
declarations and artifacts with no such entry. Rendering writes
`returns`/`types` only when present, so WP-347 artifacts keep their exact bytes.
No runtime site reads these fields yet; the host boundary stays closed.

Consequence: Route H costs a core edit at **each** of those eight sites, with a
test per site — not the single enum change this document originally claimed, and
not a two-edit change either. §6 item 1 is written against this table.

### Blocker 2 — the expression surface cannot walk data, and has no arithmetic

Production syntax has no list indexing, iteration, argument echo, or arithmetic
expressions (`doc/01-syntax.md` §2, §9); the native std surface likewise has no
arithmetic operation (`StdOperation`, `minimal_std.rs:32-44`). Route I therefore
has no runnable target today. A scalar arithmetic function is the *intended first*
ingestable class, not a currently supported one.

### Blocker 3 — no lowering to a foreign backend

`doc/04-translation.md` leaves RE Core IR → WASM → ARM64/x86-64 undefined; the
relevant subsection is the one titled "production lowering（占位）" (the document
has two `### 4.1` headings, so cite it by title, not by number). Route H isolation
is therefore "trust the host process", not "run in a sandbox".

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

1. **Open Route H's closed vocabulary behind one schema registry.** A registry
   entry supplies, for one schema member: its reference, its argument names and
   types, its result type, and its declared error family. That single declaration
   must drive all eight sites listed in blocker 1 — at check time the allowlist,
   the `(schema, member)` table and the positional argument names; at runtime the
   request mapping, the response mapping, the error mapping, and the observation
   label. Undeclared members stay fail-closed at every one of them.
   Status: WP-346 lands the three check-time sites behind
   `check_graph_with_declared_schemas`; WP-347 gives that list its file format
   (`host_schema_registry`, `revia graph-check --schema-registry`), and WP-348
   carries each member's declared result type and error variants in that same
   artifact; the four runtime sites and the two parse-time helpers are still
   hardcoded and read none of it.
   Acceptance test: an out-of-tree schema and member declared through the
   registry (not a new match arm) passes `re check`, executes through
   `HostBackedBridge`, returns its declared result type, surfaces its declared
   error family, and appears in the effect log under its real operation name.
   The same program without the registry entry fails at check time with
   `unknown-schema-reference`; a declared schema with an undeclared member fails
   with `unknown-capability-member`. Extending `HostOperation` or `HostAdapter`
   alone satisfies none of this.
2. **Expression surface for traversal and arithmetic**: list indexing,
   iteration, text concatenation, and numeric operations, with canonical form and
   lowering defined — the precondition for any Route I candidate beyond trivia.
3. **Lowering skeleton** to one foreign backend, starting at `wasm32-wasip1`
   hello-world, so Route H can eventually mean sandboxed rather than trusted.
4. **Ingestion pipeline prototype** on exactly one scalar function, exercising
   §5 end to end: the first Route I artifact.

## 7. Non-claims / 非声明

- This document does not admit any library, and no Route I evidence artifact
  exists yet.
- Route H evidence in `src/host/` is bounded host conformance, not a promise of
  general third-party extensibility; blocker 1 explains what is missing.
- The tests added alongside this document
  (`native/revia-core/tests/wp345_library_admission_boundary.rs`) pin the
  *direct-invocation* branch of an undeclared member. They do not test the eight
  admission sites named in blocker 1, and they must be revisited, not merely kept
  green, when §6 item 1 lands.
- No claim that transpilation generalizes beyond pure total deterministic
  functions with a typed surface.
- Nothing here changes the research/preview maturity statement in `README.md`.
