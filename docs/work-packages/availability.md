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
`grant-member-duplicate:<reference>.<member>`. One reason is outside that
vocabulary because it is not a policy-parse failure at all: a policy file
opening with a UTF-8 byte-order mark is refused with
`byte-order-mark-not-allowed`, the same code the single-file reader and the
project manifest use, since the text is well-formed and only its prefix is not.
The two `duplicate-field`
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

76. `docs/agent-workflow.md` is the first instruction an outside evaluator
    follows, and it lists the evaluate commands as bare backticked words, so
    the documented-invocation scan never saw them. A renamed subcommand would
    leave the page telling a reader to run a command the CLI rejects. The
    command suite now resolves every command the evaluate step names against
    the usage text.

77. `docs/android-termux-experimental-contract.md` promises Android stays an
    additive experimental target that neither satisfies nor weakens the desktop
    set, but no test read the page. Promoting Android in the matrix would leave
    the boundary still calling it additive, so the compatibility suite now
    holds the page to the current matrix's target set and count in both
    languages.

78. `docs/server-conformance.md` publishes the bounded Server slice as measured
    evidence, but no test read `runtime/rc1/server-evidence.json`. The page
    could keep describing a two-module Darwin arm64 rc.1 slice after the
    evidence moved, or after the rc.1 matrix measured a second target the page
    still calls out of scope, so the compatibility suite now holds the page to
    the evidence version, target, module count, and the matrix's measured set.

79. `docs/rc1-sealed-export-contract.md` is the only accepted bridge from
    private development, but no test read it: the eleven-file inventory, the
    manifest identity fields, and the six-target matrix were prose the export
    could silently outgrow. The compatibility suite now binds the inventory to
    `runtime/rc1/export-manifest.json` (ten payloads plus the manifest itself)
    and the target matrix to the measured `darwin-arm64` row.

80. `docs/rc2-target-expansion-contract.md` names a hosted runner for each
    desktop target, but no test compared the page with the gate matrix. A
    runner image bump in `release-gate.yml`, or a native conformance workflow
    on another image, would leave the contract describing machines that never
    build the target. The new guard checks the page's English and Chinese
    runner assignments against the matrix and the native workflows.

81. `docs/load-time-authority.md` says four builtin members are the whole
    language-visible surface, but no test compared the page with the checker's
    supported-operation table. A fifth accepted operation would leave the page
    understating what the runtime executes. The new guard derives the families
    from `src/toolchain/checker.js` and requires the page to list exactly them.

82. The rc.2.2.1 candidate manifest and public export are written by separate
    steps, and no test compared their archives. The export could ship one
    measured target and omit another while every record still claimed both.
    The new guard requires the export to list the candidate targets and an
    archive whose digest and size match each candidate row.

83. The rc.2.2.1 target matrix is what readers quote as readiness, while the
    native evidence files record what was measured. No test paired them, so a
    row could stay `measured-native` after its evidence changed version, or a
    pending target could carry a measured record. The new guard requires the
    matrix rows and the evidence files to name the same targets.

84. `capability-evidence.json`, `multi-module-evidence.json`, and
    `server-evidence.json` record the measured conformance runs, but no test
    read them: a candidate bump, or a matrix that measured another target,
    would leave the records naming a run for a release or target that no
    longer exists. The new guard binds their version, source commit, scope,
    and per-target run ids, which must agree across the records, to the
    candidate manifest and the measured matrix rows.

85. The sealed RC1 export manifest lists six records the public tree still
    carries, but only `LICENSE-RC.md` was checked against its digest: a renamed
    or edited record would leave the sealed manifest describing a file that is
    no longer there. The new guard requires each shipped record's size and
    SHA-256 to match the sealed entry.

86. `runtime/checksums.txt` is the plain digest list readers check a download
    against, but only the RC1 lines and the export manifest's listing were
    covered: the current candidate could ship a stale or misspelled digest
    line. The new guard requires the candidate archive and binary digests in
    `checksums.txt` to match the candidate manifest, rejects duplicate or
    malformed lines, and rejects entries no release record names.

87. `experiments/rc1/kit/trial-manifest.json` is the reproducible input for
    the RC1 trial: it lists every file the runner copies and hashes, but nothing
    compared those digests with the files in the tree, so a fixture could drift
    or go missing while the manifest kept publishing the old hash. The new guard
    requires each listed file's size and SHA-256 to match, rejects duplicate
    entries, and requires the kit to ship no unlisted file.

88. The RC1 kit's own `checksums.txt` is what a trial runner verifies before
    executing, but no test read it: it could disagree with the manifest while
    both claimed to describe the same kit. The new guard requires its file set
    to equal the manifest's files plus the manifest itself, with matching
    digests, and rejects duplicate or malformed lines.

89. The RC1 trial kit names the binary it ran and the evidence record each
    trial refreshes, but neither was tied to the candidate or the sealed
    export: the kit could claim a runner or an evidence file the release never
    made, and a trial could point every step at one record while another shipped
    record went stale. The new guard requires the published runner digest to
    match the candidate file, every `evidence_ref` to be in the sealed export,
    each record to name the candidate version, and every shipped evidence record
    to be refreshed by at least one trial.

90. `docs/evidence.md` is the page a reader lands on before reproducing the
    RC1 trial: it counts the measured command paths, names each one, and states
    the version. The trial manifest could gain, lose or rename a path while the
    page kept its prose. The new guard binds the page to the manifest and the
    candidate: seven paths mapped to their trial ids, every trial measured with
    a command, an exit status and a stderr digest, the command surface still
    running, and the page naming the candidate version.

91. The RC1 lines in `runtime/checksums.txt` were only whitelisted by name,
    and the sealed export's archive entry was never compared with them: the two
    records that describe the same download could disagree while both tests
    passed, and the binary line was compared with nothing at all. The new guard
    restates the RC1 binary digest from the candidate file and the RC1 archive
    digest from the sealed export, so a drift on either side fails.

92. The sealed RC1 export carries the license digest twice: in the payload
    inventory and as the top-level `license_sha256`. Only the inventory entry
    was compared with the shipped license, so the top-level field could name a
    stale digest while every other check stayed green. The new guard requires
    both to restate the `LICENSE-RC.md` bytes and therefore each other.

93. The public trial kit header names a version, and its README states the
    release in prose, but neither was compared with the candidate manifest the
    kit measures: the header could name one release while the kit measured
    another. The new guard requires the kit version to match the candidate
    version, the status to stay measured, and the README to name that version.

94. The current target matrix was only read for its pending-row count: its
    version field was compared with nothing, and a measured row could name a
    target the candidate never shipped while the count stayed the same. The new
    guard binds the matrix schema and version to the candidate manifest, keeps
    the desktop target vocabulary of both matrices equal, and requires the
    measured rows to be exactly the candidate's targets.

95. `docs/rc1-trial-kit-contract.md` promises that the static verifier rejects
    digest drift, changed checksums, and symlinked fixtures, but the suite only
    ran it against the intact kit: a comparison weakened to accept any value
    would still print the verified line on every push. The new guard copies the
    kit to a scratch directory, requires the copy to verify, then changes one
    fixture byte, one checksum line, and adds one symlink, requiring each edit
    to fail with its documented message.

96. The 1.1 trial contract moved `command` and `expected` inside `steps`, and
    `scripts/run-public-trials.sh` is the only place that enforces it, but its
    shell test only greps for the failure message: a contract clause dropped
    from the jq filter would leave the message and the test intact. The new
    guard runs the runner on a scratch copy three times: the pristine kit must
    pass the contract and stop at the candidate digest, while a trial-level
    command and a step without results must each stop at the contract gate.

