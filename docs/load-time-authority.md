# Load-time authority / 加载时权威链

`re.load-time-authority-pin@0.1.0` is a provider-neutral authority envelope
for a reviewed execution. It binds reviewed source bytes, canonical graph,
build artifact, runtime/interpreter, command, environment input,
canonicalization, hash algorithm, load process, expected loaded-byte origin,
and an optional post-run runtime result.

`verifyLoadTimeAuthorityPreflight` compares the reviewed source and actual
loaded bytes, runtime, command, environment, canonicalization, and load
process before parsing or checking. `verifyLoadTimeAuthority` then completes
the graph/artifact/result comparison. Source, graph, artifact, loaded-byte,
runtime, command, environment, load-process, runtime-result, or
canonicalization drift fails closed. `executeWithLoadTimeAuthority` performs
the check before invoking its effect callback.

The pin digest is a canonical consistency digest. It is not a signature,
attestation, or independent trust root. The loader-facing
`runSourceFromLoadedBytesWithAuthority` path now uses one byte snapshot for
preflight, parsing, checking, translation, and execution; mutated source is
rejected as `DRIFTED` before parsing or effects. Public CLI flag and native
runtime integration remain separate evidence gaps. The Node CLI exposes this
slice as `re run --format json --authority-pin <pin.json> <file.re>`;
`--authority-pin` is opt-in and cannot be combined with `--runtime-receipt`.
Unreadable, malformed, or schema-invalid pin files return a stable
`re.run-result@0.1.0` host-fault envelope with no program stdout.

The executable corpus is
[`test/fixtures/load-time-authority.json`](../test/fixtures/load-time-authority.json),
with focused coverage in
[`test/load-time-authority.test.js`](../test/load-time-authority.test.js).

## Native host execution boundary

The measured boundary around a native guest program is recorded in
[`docs/work-packages/availability.md`](work-packages/availability.md) section 4
and pinned by
[`test/fixtures/host-boundary-refusal-corpus.json`](../test/fixtures/host-boundary-refusal-corpus.json)
with the driver
[`native/revia-cli/tests/wp357_host_boundary_corpus.rs`](../native/revia-cli/tests/wp357_host_boundary_corpus.rs).
Four builtin members (`fs.read`, `fs.write`, `process.stdout`,
`process.args`) plus the `process.exit` status domain, and three served
declared members (`revia.strings.concat`, `revia.strings.scalar_count` —
measured by the section 5 corpus — and `revia.clock.monotonic_nanos`, measured
by section 4), are the whole language-visible surface. Anything outside the
builtin table is not expressible from program text: the graph builder rejects
the reference before a host exists. The boundary that holds is the host
configuration — sandbox root is the source file's parent directory; arguments,
environment, and secrets are empty (host configuration, verified-only, not
corpus-asserted); the read budget is 1 MiB and measured, while the same
`MAX_OUTPUT_BYTES` constant guarding the write payload is verified-only; paths
are validated lexically and by canonical prefix; and symlink writes are refused
in a Unix-only driver test. The `--capability-policy` artifact is an operator
authorization record for declared families only: it does not gate the builtin
surface, and naming a builtin in it is refused. A `.rebc` artifact carries no
authority; each `run` re-derives it from the policy, so no artifact can widen
what an operator granted. The `process.exit` status domain (0..=255) is
enforced while the bytecode is built, not by the host.
