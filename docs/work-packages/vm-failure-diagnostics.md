# VM failure diagnostics: compatibility decision

Status: **decided 2026-11-08** (decision record, no code change).
Scope: the `native-vm-capability-failed` collapse in
`native/revia-core/src/vm.rs`, recorded as `fault-observed` in
[availability.md](availability.md) section 3.6 (row 1) and section 4.4.

This page answers the one question those rows leave open: may the shipped CLI
output be changed so that a capability failure reports *which* failure it was?
It records the decision, its evidence, and what the decision forbids. It does
not change the VM, the result schema, or any test.

## 1. Observed behaviour (measured)

A declared member that the policy refuses ends the run here:

```
$ revia execute --schema-registry reg.json --capability-policy deny.json \
    s.re sha256:eeee…eeee
exit 65
stdout: (empty)
stderr: {"diagnostics":[{"code":"native-vm-capability-failed"}],"ok":false,
         "schema":"re.native-host-execution-result@0.1.0"}
```

That is the whole refusal surface: one code, no invocations, no receipt. The
same shape is pinned end to end by
`native/revia-cli/tests/wp355_declared_capability_policy_cli.rs:262` and
`native/revia-cli/tests/wp358_policy_rejection_corpus.rs:260`.

Inside the VM the collapse is a single expression in the `BranchResult` arm:
both non-value bridge responses become the same `GraphError`
(`native/revia-core/src/vm.rs:425-429`):

```rust
CapabilityResponse::CheckFailure { .. }
| CapabilityResponse::HostFault { .. } => {
    return Err(GraphError::new("native-vm-capability-failed"));
}
```

Nothing survives the `Err`: no `VmResult`, no `invocations[]`, no
`invocation_values[]`, no receipt. The model nevertheless **knows** the
distinction before discarding it — `CapabilityResponse::{CheckFailure,HostFault}`
carry a precise `code` (`vm.rs:32-36`), and `response_outcome` already maps them
to `"check-failure"` / `"host-fault"` (`vm.rs:697-703`). Those strings are
visible only in a *successful* execution's `invocations[].outcome`, which a
collapsed failure never produces.

The precise codes are pinned one layer down, where the bridge is visible:
`native/revia-core/tests/wp354_declared_host_serving.rs:240` and `:266`,
`native/revia-core/tests/wp255_vm_executor.rs:238`.

## 2. What the collapse costs

An end-to-end caller holding exit 65 and `native-vm-capability-failed` cannot
distinguish:

- a policy denial (`native-host-bridge-capability-denied`),
- a wrong-shaped adapter answer (`native-host-bridge-declared-member-unknown`),
- a host fault from the adapter itself.

The distinction exists in-process and in the core tests; it is simply not
serialized when execution fails. That is a reporting gap in the failure path,
not a hole in the isolation boundary: the run fails closed in every case, and
the failed call never produces program-visible output.

## 3. Options

| Option | What it changes | Cost |
|---|---|---|
| **A. Keep the collapse; declare it the contract** | nothing | Callers keep a coarse code; the precise vocabulary stays core-only. |
| **B. Additive failure detail under a new result schema revision** | a member that carries the invocation outcome kind and the bridge code, emitted only on a collapsed failure | Needs a versioned result envelope (`re.native-host-execution-result@0.2.0`) or an opt-in flag, plus the impact analysis a public-interface change requires. |
| **C. Split the code token in place** (`native-vm-capability-failed:<kind>` or distinct codes) | the meaning of an already-published token | Breaks every consumer that pins the token; rejected outright. |

Option B is compatible by construction where it matters: a failed execution
produces no receipt, so **no pinned `receipt_digest` can move**, and the
existing token, the exit status, and the fail-closed behaviour can all stay
exactly as they are.

## 4. Decision

**Adopt A now; B is the only acceptable path later, and only as a versioned
addition.**

1. `native-vm-capability-failed` is a stable token of the 0.1 result contract.
   Its meaning is exactly "a capability call failed before producing a value".
   No caller may read a finer cause out of it, and the documentation must not
   imply one.
2. Execution keeps returning `Err` on any non-value bridge response. Failing
   closed is not negotiable; only the reporting layer may grow.
3. When the vocabulary is needed, the carrier must be additive and versioned: a
   new result schema revision, or an opt-in member on the existing one in the
   same manner as `invocation_values` (WP-357/WP-359). It must not change the
   existing token, exit status 65, the empty stdout, the fail-closed path, or
   any successful-execution receipt digest.
4. The VM model already carries both the kind and the precise code, so that
   follow-up needs no new host information. It needs two decisions that belong
   to its own impact analysis: how the detail is serialized, and whether a
   failed execution may emit a partial invocation record. Neither is decided
   here.
5. Until then the split stays pinned at the core boundary (the tests in
   section 1) and the collapse stays pinned at the CLI boundary (the two tests
   in section 1). Neither pin may be removed to make a change look green.

## 5. What this decision forbids

- Inventing a CLI-level refusal or diagnostic code the binary does not exhibit.
- Emitting a distinct code for a collapse without the schema revision of
  section 4.3.
- Claiming that a caller can tell denial from host fault on the shipped path.
- Reporting a failure detail that changes a successful execution's receipt.
- Weakening the core pins in section 1 while the CLI pin still expects the
  collapse.

## 6. Correction carried by this record

[result-value-interface.md](result-value-interface.md) section 4 item 3 said
`--print-values` "prints `null` for those without saying which". Measured, that
is not what happens: a `CheckFailure` or `HostFault` response terminates the
execution in the `BranchResult` arm, so the command prints the collapsed
diagnostic and no result at all. The `invocation_values` slot for such a
response is recorded inside the VM (`vm.rs:393-397`) but cannot reach a caller
under the current four-instruction artifact shape. The item now says what is
measured. This is a wording correction, not a behaviour change.

## 7. Evidence

| Claim | Evidence |
|---|---|
| CLI refusal surface | measured with the WP-355 fixtures: exit 65, empty stdout, the stderr line in section 1 |
| Collapse point | `native/revia-core/src/vm.rs:425-429` |
| Kind and code exist before collapse | `native/revia-core/src/vm.rs:32-36`, `:697-703` |
| Precise codes pinned at the core boundary | `wp354_declared_host_serving.rs:240`, `:266`; `wp255_vm_executor.rs:238` |
| Collapse pinned at the CLI boundary | `wp355_declared_capability_policy_cli.rs:262`; `wp358_policy_rejection_corpus.rs:260` |
| No receipt exists for a failed execution | `vm.rs` returns `Err` before `build_receipt` in the `BranchResult` arm |

## 8. Not claimed

- No change to the VM, the result schema, or any test in this record.
- No timeline for option B; it stays a documented follow-up, not a scheduled
  work package.
- The four existing `--print-values` tests and the WP-355/WP-358 corpora are
  untouched and keep passing.
