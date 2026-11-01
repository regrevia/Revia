# Load-time authority / 加载时权威链

`re.load-time-authority-pin@0.1.0` is a provider-neutral authority envelope
for a reviewed execution. It binds reviewed source bytes, canonical graph,
build artifact, runtime/interpreter, command, environment input,
canonicalization, hash algorithm, load process, expected loaded-byte origin,
and an optional post-run runtime result.

`verifyLoadTimeAuthority` compares an externally supplied reviewed pin with
actual load-time observations. Source, graph, artifact, loaded-byte, runtime,
command, environment, load-process, runtime-result, or canonicalization drift
fails closed. `executeWithLoadTimeAuthority` performs the check before
invoking its effect callback.

The pin digest is a canonical consistency digest. It is not a signature,
attestation, or independent trust root. The current slice is provider-neutral
and is not yet wired into the public `re run` or native runtime entry points;
that integration remains a separate evidence gap.

The executable corpus is
[`test/fixtures/load-time-authority.json`](../test/fixtures/load-time-authority.json),
with focused coverage in
[`test/load-time-authority.test.js`](../test/load-time-authority.test.js).
