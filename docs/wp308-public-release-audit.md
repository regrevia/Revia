# WP-308 Public Release Audit

- **Base:** `7d9ca9f54ddd0dc6c70d82cddc72889d600efdf0`
- **Overlay:** `revia.public-release-sync@1.0.0`
- **Overlay digest:** `1d2d61be70794ddc47381acd6e97eee26467467c403060da7b2a28bbb5c9279c`
- **Release posture:** RC / evaluation-only / source-closed / `darwin-arm64` measured
- **Historical assets:** preserved; no historical tags, archives, licenses, checksums, runtime evidence, or feedback templates removed.
- **Deleted files:** none.
- **引用审计:** `rg` 全仓审计完成；未发现可安全删除且已被 1.1 contract 完全取代的无引用重复静态内容。

## Verification

- `scripts/test-public-trial-runner-contract.sh` — pass
- `scripts/verify-rc1-trial-kit.sh` — pass
- `scripts/test-json-contract.sh` — pass
- Public trial runner — 7 trials pass; `project-workflow` 3/3 ordered steps pass
- Reviewed file plan — denied zero-effect, stale approval fail-closed, approved output pass
- `scripts/validate-public-tree.sh` — pass
- `git diff --check` — pass

The runner was verified with the published RC1 Darwin arm64 candidate whose
SHA-256 is `8680c8df50bec5cd0a6c0e2f421d0ea78e4fd4808cbf437f8c185906bde9eb4d`.