97. `scripts/test-rc1-launcher-contract.sh` pins the RC1 launcher messages and
    `scripts/test-rc1-gate-contract.sh` pins the RC1 gate workflow steps, but
    neither script was invoked by the test suite, the CI validator, or a
    workflow: a dropped message or gate step would only surface by hand. Both
    scripts now run from `scripts/validate-public-tree.sh`, and a guard keeps
    that wiring and requires both contracts to pass, so losing either the
    launcher wording or the gate step fails the suite.

98. `scripts/run-reviewed-file-plan.sh` is the boundary between a reviewed
    approval and a sandbox write: the approval is bound to the plan bytes it
    was given, effect paths may not escape the sandbox, duplicate effects are
    rejected, and a denied decision must not invoke the runner at all. Only
    `sh -n` checked the script; no test, workflow, or script executed it, so a
    weakened check would keep passing by hand. A guard now drives the script
    through its usage, stale-approval, unsafe-path, duplicate-effect, and
    denied-no-execution branches, so any of those checks going quiet fails the
    suite.

99. The documentation tests parse documented invocations for their
    subcommand names and required flags, but never resolve the `.re` inputs
    those invocations name, so a renamed or moved example leaves the
    architecture walkthrough and the example pages telling a reader to run a
    file the repository no longer ships while every documented-command check
    keeps passing. A guard resolves every `examples/`, `projects/`, and
    `experiments/` `.re` path named in the scanned documents and requires it
    to exist, so doc rot of a runnable input fails the suite.

100. `scripts/test-public-trial-runner-contract.sh` pins the markers the
     public trial runner relies on, but nothing invoked it: the public tree
     validation never chained it and no test ran it, so its pins could drift
     with the runner while it stayed green by hand. The validation now chains
     it, and a guard requires the chain, executes the contract, and checks
     that every pinned marker still exists in both the contract and the
     runner, so a stale pin fails instead of passing quietly.

101. `scripts/verify-rc1-export.sh` is the gate a sealed RC1 export has to
     pass, and only `sh -n` covered it: the usage exit, the missing-directory
     rejection, the symlink rejection, the exact inventory rejection, and the
     evidence parse were all unbound, so a weakened check would let an
     unsealed directory through while the syntax check stayed green. A guard
     drives each rejection on synthetic directories and requires its exit
     code and message.

102. `scripts/verify-rc1-trial-kit.sh` is the gate a trial kit has to pass,
     and on the current version line only `sh -n` covered it: the usage exit
     and every rejection before the digest comparison were unbound, so a
     weakened directory, symlink, file-type, inventory, or canonical-JSON
     check would let a kit through while the syntax check stayed green. A
     guard drives each rejection on synthetic kits and requires its exit code
     and message.

103. `scripts/verify-rc1-release-assets.sh` derives the release tag from
     `VERSION` and refuses to inspect any other tag, but only `sh -n` covered
     it. A guard requires the usage exit and rejects both a foreign tag and the
     bare version without its `v` prefix, so a weakened comparison cannot let
     the asset check inspect a release for the wrong version.

104. `scripts/test-adversarial-review-contract.sh` is the only thing that
     exercises the three adversarial case directories end to end, and nothing
     referenced it: a case could be added without the contract, or dropped from
     the contract while its directory stayed, and the tree would still
     validate. The public tree validation syntax-checks the contract, and a
     guard keeps its case list and the case directories in step.

105. The source-import allowlist decides what the manifest covers, and
     `scripts/validate-release-provenance.mjs`, which release-gate CI runs,
     was absent from it: its provenance could change without any digest
     moving. The path is listed and a guard requires every tracked JavaScript
     module to be in the allowlist, so a new module cannot enter unnoticed.
106. The sequencing ledger in this file is edited by hand at the end of every
     work package and no document scan reads it (`docs/work-packages/` is
     excluded from the command and link checks), so a skipped or reused number
     would make two packages indistinguishable in review. A guard now requires
     the entries under `## 7. Sequencing` to be numbered 1..N, once each and in
     order, and the last entry to keep its evidence lines.
107. The release and trial scripts under `scripts/` are read and run by
     maintainers, but only a subset is parsed at run time
     (`scripts/validate-public-tree.sh` checks six of the thirteen). A syntax
     error in the rest ships unnoticed: breaking `scripts/test-launchers.sh`
     leaves that gate green. A guard now parses every tracked `*.sh` with
     `sh -n` and requires all of them to parse.
108. `package.json` and `MINIMUM_NODE_VERSION` are pinned to each other, but
     the `.github/workflows/validate.yml` matrix pins a version of its own. The
     matrix is the only place the advertised floor is exercised, so a minimum
     bump would leave CI testing a runtime the package no longer claims. A
     guard now requires the matrix to name both the exact floor and the major
     line it tracks.
109. The workflows name ten files under `scripts/` and `runtime/`; a rename
     that misses one only fails when that gate is next triggered, and two gate
     workflows (`rc2-release-gate.yml`, `windows-rc2-release-gate.yml`) are not
     named anywhere else in the tree. A guard now collects every path the
     eight workflow files invoke and requires it to exist, so the rename lands
     in every workflow that names it.
110. The npm scripts are how a contributor reaches the CLI, the cold-start
     runner and the grammar fuzz gate, and nothing read their targets: a rename
     that updated the imports could leave `npm run` pointing at a file the
     repository no longer ships. A guard now resolves every script target
     against the tracked tree and rejects a command that is not a plain `node`
     invocation.
111. `.github/pull_request_template.md` is the one page every contributor reads,
     and the link scan reached `docs`, `doc` and `examples` but never it. Its
     licence link and the agreement checkbox are the contributor's part of the
     release contract, so a guard now resolves the template's links from
     `.github` and keeps the checkbox.
112. A workflow that omits `permissions` runs with the repository default
     token scope, so a release or validation gate can quietly gain write access
     it never needed and nothing in the tree said so. A guard reads the block
     from each workflow and accepts only `{}` or read-only scopes.
113. `.github/ISSUE_TEMPLATE/config.yml` decides where a report can go, and no
     test read it: enabling blank issues lets a reporter skip the form the
     diagnostics page promises, and a contact link that leaves the repository
     sends the report where nobody reads it. A guard keeps blank issues off and
     pins each contact link to this repository.
114. `runtime/checksums.txt` is what a trial runner verifies a download against,
     while the candidate and export manifests are what the release record cites;
     nothing tied the two, so the list could pass a file the record does not
     describe. A guard recomputes the list digest and matches every current
     release entry to the manifests.
115. `experiments/rc1/comparison/baseline-status.json` states what the comparison
     study has established, and no test read it: a metric could be recorded as
     measured without a preregistered run, or an advantage claimed while every
     metric is still `not_evaluated`. A guard keeps the metric set complete,
     every metric unmeasured, and the claim negative.
116. `experiments/rc1/comparison/record.schema.json` defines what a comparison
     record must publish, and nothing read it: dropping a required digest, an
     execution mode, or `additionalProperties: false` would let a record look
     complete while omitting the proof. A guard pins those five shapes.
117. `runtime/rc1/trial-manifest.json` publishes what the RC1 trial measured and
     the kit ships a copy of the same record, but nothing compared them: a
     regenerated kit could leave the published record naming other digests, and
     the runner digest was never tied to the entry in `runtime/checksums.txt`.
     A guard requires both records to agree and every trial to name that runner.
