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
| runtime | `HostBackedBridge::host_request` (`minimal_std.rs:970`), fallback `declared_request` (`:1023`) | maps a member onto a `HostRequest`; since WP-351 a declared reference maps to `HostOperation::Declared` | `native-host-bridge-operation-unsupported:<instance>.<member>`, plus `-argument-missing`, `-argument-unknown:<name>`, `-argument-type-mismatch`, `-declared-member-unknown:<reference>.<member>` |
| runtime | `HostBackedBridge::response` (`:1074`) | maps a `HostOutcome` back onto the declared result type; since WP-351 declared members have their own arm | `native-host-return-type-mismatch` (`declared_response`, `:1332`) |
| runtime | `declared_response` (`minimal_std.rs:1322`), not `declared_host_error` (`:1196`) | maps a declared outcome back onto the declared result and error family; `declared_host_error` still only translates the closed built-in `StdError` set and WP-351 does not touch it | `-error-variant-unknown:<family>.<variant>`, `native-host-return-type-mismatch` |
| runtime | `host_operation_name` (`:1498`) | observation label for the effect log; declared calls are labelled `declared:<reference>.<member>` | none — silently `"unknown"` |

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
type mismatch). The four runtime sites stayed closed until WP-351: then a declared schema
passed `re check` and still failed closed at the host boundary with
`native-host-bridge-operation-unsupported:<instance>.<member>`. Two parse-time
helpers stay closed too (`default_argument_name`, `contextual_literal`, both run
inside `parse_compact_graph` where no declaration list exists), so a declaration
cannot yet drive positional arguments. Declarations cannot shadow the five
built-in references; a conflicting or malformed declaration is rejected with
`declared-schema-invalid` before the graph is read.

Partial progress, measured (WP-351a): inside one bridge instance the declaration
list now drives request mapping, response mapping, error mapping and the
observation label with one canonical encoding. Two properties make check-time and
run-time agree on the same registry. First, the declared argument object is
serialized in bytewise key order, so `argument_digest` does not depend on the
order in which the registry lists members or parameters. Second, type support and
shadowing are enforced only for a reference the graph actually calls: a
declaration the program never names no longer turns a `check`-admitted registry
into a construction failure. That seam is closed by WP-353:
`graph::validate_declarations` stays vocabulary-free, but check time now holds a
*referenced* declaration to the same payload vocabulary the bridge can map, so a
referenced member whose declared type cannot cross the host boundary is refused
by `check_graph_with_declared_schemas` with `declared-type-unsupported:<name>`
instead of surviving until `HostBackedBridge` construction. Unreferenced
declarations stay vocabulary-free on both sides, so a registry entry the program
never names still cannot decide whether the program runs.

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
WP-351 is the slice that starts reading them (below).

Partial progress, measured (WP-351): the runtime half of the registry opens,
but only for a bridge that is handed the same declaration list. The
`DeclaredMember` list already travels beside the graph (it was never stored on
`Graph`), so `HostBackedBridge::new_with_declarations` /
`new_for_graphs_with_declarations` take `&[DeclaredSchema]` and build a
`reference -> member -> DeclaredMember` table at construction time; `new` and
`new_for_graphs` keep their signatures and delegate with an empty list, so
built-in behaviour is untouched. A capability whose `reference` is in that table
now projects to `HostOperation::Declared { reference, member }` instead of
falling off the built-in match, and the response arm maps a declared
`result<ok, family>` return onto the declared family: `Ok(payload)` becomes a
plain `CapabilityResponse::ok` (the VM adds the `ok` wrapper, exactly as for the
built-in `fs.read`), `HostOutcome::DeclaredFailure(variant)` becomes
`CapabilityResponse::err(VmValue::ResultErr { type_name: family, variant })`, and
a variant outside `DeclaredMember.errors` is rejected rather than named. The
bridge is still fail-closed everywhere else: declarations cannot shadow a
built-in (that is rejected when the table is built, with
`native-host-bridge-declaration-invalid`), an unsupported type is rejected with
`native-host-bridge-declared-type-unsupported:<name>` (the same type name is
refused earlier, at check time, as `declared-type-unsupported:<name>`), an
adapter that answers
`UnknownOperation` still surfaces
`native-host-bridge-operation-unsupported:<instance>.<member>`, and declared
calls never commit an effect. New
`native/revia-core/tests/wp351_declared_host_dispatch.rs` (18 cases) proves the
dispatch through a stub `HostAdapter`, so the wiring is tested without teaching
`SystemHost`/`MemoryHost` the declaration table; those two still answer
`UnknownOperation` for `Declared` requests, which is why at WP-351 the CLI
exposed no registry yet -- WP-352 wires the flag in and the executing commands
still stop at that boundary (below).

