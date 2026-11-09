# Availability Work Package: Declared Capability Execution Closure

Status: in progress. Issues 1-4 are closed; the section 6 language change
(route A) is scheduled, and route B is delivered.

This page is the plan and the acceptance record for the next maturity slice of
the native toolchain: what a declared host capability can actually do end to
end, what refuses it, and in what order the remaining availability gaps are
closed. The companion page
[declared-capability-execution.md](declared-capability-execution.md) is
reserved as the later sealed evidence product; it intentionally carries no
claims yet.

## 1. What "available" means on this page

Three different facts are routinely conflated when a capability is discussed,
so this package keeps them separate:

| Fact | Meaning | Where it lives |
|---|---|---|
| Declared | A program states `capability @alias: family@version` and the registry describes the member's parameter and result types | graph + `--schema-registry` artifact |
| Implemented | The production host actually serves the member | `production_member` in `native/revia-core/src/declared_host.rs` |
| Authorized | An explicit `--capability-policy` artifact grants `reference.member` to this run | `revia.capability-policy@0.1.0` |

A registry **declares shape, never permission**. A policy can grant only what
the host implements. A program is refused unless all three line up, and each
refusal names its own diagnostic instead of collapsing into a generic host
fault. That three-way split is the reason Issue 1 exists: before it, a
declaring graph could reach the host adapter without any authorization artifact
and failed late inside the VM.

Availability labels used below:

- **measured** — reproduced by a checked-in test or recorded command on this
  source tree.
- **verified-only** — established by inspection or a bounded probe, not by a
  checked-in end-to-end test.
- **pending** — planned, no evidence yet.
- **fault-observed** — a defect was seen and is recorded as a known limitation.

## 2. Measured snapshot

- Source: `361de41` plus the WP-357 boundary change in section 4.
- Rust gates on this tree: `cargo fmt --all -- --check`,
  `cargo check --workspace --offline`, and
  `cargo clippy --workspace --offline --all-targets -- -D warnings` pass.
- `cargo test --workspace --offline` passes, including the declared capability
  harnesses named in section 3, the 14-case corpus in section 5, and the
  22-case host boundary corpus in section 4.
- `npm test` passes after the source import manifest is regenerated.
- No production-readiness, cross-platform, or Stable V1.0 claim is made by this
  page.

## 3. Issue 1 (P0, closed): declared capability execution closure

### 3.1 The counterexample this closes

A graph declares `capability @strings: revia.strings@0.1.0` and calls
`@strings.concat(...)`. With a schema registry supplied, the pre-WP-355 CLI
compiled, verified, and executed it, sent the call through
`HostBackedBridge` -> `SystemHost` -> `DeclaredCapabilityHost`, and failed
inside the VM. Nothing in that path required the run to say *who authorized
the call*: the registry was silently doing double duty as permission. Two
concrete defects sat behind that:

1. `HostRequest::declared` (`native/revia-core/src/minimal_std.rs:1038`)
   rendered each argument with `serialize_vm_value`
   (`native/revia-core/src/vm.rs:470`), producing typed envelopes
   (`{"<arg>":{"type":"text.utf8","value":"ab"}}`), while the host decoded them
   as bare JSON strings. Every production call therefore failed with
   `ArgumentTypeMismatch`, which the VM rewrote into
   `native-vm-capability-failed`.
2. Without a policy artifact, the CLI passed an empty declared-schema list, so
   the "host boundary" the earlier work packages reached was a boundary that
   could not authorize anything.

### 3.2 What was built

- `native/revia-core/src/declared_host.rs` (new): `DeclaredCapabilityHost<H>`
  wraps any `HostAdapter`, owns a `CapabilityPolicy`, serves exactly
  `revia.strings@0.1.0.concat`, `revia.strings@0.1.0.scalar_count`, and
  `revia.clock@0.1.0.monotonic_nanos`, delegates every other operation to the
  inner adapter unchanged, and refuses a policy grant for a member the build
  does not serve at binding time (`native-host-capability-policy-not-served`).
- Policy model: `revia.capability-policy@0.1.0` with a closed field set
  (`schema`, `grants`; grants carry `reference` + non-empty unique `members`).
  Every rejection has a stable reason suffix, e.g.
  `native-capability-policy-invalid:grant-member-duplicate:<reference>.<member>`.
  The reasons are enumerated in section 3.5.
- CLI: `--schema-registry` and `--capability-policy` on both `execute` and
  `run`; a graph that references a declared member with no policy is refused
  with `native-host-capability-policy-missing` (exit 65) before a host is
  built; a policy that cannot be read is exit 66 and one that cannot be parsed
  is exit 65.
- Tests:
  - `native/revia-core/src/declared_host.rs` unit tests: 13, covering policy
    round-trip and every reachable rejection, member semantics, denial that
    never reaches the inner host, pass-through of operations the adapter does
    not serve, oversize output, and wrong argument shapes.
  - `native/revia-cli/tests/wp355_declared_capability_policy_cli.rs` (new):
    9 end-to-end CLI tests using the real `revia` binary, the real
    `SystemHost`, a real registry file, and real policy files.

### 3.3 End-to-end path that is now measured

```
.re source --compile--> .rebc --run/execute--> graph check
  -> referenced_declared_references() sees the declared member
  -> --capability-policy required            (missing => exit 65, stderr diagnostic)
  -> CapabilityPolicy::parse + binding check (unserved gift => exit 65)
  -> DeclaredCapabilityHost over SystemHost  (ungranted => CapabilityDenied)
  -> bridge typed envelope decoded by typed_argument()
  -> Text/Int outcome
  -> VM branch-result => exit status of process.exit(...)
```

The successful `run` stdout carries `re.native-host-execution-result@0.1.0`
with `ok: true`, `invocations[]` naming the instance, member, outcome and
invocation id, and `trace[]` with `invoke-capability` / `branch-result` /
`return-status` at pc 0/1/2. That invocation record is the traceability the
acceptance criteria asked for.

### 3.4 Evidence quality caveat (recorded, not hidden)

The declared-call result value cannot be printed or bound from program text:
the language accepts only `ok(_)` / `err(_)` match arms after a declared call,
so a program can observe the result only through the exit status and the
runtime diagnostics. End-to-end CLI evidence is therefore **exit-status and
diagnostic evidence**. Value-level correctness (`concat` joins in argument
order, `scalar_count` counts characters rather than bytes, the clock is
monotonic, an oversize concat is a declared failure) is proven at the
`DeclaredCapabilityHost` unit level, not at the CLI level. This is a ceiling of
the current language surface, not a gap in the tests; lifting it is part of
Issue 4.

### 3.5 Rejection vocabulary (fail-closed)

Policy parse failures, all prefixed `native-capability-policy-invalid:`:
`not-json`, `not-an-object`, `unknown-field:<name>`, `missing-field:<name>`,
`schema-unsupported:<value>`, `schema-not-text`, `grants-not-an-array`,
`grant-not-an-object`, `unknown-grant-field:<name>`,
`missing-grant-field:<name>`, `grant-reference-not-text`,
`grant-reference-empty`, `grant-members-not-an-array`,
`grant-members-empty:<reference>`, `grant-member-not-text:<reference>`,
`grant-member-empty:<reference>`,
`grant-member-duplicate:<reference>.<member>`. The two `duplicate-field`
branches in `CapabilityPolicy::parse` are defensive: `parse_json` collapses an
object to unique keys, so text input cannot reach them. They are pinned by
inspection, not by a test, and that is stated rather than papered over.

Every reason above is pinned end to end by
[`native/revia-cli/tests/wp358_policy_rejection_corpus.rs`](../../native/revia-cli/tests/wp358_policy_rejection_corpus.rs):
18 policies that differ only in their bytes, run over one program and one schema
registry through the shipped `execute` path. Each case asserts exit status 65, a
single stderr diagnostic, `ok:false`, the host-result schema, an empty stdout,
and its reason token by exact equality rather than by substring. The same file
checks that the tested vocabulary is still the documented one, so this paragraph
and the corpus cannot drift apart silently. The one reason that is not reachable
there, `native-host-bridge-declared-member-unknown`, stays at the core boundary:
the CLI derives the bound host from the same registry the graph was checked
against, so the declared sets cannot disagree through that entry point.