118. `docs/architecture.md` draws the source-to-review path and prints the four
     commands that walk it, but nothing ran them: a renamed subcommand or a moved
     example could leave the drawing and its commands describing a path the
     toolchain no longer takes. A guard executes the documented block and checks
     the stages stay `check`, `run`, `manifest`, `view`.
119. `docs/architecture.zh-CN.md` repeats the runnable example of its English
     counterpart, and only the locale is meant to differ. Nothing compared the
     two blocks, so a translated page could keep an older command list and send
     its readers down a path the English page no longer takes. A guard requires
     the same stages in both pages and exactly one locale each.
120. Decision records cite source as `path:line`, and nothing resolved those
     citations: a moved file or a line past the end still reads as evidence while
     pointing at nothing, so a reader checking a decision lands nowhere. A guard
     asks every whole-repository citation under `docs/` to name a file that
     exists and that has the cited line.
121. `runtime/rc1/candidate-manifest.json` inventories the binary it measured and
     seeds its `candidate_id` with that digest, while `runtime/checksums.txt` is
     what a downloader verifies. Nothing compared the two, so a re-cut binary or
     a stale id could drift unnoticed. A guard requires the inventoried binary
     digest to be the published one and the candidate id to carry it.
122. `runtime/rc1/native-evidence.json` re-states the release-evidence digest,
     input, stable digest and schema that `capability-evidence.json` records, and
     all four RC1 evidence files claim one target, version and status. Nothing
     compared them, so one record could be refreshed alone. A guard requires the
     four records to agree and the native record to restate the capability run.

123. `runtime/rc1/server-evidence.json` and `multi-module-evidence.json` each
     publish a report digest, a stable digest and a gate digest for one measured
     run, and both measured the same two modules. Nothing compared them, so a
     partial refresh could publish a stable digest naming a report that no
     longer exists. A guard requires each record to name one digest and both to
     agree on the module count.

124. The top-level reference pages name nine JSON schema identifiers, and each
     is emitted by a source file. Nothing tied the two, so a page could promise
     a schema the tree no longer emits. A guard resolves every identifier on
     those pages against the emitters under `src/` and `native/*/src/`.

125. Each `runtime/rc*` directory publishes records that travel together. A
     record copied forward from the previous release keeps every digest field
     valid, so only its version field says which release it describes. A guard
     sweeps those directories and requires each record to name its own release.

126. The shipped records and fixtures are opened one at a time. A tracked
     JSON file that no test happens to read can lose its closing brace or
     keep a trailing comma, and `npm test` stays green until a reader hits
     it. A guard parses every tracked JSON file outside `native/` in one
     sweep, so a broken record fails before it ships.

127. The declared-capability acceptance page has no reader of its own. Its
     status sentence can call the slice delivered while platform rows are
     still pending, a findings row can take a state word section 1 never
     defines, and a renamed diagnostic token still sends a reader after a
     code the binary cannot print. A guard binds the status word to the
     target matrix, the kind cells to the four defined labels, every named
     token to a native source, and checks the page's own links.

128. Exit 66 promises the input file could not be read, but thirty-one native
     read sites short-circuited with a bare code and printed nothing, so a
     caller learned only "unreadable" with no path, phase, or rule. Every
     transcript, catalog, digest, graph, and path resolver now prints the
     source diagnostic the check path prints before exiting, and a guard runs
     one command from each read family and requires the same field set.

129. The native help table is one literal and the per-command topics another,
     so they drifted: the table advertised `project-run` twice, once without the
     `--project-receipt` and `--print-values` flags its dispatch accepts, and no
     test compared either table with the topics it serves. The duplicate line is
     gone, and a guard now reads the advertised table, requires each command to
     appear once, and requires both `help <command>` and `<command> --help` to
     repeat that command's usage line exactly.

130. The native CLI exits 66 for an unreadable input, and the diagnostics page
     said so for one policy file while naming no object a caller could parse:
     no page carried the schema, code, or rule of the diagnostic that command
     prints. The page now quotes the object an unreadable input writes to
     stdout in full, and a guard reads that quote out of the page and compares
     it with the bytes the release binary prints, so a field added, dropped, or
     renamed on either side fails.

131. The native CLI exits 65 for a source that reads but does not parse, and
     the diagnostics page described that outcome only as a diagnostic that
     names the offending token: it did not say where the bytes go or what the
     envelope is, so a caller could not tell a parse failure from an unreadable
     input by reading stdout. The page now states that `64` writes the banner
     to stderr and `65` writes the parser result envelope to stdout, and quotes
     the envelope in full. A guard runs the release binary for both codes and
     compares the printed envelope with the quoted one, so a change to the
     stdout/stderr side or to any envelope field fails.

132. The language reference recorded a measurement of its own — `revia check`
     on `ok(%data) => …` exits 65 with `re.native-parser-result@0.1.0`,
     `code:"unexpected-token"`, `expected:"_"` — and no test reproduced it, so
     the sentence could drift away from the parser it describes. A guard now
     runs the release binary on the fixture with that branch rewritten and
     compares the code, schema, and expected token it prints with the ones the
     sentence names, so either side moving fails.

133. The language page told readers that the preview forms it lists are dead
     on the current binary — `revia check --format json` and `revia check
     --write` exit 64 with the banner on stderr — but nothing ran those two
     arrays, so the sentence could survive a change that made either form
     work. A guard reads the flags and the code out of the sentence and runs
     both against the release binary, failing if the page or the parser moves.

134. The feedback page told a reporter to collect three facts from the clone
     before filing: the manifest version, the commit, and the Node build, and
     it printed the version and the `node >=22.16.0` floor beside them. The
     first command carries shell-escaped quotes that a tidy-up would delete,
     turning it into a syntax error, and no test ran any of the three, so the
     block could stop working without the prose noticing. A guard now reads
     the fenced block out of the page, runs each command from the clone root,
     and compares the printed version with the manifest, the VERSION file, and
     the sentences in both languages, the commit with a commit shape, and the
     Node build with the floor the page and the package declare.

135. `revia digest` prints the `source-digest` value that the release and
     runtime contracts take as an argument, but only its refusal for an
     absent file was ever executed: the success path could hash a parsed
     graph, a file name, or the wrong bytes and every receipt built on it
     would still pass. That digest is now pinned to the SHA-256 of the file
     bytes: four inputs, including an empty file and a file the parser
     rejects, must print `sha256:` plus the hex Node computes over the same
     bytes, a renamed copy must digest identically, and a one-file change
     must move the value.

136. `revia canonical` writes the canonical form that every later stage can
     re-read, but nothing executed it: the header, the idempotence branch that
     recognizes its own output, and the claim that the text carries no input
     path were all asserted only by inspection. A guard now canonicalizes a
     tracked example, checks the header, canonicalizes a renamed copy and
     demands the same bytes, feeds the output back through `canonical` and
     demands a fixed point, and requires `check` to accept the result as
     `ok`: true.

137. `revia lex` publishes the byte spans every later stage trusts, but no test
     ran it: a lexer that reported character offsets would still emit plausible
     numbers on the ASCII-only examples, because their multi-byte text sits in
     comments the lexer skips. A guard now lexes a program whose path literal is
     multi-byte, requires `check` to accept it, then demands that every token
     span slice out of the file bytes equals the token text and that the
     sentinel covers the whole file.

138. The three WP-313 entries (`task-request`, `approval-authority`, `task-run`)
     are advertised by `help` as reserved, and they stay unreachable from argv:
     an invocation with their documented arity exits 64 with nothing on stdout
     and the usage line on stderr. A guard now pins that refusal for all three,
     so enabling an unverified approval path would surface as a changed exit
     code rather than a silent new dispatch.

