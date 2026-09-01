# Revia V1 RC1 Deep-Trial Kit

> 中文：这是 `v1.0.0-rc.1` 的深度试用入口。公开控制面已经就绪，但在密封资产通过验证并正式发布前，实验状态保持 `pending sealed evidence`，不会展示伪造结果。

## What this kit tests

| Track | Question | Public input | Result before RC publication |
|---|---|---|---|
| Hello | Can the candidate discover and check a minimal program? | [`examples/hello.re`](../../examples/hello.re) | Pending |
| Agent review | Are authority, success, and failure paths inspectable? | [`examples/agent-review/main.re`](../../examples/agent-review/main.re) | Pending |
| Capabilities | Are args and file-read effects explicit and closed? | Existing capability examples | Pending |
| Multi-module | Does an explicit project DAG bind modules, build, translation, plan, and outcome? | Sealed public fixture required | Pending |
| Bounded Server | Does the measured HTTP/JSON/SQLite slice reproduce without claiming production scope? | Sealed public fixture required | Pending |
| Comparison | Can another agent or language report the same task, input, outcome, and environment? | [`comparison/record.schema.json`](comparison/record.schema.json) | Ready for records; no measured result yet |

## Fifteen-minute path after publication

1. Confirm that the release is a GitHub prerelease and download only the official Darwin arm64 asset.
2. Verify the archive and executable SHA-256 from `runtime/checksums.txt`.
3. Confirm exact identity with `revia --version` and inspect `revia --help`.
4. Run the Hello, Agent review, and capability tracks using the commands pinned in the accepted `runtime/rc1/trial-manifest.json`.
5. Run the multi-module and bounded Server tracks only with their accepted fixtures and prerequisites.
6. Save a comparison record with exact version, target, asset hash, commands, output hashes, and limitations.

The command manifest does not exist before the sealed development handoff. Its absence is intentional and blocks publication rather than falling back to the old preview CLI.

## Safety boundary

- Non-production evaluation only; see [`LICENSE-RC.md`](../../LICENSE-RC.md).
- Initial evidence target: native macOS arm64 only.
- SQLite and loopback HTTP are bounded test dependencies, not a production hosting claim.
- Do not publish private inputs, credentials, personal data, or the binary itself in a comparison record.
- A failed experiment is valuable when it includes a minimal public input, exact asset checksum, command transcript, first failing stage, and expected behavior.

## Submit a challenge

Use the repository issue or feedback templates. High-value challenges try to produce identity drift, an undeclared effect, a stale project/module binding, an archive/evidence mismatch, a wrong-graph result, a partial Server publication, or a false cross-platform claim.
