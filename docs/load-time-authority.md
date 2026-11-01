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