139. Native artifacts are reproducible: compiling one source twice, to two
     different output paths, yields byte-identical artifacts, and compiling a
     renamed copy of that source yields the same bytes and the same reported
     digest. A guard now compiles the three ways and compares bytes and the
     printed result, so any machine-specific value in the artifact or its JSON
     (an output path, a timestamp) fails the suite instead of reaching release
     evidence.

140. A compile that cannot write its artifact keeps a distinct exit code:
     74, not the generic 65 that means the source or contract was rejected.
     The guard makes the final rename fail and pins the code, the error
     envelope on stdout with empty stderr, and the absence of a temporary
     artifact beside the destination, so a release script can tell a bad
     source from a bad output path.

141. The same rule holds for the release matrix: it shares the atomic write
     helper, so its write failure must keep code 74 while a rejected target
     stays 65. The guard fails the rename on the matrix destination, pins the
     release envelope and the absence of the temporary file, then rejects an
     unknown target and pins 65, so the two failure classes cannot merge into
     one status without the suite noticing.

142. A status a caller can meet has to be one the help text explains. The
     legend listed 0, 64, 65, 66 and 101 while the CLI already returned 74
     for an output it cannot write. That line is now there, and the guard
     provokes each failure class, reads the code back from the process, and
     requires the legend to carry it, so a new exit code cannot ship without
     a reader being able to interpret it.

143. Per-command help is a second surface for the same claim, and it can
     drift on its own: a page can name a status the legend never explains,
     or the top-level listing can advertise a command whose page is
     missing. The guard reads every command name out of `--help`, requires
     each one to answer `help <command>` with status 0, collects the exit
     codes those pages mention, and requires each to appear in the legend.
     Renaming a documented status in one page now fails the suite.

144. Exit `66` is documented as one bare diagnostic object on stdout with
     stderr empty, and `docs/diagnostics.md` shows that object next to a
     missing path. Four readers obeyed it: `digest`, `canonical`,
     `manifest`, and `graph-check` all printed the object alone. Two did
     not: `check` and `lex` wrapped the same diagnostic in the parser
     result envelope, so one command's stdout at the same exit status had
     two shapes and a caller that parsed per the doc broke on half the
     verbs. `read_source` now routes its read failure through the same
     printer the other four use. The guard runs all six verbs against one
     missing path and requires exit 66, empty stderr, a single stdout line,
     a bare diagnostic with `schema` `re.source-diagnostic@0.1.0` and no
     `ok` or `diagnostics` key, and identical bytes from every verb; the
     older exit-66 test now rejects an envelope instead of demanding
     `ok:false`. The path assertion escapes separators, so the guard
     matches the same contract on Windows. Wrapping any reader again
     fails that test.

145. `docs/diagnostics.md` says a `64` is a usage error and prints the
     usage banner to stderr with stdout empty, and `project-init` was
     documented only as taking a directory. It accepted any two-element
     argv as a directory and wrote a scaffold before inspecting the
     rest, so a mistyped option such as `--definitely-bogus-flag` exited
     `0` after creating `./--definitely-bogus-flag/project.json` and
     `./--definitely-bogus-flag/modules/main.re`. The dispatch arm now
     refuses a directory argument that begins with `-`, printing the
     command's usage line and the `./<name>` spelling that works, and
     returning `64` before any filesystem call; `./-name` and a plain
     name still scaffold and keep their success envelope. The guard
     asserts the refusal, the empty working directory afterwards, and
     both spellings that succeed; dropping the dash test fails it.

146. A gate that was handed a source path it cannot read answered with
     exit `65` and a `re.native-node-free-result@0.1.0` envelope, so
     `node-free-gate absent.re ...` claimed a verdict the gate never
     computed and contradicted the `66` the other readers return for the
     same missing file. The gate now inspects its source argument first:
     an unreadable path prints the bare `re.source-diagnostic@0.1.0`
     object naming that path on stdout, leaves stderr empty, writes no
     report, and returns `66`, while a readable source keeps the gate
     verdict path. The guard asserts the code, the empty stderr, the
     diagnostic fields, the absent envelope, and that no report appears;
     deleting the pre-check makes the gate exit `65` and fail it.

147. Two of the three gates still disagreed with that reading: a
     `toolchain-gate` whose source path is absent printed
     `native-toolchain-gate-source-unreadable` on stderr and exited
     `65`, and `release-evidence-gate` wrapped the same read failure in
     a `re.native-release-evidence@0.5.0` envelope on stderr with `65`.
     Both now inspect the source argument first, like `node-free-gate`:
     the bare `re.source-diagnostic@0.1.0` object on stdout, empty
     stderr, no report or evidence file, and exit `66`, byte-identical
     across the three gates. The guard runs all three gates against the
     same absent path and compares their stdout bytes; removing either
     pre-check makes that gate exit `65` and fails it.

148. `--refresh` rebuilt the import allowlist from the source roots plus
     `EXPLICIT_PATHS`, and that list omitted
     `scripts/validate-release-provenance.mjs`, which the release gate
     runs: every refresh silently deleted the entry, `--check` then
     disagreed with CI, and the deletion appeared in no diff as a
     removal. The selection now lives in `scripts/source-import-selection.mjs`
     and the builder imports it, so a refresh and the admitted list are
     the same set. The new test compares `selectFiles` against
     `SOURCE_IMPORT_FILES.json` in both directions; deleting the entry
     makes it report the file the refresh would drop, and a test file
     absent from the list fails the other direction.

149. `developer-gate` was handed an unreadable project root and, instead
     of a verdict about that root, it resolved the report path, created
     a temporary root, and only failed when the first `project-check`
     child came back non-zero: the code printed `project-check`'s
     envelope on stderr and exited `65`, while `project-check absent`
     printed the same bytes on stdout. The gate now loads the project
     first and, when the only failure is `project-root-unreadable`,
     prints that envelope on stdout with empty stderr and exits `65`,
     leaving the report unwritten; every other load failure keeps the
     stage-by-stage path that the drift guard pins. The guard compares
     the gate's stdout with `project-check`'s byte for byte, requires the
     empty stderr and the absent report, and deleting the load check
     makes stderr non-empty and fails it.

150. When the report path of `capability-comparison` could not be
     written, the command printed the bare token
     `native-capability-comparison-report-write-failure` on stderr and
     exited `74`, so a caller that parses the diagnostic envelope for
     every other code from this command had nothing to parse, while the
     neighbouring `runtime-bundle` and `runtime-authority` writers
     already answered a `74` with their own envelope. The write failure
     now prints the `re.native-capability-comparison-report@0.1.0`
     object naming that code on stderr, keeps stdout empty, and still
     returns `74`; the report directory is left untouched. The guard
     points the report path at an existing directory, then asserts the
     exit code, the empty stdout, the exact stderr bytes, and that the
     directory is still empty; restoring the bare token makes the byte
     comparison fail.

151. The `bundle-comparison` writer carried the same bare token as
     `capability-comparison` did: a report path that blocked the write
     printed `native-runtime-bundle-comparison-report-write-failure` on
     stderr with exit `74` and nothing on stdout, while its own
     report-object arm, one line below, already answered a `65` with a
     `re.native-runtime-bundle-comparison@0.2.0` envelope. The write
     failure now prints that same object family on stderr naming the
     write-failure code, keeps stdout empty, returns `74`, and leaves
     the report path untouched. The guard makes the report path an
     existing directory and asserts the exit code, the empty stdout, the
     exact stderr bytes, and the still-empty directory; restoring the
     bare token fails the byte comparison.

