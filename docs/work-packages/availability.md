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

Binding and execution failures: `native-host-capability-policy-missing`,
`native-host-capability-policy-not-served:<reference>.<member>`,
`native-host-bridge-capability-denied`, `native-host-bridge-declared-member-unknown`.

### 3.6 Open findings from Issue 1

| Finding | Kind | Consequence |
|---|---|---|
| `vm.rs` collapses every non-value bridge failure into `native-vm-capability-failed` | fault-observed | An end-to-end caller cannot tell denial, wrong-argument, and host fault apart; the precise code is tested at the core boundary instead. Fixing this changes observable CLI output, so it needs its own compatibility decision. |
| `HostBackedBridge::observations()` is not exposed by the CLI | pending | Rich in-process host tracing exists but is not part of the shipped run output; `invocations[]` is the only trace surface a CLI caller sees. |
| `wp354` adapter handlers ignore `request.argument` | verified-only | WP-354 pins dispatch, not the wire encoding. The typed encoding is now pinned by the WP-355 decoder tests and the CLI end-to-end path. |
| No CLI negative for every bridge error variant | pending | Section 3.5 lists the exact remaining negatives; they are the first item of Issue 3. |

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
[`test/fixtures/host-boundary-refusal-corpus.json`](../test/fixtures/host-boundary-refusal-corpus.json)
(`re.host-boundary-refusal-corpus@0.1.0`), driven by
[`native/revia-cli/tests/wp357_host_boundary_corpus.rs`](../native/revia-cli/tests/wp357_host_boundary_corpus.rs),
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
| An ungranted **served** declared member collapses into `native-vm-capability-failed` | fault-observed | Same VM diagnostic collapse as section 3.6; `declared-clock-ungranted` pins the collapsed code, not a precise denial. The fix still needs its own compatibility decision. |
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