Partial progress, measured (WP-352): the registry now reaches the commands that
consume a graph, so a declared schema is no longer rejected by a second,
declaration-blind check downstream. `translate_graph`,
`verify_bytecode_artifact` and `execute_bytecode` each gained a
`*_with_declarations` variant that re-checks with
`check_graph_with_declared_schemas`; the original public functions delegate with
an empty list, so every existing caller — `fault_corpus`, `runtime_bundle`, the
VM's own verification path — keeps its exact behaviour and bytes. The CLI wires
`--schema-registry` into `compile`, `execute`, `verify` and `run`, reading the
declarations once and threading them through. Without the flag nothing changes:
a declared graph is still `unknown-schema-reference`. With it, `compile` and
`verify` succeed and the executing commands reach the host boundary and fail
closed with `native-vm-capability-failed`, because `SystemHost`/`MemoryHost`
still answer `UnknownOperation` for `Declared` requests -- so this is admission
through the whole pipeline, not execution of a declared member. New
`native/revia-cli/tests/wp352_declared_registry_cli.rs` (3 cases) pins both
halves. The loaders keep the two routes separate, exactly as before declarations
existed: a compact source is parsed and checked with the caller's declarations,
while a canonical source is only loaded, because canonical form is written from
an already-checked compact graph and carries no declared reference.

Partial progress, measured (WP-353): one declared-type validator now serves
check time and the runtime bridge. `graph::is_supported_declared_type` (payload
names) and `graph::declared_return_type_supported` (`result<ok, family>`) are the
public predicates; `check_graph_with_declared_schemas` applies them to every
member of a schema the graph names, and `minimal_std` delegates its two
predicates to them, so the two sides cannot drift. The bridge keeps its own
`native-host-bridge-declared-type-unsupported:<name>` for the unit-level caller
that builds a bridge directly from an unchecked declaration list.
`validate_declarations` stays shape-only and vocabulary-free: a definition the
graph never names keeps whatever types it likes. New
`native/revia-core/tests/wp353_declared_type_vocabulary.rs` (8 cases: a matrix
over accepted and refused payload and return types asserting both sides answer,
a predicate-only guard that a malformed family half such as
`result<text.utf8, family>x>` is not a usable family name, plus the
unused-definition tolerance) and
`native/revia-cli/tests/wp353_declared_type_cli.rs` (3 cases: `graph-check` and
`compile` refuse a bad parameter and a bad return type with exit 65 and JSON on
stdout, and an unused unsupported definition still checks).

Partial progress, measured (WP-354): the execution half of §6 item 1 now has
end-to-end evidence, on the runtime seam rather than through the CLI. A
test-local `ServingHost` adapter — a `reference.member` handler table
implementing only `HostAdapter::invoke` and `close_secrets` — drives the
declaring program through
`translate_graph_with_declarations` -> `serialize_bytecode_artifact` ->
`VmRequest::new` -> `HostBackedBridge::new_with_declarations` ->
`execute_bytecode_with_declarations`. The run completes at `process.exit(0)`,
the adapter receives `HostOperation::Declared { reference, member }` with the
argument object named by the declaration
(`{"text":{"type":"text.utf8","value":"hi"}}`), `HostOutcome::DeclaredFailure`
lands on the program's `err` branch with the declared family, and the
observation carries `operation = "declared:demo.echo@0.1.0.say"` with
`effect_committed` false. The error family is asserted where it actually
appears, at the bridge: `empty` becomes
`err(ResultErr { type_name: "demo.echo_error", variant: "empty" })`, the
declared success payload is passed through unchanged, and a variant outside the
declared family is refused by name
(`native-host-bridge-error-variant-unknown:demo.echo_error.boom`) instead of
being folded into the branch. Fail-closed is unchanged: a member the adapter does
not serve is still answered `UnknownOperation`, becomes
`native-host-bridge-operation-unsupported:<instance>.<member>` at the bridge,
and fails the VM with `native-vm-capability-failed`; a wrong-shaped
`HostOutcome` becomes `native-host-return-type-mismatch` and the same VM
failure. This is evidence about the seam, not a production host: `SystemHost`
and `MemoryHost` still refuse `Declared`, so `run`/`execute` still stop at the
boundary. New `native/revia-core/tests/wp354_declared_host_serving.rs`
(6 cases).

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
   artifact; WP-351 opens the four runtime sites for a bridge built with that
   same list; WP-354 proves the execution half end to end with a serving test
   adapter. The two parse-time helpers (positional argument naming and the
   literal fallback) still run before any declaration exists and stay
   hardcoded.
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