152. `developer-gate` had the same split as its written report: a
     refusal after the report was built already answered in the gate
     object, but a temporary directory that could not be created printed
     the bare token `native-developer-gate-temporary-directory-failure`
     and exited `74`. The two failures a caller cannot tell apart by exit
     code now share one shape: the same code, still on stderr, inside a
     `re.native-developer-gate@0.1.0` envelope, with stdout empty and no
     report written. The guard points `TMPDIR` at an existing file,
     asserts the exit code, the empty stdout, the exact stderr bytes, and
     that no report appeared; restoring the bare token fails the byte
     comparison.

153. The toolchain gate answered a report write failure with the bare
     token `native-toolchain-gate-report-write-failure` on stderr, even
     though every earlier refusal in the same gate already spoke the
     `re.native-toolchain-gate@0.1.0` object. The dispatch arm keyed the
     exit status off the `report-write-failure` suffix, so the code
     survived the change while the shape caught up: same code, still
     stderr, now inside the gate envelope, stdout empty, nothing written.
     The guard makes the report path a directory, asserts exit `74`, the
     empty stdout, the exact stderr bytes, and an empty directory after
     the run; restoring the bare token fails the byte comparison.

154. `capability-project-comparison` prints its report on success and
     answers every build refusal inside the
     `re.native-capability-project-comparison-report@0.1.0` object, so a
     write failure that printed the bare token
     `native-capability-project-comparison-report-write-failure` was the
     one shape a caller could not parse. The token now rides inside the
     same envelope on stderr, exit `74`, stdout empty, and the report path
     left as the empty directory it was. The guard builds the real four
     workload project, points the output at a directory, and asserts the
     exit code, empty stdout, exact stderr bytes and an untouched
     directory; restoring the bare token fails the byte comparison.

155. The developer gate's own report write has two failure shapes, and
     only one of them had caught up with the gate envelope: the temporary
     directory failure speaks the
     `re.native-developer-gate@0.1.0` object (WP-152), while the write of
     the finished report still printed
     `native-developer-gate-report-write-failure` as a bare token. Both
     now answer in the same object on stderr with exit `74` and empty
     stdout, which is what the neighbouring drift and containment
     refusals already did. The guard makes the report path a directory,
     then asserts the exit code, the empty stdout, the exact stderr bytes
     and a still-empty directory; the existing report-directory test in
     the same gate keeps passing because the token survives inside the
     envelope.

156. The developer gate's containment refusal, `report-inside-project`, was
     the last refusal in that gate still printed as a bare token on
     stderr, next to a success path that has been a canonical report for
     many rounds. It now answers with the same
     `re.native-developer-gate@0.1.0` object the report write failure and
     the temporary directory failure already speak, keeping exit `65`
     because nothing was executed. The guard points the report at a path
     inside the project, then asserts the exit code, the empty stdout,
     the exact stderr bytes and that no report was created.

157. The server gate checked that its database and report stay outside the
     project only after it had already resolved the external `sqlite3`
     executable, so a project-local output path with a missing executable
     answered `native-project-server-gate-sqlite-unavailable` and never
     reached the containment refusal. The refusal now runs first, before
     anything external is resolved, and speaks the gate's own
     `re.native-project-server-gate@0.2.0` object on stderr instead of a
     bare token. The guard points both outputs inside the project and
     passes a sqlite path that does not exist, then asserts exit `65`,
     empty stdout, the exact stderr bytes and that neither output was
     created, so it fails both when the ordering regresses and when the
     refusal stops being an object.

158. `docs/diagnostics.md` gives an artifact path as a name to write, and two
     commands wrote it over the program they had just read. `compile
     hello.re hello.re` exited `0` and left a 913-byte artifact where the
     source had been, and `runtime-package hello.re hello.re` did the same
     with a bundle, so one mistyped second argument destroyed the input and
     reported success. Both now compare the normalized source and output
     paths first and refuse with the envelope their own failures already
     use — `re.native-compile-result@0.1.0` on stdout for `compile`,
     `re.native-runtime-bundle@0.1.0` on stderr for `runtime-package` — at
     exit `65`, before the source is read. The guard runs both commands with
     one path as both arguments and asserts the code, the exact refusal
     bytes, the untouched source, and that no temporary file is left, then
     runs both with a sibling output and requires exit `0`. Removing either
     comparison makes that command exit `0` and fails the test.

159. The two refusals added by 158 compared the argument strings after
     folding `.` and `..`, so `revia compile hello.re ./hello.re` still
     exited `0` and replaced the source. Comparing text cannot decide
     whether two names reach one file: the same file is spelled relative
     and absolute, with a leading `./`, and below a `..` that cancels a
     directory. Both commands now resolve each argument against the working
     directory, fold the components, and canonicalize the parent directory
     before comparing, so the name pairs above are refused at exit `65`
     with the same envelope and the source untouched. The guard drives
     three spellings of one output for each command, then a sibling output
     that must still exit `0`, and fails when the comparison goes back to
     the raw strings.

160. Comparing resolved parents left one alias open: a symlink whose target
     is the source. `revia compile link.re real.re`, with `link.re` pointing
     at `real.re`, exited `0` and replaced `real.re` with the artifact, so
     the source lost its contents while every name-based comparison said
     the two arguments differed. Path identity now resolves the whole path
     when it exists and only falls back to the parent when it does not, so
     the pair above is refused at exit `65` with the source untouched and
     the symlink still in place. The test covers both commands plus a
     sibling output that must still exit `0`, and fails when the resolution
     of the file itself is dropped.

161. Resolving the path closed the symlink but not the hard link: a second
     name for one inode cannot be told apart by any path, so `revia compile
     link.re real.re`, with `link.re` and `real.re` hard-linked, exited `0`
     and rewrote the shared inode, destroying the source through the other
     name. Path identity is now backed by a device and inode comparison of
     both existing files, so the pair above is refused at exit `65` with
     both names keeping their bytes. The test covers both commands plus a
     control copy that must still exit `0`, and fails when the inode
     comparison is disabled.

162. Refusing a report inside the project compared paths, and a path that
     leaves the project and comes back through a symlinked directory spells
     a different string, so `revia developer-gate project revia.app.main
     <digest> outside/into/report.json`, with `outside/into` a symlink to
     the project, exited `0` and wrote the report into the project it had
     promised to stay out of. Both containment helpers now resolve their
     arguments, down to the nearest existing ancestor, before comparing, so
     that command is refused at exit `65` with the exact envelope and no
     file is written through the link, while a sibling report path still
     exits `0`.

163. A bundle that opened but was not UTF-8 was reported as unreadable, so
     `revia runtime-verify bad.rebundle` exited `66` and named
     `native-runtime-bundle-unreadable`, the same class as a path that does
     not exist: the bytes had been read and rejected, and the caller was
     told to go and look at its path. Reading the bundle now separates the
     open from the decode, so that command is refused at exit `65` with
     `native-runtime-bundle-json-invalid` on stderr and empty stdout, while
     a missing path and a directory still exit `66` and an intact bundle
     still exits `0`. The test covers all four and fails when the decode
     error is folded back into the unreadable class.

