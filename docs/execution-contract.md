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
./bin/revia check examples/agent-handoff-review/main.re
./bin/revia run examples/agent-handoff-review/main.re
./bin/revia manifest examples/agent-handoff-review/main.re > manifest.json
./bin/revia view --locale en-US --format html examples/agent-handoff-review/main.re > review.html
```

Use the source, `manifest.json`, `review.html`, output, and exit status as one
review set. A change to the source should be checked against all four views.

## Public Contract Surface

| Surface | Role |
|---|---|
| `.re` | Agent-authored executable source |
| `check` | Source and semantic validation |
| `run` | Bounded execution and observed result |
| `manifest` | Machine-readable capability, effect, and path facts |
| `view` | Human-readable semantic graph |

The release package is the runnable entry point. Language rules and output
schemas are documented separately in [Language](language.md) and
[Protocol](protocol.md).
