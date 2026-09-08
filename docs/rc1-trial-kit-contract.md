# RC1 Public Trial Kit Contract 1.1

The trial kit is a source-free collection of public fixtures and measured
expectations for the accepted macOS arm64 RC1 binary. Schema
`revia.public-trial-kit@1.1.0` replaces the broken 1.0 execution shape.

Each trial has one ordered, non-empty `steps` array. Each step independently
binds `command`, `exit_status`, `stdout_sha256`, `stderr_sha256`, and a `results`
array. Every result binds the produced `path`, its `sha256`, and a public
`fixture` containing the expected bytes. There is no trial-level `command`,
`expected`, or ambiguous `result_sha256` fallback to stdout.

`project-workflow` must execute these commands in the same isolated copy:

1. `project-init`
2. `project-check`
3. `project-test`

The final step verifies both generated project files against their result
fixtures. A runner that executes only the first command does not implement this
contract.

Use the static verifier first, then execute every measured step:

```bash
./scripts/verify-rc1-trial-kit.sh experiments/rc1/kit runtime/rc1/export-manifest.json
REVIA_EXECUTABLE=./bin/revia ./scripts/run-public-trials.sh experiments/rc1/kit
```

The verifier and runner reject unsafe paths, symlinks, empty step sets, legacy
1.0 command-only trials, digest drift, missing result files, and fixture
mismatch. SHA-256 binds exact bytes and executable identity; it does not prove
that the closed compiler/runtime correctly enforces every claimed security
boundary.

中文摘要：1.1 清单按步骤绑定命令、退出码、标准输出、标准错误和结果文件；
`project-workflow` 必须顺序执行 init/check/test。摘要只证明字节身份，不证明闭源运行时
实现了正确的安全边界。