164. A source file whose bytes do not decode was reported at the start of
     the file: `revia check late.re`, with the bad byte 28 bytes in, printed
     `"line":1,"column":1` beside `"byte_start":28`, so every undecodable
     file named the same position and a tool could not point an editor at
     the cause. The decoder now derives `line`, `column`, `end_line` and
     `end_column` from the bytes that precede the offending one, using the
     position rule the rest of the diagnostics already share, so that file
     reports `"line":4,"column":10`, a byte-order mark still reports line 1
     column 1, and a bad byte after a three-byte scalar reports one column
     per scalar rather than per byte. The test covers all three files and
     fails when the position is pinned back to the file start.

165. The same collapse WP-163 fixed for `runtime-verify` still held on the
     four other JSON inputs the authority commands read: a pin or receipt
     that opened but was not UTF-8 exited `66` naming an `-unreadable` code,
     so `revia runtime-authority-pin bad.rebundle` and
     `revia runtime-receipt-verify` sent the caller to inspect a path that
     was there and readable. All four now read bytes and decode separately,
     so a damaged pin, receipt or bundle is refused at exit `65` with
     `native-runtime-load-authority-json-invalid` or
     `native-runtime-load-receipt-json-invalid`, the code the same file
     already produced when it was merely malformed, while an absent path
     still exits `66` with its `-unreadable` code. The test asserts both
     halves at each of the four sites and fails when the decode error is
     folded back into the unreadable class.

166. The same collapse reached the project-run pair, the last two JSON
     inputs read as text: `revia project-run-verify bad.json` and the two
     reads inside `revia project-run-receipt-verify` reported a file whose
     bytes do not decode as an unreadable path, exiting `66`, when the bytes
     had been read and rejected. Both commands now separate the open from
     the decode, so a damaged run or receipt is refused at exit `65` with
     `project-manifest-json-invalid`, the code the same file already
     produced when it was merely malformed, while an absent path still
     exits `66` with `native-project-run-unreadable` or
     `native-project-run-receipt-unreadable`. The test asserts both halves
     at all three reads and fails when the decode error is folded back into
     the unreadable class.

167. The replay catalog commands never reached the fix because they read
     their catalog through the shared text-input helper rather than
     `fs::read_to_string`, and that helper returns a source diagnostic in a
     shape of its own. `replay-catalog`, `replay-fault-catalog` and
     `replay-fault-corpus` therefore answered a catalog whose bytes do not
     decode with exit `66` and `input-unreadable`, while the same file merely
     malformed was refused at exit `65` under each command's own
     `-json-invalid` code in a different envelope. A catalog that was read
     and rejected is now a content rejection on all three: exit `65`, the
     same code and envelope as the malformed case, with an absent path left
     alone at exit `66` in the diagnostic shape. The test asserts all three
     commands against bad bytes, malformed bytes and a missing path, so the
     decode failure cannot drift back into the unreadable class without
     turning the suite red.

168. The graph routes answered a source they could not decode with the code
     alone. `canonical`, `translate` and `compile` all pass the bytes through
     `SourceText::from_bytes`, and when that fails they printed
     `{"diagnostics":[{"code":...}]}` with the rest of the diagnostic dropped,
     so a refusal caused by a byte-order mark and a refusal caused by a bad
     byte on line 4 were the same message. `check` had already been taught to
     carry the position; the three graph routes now use the same diagnostic,
     in the same `re.native-graph-result@0.1.0` envelope, so the offending
     byte, its line and its column survive the refusal. The test drives all
     three against a byte-order mark and two of them against a late bad byte,
     which is what tells the positions apart.
169. The project loader verified a module with `std::str::from_utf8` and a
     digest, and nothing else. A byte-order mark is valid UTF-8, so a module
     that began with one passed the digest, entered the graph, and
     `project-check` reported the project as sound, while `project-test` on the
     same directory refused the same bytes with `byte-order-mark-not-allowed`
     and the single-file routes refused the file outright. The loader now
     refuses the mark where it reads the module, so the project gates agree
     with each other and with `check` instead of the strictest one being right
     only by accident of running later.
170. The project loader read `project.json` through `fs::read_to_string`,
     which fails both when the file cannot be opened and when it opens but
     holds bytes that are not text. Both failures arrived as
     `project-manifest-unreadable`, so a manifest truncated at a random offset
     and a manifest deleted outright were the same refusal, and the reader was
     told to check a file that was there the whole time. The read is now split:
     opening the file keeps its own class, and undecodable bytes get
     `project-manifest-invalid-utf8`.
171. A project manifest that opens with a byte-order mark decodes as valid
     UTF-8, so it reached the JSON parser and came back as
     `project-manifest-json-invalid` — the reader was sent to look for a stray
     brace in a file whose JSON was intact. Modules with the same mark already
     got `byte-order-mark-not-allowed` (169); the manifest now gets the same
     name, because the mark is the whole problem.
172. `fs::canonicalize` resolves a path but says nothing about what it
     resolved to, so a regular file handed to `project-check` came back as
     `project-manifest-unreadable` — the manifest was the one thing that was
     fine. The loader now checks that the resolved root is a directory and
     reports `project-root-not-a-directory`.
173. The module loader has refused symlinked modules since the filesystem
     alias work, but `project.json` itself was read without looking at how it
     was reached — a manifest symlinked to a copy outside the project loaded
     and reported a healthy graph. It now refuses with
     `project-manifest-symlink-not-allowed`, the same rule the modules follow.
174. A capability policy that opens with a byte-order mark decodes as valid
     UTF-8, so it reached the JSON parser and came back as
     `native-capability-policy-invalid:not-json` — the reader was told the
     policy was not JSON when the JSON was intact and only the encoding prefix
     was not. Modules (169), the project root (172) and the manifest (171) had
     each already been given a name for that mark; the policy artifact was the
     last text input still folding it into a decode failure. It now reports
     `byte-order-mark-not-allowed`, matching `source.rs`, and the unmarked
     policy still parses, so the rule is narrower rather than stricter.
175. The schema registry is the third artifact read through the same parser,
     and it carried the same blind spot: every JSON failure came back as
     `declared-schema-registry-invalid` with `actual: "json"`, so a registry
     behind a byte-order mark was reported as unreadable JSON. It now reports
     `actual: "byte-order-mark-not-allowed"` while keeping its own error class,
     which is what distinguishes this from 171 and 174: those readers own the
     artifact and can name the mark outright, whereas the registry already has
     a class and needs the reason inside it rather than instead of it.
176. The replay workload catalog reader had the identical blind spot one layer
     out: a catalog opening with a byte-order mark came back as
     `replay-workload-catalog-json-invalid`. The tell is that the plain catalog
     is rejected by the catalog's own rules (`too-few-workloads`), so the JSON
     layer had already accepted the bytes; only the mark made the difference.
     It now reports `byte-order-mark-not-allowed`, and genuinely malformed text
     keeps the JSON code, which the same test pins.
177. The fault catalog was the third reader in this family and carried the
     same defect: `parse_replay_fault_catalog` folded the mark into
     `replay-fault-catalog-json-invalid`. Its plain form reaches
     `too-few-workloads`, which is what made the difference attributable, so
     the mark is now named there too. Malformed text keeps the JSON code.
178. The fault observation corpus reader is the fourth and last of these, and
     the mark reached `native-fault-corpus-json-invalid` there as well. Its
     plain form stops at `schema-or-size-invalid`, so the JSON layer had again
     accepted the bytes. The mark is now named, and malformed text keeps the
     JSON code in the same test.
179. The runtime load authority pin shares the reader shape but is reached
     through `runtime-receipt-verify`, and it files every JSON failure as
     `native-runtime-load-authority-json-invalid`. A pin of `{}` is refused by
     the pin's own field rules, so the JSON layer accepts the bytes; with the
     mark in front the same document was called unreadable JSON. The mark is
     now named, and malformed text keeps the JSON code.