Binding and execution failures: `native-host-capability-policy-missing`,
`native-host-capability-policy-not-served:<reference>.<member>`,
`native-host-bridge-capability-denied`, `native-host-bridge-declared-member-unknown`.

### 3.6 Open findings from Issue 1

| Finding | Kind | Consequence |
|---|---|---|
| `vm.rs` collapses every non-value bridge failure into `native-vm-capability-failed` | fault-observed | An end-to-end caller cannot tell denial, wrong-argument, and host fault apart; the precise code is tested at the core boundary instead. Fixing this changes observable CLI output, so it needed its own compatibility decision: [vm-failure-diagnostics.md](vm-failure-diagnostics.md) records it — the collapse stays the shipped contract, and any finer detail must arrive as a versioned additive member, never as a changed token. |
| `HostBackedBridge::observations()` is not exposed by the CLI | pending | Rich in-process host tracing exists but is not part of the shipped run output; `invocations[]` is the only trace surface a CLI caller sees. |
| `wp354` adapter handlers ignore `request.argument` | verified-only | WP-354 pins dispatch, not the wire encoding. The typed encoding is now pinned by the WP-355 decoder tests and the CLI end-to-end path. |
| No CLI negative for every bridge error variant | measured for the policy vocabulary; one variant stays core-only | WP-358 pins all 18 text-driven policy rejections end to end (section 3.5). `native-host-bridge-declared-member-unknown` is unreachable from the CLI by construction, so it remains pinned at the core boundary by `wp351_declared_host_dispatch`; its precise code is still collapsed to `native-vm-capability-failed` on the CLI path, which is the first row of this table. |

