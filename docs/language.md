# Revia 0.1-preview Language Surface

This document describes the currently runnable preview slice. It is not a
Stable V1.0 specification.

## Program Shape

A `.re` file begins with an exact version header on its first physical line:

```re
re 0.1 compact
```

The current executable examples then declare:

1. a stable `unit` identity;
2. every external capability before use; and
3. an `@main` function returning `process.status`.

```re
unit @hello
cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("Hello, World!\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
```

## Core Rules

- The semantic graph is authoritative; `.re` text is its deterministic carrier.
- Values have explicit types and no implicit conversions.
- External authority is named by revision-pinned capability declarations.
- Effects and their data/order dependencies are explicit graph nodes and edges.
- Fallible operations return typed `result` values; the preview has no hidden
  exception propagation.
- `match` consumption is explicit and exhaustive in the executable slice.
- Source diagnostics carry stable machine fields; Agents should not infer
  repairs from human prose alone.

## Current Capability Slice

- `process.stdout@0.1.0`
- `process.args@0.1.0`
- sandboxed source-directory file read/write operations used by the preview

Undeclared capabilities and unsupported members fail during checking. The
preview does not grant ambient network, database, secret, or subprocess access.

## Commands

```text
revia check [--format json | --write] <file.re>
revia audit --format json <file.re>
revia build --out <dir> <file.re>
revia manifest <file.re>
revia run [--format json] <file.re> [-- <args>...]
revia translate --format json <file.re>
revia view [--locale zh-CN|en-US] [--format html|svg] <file.re>
```

Additional project-oriented commands exist in the binary but are not part of
the first 60-second compatibility promise. Their contracts may change during
the preview.
