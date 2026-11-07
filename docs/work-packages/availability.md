# Availability Work Package: Declared Capability Execution Closure

Status: in progress. Issue 1 is closed; Issues 2-4 are planned and not started.

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

- Source: `ee479ef` plus the WP-356 corpus change in section 5.
- Rust gates on this tree: `cargo fmt --all -- --check`,
  `cargo check --workspace --offline`, and
  `cargo clippy --workspace --offline --all-targets -- -D warnings` pass.
- `cargo test --workspace --offline` passes, including the declared capability
  harnesses named in section 3 and the 14-case corpus in section 5.
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

## 4. Issue 2 (P0, planned): security isolation of the execution boundary

Goal: make "the guest cannot escape the declared surface" a measured property.

- Enumerate every host operation reachable by a program and pin each with a
  fail-closed negative: filesystem, environment, secrets, clock, bytes,
  integer limits.
- Prove authorization cannot be widened by the artifact under test: a compiled
  `.rebc` produced under one policy must not run under a policy that does not
  grant its members, and a registry must not substitute for a grant.
- Record the residual trust boundary: the adapter itself is trusted code; the
  policy is an operator artifact, not a sandbox. Say so explicitly.
- Acceptance: every enumerated operation has a test that shows refusal, and a
  test that shows the granted case still works; the boundary claim in
  `docs/load-time-authority.md` is updated to match the measured set.

Not started. Depends on Issue 1 (boundary vocabulary) and its findings table.

## 5. Issue 3 (P0, closed): conformance corpus for the declared surface

Goal: turn the WP-355 fixtures into a corpus other implementations can run.

- **Delivered as data.** `test/fixtures/declared-capability-execution-corpus.json`
  (`re.declared-capability-execution-corpus@0.1.0`) carries 14 cases, each a
  `(registry, policy, program, expected exit and diagnostic)` tuple plus a
  `catches` line that states what an implementation change would break.
  `registry` and `policy` are JSON artifacts; a policy may also be a raw string
  so the non-JSON case is expressible. `expected` names the stream
  (`stdout`/`stderr`), the result schema, the fragments that stream must carry,
  and the stream that must stay empty.
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
  checked: flipping one expected channel makes the case fail, and restoring the
  file makes it pass.
- **Limits.** Declared-call return values cannot be bound or printed
  (`ok(_)`/`err(_)` only), so CLI evidence stops at exit status and
  diagnostics; value-level correctness rests on the 13 `declared_host` tests.
  A denied member and every other bridge failure collapse to
  `native-vm-capability-failed` at `vm.rs:417`, so the denial case can only
  assert the collapsed code. The corpus does not enumerate one negative per
  bridge error variant; that needs the `vm.rs` compatibility decision, not a
  fixture.

## 6. Issue 4 (P1, planned): semantic interfaces for capability results

Goal: let a program actually observe what a capability returned.

- Specify binding a declared result to a value (`ok(%value)` / `err(%error)`)
  and rendering it, with the typed envelope preserved end to end.
- Specify how a `number.i64` return (e.g. `scalar_count`) is stored in a
  `result` binding; today a non-`result` return type cannot be stored, so the
  VM fails even when the call is authorized.
- Decide the stable way to print or compare a capability result so CLI evidence
  can be value-level instead of exit-status-level.
- Acceptance: an impact analysis for the language change, a versioned grammar
  note, and a CLI test that prints a capability value.

Not started. It changes language semantics, so it must not be smuggled into
Issues 1-3.

## 7. Sequencing

1. Issue 1 — closed (this page).
2. Issue 3 — closed (this page): the corpus and its negatives are in place for
   Issue 2 to enumerate against.
3. Issue 2 — the isolation claim needs the corpus to enumerate against.
4. Issue 4 — last, because it is the only item that changes the language.

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
  explicitly rejected.