Issue 1 is closed on the four acceptance criteria it owned: the host is bound to
the production path, undeclared/unauthorized calls are rejected at the
authorization boundary, the CLI validation uses the native binary and the real
adapter, and no new open items were introduced. The four rows above are
disclosed limits of the slice, not latent failures inside it; the first row is a
real defect in a different component (the VM's diagnostic collapse) and is
labelled fault-observed for exactly that reason, with its fix deferred behind a
compatibility decision.

One ordering statement is verified-only rather than measured: the CLI rejects a
referenced-declared graph without a policy *before* constructing a host. In
`native/revia-cli/src/main.rs` the order is fixed by `read_capability_policy`
(`:1127` for `execute`, `:8090` for `run`) running before
`system_host_bridge_with_policy` (`:1143`, `:8103`), and
`referenced_declared_references` is consulted inside it (`:8438`). No test
asserts the absence of host construction; the tests pin the refusal, its
diagnostic, and its exit status.

## 4. Issue 2 (P0, closed): security isolation of the execution boundary

Goal: make "the guest cannot escape the declared surface" a measured property.

Closed with a 22-case corpus,
[`test/fixtures/host-boundary-refusal-corpus.json`](../../test/fixtures/host-boundary-refusal-corpus.json)
(`re.host-boundary-refusal-corpus@0.1.0`), driven by
[`native/revia-cli/tests/wp357_host_boundary_corpus.rs`](../../native/revia-cli/tests/wp357_host_boundary_corpus.rs),
plus one Unix-only driver test for the symlink forms. Each case carries a
`catches` line stating what an implementation change would break, asserts the
result schema and fragments on the stream that must carry them, and names the
stream that must stay empty. The harness was flipped twice in review: mutating
one case's expected exit, and inverting the absolute-write case's after-state to
demand the file appeared. Both mutations failed the corpus at the mutated
assertion, which is the evidence that the corpus bites rather than merely
passes.

### 4.1 What a program can reach, and what refuses it

The language-visible host surface is exactly four builtin members plus the
process status domain, and the declared families the registry/policy pair
admits. A member outside the builtin table is not expressible from program
text: the graph builder has no entry for it and rejects the reference as
`unknown-capability-member` before a host exists (that diagnostic is covered by
the graph tests, not by this corpus). Each reachable operation now has both
directions measured:

| Operation | Granted / positive case | Refusal case |
|---|---|---|
| `fs.read@0.1.0.read_file` | `builtin-read-granted` | `builtin-read-missing-file`, `builtin-read-relative-escape`, `builtin-read-absolute-path`, `builtin-read-size-limit`, and the driver's symlink read |
| `fs.write@0.1.0.write_file` | `builtin-write-granted` | `builtin-write-relative-escape`, `builtin-write-absolute-path`, and the driver's symlink write |
| `process.stdout@0.1.0.write` | `builtin-stdout-granted` (content visible in `program_stdout`) | `builtin-stdout-over-limit` (1,048,577 bytes) |
| `process.args@0.1.0.read` | `builtin-args-empty` | none: the member returns the host's argument list, which `execute` pins to empty; that pinning is host configuration (4.2), so the case proves the member is served and accepted, not what it returns |
| `process.exit@0.1.0.process.exit` | every case above exits through it | `exit-status-domain-refused` (status 256 refused while the artifact is built) |
| `revia.clock@0.1.0.monotonic_nanos` | `declared-clock-granted`, `artifact-run-granted` | `declared-clock-ungranted`, `declared-family-without-registry-refused`, `declared-unsupported-family-refused` |
| compiled artifact replay | `artifact-run-granted` | `artifact-run-without-grant`, `artifact-run-registry-not-grant` |

### 4.2 The boundary is the host configuration, not the policy

Measured, and recorded because the intuitive reading is the opposite:

- A program using a builtin capability runs with **no** `--capability-policy`,
  and runs again under a policy whose grant list is empty
  (`policy-does-not-gate-builtins`). The policy neither widens nor narrows the
  builtin surface.
- A policy that *names* a builtin is itself refused, as
  `native-host-capability-policy-not-served:fs.read@0.1.0.read_file`, exit 65
  with empty stdout (`policy-naming-builtin-refused`,
  `policy-naming-write-builtin-refused`). A policy can only authorize declared
  families the host actually serves.
- What holds is `SystemHost`: sandbox root = the `.re` source's parent
  directory, empty argument/environment/secret maps, a 1 MiB read budget, a
  lexical `validate_path` plus canonical-prefix check, and `symlink_metadata`
  refusing symlinks on the write side. The read budget is measured by the
  2 MiB refusal case; the identical `MAX_OUTPUT_BYTES = 1_048_576` constant
  also guards the stdout write and the `fs.write` payload in host code, but
  only the stdout limit is corpus-exercised, so the write payload limit stays
  verified-only. The empty argument/environment/secret maps are host
  configuration read from `system_host_bridge_with_policy`, not corpus
  assertions. A refused path
  survives as a program-visible `err` — the guest takes its own err branch and
  the CLI still exits 0 with `"ok":true` and an empty stderr — so asserting a
  host fault or exit 65 for those cases would pin the wrong behaviour.
- The 0..=255 status domain is enforced while the bytecode is built, not by
  the host: status 256 exits 65 with a graph-result
  `bytecode-literal-type-invalid` on stdout before any host exists.

The residual trust boundary is explicit: `SystemHost` and the
`DeclaredCapabilityHost` around it are trusted code. The guest cannot escape
them, and that is the measured claim; nothing here constrains host code
itself. The policy artifact is an operator-side authorization record, not a
sandbox, and it does not constrain the builtin surface at all.

### 4.3 Compile-time authority is not carried by the artifact

The widening probe is a corpus case rather than prose. `compile
--schema-registry <registry> <source> <artifact>` has no policy flag; the same
artifact is then replayed three ways. Under a granting policy: exit 0 with an
`ok` invocation. Under a policy that grants only a sibling family: exit 65,
`native-vm-capability-failed` on stderr. With no policy: exit 65,
`native-host-capability-policy-missing`. A registry without a policy never
authorizes anything (`artifact-run-registry-not-grant`). Authorization is
re-derived on every `run`; the artifact carries the typed call shape, never
the permission.

### 4.4 Disclosed findings

| Finding | Kind | Consequence |
|---|---|---|
| A refused filesystem path folds into the guest's own `err` branch (exit 2 here) while the CLI exits 0 | measured | There is no distinct diagnostic code for a path refusal; a caller reading only the exit status cannot tell refusal from a handled program error. |
| An ungranted **served** declared member collapses into `native-vm-capability-failed` | fault-observed | Same VM diagnostic collapse as section 3.6; `declared-clock-ungranted` pins the collapsed code, not a precise denial. The compatibility decision is recorded in [vm-failure-diagnostics.md](vm-failure-diagnostics.md). |
| `EnvironmentRead`, `SecretRead`, `RandomBytes`, `LogEvent`, `TraceEvent` exist in the adapter and in `MemoryHost` but are unreachable from program text | pending | They are unreachable today because the graph's builtin table has no member for them; the moment a language surface appears they become boundary items and need the same refusal evidence. |
| The symlink forms are a Unix-only driver test, not corpus cases | measured (recorded) | The fixture format has no portable way to create a symlink, and the Windows runner lacks the privilege. Both directions (read and write) are asserted on Unix and the gap is named rather than hidden. |
| `execute` derives its sandbox from the source path and cannot be pointed elsewhere | verified-only | Only `runtime-run` and `project-run-sandbox` take an explicit sandbox directory; the isolation measured above is the default path, and those two CLI paths are not covered by this corpus. |

Acceptance for this issue: every enumerated operation has a refusal case and,
where the boundary admits one, a granted case next to it (section 4.1); the
artifact-widening claim is measured (4.3); the residual trust boundary is
stated (4.2); and the boundary claim in
[`docs/load-time-authority.md`](../load-time-authority.md) is updated to the
measured set.

## 5. Issue 3 (P0, closed): conformance corpus for the declared surface

Goal: turn the WP-355 fixtures into a corpus other implementations can run.

- **Delivered as data.** `test/fixtures/declared-capability-execution-corpus.json`
  (`re.declared-capability-execution-corpus@0.1.0`) carries 14 cases, each a
  `(registry, policy, program, expected exit and diagnostic)` tuple plus a
  `catches` line that states what an implementation change would break.
  `registry` and `policy` are JSON artifacts; a policy may also be a raw string
  so the non-JSON case is expressible. `expected` names the stream
  (`stdout`/`stderr`), the result schema and fragments that stream must carry,
  and the stream that must stay empty. The two granted cases assert exit 0, the
  host-result schema, `"ok":true`, and an empty stderr; nothing wider, because
  the return value is not observable.
- **Consumed in one command.**
  `cargo test -p revia-cli --test wp356_declared_capability_corpus --offline`
  replays all 14 cases against `env!("CARGO_BIN_EXE_revia")`, one temp
  directory per case, through `execute` (no prior `compile` artifact). Each
  case is a CLI run: nothing in the corpus rests on a library-only test.
- **Two planned negatives were wrong, and the page says so.** Section 3.6
  proposed "non-`result` return type" and "unknown error variant" as negatives.
  Both are legal declarations: `host_schema_registry.rs` reads error variants
  from the definition's `types` table, not from a member's `errors` field, and
  `validate_declarations` treats variant names as declaration-local rather than
  a closed vocabulary, so a non-`result` return with an empty `errors` list is
  well formed. The corpus therefore drops those two bullets instead of
  inventing a rejection the checker does not and should not produce, and adds
  the structurally malformed declarations that *are* refused:
  a registry carrying another schema id, a duplicate declaration of one
  reference, and an error family nothing references (the round-trip guard).
- **Coverage of the section 3.6 list.** Unknown declared member
  (`unknown-capability-member`), wrong parameter type
  (`literal-type-mismatch`, with a well-formed literal of the wrong declared
  type — an integer literal in a named-argument position dies in the parser,
  so it cannot stand in for type checking), and host fault
  (`host-fault-output-limit`, the 65,536-byte declared text budget surfacing as
  `native-vm-capability-fault`) are all pinned at the CLI with exact exit codes
  and diagnostics.
- **Comparison with the Node reference path.** `src/host/` declares error
  *variants* in its adapter contracts (`declaredError`, with
  `undeclared-error-variant` as the refusal), but no Node module consumes
  `revia.host-schema-definitions@0.1.0` or runs a declared call. The overlap is
  the declaration vocabulary only; the execution path has no Node opposite
  number, and this page does not claim parity.
- **Acceptance evidence.** The corpus runs in one command; no case is a unit
  test; every case states what it catches. The harness was also mutation
  checked: flipping the expected channel of a negative case makes it fail, and
  restoring the file makes it pass.
- **Limits.** Declared-call return values cannot be bound or printed
  (`ok(_)`/`err(_)` only), so CLI evidence stops at exit status and
  diagnostics; value-level correctness rests on the 13 `declared_host` tests.
  A denied member and every other bridge failure collapse to
  `native-vm-capability-failed` at `vm.rs:417`, so the denial case can only
  assert the collapsed code, and the granted cases carry no fragment about the
  value they computed. The corpus does not enumerate one negative per
  bridge error variant; that needs the `vm.rs` compatibility decision, not a
  fixture.

## 6. Issue 4 (P1, closed): semantic interfaces for capability results

Goal: let a program actually observe what a capability returned.

- Specify binding a declared result to a value (`ok(%value)` / `err(%error)`)
  and rendering it, with the typed envelope preserved end to end.
- Specify how a `number.i64` return (e.g. `scalar_count`) is stored in a
  `result` binding; today it has no value position: the response is a plain
  `ok`, so matching it silently takes the `ok` branch and the value is dropped
  (measured in `result-value-interface.md`, section 1).
- Decide the stable way to print or compare a capability result so CLI evidence
  can be value-level instead of exit-status-level.
- Acceptance: an impact analysis for the language change, a versioned grammar
  note, and a CLI test that prints a capability value.

Delivered as route B in
[`result-value-interface.md`](result-value-interface.md): that page is the
impact analysis, the versioned grammar note is in
[`../language-reference.md`](../language-reference.md),
and `native/revia-cli/tests/wp4_result_value_cli.rs` prints a capability value.

Route B is CLI value-level evidence only: `revia execute --print-values` adds an
additive, non-digest `invocation_values[]` for each invocation, with the default
output and every `receipt_digest` unchanged. The language change (route A —
`ok(%value)` / `err(%error)`, payload-carrying `BranchResult`, artifact
`@0.2.0`) is **scheduled**, not implemented, which is what section 10 allows.
It still changes language semantics and was not folded into Issues 1-3.

## 7. Sequencing

1. Issue 1 — closed (this page).
2. Issue 3 — closed (this page): the corpus and its negatives are in place for
   Issue 2 to enumerate against.
3. Issue 2 — closed (this page): the isolation claim is measured against the
   corpus from Issue 3.
4. Issue 4 — closed (this page): the section 6 value interface
   shipped as route B, and the language change is scheduled there.
5. WP-358 — closed: the section 3.5 policy vocabulary has a CLI negative for
   every text-reachable reason, and the two remaining boundaries are named
   rather than assumed.
6. WP-359 — closed: the staged artifact path (`run`) carries the same opt-in
   value evidence as `execute`, so the two paths cannot disagree about what a
   capability call returned; the default staged result is unchanged and the
   member stays outside every `receipt_digest`.
7. WP-360 — decision recorded: the `native-vm-capability-failed` collapse is the
   shipped 0.1 contract, not a placeholder waiting to be split; a finer
   diagnosis may only arrive as a versioned additive member, and the record
   names what that forbids ([vm-failure-diagnostics.md](vm-failure-diagnostics.md)).
8. WP-361 — closed: `runtime-run` accepts the opt-in `--print-values`, so all
   three VM-backed CLI paths (`execute`, `run`, `runtime-run`) print the same
   value evidence for the same source, artifact, and input digest; the default
   replay bytes and the authority receipt are unchanged
   (`wp361_runtime_run_value_evidence_cli`, in
   [result-value-interface.md](result-value-interface.md) §5).
9. WP-362 — closed: the boundary for the remaining execution family is measured
   rather than assumed. `project-run` (and `project-execute*`) is refused the
   flag outright, its flat envelope carries no per-invocation data, and
   `project-run-verify` rejects both an added value member and an edited field,
   so value evidence there requires a versioned envelope — recorded as deferred
   item 1 in [result-value-interface.md](result-value-interface.md) §4
   (`wp362_project_value_evidence_boundary_cli`).
10. WP-363 — closed: value evidence on the project path arrives as an opt-in
    versioned envelope, not as a widened `@0.1.0`. `project-run --print-values`
    emits `re.native-project-run@0.2.0` (`@0.1.0` plus `invocation_values`),
    `project-run-verify` and `project-run-receipt-verify` accept both schemas,
    the default bytes and their digests are unchanged, and the other project
    commands still refuse the flag
    (`wp362_project_value_evidence_boundary_cli`, in
    [result-value-interface.md](result-value-interface.md) §5).
11. WP-364 — closed: the release gate asserts the binary that actually ships.
    `scripts/release-contract-smoke.mjs` is the single source of truth for the
    executable contract (version banner, parsed `check` result, byte-identical
    compiles across fresh processes, executed `run` envelope, exit `64` with a
    `Usage: revia` diagnostic, exit `66` for unreadable input) and runs on every
    target and both operating systems, replacing the POSIX-only shell contract.
    All four gate surfaces — draft POSIX asset, draft Windows asset,
    self-hosted Windows asset, published asset — delegate to it. The gate had
    been asserting CLI shapes the native binary does not offer (`check --format
    json`, single-argument `run`, a `65`-exit diagnostic sample that in fact
    parses with `ok:true`), so the four helpers encoding the same assumptions
    were retired as superseded by a stricter contract rather than silently
    kept: `scripts/test-json-contract.sh`,
    `scripts/test-compact-determinism.sh`, `scripts/test-compact-determinism.ps1`,
    `scripts/test-compact-determinism-contract.sh`. The launcher-level release
    smoke keeps its own assertions because `bin/revia` is a downloader, not a
    passthrough. Guarded by `test/release-contract-gate.test.js`.
12. WP-365 — closed: the documented permission scope matches the measured one.
    The execution contract had documented the policy as `{"schema": 1, ...}`
    while the binary reads a text schema and rejects the numeric form with
    `native-capability-policy-invalid:schema-not-text` (exit 65); both language
    versions now show the shape the shipped toolchain accepts, and both `execute`
    and `run` help state that the policy admits declared host members only, not
    that it is a filesystem or process sandbox. Pinned by
    `wp365_permission_scope_cli`, which also measures that a policy granting an
    unrelated declared member leaves a built-in `fs.read` call executing with
    `"ok":true` and `outcome.code: 0`, so no test or document can promote the
    artifact into a general permission boundary.

13. WP-366 — closed: the examples index says which stage produces the
    diagnostic. It called `examples/diagnostic-error.re` "structured diagnostic
    and exit 65" without naming the toolchain; measured, the Node reference
    `check` exits 65 with one diagnostic line on stderr, while the native
    `revia check` is a parser only and answers `re.native-parser-result@0.1.0`
    with `"ok":true` and exit 0, and the native diagnostic appears from
    `translate` or `compile` as `unknown-argument` in
    `re.native-graph-result@0.1.0` with exit 65. The index now gives the command
    for each toolchain, and the design-fixture note states that both `check`
    implementations reject those files with `unexpected-token`. The preview
    command table in `docs/language.md` now says the same for the shipped
    surface: `check` takes a bare file, so the preview forms `check --format
    json` and `check --write` exit 64 with `Usage: revia` on stderr. Pinned by
    `wp366_check_stage_cli`, which holds each stage to its measured exit code
    and diagnostic so no later edit can present the parser as the checker.

14. WP-367 — closed: the first-run path teaches a program, not just a command.
    `QUICKSTART.md` ran `examples/hello.re` and then jumped to the full test
    suites, so a reader never met the diagnostic themselves. The new "Your first
    program" section copies `examples/hello.re` into the Git-ignored `scratch/`,
    changes the literal, and records the measured output of `npm run re -- run
    scratch/first.re` (`Hello, Revia!`), `npm run re -- check scratch/first.re`
    (`OK scratch/first.re`), the argument-name diagnostic
    `scratch/first.re:9:28: unexpected-argument (expected data, got message)` on
    stderr with exit 65, and the machine-readable forms: `check --format json`
    answers `re.check-result@0.1.0` with `schema`, `file`, `ok`, and
    `diagnostics`, and `manifest` answers `re.review-manifest@0.1.0` with the
    declared capability, effect calls, and error paths. Pinned by
    `quickstart-first-program`, which runs the same flow in a temporary
    directory and asserts those outputs, so the tutorial cannot drift from the
    CLI. The same fresh-clone walk found the native block unusable as written:
    `cd native && cargo test --workspace --offline` exits 101 with
    "build the release binary before this test", because
    `wp283_release_evidence_cli` executes `native/target/release/revia` and a
    clone has no `target/`. The CI workflows already build the release binaries
    before testing; `QUICKSTART.md` and `AGENTS.md` now say so, and the focused
    test keeps the build step ahead of `cargo test`.
15. (WP-368) The same walk found the native block in `README.md`,
    `README.zh-CN.md`, and `CONTRIBUTING.md` with the same two defects plus a
    third: the block never changes into `native/`, so its first command is
    `cargo test --workspace --offline` from the repository root, which exits 101
    with "could not find `Cargo.toml`". All three documents now `cd native`,
    build the release binary first, and then test; `test/quickstart-first-program.test.js`
    asserts the order in all four documents and that the three block-bearing
    documents change into `native/`. `README.md` and `README.zh-CN.md` also
    stated current-source evidence at main commit `ca268c4`; both now name
    `45e6e66` as the commit that was passing when the file was last updated and
    say the evidence does not extend to later commits.

16. (WP-369) The first-run walk also checked the opposite direction: every
    `re 0.1 compact` sample embedded in `doc/` and `docs/` was extracted and run
    through `node src/cli/re.js check`. Four fences open with the program header
    and three of them are rejected with exit `65`: `doc/00-overview.md` twice
    (the original Hello World draft and a later `process.exit(0, after: …)`
    sketch) and `doc/01-syntax.md` section 8 (the compact half of a
    compact/canonical illustration). Only `docs/language.md` embeds a runnable
    program. None of the three was rewritten: they are design history, and the
    two documents now say at the top of the sample that the shape is not
    executable and point at `QUICKSTART.md` and `examples/` for runnable code.
    The same walk found the tutorial's missing second step. `QUICKSTART.md` now
    has "Your second program": it creates `scratch/input.txt` and a `fs.read`
    program with `@files.read_file(path: "input.txt")`, then
    `npm run re -- check scratch/read.re` answers `OK scratch/read.re` and
    `npm run re -- run scratch/read.re` exits 0 with empty stdout and stderr.
    Two properties of that surface are now written down because a reader would
    otherwise discover them as a surprise: file paths resolve relative to the
    directory of the program file, and a path that leaves it still passes
    `check` but takes the `err` branch at run time (exit `3` in the sample, with
    empty streams, no stack trace), and a `0.1` match cannot name the value it
    matched, so the program can branch on the read but cannot print it until
    `re 0.2 compact`. Pinned by two tests in
    `test/quickstart-first-program.test.js`: the tutorial flow, extracted from
    the documented heredoc and replayed in a temporary directory, and the fence
    audit above, which fails if a design document starts presenting an
    unexecuted shape as runnable.

17. (WP-370) The third first-run walk ran every `examples/*.re` file from the
    repository root, the directory `examples/README.md` tells a reader to use.
    Nineteen of twenty settled as documented, but `read-check.re` and
    `read-encoding.re` both exited `2` with empty streams: both call
    `@input.read_file("input.txt")`, paths resolve relative to the program file,
    and `examples/input.txt` did not exist, so the documented first-run command
    took each program's own `err` branch. `examples/input.txt` now ships with
    the line `example input for read-check.re`, both samples exit `0`, and the
    README states the file each sample needs, the directory-relative rule, the
    exit `2` that a removed input produces, and the `examples/output.txt` that
    `write-check.re` writes (now Git-ignored). `test/examples-runnable.test.js`
    copies the examples into a temporary directory, runs all twenty, and pins
    the exact split: seven print a fixed report, six exit `0` silently, one
    (`diagnostic-error.re`) exits `65` with `:9:28: unexpected-argument`, and
    the six design fixtures (`cf-*`, `p0-demo-runtime.re`, `schema-ops.re`)
    exit `65` with `unexpected-token`. An example missing from the tables fails
    the test, so a new sample cannot reach a reader unclassified.

18. (WP-370b) The gate document carried its own frozen copy of the
    code-validation snapshot and mislabelled the evidence. `docs/stable-release-gate.md`
    named `ca268c4` in the template row and in both prose languages, and called
    `project-surface-check` a workflow although no workflow of that name exists:
    it is a native CLI subcommand, exercised by
    `native/revia-cli/tests/project_template.rs` inside every
    `cargo test --workspace` pass. The gate now names the mechanism instead of a
    hash (the native test suite in all three validating jobs, plus the Windows
    job verifying the digest of the executable it built before launching it),
    points at `docs/release-policy.md` for the measured snapshot, says the
    evidence does not extend to later commits, and states the real remaining
    condition: a versioned candidate must rebuild the template natively, run
    `revia project-check` and `revia project-surface-check` against that build,
    and bind the result to its own tag. `docs/release-policy.md` now describes
    the same evidence the same way: it owns the one snapshot hash (`ca268c4`),
    says the `project-check` and `project-surface-check` tests come from that
    commit's `cargo test --workspace` run rather than a non-existent workflow,
    and says the evidence does not extend to later commits.
    `docs/development-status.md` keeps its deliberate fixed snapshot. `test/release-gate-evidence.test.js` fails if the
    gate pins a commit hash again, drops the mechanism or either subcommand, if
    a named workflow stops running `cargo test --workspace`, if the Windows job
    stops verifying its digest, or if the release policy stops naming the same
    snapshot in English and Chinese.

19. (WP-371) The RC2.2.1 release notes repeated the same two mistakes one
    document further out. `RELEASE_NOTES.md` said "The current main source
    later passed" CI at `ca268c4`, which stops being true at the next green
    commit and reads as a live claim about whatever main is, and it called
    `project-surface-check` a "gate" as if a workflow of that name existed.
    The notes now say a later main snapshot, `ca268c4`, passed that CI, point
    at `docs/release-policy.md` as the place recording the snapshot, credit the
    `project-check` and `project-surface-check` tests to that CI's
    `cargo test --workspace`, keep the Windows digest re-verification, and say
    the checks neither belong to the published RC2.2.1 assets nor extend to
    later commits. The fourth case in `test/release-gate-evidence.test.js`
    fails if the notes revert to "current main source" (English or Chinese),
    drop the snapshot hash point at the policy, lose the workspace-suite credit
    or the digest re-verification, or call the subcommand check a gate again.

20. (WP-372) Three links in this file and eight in the `doc/` design pages
    pointed at paths that do not resolve from where they are written.
    `docs/work-packages/availability.md` wrote `../native/...` and
    `../test/...` links, which land in `docs/native` and `docs/test`; the
    targets were one directory further up and are now `../../native/...` and
    `../../test/...`. `doc/05-execution.md` and `doc/06-open-questions.md`
    linked to `BOOTSTRAP.md` and `V1-DESIGN.md` as siblings in the repository
    root, but those are internal design records that are not part of the
    public tree: the references now name them as such and are no longer
    links. `test/docs-links.test.js` scans the root documents, every
    `docs/**/*.md` page, and the `doc/` pages, ignores fenced code and
    external or pure-anchor targets, rejects any relative target that escapes
    the repository, and requires at least 150 resolved targets so a scan that
    silently stops walking the tree fails.

21. (WP-373) Every release-notes link in the `docs/evolution.md` timeline
    pointed at a fragment that does not exist. The three rows used
    `#01-preview`, `#01-preview1`, and `#v100-rc1--deep-trial-`, while the
    notes only carry `v1.0.0-rc.2.2.1`, `v1.0.0-rc.2.1`, `v1.0.0-rc.1`, and
    `Historical Preview`: a reader following any of them landed at the top of
    the file with no section in view. The notes now carry explicit
    `<a id="...">` anchors for the two preview rows and for the rc.1 and
    rc.2.2.1 sections, and the timeline links name those anchors.
    `test/docs-links.test.js` now also resolves the fragment of every relative
    link against the target page's heading fragments and explicit anchors, so
    a link into a renamed or never-written section fails instead of opening
    the page at the top.

22. (WP-374) `docs/README.md` presents itself as the map of the public
    documentation but did not list three pages: `translation-rendering.md` was
    reachable only by following a link out of the architecture page, and the
    two Chinese mirrors (`architecture.zh-CN.md`, `execution-contract.zh-CN.md`)
    appeared nowhere in the map at all. The map now names the translation and
    rendering page and the two mirrors next to their English originals.
    `test/docs-links.test.js` gained a second case: every top-level page under
    `docs/` except the map itself must be linked from the map, so a page added
    without an index entry fails instead of drifting out of reach. Records
    under `docs/work-packages/` and the local promotion and planning notes stay
    out of that rule, because they are reached from the pages that cite them.
23. (WP-375) Two pages described a repository shape that does not exist.
    `doc/04-translation.md` pointed at an internal roadmap under
    `docs/superpowers/plans/`, a path that is not in the public tree, so the
    citation now names the plan without pretending it ships. `doc/11-node-free-
    milestone-0.1.md` listed `native/revia-compiler`, `native/revia-vm` and
    `native/revia-server` as workspace crates; the workspace has four crates
    (`revia-core`, `revia-cli`, `revia-conformance`, `revia-macos-identity`),
    and the compiler, VM and server roles live inside `revia-core` as modules.
    The layout list now matches the tree and names the macOS identity crate.
    `test/docs-links.test.js` gained a third case: every repository path written
    in inline code on a shipped page has to exist, either itself or as the
    documented shorthand for a sibling file (`doc/04` for
    `doc/04-translation.md`). Glob patterns, `<...>` shape descriptions,
    `native/target/` build output and file:line suffixes are exempt. Historical
    records under `docs/work-packages/` are out of scope, because a past entry
    naming a script deleted later is faithful history rather than an
    instruction.
24. (WP-376) Documentation told readers to run commands and named the command
    surface by hand, so drift was invisible. `test/docs-commands.test.js` now
    holds two invariants: every `npm run <name>` a shipped page shows must be a
    script `package.json` declares, and every `node src/cli/re.js <name>` must be
    a subcommand the CLI accepts. The subcommand set is read from `re --help`,
    which prints usage to stderr and exits 64, so the test asserts both sets are
    non-trivial (at least five scripts, at least ten subcommands) rather than
    passing on an empty parse. At the time of writing the probe is clean: no
    page names an unlisted script or an unknown subcommand. Appending
    `npm run nosuchscript` or `node src/cli/re.js nosuchcommand` to
    `docs/architecture.md` fails both cases.
25. (WP-377) The link guard read the repository pages but not the pages under
    `examples/`, although those are first-run documentation: a reader is sent to
    them from the shipped pages and they say what to run. The scan now covers
    `examples/**/*.md` as well. The tree is clean today, and appending a link to a
    page that does not exist fails the case with the offending document and
    target.
26. (WP-378) `examples/README.md` is the first-run index of the sample
    programs, but three tracked samples (`agent-business-starter.re`,
    `agent-args-policy.re`, `agent-file-report.re`) were never named in it, so a
    reader browsing `examples/` met files the index did not explain. All three
    run from the repository root; the index now names them, and
    `test/examples-runnable.test.js` fails when a top-level `examples/*.re` is
    missing from the index.
27. (WP-379) The command guard read the repository pages but not the pages
    under `examples/`, although those are where a reader first types the commands:
    `npm run re -- check ...`, `npm run re -- view ...`, `node src/cli/re.js
    project-check ...`. The scan now covers `examples/**/*.md` too. The tree is
    clean, and a command that is not one the CLI accepts fails the case with the
    offending page and command.
28. (WP-380) The runnable-example guard copied only the top-level `*.re`
    files, so the twelve programs below the top level were never checked: six
    standalone programs (`adversarial-review/case-0{1,2,3}/main.re`,
    `agent-handoff-review/main.re`, `agent-review/main.re`,
    `reviewed-file-plan/plan.re`) and the six modules of the
    `agent-expense-review` fixture. The guard now walks the directory: a nested
    program must pass `check`, and a module of a project fixture must pass the
    fixture's `project-check`.
29. (WP-381) `examples/agent-evidence-boundary/README.md` explains the
    program's run commands and review framing, but no shipped page linked it, and
    the index only linked top-level `.re` files, so the six example directories
    that carry pages went unguarded. The index now names the page, and
    `test/examples-runnable.test.js` fails when a directory under `examples/` is
    not linked.
30. (WP-382) `projects/README.md` listed the source command that verifies the
    project template as `node src/cli/re.js project-check`, which the CLI rejects
    with the usage exit code 64 because `project-check` only accepts
    `--format json`; a reader copying the table could not reach the check it
    names. The table and the surrounding prose now show the flag, and
    `test/docs-commands.test.js` reads both documented invocation shapes, joins
    backslash continuations, and fails when a documented invocation omits an
    argument the CLI requires.

31. (WP-383) `QUICKSTART.md` showed a rejected program exiting `65` and a
    second program exiting `3` without saying which code belongs to the command
    and which to the program, so a reader could not tell a usage mistake from a
    program's own verdict. The first-program section now states the command's
    codes (`0` complete, `64` unknown command line, `65` unreadable or
    rejected) next to the note that `run` passes a program's exit code through,
    and `test/quickstart-first-program.test.js` measures each of those codes.

32. (WP-384) A rejection's two halves — the message and the exit code — were
    documented only in fragments: `QUICKSTART.md` gave one paragraph and
    `docs/evidence.md` described release evidence, but no page said where a
    diagnostic goes or which code belongs to the command rather than the
    program. `docs/diagnostics.md` now shows the exit-code table (`0`, `64`,
    `65`), the one-line `file:line:column: code (expected, got)` form, the
    `re.check-result@0.1.0` JSON shape, and the facts a failure report needs;
    `docs/README.md` and both language halves of `QUICKSTART.md` link it, and
    `test/docs-diagnostics.test.js` measures every code and both diagnostic
    forms against the CLI.

33. (WP-385) The first-program tutorial showed the rejected edit and stopped:
    the reader learned that `message:` exits `65` but not that putting the call
    back returns the file to `0`, so a copy-pasted rejection had no way out.
    `QUICKSTART.md` now ends the rejection with the repair — the restored
    `@stdout.write("Hello, Revia!\n")` call, a passing `check`, and the
    sentence that the command exits `0` again — in both languages, and
    `test/quickstart-first-program.test.js` re-runs `check` after restoring the
    source and pins `OK scratch/broken.re` with an empty stderr.

34. (WP-386) The failure path was descriptive but not actionable: the page
    listed the facts a report needs, then pointed at a prose policy, leaving a
    reader with nowhere concrete to file it even though
    `.github/ISSUE_TEMPLATE/bug.yml` already asks for exactly those six fields.
    `docs/diagnostics.md` and `docs/feedback-loop.md` now link the bug form,
    and `test/docs-diagnostics.test.js` holds the checklist, the form ids and
    labels, and the six required flags together so neither side can drift.

35. (WP-387) The examples index never told a reader how to tell whether an
    edit changed a program's contract. `examples/README.md` now documents the
    three measured comparisons on `hello.re` — a comment leaves
    `graph_revision` alone, a reworded string leaves `capabilities` alone, an
    added `cap @input: fs.read@0.1.0` grows it — and
    `test/examples-runnable.test.js` re-runs all three and quotes them.

36. (WP-388) The integration guide named `project-projection` but never said
    what a consumer outside the repository reads. `docs/integration.md` now
    states the measured exit status, the
    `re.interface-projection-manifest@0.1.0` envelope keys, the two generated
    files, the routed operation, and the exact three lines a plain Node
    consumer prints; `test/docs-commands.test.js` re-runs the projection and
    the consumer, then requires the guide to quote that output as one block.

37. (WP-389) The bug form requires a version, commit and minimal input, but no
    page said how to produce them. `docs/feedback-loop.md` now gives the three
    measured commands (version from `native/Cargo.toml`, `git rev-parse
    --short HEAD`, `node --version`), the supported Node range, and the exact
    diagnostic shape a rejection prints; `test/docs-commands.test.js` re-runs
    the version recipe and a real rejection and requires the guide to match.

38. (WP-390) A reader who opens one module of the largest example project and
    runs the single-file checker got `unsupported-language-version (expected
    0.1, got 1.0; phase header; ...)` at `1:4` with exit `65`, which reads like
    a broken tool. `examples/agent-expense-review/README.md` now says the six
    files are project modules rather than standalone programs, quotes that
    diagnostic verbatim, and points at `project-check`;
    `test/examples-runnable.test.js` re-runs the rejection and the project
    check and requires the page to quote both the diagnostic and the checker.

39. (WP-391) The diagnostics page said the source CLI exits with one of three
    codes, but a host input the program needs can fail before it runs: `run
    --format json --authority-pin` with a missing, non-JSON, or non-pin file
    exits `70` and writes a `re.run-result@0.1.0` host-fault envelope to
    stdout. `docs/diagnostics.md` now lists `70`, quotes that measured
    envelope, names the three measured fault codes and the `64` a pin without
    `--format json` returns; `test/docs-diagnostics.test.js` runs all four
    cases and requires the page to match.

40. (WP-392) The integration guide showed a `build --out` invocation but
    never said what the directory is for, so a reader could not tell that the
    artifact runs on plain Node outside this repository. `docs/integration.md`
    now documents the `re.build-result@0.1.0` envelope, the seven files, the
    `re.build-artifact@0.1.0` profile, the measured `Hello, World!` output, the
    checksum check and the `65`/`build-write-failed` refusal for an absent
    parent or a non-empty directory; `test/docs-commands.test.js` builds the
    artifact, copies it, runs it from another directory with a PATH-only
    environment and re-runs both failure cases.

41. (WP-393) The diagnostics page explained a rejection line but never
    showed a reader how to get from one back to an accepted file, which a
    modification task needs. `docs/diagnostics.md` now pairs three measured
    rejected edits — a header version this release does not accept, a deleted
    `cap` line, and a capability revision the target does not provide — with
    the position each diagnostic reports and the smallest repair that makes
    `check` exit `0`; `test/docs-diagnostics.test.js` re-runs every pair.

42. (WP-394) A reader looking for the modification path had no entry point:
    the documentation map listed running, reading diagnostics, and contributing
    but not changing an example. `docs/README.md` now links the
    `After You Edit` section, and `examples/README.md` links the diagnostic
    page so a rejected edit has a stated next step; `test/docs-links.test.js`
    resolves every fragment these links name.

43. The largest checked project example documented only static checks, so a
    reader could not see its execution path; `project-run --fixture` exits `0`
    with `re.project-run-result@0.1.0` and a `re.project-run-receipt@0.3.0`
    receipt. `examples/agent-expense-review/README.md` now runs that command
    with the checked-in fixture, states the stable `receipt_digest`, `replay`
    `attempts: 2`, the approved typed outcome, and the `64` usage exit without
    `--fixture`; `docs/integration.md` links that section.
    `test/docs-commands.test.js` re-runs the command twice and resolves the
    link, and the `attempts` mutation is caught. The page also states the
    three rejection paths — exit `65` with
    `missing-project-run-selection-field`,
    `project-run-graph-revision-mismatch`, or `project-run-case-not-found` —
    and the test replays each; the first draft of the test asserted only the
    live behaviour, so the code mutation passed until the page assertions were
    added.

44. QUICKSTART.md ended at the two single-file programs, so a reader who
    wanted a project had to leave the page; the checked multi-module example is
    now a third step with `project-check --format json` (`0`,
    `re.project-check-result@0.1.0`, `"ok":true`) and `project-run --fixture`
    (`0`, `re.project-run-receipt@0.3.0`, `64` without the flag).
    `test/quickstart-first-program.test.js` re-runs both from the root and pins
    the promised envelopes; the receipt-version mutation is caught.

45. The example's modification steps named `project-surface-check` with no
    binary, so a reader typed a command that does not exist; the steps now copy
    the example to `scratch/`, name `native/target/release/revia
    project-surface-check`, and record that its `graph_revision` is a native
    digest that does not equal the pinned Node one. `docs-commands` re-runs the
    stale-digest rejection (`project-module-source-digest-mismatch`, `65`) and
    the native envelope when the binary exists; the code mutation is caught.

46. `projects/README.md` presented `project-init` next to the source CLI's
    `project-check`, with no provenance and no warning that the starter it
    writes cannot be checked by that CLI: measured, the native starter seals a
    `re 0.1 compact` module, so `project-check --format json` exits `65` with
    `unsupported-module-surface-header` and the native surface check exits `65`
    with `native-project-module-surface-header-unsupported`. The page now names
    the release binary, the `re.native-project-init@0.1.0` envelope, the working
    `revia project-check` path, and the failing header rewrite. The template
    page says where `revia` comes from. `project-template` re-runs all four
    envelopes and catches a renamed schema.

47. The example's modification steps still told a reader to "update the source
    digests" and confirm the native surface check "fails closed", which no
    published command performs. Measured on a `scratch` copy: a comment-only
    edit yields `65` `project-module-source-digest-mismatch`; updating only
    `modules[].source_sha256` yields `65`
    `project-module-implementation-digest-mismatch` for the same module; both
    pins updated, `project-check` exits `0`. A capability-access edit with the
    same two pins also exits `0` from `project-check` and the native surface
    check, and the closed gate is `project-run --fixture ...`, which exits `65`
    with `project-run-graph-revision-mismatch` because the fixture pins the
    pre-edit revision. The steps now state the two-pin repair and that run
    gate; `docs-commands` re-runs both and catches the code mutation.

48. `bin/revia` reported every target the candidate never published as
    `Revia runtime error: Missing checksum for revia-1.0.0-rc.2.2.1-darwin-arm64.tar.gz.`
    with exit `70`, which reads as a damaged checkout. Measured: the candidate
    publishes only `linux-x64` and `windows-x64` assets, and
    `runtime/checksums.txt` has no `darwin-arm64` row for it, so on this
    checkout `./bin/revia check ...` failed at the checksum lookup. Both
    launchers now distinguish the two states: an absent per-target row prints
    `pending target` with the target and compatibility pointer and exits `69`,
    while a missing `runtime/checksums.txt` or a version with no rows at all
    still exits `70`. `release-compatibility-table` runs synthetic roots for
    all three, catches the reverted exit code, and requires the compatibility
    page to state both codes.

49. `docs/compatibility.md` and `docs/evidence.md` said "five pending
    targets" on pages whose current section is RC2.2.1. The number was
    accurate when written for the RC1 import (`c4e7867`):
    `runtime/rc1/target-matrix.json` has five pending rows because RC1 measured
    `darwin-arm64`, and `runtime/rc2.2.1/target-matrix.json` has four. On the
    same page the sentence could be read against either matrix, and no test read
    it. Both pages now say "the pending targets" without a count, and
    `release-compatibility-table` accepts a count only when it equals the
    pending rows of a published matrix (five or four here), in English and
    Chinese, so a count that matches neither candidate fails.

50. `QUICKSTART.md` described the published candidate assets only by libc
    floor, so a macOS `arm64` reader following it would reach the source
    launcher and get an unexplained refusal: measured here, `bin/revia check`
    exits `69` with `pending target` because RC2.2.1 publishes no darwin asset.
    The section now says the launcher runs a command only for a target with a
    recorded release asset, names the four pending targets, and points at
    `native/target/release/revia` as the supported path there.
    `release-compatibility-table` asserts the quickstart keeps that wording
    next to the compatibility matrix.

51. An earlier revision of record 49 in this file called the "five pending
    targets" wording drift that appeared after the RC2.2.1 matrix settled. That
    was wrong: `git log -S` traces the sentence to the RC1 import, where five
    pending rows was the correct count. The defect is ambiguity across two
    matrices, not a stale number, and record 49 now says so.

52. `docs/execution-contract.md` and its Chinese mirror introduced `bin/revia`
    as the versioned native launcher without saying that it resolves only a
    candidate whose release asset is recorded in `runtime/checksums.txt`, and
    `docs/language-reference.md` did the same. A reader on macOS `arm64` could
    plan a launcher-based run that exits `69` with `pending target`. All three
    pages now state the resolution rule and link the compatibility matrix, and
    `release-compatibility-table` asserts the English exit code and link plus
    the Chinese exit code.

53. `examples/README.md` told readers to run the challenge and review
    directories from the repository root without saying that several of them
    drive `./bin/revia`. On a pending target the first launcher command exits
    `69` with `pending target`, so the index now states the release-asset rule,
    the build-from-`native/` alternative, and links the compatibility matrix;
    `release-compatibility-table` guards the exit code and the link.

54. The five example landing pages that drive `./bin/revia` — the three
    adversarial-review cases, `examples/challenges/`, and
    `examples/reviewed-file-plan/` — repeated the launcher commands without
    saying that an unpublished target stops at exit `69`. Each page now states
    the `pending target` outcome, the build-from-`native/` alternative, and
    links the compatibility matrix; the same test guards all five.

55. `scripts/test-launchers.sh` still asserted the rc.1 usage line
    `Usage: revia <command>` and versioned only for `0.1-preview.1` and
    `1.0.0-rc.1`, so on the current candidate it failed at its second
    assertion. It now checks the current help surface, derives this host's
    asset from `runtime/checksums.txt`, and expects exit `69` with
    `pending target` and the compatibility pointer when no row exists. The
    release compatibility test runs the script on POSIX hosts, so drift fails
    the suite instead of waiting for a hand run.

56. `docs/language.md` still told readers to run `revia --help` on macOS
    arm64 "for `v1.0.0-rc.1`", naming a version whose only measured target is
    not where the current candidate is measured. The clause now records the
    rc.1 measurement as history, keeps its trial manifest as the rc.1
    contract, and points at the compatibility matrix for the candidate a
    reader actually runs. The release compatibility test holds both the
    pointer and the retired phrasing.

57. `docs/diagnostics.md` is where an exit code gets looked up, and it covered
    only the source CLI's `0`, `64`, `65`, and `70`. A reader who hit the
    launcher's `pending target` refusal found no row for `69` and could not
    tell that code's `70` from the source CLI's host fault. The page now has a
    launcher table for both codes, the measured messages behind each, and the
    compatibility pointer. Measured on this host: no rows for the version
    exits `70` with `Release checksums have no entries for …`, an unreadable
    file `70` with `Release checksums file is unavailable.`.

58. The rc.1 trial kit README and its contract both told a reader to put the
    accepted Darwin arm64 candidate at `./bin/revia` and run the trials with
    `REVIA_EXECUTABLE=./bin/revia`. In the repository that path is the launcher
    for the current candidate, so the documented run stops at `runner binary
    digest mismatch`, and following the README literally would overwrite a
    tracked file. Both pages now install the candidate outside the repository
    and pass its path, and say that the manifest's `./bin/revia` runner names
    the copy the runner makes in its temporary run directory.

59. The first attempt at 58 also rewrote the kit README, which is hash-bound
    fixture text in the sealed rc.1 export: the trial-kit verifier then failed
    with `fixture hash mismatch: README.md`, and nothing in `npm test` ran it
    to notice. The README is back to its recorded bytes and the correction
    lives in the contract only; the compatibility test now runs the verifier,
    so a later edit to a sealed fixture fails on a push instead of on a tag.

60. `experiments/rc1/README.md` told readers to install the accepted binary at
    `kit/bin/revia`, but the kit tree ships no `bin/` directory and the runner
    reads `REVIA_EXECUTABLE`, so the instruction named a path nothing loads.
    The guide now sends readers to an installed path and the contract; the
    compatibility test rejects the old sentence.

61. `docs/evidence.md` repeated the same dead install instruction in both
    languages: it told readers to put the accepted binary at `bin/revia`, which
    no script loads. Both paragraphs now install outside the repository and
    pass the path as `REVIA_EXECUTABLE`, matching the contract; the
    compatibility test covers this page too.

62. `scripts/test-rc1-validate-contract.sh` still asserted the retired
    `0.1-preview.1` branch and workflow anchors, so running it always failed,
    and nothing invoked it. It now checks that the tree validator still names
    the checked-in `VERSION` and keeps an `unsupported VERSION` fallback, and
    `scripts/validate-public-tree.sh` runs it on every push.

63. `scripts/test-public-tree-worktree-contract.sh` asserted an
    `--exclude=.git` argument the tree validator no longer passes; the
    validator stopped walking the filesystem and now delegates to the
    source-import manifest, whose `SOURCE_ROOTS` never include `.git`. The
    obsolete guard is removed rather than kept failing.

64. The Linux baseline test pinned five host patterns and the floor, so the
    section's other parenthesised glibc numbers — `Ubuntu 23.10 (2.38)` in both
    language halves among them — could be edited silently. It now collects every
    host/glibc pair in each half, requires the recorded set, and rejects any pair
    at or above the stated floor.

65. `experiments/rc1/README.md` said its manifest "binds seven trials" and that
    five targets stayed pending, but no test read either number: a trial or a
    matrix row could be added while the guide kept describing the old kit. Both
    counts now derive from `kit/trial-manifest.json` and
    `runtime/rc1/target-matrix.json` in the release-compatibility suite.

66. `docs/cross-platform-evidence.md` restated the RC1 matrix table and the
    rc.2.1 archive and executable digests, and no test read the page: a status,
    a row, or a published digest could change while the evidence procedure kept
    quoting the old value. The suite now compares every table row to
    `runtime/rc1/target-matrix.json`, both digests to
    `runtime/rc2.1/native-evidence.json`, and the six-target count to the
    matrix length.

67. `docs/development-status.md` published the declared-call and host-boundary
    corpus sizes, but the Rust drivers iterate whatever the fixtures hold, so
    the page could keep quoting a stale count after a case was added or
    removed. The suite now derives both counts from
    `test/fixtures/declared-capability-execution-corpus.json` and
    `test/fixtures/host-boundary-refusal-corpus.json` and rejects a fixture
    that repeats a case id.

68. `docs/protocol.md` published the exit-status table that users branch on,
    but no test compared it to the code: a renumbered `EXIT_*` constant or a
    new launcher status would leave the page quoting a set that no longer
    exists. The docs suite now derives the documented set from `src/cli/re.js`
    and `bin/revia` and requires the table to match it exactly.

69. `docs/evolution.md` is the only page linking into the explicit `<a id>`
    anchors in `RELEASE_NOTES.md`, and no test resolved them: renaming an
    anchor or retitling the section under it left a dead timeline link. The
    docs suite now checks every cited anchor exists, precedes the heading for
    its version, and appears once per version.

70. Current pages quote schema identifiers that consumers branch on, and no
    test compared them to the tree: renaming an identifier left a page telling
    readers to switch on a string no command emits. The docs suite now
    requires every backticked identifier in a current page to appear in a
    tracked non-page, non-test file. `doc/` (retired pre-public tree) and
    `docs/work-packages/` (plans) stay out of scope.

71. The rendering page listed the text form as a format the `view` command
    supports, and the command answers `--format text` with the usage block:
    nothing compared the page's format list to the shipped CLI. The docs suite
    now derives the accepted formats and locales from the `view` usage line in
    `src/cli/re.js`, requires the page to state exactly that list, and checks
    that every documented format runs while an undocumented one still fails
    with the usage exit code.

72. The RC1 license page described the first RC asset as still planned for
    one native target while the matrix recorded it measured, and no test read
    the page: a matrix row could change, or the page could announce a target
    early, without the boundary moving. The compatibility suite now derives
    every target state from `runtime/rc1/target-matrix.json`, requires the
    page to name exactly the measured target and no pending one, and rejects
    the stale planned wording.

73. The RC1 license page summarized the controlling license but listed only
    four of its seven restrictions, and nothing compared the two: a reader
    could take the page as the full list of prohibited uses. The page now
    enumerates every restriction, and the source-transition suite parses the
    numbered restrictions from `LICENSE-RC.md` and requires a matching
    summary bullet carrying each restriction's topic, so a dropped bullet or
    a reworded license fails.

74. The RC1 license page opens with a Chinese one-line abstract, and it kept
    its own shorter list: after the English bullets covered every restriction
    the abstract still named four. Nothing read the abstract, so the two
    mirrors could diverge unnoticed. The source-transition suite now requires
    the abstract to carry a topic for each restriction the license states, and
    the abstract names the removed-notice, control, and endorsement limits.

75. `docs/test-population-evidence.md` is what an evaluator reads before
    trusting a population report, and it names the schema id the runner emits
    and the CI artifact that carries it. No test read the page, so a schema
    bump or an upload rename would leave it describing evidence the repository
    no longer produces. The runner suite now holds the page to the exported
    schema constant and to the workflow's artifact name.

## 8. Evidence rules

- Every claim on this page names the command, fixture, or source line that
  supports it, and keeps `measured` / `verified-only` / `pending` /
  `fault-observed` distinct.
- A passing CLI test proves the path it exercises and nothing wider. A registry
  entry is never evidence of authorization, and a policy grant is never
  evidence of implementation.
- Findings that would require changing observable output or language semantics
  are recorded and deferred, not fixed inside an unrelated slice.
- No tag, release asset, or published digest is touched by this package.

## 9. Review gate

The page and the Issue 1 slice are reviewed by a second model against the
acceptance criteria above, with the reviewer instructed to check the code and
tests rather than the prose alone. A `FAIL` verdict reopens the relevant item;
a `PASS` verdict is recorded here with the reviewer's verdict line.

**Verdict: `PASS`** (2026-11-07, independent Claude review, 30-turn budget,
read-only). The reviewer re-counted the tests (13 core, 9 CLI), traced the four
diagnostic codes, the typed envelope and its strict decoder, the `vm.rs`
collapse point, and the CLI's pre-host policy gate; it confirmed that the
closure claim does not present untested behaviour as tested. Five minor
findings were raised and are resolved here:

| # | Finding | Disposition |
|---|---|---|
| 1 | The encoder is `serialize_vm_value` in `vm.rs`, invoked from `HostRequest::declared`; attributing it to one file was imprecise | Section 3.1 now names both call sites. |
| 2 | `main.rs` does not contain the literal `native-host-capability-policy-missing` | It uses the constant; the code exists and is proven end to end by the WP-352 and WP-355 stderr assertions. No change needed. |
| 3 | "Before a host is built" was stated as measured | Re-labelled verified-only above, with the ordering evidence named. |
| 4 | The `vm.rs` finding was not shown to suppress *all* non-value bridge failures | The doc already labels it fault-observed and the claim is scoped to the single collapse point at `vm.rs:417`. |
| 5 | "not unresolved defects" read as self-exemption for a fault-observed row | Reworded: the VM collapse is called a real defect in another component. |

No finding required a code change; none contradicted the closure claim.

## 10. Exit criteria for this work package

- Issue 1: closed, with the measured path and evidence in section 3.
- Issue 2: every enumerated host operation has a refusal test and a granted
  test; residual trust statement published.
- Issue 3: corpus runs in one command and includes the section 3.6 negatives.
- Issue 4: impact analysis accepted; language change either scheduled or
  explicitly rejected. This page: scheduled (route A), route B delivered —
  section 6 and `result-value-interface.md`.