180. The receipt reader behind the same command had the same shape and filed
     its failures as `native-runtime-load-receipt-json-invalid`. A receipt of
     `{}` stops at `native-runtime-load-receipt-fields-invalid`, so the JSON
     layer had accepted the bytes, and the mark reached the JSON code. The mark
     is now named, and malformed text keeps the JSON code. The reader is
     covered directly rather than through the command, which reads a pin first.
181. The VM result the receipt is built from is read by a second parser in the
     same file, and it filed both its UTF-8 and its JSON failures as
     `native-runtime-load-receipt-result-invalid`. A result of `{}` reaches that
     same code, so the JSON layer had accepted the bytes; the mark did not make
     the text undecodable, it only moved the failure. The mark is now named,
     and a result that really is malformed keeps the result code.
182. The project run document is parsed with the shared project JSON parser,
     and the run verifier passed that parser's code straight through. The parser
     is shared with the project manifest, so a run document that opens with a
     byte-order mark was refused as `project-manifest-json-invalid` — one file's
     code on another file, naming a manifest the user never wrote. A run of `{}`
     gets past the JSON layer and stops at `native-project-run-schema-mismatch`,
     which is how the bytes were shown to be acceptable; only the leading mark
     differed. The mark is now named, and malformed text keeps the parser code.
     The Windows lane's `wp277` cleanup now retries its own directory removal,
     which the copied release binary keeps locked for a moment; that lane had
     failed on the retry the test already applied to its read.
183. The execution document had the same problem one reader over. Its verifier
     shares the project JSON parser, so an execution document that opens with a
     byte-order mark was refused as `project-manifest-json-invalid` — a manifest
     code on an execution file. An execution document of `{}` gets past the JSON
     layer and stops on the missing fields (`invalid-project-field`), which is
     how the bytes were shown to be acceptable. The mark is now named there too,
     and text that really is malformed keeps the parser's own code.
184. The execution plan had the same problem again. `parse_project_execution_plan`
     shares the project JSON parser, so a plan that opens with a byte-order mark
     was refused as `project-manifest-json-invalid` — a manifest code on a plan
     file. A plan of `{}` gets past the JSON layer and stops on the missing
     fields (`invalid-project-field`), which is how the bytes were shown to be
     acceptable. The mark is now named there too, and text that really is
     malformed keeps the parser's own code.
185. The project run receipt had it too. Its parser shares the project JSON
     parser and returned that parser's code unchanged, so a receipt that opens
     with a byte-order mark was refused as `project-manifest-json-invalid` — a
     manifest code on a receipt file. A receipt of `{}` gets past the JSON layer
     and stops on the missing fields
     (`native-project-run-receipt-fields-invalid`), which is how the bytes were
     shown to be acceptable. The mark is now named there too, and text that
     really is malformed keeps the parser's own code.
186. So did the comparison catalog. Its reader reports every parse failure as
     `comparison-catalog-json-invalid`, so a catalog that opens with a
     byte-order mark was called malformed JSON although its text is fine. A
     catalog of `{}` gets past the JSON layer and stops on the missing fields
     (`comparison-catalog-required-field-missing`), which is how the bytes were
     shown to be acceptable. The mark is now named there too, and text that
     really is malformed keeps the reader's own code.
187. The experiment kit reader had it as well. It reports every parse failure
     as `experiment-kit-json-invalid`, so a kit that opens with a byte-order
     mark was called malformed JSON although its text is fine. A kit of `{}`
     gets past the JSON layer and stops on the missing fields
     (`experiment-kit-required-field-missing`), which is how the bytes were
     shown to be acceptable. The mark is now named there too, and text that
     really is malformed keeps the reader's own code.

188. The runtime bundle reader too. It reports every parse failure as
     `native-runtime-bundle-json-invalid`, so a bundle that opens with a
     byte-order mark was called malformed JSON although its text is fine. A
     bundle of `{}` gets past the JSON layer and stops on the fields
     (`native-runtime-bundle-fields-invalid`), which is how the bytes were shown
     to be acceptable. The mark is now named ahead of the trailing-newline gate,
     so a marked document is named even without the newline, and text that
     really is malformed keeps the reader's own code.

189. Release evidence records are outcomes. `runtime/rc2.2.1/linux-native-evidence.json`
     and its Windows sibling carry `source_commit`, `source_inventory_digest`,
     `binary_sha256` and `archive_sha256`, which pin bytes to a commit, and none of
     it says how the observation was made, so a reader who was not there can check
     the artifact but not repeat the run behind it. `classifyEvidenceWitness` in
     `src/toolchain/release-evidence-witness.js` answers the only question that can
     be answered honestly about a record in hand: whether it names a witness, and
     which parts of one it is missing. The shipped records name none, and the test
     says so rather than passing by construction. A record that does carry a
     witness must give the `command` that produced it plus the `environment_digest`
     and `raw_log_sha256` of that run; a partial one is refused with every absent
     field listed, so a half-written witness cannot ship green later. The obligation
     is scoped to `measured-native` records: a `pending` target that names no
     witness is not failing, it is making no claim. `docs/compatibility.md` states
     the consequence in both halves of the page: a record without a witness cannot
     support a `requires` sentence. Nothing in the published artifact moves — the
     linux-x64 target stays `measured-native` with the same archive and binary
     digests, and macOS arm64, macOS x86_64, Linux arm64 and Windows arm64 stay
     `pending`.

190. The loader-path sentence had no test behind it. `docs/compatibility.md` shows
     one loader failure from `/lib/x86_64-linux-gnu/libc.so.6`, then says the
     `libc.so.6` path differs by distribution and that a different path does not
     change the conclusion — reasoning about the loader's message format, not an
     observation anyone recorded. `runtime/rc2.2.1/loader-path-probe.json` now
     carries that state as `pending`, with the reason: no host below glibc 2.39 was
     available, and the example was neither reproduced nor re-run. The page says the
     same thing in both halves instead of standing on the example alone, and names
     the record. `classifyLoaderPathProbe` in `src/toolchain/loader-path-probe.js`
     is the gate: a probe counts as measured only with two distinct loader-reported
     paths whose diagnostics agree once the path is masked, so a single path or a
     message that changes with the path cannot be reported as path independence.
     Flipping the record to `measured` moves the obligation onto the page, which
     must then cite the observation it now has; the test fails until it does. No
     measurement is claimed that was not taken, and the published artifact does not
     move.
191. The source-import gate refused a byte-order mark without naming it.

`--check` on an allowlist that opens with a UTF-8 byte-order mark failed with
`source-import-failed`, `stableCode()`'s fallback for any error whose message
is not a code. The mark is not a corrupt document: the bytes are well-formed
UTF-8 and the JSON behind them parses on its own, so the one thing wrong with
the file was the only thing the reader could not say. The same three bytes
made `--refresh` rewrite the allowlist without ever reading it, so the mode
that erased the mark accepted what `--check` rejected.

Both halves are closed by refusing the mark by name, before any parse or
comparison sees the text: `refuseMark` in
[`scripts/build-source-import-manifest.js`](../../scripts/build-source-import-manifest.js)
throws `byte-order-mark-not-allowed`, the code the native readers already
publish for the same defect class, and `--refresh` reads the existing
allowlist through it first, so it leaves a marked file untouched instead of
quietly erasing the defect. Drift keeps `source-import-manifest-drift`, a
genuinely unparseable file still reports `source-import-failed`, and no bytes
are ever stripped.

