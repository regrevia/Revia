# WP-4: The Result Value Interface / 结果值接口

Status: route B delivered (CLI value-level evidence); route A (language change)
**scheduled**, not implemented. This page is the impact analysis required
before any language-semantics change, and the versioned grammar note it asks
for lives in
[`docs/language-reference.md`](../language-reference.md#grammar-note-result-value-binding--文法说明结果值绑定).

状态：路线 B 已交付（CLI 值级证据）；路线 A（语言变更）**已排期**，未实现。
本文是语言语义变更前的影响分析；版本化文法说明写在
[`docs/language-reference.md`](../language-reference.md)。

Work package index: [`availability.md`](availability.md). Public behaviour
reference: [`execution-contract.md`](../execution-contract.md).

## 1. The gap, measured / 缺口（实测）

A capability call's value reaches a program register and is then dropped. Three
source facts make that structural, not accidental:

- `VmInvocation` (`native/revia-core/src/vm.rs:134-139`) has exactly four
  fields — `instance`, `member`, `invocation_id`, `outcome`. There is no
  payload field.
- `execute_verified` keeps only the *last* value response in
  `returned_value` (`vm.rs:393`); earlier responses are overwritten, and a
  `BranchResult` jump carries no payload (`vm.rs:411-441`).
- The receipt is serialized from the four invocation fields alone
  (`serialize_receipt_without_digest`, `vm.rs:588`), so the value never reaches
  any published digest either.

Consequences measured with the real binary on 2026-11-07 (macOS aarch64,
`native/target/debug/revia`, fixture programs in the `execute` shape required by
`validate_graph_shape`: one `InvokeCapability`, one `BranchResult`, two
`ReturnStatus`):

| Probe | Command | Observed | Status |
|---|---|---|---|
| A declared result cannot be bound to a value | `revia check` on `ok(%data) => …` | exit 65, `re.native-parser-result@0.1.0`, `code:"unexpected-token"`, `expected:"_"` | `measured` |
| Default `execute` shows no value | `revia execute read.re <digest>` (readable `in.txt`) | exit 0, `invocations:[{instance,invocation_id,member,outcome}]`, no value member | `measured` |
| A success and a refusal are indistinguishable at exit-status level | same program, `in.txt` absent | exit 0, `"ok":true`, `outcome.code:2`, `invocations[0].outcome:"err"` | `measured` |
| A non-`result` return has no value position and is matched as `ok` | `revia compile` + `revia execute` on `%n = @clock.monotonic_nanos()` followed by `match %n { ok(_) => process.exit(0) … }`, clock declared and granted | compile exit 0; execute exit 0, `invocations[0].outcome:"ok"`, `outcome.code:0` — the plain `number.i64` takes the `ok` branch and is discarded, so nothing names or renders it | `measured` |

So the public grammar underspecifies precisely the two things the Issue asks
for: the value-binding position (`wildcard` has none) and the branch body
(`effect-call` only, `docs/language-reference.md:11-26`). Anything that renders
a result today is rendering the *outcome*, not the *value*.

## 2. What this work package delivers (route B) / 本次交付

Opt-in value-level evidence in the CLI, with no language change:

- `VmExecution` gained `invocation_values: Vec<Option<VmValue>>`
  (`vm.rs:182-191`), filled next to the existing `invocations.push`
  (`vm.rs:397`, `:406`) — one entry per invocation, in invocation order:
  `Value{payload}` ⇒ `Some(payload)`, `CheckFailure` / `HostFault` ⇒ `None`.
- `execute_bytecode_with_return_value_and_declarations` became public
  (`vm.rs:255`) so the CLI can ask for the value-aware execution while still
  admitting registry declarations. Dropping declarations at the `&[]` door
  would re-verify the artifact against an empty vocabulary and reject the graph.
- `revia execute --print-values <source> <input-digest>` renders the array as
  `"invocation_values":[…]` next to `invocations`
  (`native/revia-cli/src/main.rs:1190`, `:8356-8390`), each entry the canonical
  VM value JSON (`serialize_vm_value`, `vm.rs:481`).
- `revia run --print-values` (WP-359) and `revia runtime-run --print-values`
  (WP-361) accept the same flag on the two other paths that execute a verified
  artifact. For one source, one artifact, and one input digest, all three print
  the same bytes; the replayed paths differ only in loading or unpacking the
  artifact they were given. `runtime-run` was the last VM-backed CLI surface
  that could not show what a capability call returned.

Why this is additive and not a contract revision:

- The member is emitted **only** under the flag. The code-level reason default
  output and every `receipt_digest` stay unchanged is that the receipt
  serialization still reads only the four invocation fields (`vm.rs:588`) and
  `invocation_values` is not part of it (`vm.rs:182-191` documents that); each
  non-opt-in call site passes `None`. The CLI test pins that claim by asserting
  the member is absent, the neighbouring fields keep their values, and the
  digest matches the opt-in run — it is not a whole-output baseline diff.
- The fixed bytecode shape (`validate_graph_shape`: one `InvokeCapability`,
  one `BranchResult`) allows exactly one capability call per program today, so
  the array has length 1 in this work package. "One entry per invocation"
  describes the mechanism, not a multi-value promise.
- The documented envelope stays `re.native-host-execution-result@0.1.0`. The
  optional member is described as an additive, non-digest extension pending a
  schema revision — it is not claimed as an already-versioned contract.

What value-level evidence buys, measured (`native/revia-cli/tests/wp4_result_value_cli.rs`):

| Program branch | `--print-values` entry | Exit |
|---|---|---|
| readable `in.txt` | `{"type":"text.utf8","value":"hello-value\n"}` | 0 |
| absent `in.txt` | `{"type":"fs.read_error","value":"not_found"}` | 0 (`outcome.code:2`) |

Both ran `"ok":true` before; now they are distinguishable by value, and the
refusal value keeps its typed envelope (`fs.read_error`) instead of collapsing
to a bare status.

## 3. Route A: the language change / 语言变更的影响分析

Route A is the full fix: bind and render values in the language itself.
**Scheduled, not delivered.** The analysis below is what a future work package
must land against.

### 3.1 Grammar delta / 文法增量

```text
# today (re 0.1 compact)
branch ::= "ok" "(" wildcard ")" "=>" effect-call
         | "err" "(" wildcard ")" "=>" effect-call

# proposed (re 0.2 compact)
branch ::= "ok" "(" wildcard ")" "=>" effect-call
         | "err" "(" wildcard ")" "=>" effect-call
         | "ok" "(" binding ")" "=>" effect-call
         | "err" "(" binding ")" "=>" effect-call
```

The change is additive at the surface: `ok(_)` and `err(_)` keep their current
meaning and every existing program parses identically. The new production adds
a value-binding position whose scope is the branch body only.

### 3.2 Affected components / 受影响组件

| Layer | Change | Risk |
|---|---|---|
| Parser | new branch alternative; `%name` inside `ok(`/`err(` | low — token stream already accepts `%name` |
| Graph / checker | new binding kind carrying a result payload; type of the bound name is the branch's success/error type | medium — needs a declared-result type projection, and it must reject binding a non-`result` effect call |
| Bytecode | `BranchResult` must carry the payload to the target branch (today it only sets `pc`, `bytecode.rs:32-46`); artifact/release schemas bump | high — `re.native-bytecode-artifact@0.1.0` (`bytecode.rs:13-15`) is a strict-equality check (`bytecode.rs:401-407`), so old binaries reject 0.2 artifacts and vice versa: a version boundary, not a silent skew |
| VM | `BranchResult` carries a register payload; `Validate`/`ReturnStatus` must keep the status return while values live in registers (`vm.rs:411-450`) | high — this is the ~700 LOC core: register writes on branch, no payload on return, one new failure mode per path |
| Rendering | reuses the existing `vm_value_json`/`serialize_vm_value` encoding (`vm.rs:481-520`) so a printed value and a receipt value agree | low — encoding already exists and is canonical |
| Project runtime | `result-binding|binding-type` diagnostics (`project_runtime.rs:622`) gain a valid case | medium |
| Node reference toolchain | parity for the new production, or an explicit version gate | medium — cross-language matrix would otherwise diverge |

### 3.3 Compatibility / 兼容性

- Sources: additive; all released examples keep parsing and executing.
- Artifacts: hard version boundary (0.2.0), with `verify` rejecting cross-version
  artifacts through the existing strict schema equality — no tagged release is
  invalidated, because route A ships under a new version string.
- Receipts: a program that binds a value produces a *different* graph, so its
  receipts change — that is a new write, not a rewrite of published digests.
  Published `v1.0.0-rc.2.2.1` assets are untouched either way.
- No existing test may be shrunk to make room; the 0.1 corpus keeps asserting
  the 0.1 shape.

### 3.4 Safety boundary / 安全边界

The change moves values, not authority. A bound payload is the same typed value
the host already returned through `CapabilityResponse::Value`
(`minimal_std.rs`); rendering it does not widen the host surface, and the value
must be rendered through the typed encoder so an untyped stringify never leaks a
value outside its envelope. The host boundary measured in WP-357 (sandbox root,
1 MiB budgets, `validate_path`) is unchanged by route A.

### 3.5 Why it is not done now / 为何本轮不做

Route A crosses four layers plus the Node toolchain and the artifact version
boundary, and it cannot be validated by one CLI test. §10 of `availability.md`
allows Issue 4 to close with the language change **scheduled**; route B supplies
the acceptance evidence (impact analysis, versioned grammar note, CLI test that
prints a capability value) without pre-empting the version decision.

## 4. Deferred items / 遗留项

1. **Schema revision** for `invocation_values`: today it is an opt-in additive
   member under `@0.1.0`, printed by `execute`, `run`, and `runtime-run` only.
   A follow-up either versions the envelope or drops the member; until then it
   must not be cited as a stable contract. The project path cannot join those
   three additively: `re.native-project-run@0.1.0` is a flat envelope with no
   per-invocation data at all, its `run_digest` is computed over the whole
   envelope body, and `project-run-verify` rejects an unknown member
   (`unexpected-project-field`) as well as any edited field
   (`native-project-run-digest-mismatch`). Extending `--print-values` to
   `project-run` / `project-execute*` is therefore a versioned change (a new
   envelope revision plus a new run digest), not an additive member — measured
   in `wp362_project_value_evidence_boundary_cli` and recorded here instead of
   being implemented under 0.1.0. The project path also refuses the flag
   outright (exit 64) rather than accepting and ignoring it.
2. **Non-`result` returns and binding type**: a `number.i64` from
   `clock.monotonic_nanos` comes back as a plain `ok` response, so `match` on
   it silently takes the `ok` branch and discards the value (§1 probe). Route A
   must decide whether to bind such a return or reject the match; today the
   single-file path enforces no branch-subject type.
3. **Collapsed bridge failures**: `native-vm-capability-failed` (`vm.rs:425-429`)
   is still the single collapse point for `CheckFailure|HostFault`. Measured:
   such a response terminates the execution in the `BranchResult` arm, so the
   command prints the collapsed diagnostic and no result at all — the `null`
   slot `invocation_values` records inside the VM (`vm.rs:393-397`) is
   unreachable through the CLI under the current artifact shape. The
   compatibility decision from WP-357 is now recorded in
   [vm-failure-diagnostics.md](vm-failure-diagnostics.md): the token stays, and
   any finer detail must be a versioned additive member. This work package does
   not change the code.
4. **Node toolchain parity** for `--print-values` is not claimed: only the
   native CLI path is measured here, on `execute`, `run`, and `runtime-run`.
   The Node CLI (`src/cli/re.js`) has neither `--print-values` nor
   `runtime-run`, so no equivalence claim is possible in either direction.

## 5. Evidence / 证据

| Claim | Command / test | Status |
|---|---|---|
| default output carries no `invocation_values` | `cargo test --offline -p revia-cli --test wp4_result_value_cli the_default_result_is_unchanged_and_carries_no_values` (asserts member absent + neighbouring fields, not a whole-output baseline) | `measured` |
| `--print-values` prints the typed payload | same test, `print_values_reports_the_typed_value_of_the_capability_call` | `measured` |
| receipt digest is identical with and without the flag | same test (digest equality assertion) | `measured` |
| a refusal prints its typed value | same test, `print_values_distinguishes_a_refusal_value_from_its_exit_status` | `measured` |
| usage text advertises the flag | same test, `the_usage_text_advertises_the_opt_in` | `measured` |
| `run --print-values` matches the staged evidence byte for byte | `cargo test --offline -p revia-cli --test wp359_run_value_evidence_cli` | `measured` |
| `runtime-run --print-values` matches `execute --print-values` byte for byte | `cargo test --offline -p revia-cli --test wp361_runtime_run_value_evidence_cli runtime_run_print_values_matches_the_one_shot_execute_evidence` | `measured` |
| the replay flag leaves the default output unchanged | same test, `runtime_run_without_the_flag_is_unchanged_and_prints_no_values` | `measured` |
| the authority receipt binds the value-bearing bytes and the VM receipt digest does not move | same test, `runtime_run_print_values_does_not_move_the_authority_receipt` | `measured` |
| the project run envelope carries no value evidence and is deterministic | `cargo test --offline -p revia-cli --test wp362_project_value_evidence_boundary_cli the_project_run_envelope_carries_no_value_evidence` | `measured` |
| the project path refuses `--print-values` (exit 64) instead of ignoring it | same test file, `the_value_flag_is_refused_on_the_project_path` | `measured` |
| the project envelope rejects an added value member and any field edit moves `run_digest` | same test file, `the_project_envelope_cannot_gain_a_value_member_without_a_version_change` | `measured` |
| the grammar rejects `ok(%data)` | `revia check` probe, table in §1 | `measured` |
| a non-`result` return takes the `ok` branch without a binding | `revia compile` + `revia execute` probe, table in §1 | `measured` |
| route A cost (~700 LOC, 4 layers) | estimate from the table in §3.2 | `pending` |

## 6. Review / 评审

Independent review is required before this page is treated as accepted (§9 of
`availability.md`). Record the verdict below.

- Verdict: `PASS` (2026-11-08, independent second-model review against the
  acceptance criterion and the staged diff). No blocking findings; six minor
  findings — stale line citations, an over-broad "byte for byte" phrasing, a
  multi-element array that is length 1 today, and a schema-status gap in
  `execution-contract.md` — were corrected before commit, and the
  non-`result`-return probe above was measured to replace an earlier
  `verified-only` claim.
