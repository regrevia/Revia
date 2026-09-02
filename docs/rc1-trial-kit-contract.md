# RC1 Public Trial Kit Contract

> 中文摘要：trial kit 与主二进制密封导出分离，只包含可公开的 `.re`/JSON/text/README fixture、精确逻辑命令和实测摘要；不包含二进制、编译器或运行时源码，也不记录私有路径。

The `v1.0.0-rc.1` trial kit makes the measured native candidate reproducible without weakening the source-closed distribution boundary.

## Layout

The kit is a regular directory containing:

- `trial-manifest.json`;
- `checksums.txt`;
- one public `README.md`; and
- the declared fixture files under `fixtures/`.

Every path other than `trial-manifest.json` and `checksums.txt` appears exactly once in `trial-manifest.json.files`. The checksum list covers `trial-manifest.json` and every declared payload, but not itself. No undeclared file, empty directory, symlink, nested archive, executable, binary object, source map, compiler/runtime implementation source, or private material is allowed.

Allowed public file suffixes are `.md`, `.json`, `.re`, and `.txt`.

## Manifest identity

The manifest is canonical compact JSON with schema `revia.public-trial-kit@1.0.0`, version `1.0.0-rc.1`, target `darwin-arm64`, status `measured-native`, logical runner `./bin/revia`, and the exact candidate `runner_binary_sha256`.

The logical command is what a user runs from the public repository root. Development-side measurement may substitute the sealed candidate binary internally, but no measured command, fixture, output, or report may contain that private local path. The runner binary digest proves which executable produced the expected values.

## Required trials

The manifest contains these unique trial IDs:

1. `hello-check`
2. `agent-review`
3. `capability-args`
4. `capability-file`
5. `project-workflow`
6. `multi-module`
7. `bounded-server`

Each trial binds:

- status `measured-native`;
- a command array starting with `./bin/revia`;
- working directory `.`;
- declared public fixture paths and their input digest;
- prerequisites as a string array;
- expected exit status;
- SHA-256 for stdout, stderr, and the primary canonical result/report; and
- the public evidence wrapper filename supporting the measured claim.

A read whose value is discarded, a single-file workload presented as multi-module, or a Server smoke without the actual HTTP/JSON/SQLite report does not satisfy the corresponding trial.

## Determinism and safety

Two fresh kit generations from the same candidate and fixture inputs must be byte-identical. All expected hashes come from actual execution of the sealed Darwin arm64 binary. Timestamps, random IDs, absolute paths, environment-dependent paths, credentials, internal governance text, and unmeasured platform claims are forbidden.

Run:

```bash
./scripts/verify-rc1-trial-kit.sh /path/to/trial-kit runtime/rc1/export-manifest.json
```

The second argument binds the kit runner digest, version, target, and evidence references to the already accepted main export.

After the candidate binary has been unpacked, execute the recorded commands
and verify their actual outputs:

```bash
REVIA_EXECUTABLE=/path/to/revia ./scripts/run-public-trials.sh /path/to/trial-kit
```

The runner checks every declared exit status, stdout and stderr digest, result
file digest, and result fixture digest. A manifest that only has the right
shape, or whose expected output no longer matches the candidate binary, fails
the gate.
