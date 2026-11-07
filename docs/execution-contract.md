# Execution Contract / 执行契约

Revia makes the path from Agent-written source to human review explicit:

```text
.re source
    |
    v
parse -> checked graph -> manifest
                    |
                    v
              semantic view
                    |
                    v
              bounded run
```

The same source drives each projection. `manifest` is the machine-readable
contract; `view` is the human review surface; `run` reports the observed
execution result.

## What Can Be Reviewed

The public CLI exposes:

- declared, revision-pinned capabilities;
- capability effects and their typed result branches;
- success and failure paths;
- graph revision and stable UID anchors;
- runtime output and exit status.

These are connected by the generated artifacts. The graph is translated
directly from `.re`; it is not a second hand-written explanation.

## Verification Loop

```bash
npm run re -- check examples/agent-handoff-review/main.re
npm run re -- run examples/agent-handoff-review/main.re
npm run --silent re -- manifest examples/agent-handoff-review/main.re > manifest.json
npm run --silent re -- view --locale en-US --format html examples/agent-handoff-review/main.re > review.html
```

Use the source, `manifest.json`, `review.html`, output, and exit status as one
review set. A change to the source should be checked against all four views.

These source-oriented commands use the Node reference CLI. `bin/revia` is the
versioned native launcher; its `run` command accepts a checked graph, bytecode
artifact, and input digest.

## Public Contract Surface

| Surface | Role |
|---|---|
| `.re` | Agent-authored executable source |
| `check` | Source and semantic validation |
| `run` | Bounded execution and observed result |
| `manifest` | Machine-readable capability, effect, and path facts |
| `view` | Human-readable semantic graph |

## Declared Capability Authorization (native)

The native `execute` and `run` commands accept two separate operator artifacts:

```bash
revia run --schema-registry registry.json \
          --capability-policy policy.json \
          program.re program.rebc sha256:<input-digest>
```

| Artifact | Answers | Never answers |
|---|---|---|
| `--schema-registry` (`revia.host-schema-definitions@0.1.0`) | what the member's parameter and result types are | whether this run may call it |
| `--capability-policy` (`revia.capability-policy@0.1.0`) | which `reference.member` pairs this run may call | whether the host implements them |

The policy is a closed object: `{"schema": 1, "grants":
[{"reference": "<schema>@<version>", "members": ["<member>", ...]}]}`.
Unknown or missing fields, duplicate members, and an unsupported schema value
are rejected with `native-capability-policy-invalid:<reason>`.

Behavior is fail-closed and was tightened in WP-355:

- a graph that references a declared member with no `--capability-policy` is
  refused with `native-host-capability-policy-missing` (exit 65) before a host
  is built. A registry alone no longer admits such a graph;
- a policy that grants a member this build does not serve is refused at binding
  time with `native-host-capability-policy-not-served:<reference>.<member>`;
- an authorized call that the policy does not grant for this run is refused at
  the host boundary with `native-host-bridge-capability-denied`, and the
  adapter behind the boundary is not invoked;
- a policy file that cannot be read is exit 66; one that cannot be parsed is
  exit 65. Successful runs print `re.native-host-execution-result@0.1.0` with
  `invocations[]` and `trace[]` on stdout.

`execute --print-values`, `run --print-values`, and `runtime-run --print-values`
add one optional member next to `invocations`: `invocation_values[]`, same order
and length, each entry the typed value the call returned
(`{"type":…,"value":…}` in the VM value encoding). A failed execution prints no
host-execution result at all, so no `null` entry is reachable in this format.
All three commands observe the same execution: for one source, one artifact, and
one input digest they print the same bytes — the `runtime-run` path differs only
in unpacking a bundle and its sandbox. It is opt-in and additive: without the
flag the output is unchanged, and the member is not part of any
`receipt_digest`, so an observation never moves a pinned receipt. See
[work-packages/result-value-interface.md](work-packages/result-value-interface.md).
The member is an additive extension pending a schema revision, not yet a stable
contract.

This is an operator authorization artifact, not a sandbox: the host adapter
itself is trusted code. The full boundary and its measured limits are recorded
in [work-packages/availability.md](work-packages/availability.md).

The release package is the runnable entry point. Language rules and output
schemas are documented separately in [Language](language.md) and
[Protocol](protocol.md).

When a reviewed load-time authority pin is available, use
`re run --format json --authority-pin <pin.json> <file.re>`. This opt-in path
validates the loader-provided source bytes before parsing or effects and does
not replace the ordinary `run` contract. It is JSON-only and cannot be
combined with `--runtime-receipt`.