Six tests in
[`test/source-import-byte-order-mark.test.js`](../../test/source-import-byte-order-mark.test.js)
run the shipped script against a temporary copy of itself, so the
repository's own allowlist is never the fixture: a marked allowlist is named
in `--check` and `--write`, a marked manifest is named rather than reported as
drift, `--refresh` refuses and leaves the bytes intact, and the two older
codes still fire. Each guard was falsified by mutation — removing the
throw turned three tests red, removing the `--refresh` read turned exactly the
one test named for it red — and the guide sentence in
[`AGENTS.md`](../../AGENTS.md) fails its own test when narrowed to one mode.
192. The source-import gate called a stale allowlist entry "failed".
`buildManifest()` read each listed path with `lstat()` and then asked whether it
was a file; when the path was simply not there, `lstat()` threw `ENOENT` and
`stableCode()` fell back to its unnamed `source-import-failed`, the same string
a genuinely unparseable document reports. An operator who deleted a file saw
"failed", not "you listed a file that is gone". The read now catches `ENOENT`
and names `source-import-file-missing`, so the three refusals stay distinct: a
path that is not in the tree (`source-import-file-missing`, repaired by
`--refresh`), a path that is there but is a directory or a symbolic link
(`source-import-file-invalid`, repaired by putting the file back), and a
document that cannot be parsed (`source-import-failed`, repaired by hand).
`--check` and `--write` both report the new code and write nothing, and the
directory and symbolic-link rows keep the code they already had, so the new
branch narrows the fallback without swallowing either neighbour.
[`test/source-import-file-missing.test.js`](../../test/source-import-file-missing.test.js)
runs the shipped builder from a copied root with a sorted allowlist naming both
`note.txt` and an absent `gone.txt`: `--check` and `--write` exit 1 with
`source-import-file-missing` and empty stdout; a directory and a symbolic link
at listed paths still exit 1 with `source-import-file-invalid`; an edited file
behind an unchanged manifest still reports `source-import-manifest-drift`; and
the guide sentence in [`AGENTS.md`](../../AGENTS.md) has to name both codes and
what each repair is. Each guard was falsified by mutation — restoring the bare
`lstat()` turned the missing-path test red and nothing else, and the guide
sentence fails its own test when narrowed to "a path the allowlist lists". The
`--refresh` mode is deliberately not asserted here: it regenerates the
allowlist from the tree and never reads the stale entry through
`buildManifest()`, so `source-import-file-missing` is unreachable from that
mode and the missing-path row above covers the two modes that can report it.


193. A refresh rewrote every line of the allowlist to admit one file.
`--refresh` rendered the whole list through `canonicalJson()`, which sorts the
keys and prints one line, while the checked-in
[`SOURCE_IMPORT_FILES.json`](../../SOURCE_IMPORT_FILES.json) keeps one path per
line. Running the documented repair therefore turned a one-entry admission into
a 709-line rewrite: the diff showed every path and the admission itself was the
one thing a reviewer could not find. The layout now lives in a single exported
function, `renderAllowlist()`, in
[`scripts/source-import-selection.mjs`](../../scripts/source-import-selection.mjs),
and both the checked-in file and `--refresh` render through it, so the two
cannot drift into different shapes again. The order is still `compareUtf8`, the
order `--check` reads, and the schema string is exported beside it so the
writer and the reader cannot disagree about the name either. A measured
`--refresh` on the repository now rewrites one line, not 709:
[`test/source-import-allowlist-layout.test.js`](../../test/source-import-allowlist-layout.test.js)
re-renders the committed list from its own paths and requires the result to be
byte-identical, admits one path between two others and requires the diff to be
exactly one added entry, and requires the builder to write through
`renderAllowlist()` rather than rebuild the string itself. Rendering the list on
one line turned the first two tests red while the wiring test stayed green;
bypassing the function in the builder turned only the wiring test red; narrowing
the guide sentence in [`AGENTS.md`](../../AGENTS.md) turned only the guide test
red. The neighbouring source-import tests — byte-order mark, missing path, and
selection equality — stay green.

194. A published path that disappeared reported the unnamed failure. The
selection publishes five source roots plus an explicit list of files and
directories; every explicit entry is resolved with `lstat`, and a `--refresh`
against a tree that lost one of those files threw a raw `ENOENT`. `stableCode()`
only keeps the message when it matches `^[a-z0-9-]+$`, so an `ENOENT` carrying a
space and an absolute path collapsed to `source-import-failed` — the same word
an unparseable document reports. An operator who deleted `AGENTS.md` saw
"failed", not "you lost a file the build must publish". The selection now
catches `ENOENT` and names `source-import-explicit-path-missing`, which is a
third repair from the two the gate already named: a stale allowlist is fixed by
`--refresh` and a file that is there but is a directory or a symbolic link is
fixed by putting the file back, while a lost explicit path is fixed only by
restoring the file, because a refresh cannot select what is not in the tree.
[`test/source-import-explicit-path-missing.test.js`](../../test/source-import-explicit-path-missing.test.js)
reads the explicit list out of the selection rather than keeping a second copy,
builds a root with every published path except one, and requires `--refresh` to
exit 1 with `source-import-explicit-path-missing` and empty stdout; the same
root with the path present refreshes to exactly that list, sorted the way the
selection sorts. Removing the catch turned the first test red while the
second stayed green; rethrowing the raw error instead of naming it turned only
the first red, with `source-import-failed` back in place of the name. The
neighbouring source-import tests — byte-order mark, missing allowlist path,
allowlist layout, and selection equality — stay green, and the guide sentence
in [`AGENTS.md`](../../AGENTS.md) has to name the third code and say that no
refresh repairs it.
195. A published source root that disappeared reported the unnamed failure,
and the previous paragraph said the opposite. The selection publishes five
source roots — `doc`, `native`, `src`, `test`, `test-support` — and none of
them is listed anywhere, so a tree missing one has no stale entry to find.
`walk` called `readdir` on the root and let the raw `ENOENT` out, which
`stableCode()` dropped to `source-import-failed` for the same reason as the
explicit path in 194: the message carries a space and an absolute path. A
`--refresh` in a tree without `native/` therefore reported that something
failed and named neither the root nor the repair, while 194's own paragraph
claimed a missing root read as an empty directory — a claim written from
reading the loop instead of running it, and wrong as soon as it was run. The
selection now catches `ENOENT` around each root walk and reports
`source-import-source-root-missing`, which is a fourth repair distinct from
the three the gate already named: it is the one case no `--refresh` can fix
and no allowlist can record, because the missing thing is never listed. The
catch is narrowed to `ENOENT` and sits at the root loop rather than inside
`walk`, so a fault found while descending keeps its own name and a directory
that disappears mid-walk is not reported as a root that was never there.
[`test/source-import-source-root-missing.test.js`](../../test/source-import-source-root-missing.test.js)
builds a root with every published path present, removes `native/`, and
requires `--refresh` to exit 1 with `source-import-source-root-missing` and
empty stdout; a second test puts a symbolic link inside `doc/` and requires
the refusal to stay `source-import-symlink`, so a catch that swallowed every
error would be red. Removing the catch turned the first test red with
`source-import-failed` back; rethrowing the raw error instead of naming it did
the same; replacing the narrowed catch with an unconditional one turned only
the second test red. Its fixtures moved to
[`test-support/source-import-fixture.js`](../../test-support/source-import-fixture.js)
so the two tests that build a temporary root share one copy, and the
`source-import-explicit-path-missing` tests stay green on that shared fixture.


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
