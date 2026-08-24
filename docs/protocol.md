# CLI And Output Protocol

Revia 0.1-preview exposes a process-level CLI contract. Callers provide UTF-8
`.re` files and receive stdout, stderr, and an exit status.

## Exit Status

| Status | Meaning |
|---:|---|
| `0` | Command completed successfully. |
| `64` | CLI usage was invalid. |
| `65` | Source or project checking failed. |
| `70` | Host/runtime failure prevented a trustworthy result. |

The launcher also uses `69` when no binary exists for the current platform.

## Structured Output

Use `--format json` where documented. JSON responses include versioned schema
identifiers and stable diagnostic codes. Consumers should:

- branch on schema identifiers, result kinds, codes, and exit status;
- preserve unknown fields for forward compatibility;
- fail closed on an unknown schema major;
- avoid parsing human-readable messages as authority; and
- retain exact input and command details in feedback evidence.

Diagnostics include source file, line, column, phase, rule, and a stable code
when that information is available. `manifest` reports declared capabilities,
effects, entry points, and graph identity without executing the program.

## Integrity Boundary

`bin/revia` accepts only an archive whose SHA-256 digest exactly matches
`runtime/checksums.txt`. Release assets are platform-specific. A checksum
failure, unsupported platform, malformed output, or nonzero status must not be
silently reinterpreted as success.
