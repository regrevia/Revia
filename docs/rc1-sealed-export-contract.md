# RC1 Sealed Export Contract

> 中文摘要：私有开发侧只能向发行侧交付本页声明的密封文件；发行侧按精确清单、摘要、版本、平台、许可和路径泄漏规则验证，不能接收源码或未声明文件。

This contract is the only accepted bridge from private development to the public Revia `v1.0.0-rc.1` release repository.

## Directory inventory

The export directory contains exactly these eleven regular files and no directories or symlinks:

```text
LICENSE-RC.md
NOTICE-RC.md
candidate-manifest.json
capability-evidence.json
checksums.txt
export-manifest.json
multi-module-evidence.json
native-evidence.json
revia-1.0.0-rc.1-darwin-arm64.tar.gz
server-evidence.json
target-matrix.json
```

`export-manifest.json` describes the other ten payloads. It does not contain a digest of itself.

## Export manifest

All JSON files use canonical compact JSON: sorted object keys, no insignificant whitespace, UTF-8, and one final LF. The export manifest has:

```json
{"files":[{"path":"LICENSE-RC.md","sha256":"64-lowercase-hex","size":1}],"license_sha256":"64-lowercase-hex","schema":"revia.public-rc-export@1.0.0","status":"measured-native","tag":"v1.0.0-rc.1","target":"darwin-arm64","version":"1.0.0-rc.1"}
```

The example abbreviates the `files` array. The actual array contains exactly one entry for every payload, with the exact byte size and SHA-256.

## Target matrix

`target-matrix.json` uses schema `revia.public-target-matrix@1.0.0`, binds version `1.0.0-rc.1`, and contains exactly six target records. Only `darwin-arm64` may be `measured-native` in the initial handoff. Darwin x64, Linux arm64/x64, and Windows arm64/x64 must remain `pending`.

## Evidence wrappers

Each of the four evidence JSON files contains at least:

- a versioned string `schema`;
- `version: "1.0.0-rc.1"`;
- `target: "darwin-arm64"`; and
- `status: "measured-native"`.

Evidence may contain additional canonical, path-free digests and bounded results. It must not contain local paths, source text, private repository names, credentials, internal governance records, timestamps that make repeated exports differ, or claims outside the measured run.

## Candidate archive

The gzip-compressed tar archive contains exactly:

```text
LICENSE
NOTICE
checksums.sha256
manifest.json
release-lock.json
revia
```

`LICENSE` is byte-identical to the export `LICENSE-RC.md`; `NOTICE` is byte-identical to `NOTICE-RC.md`; `manifest.json` is byte-identical to `candidate-manifest.json`. The executable is a native macOS arm64 release binary and reports exactly:

The exported `LICENSE-RC.md` and `NOTICE-RC.md` must also be byte-identical to
the files at the public candidate commit. A self-consistent private license is
not sufficient if it differs from the terms shown to public evaluators.

```text
revia native 1.0.0-rc.1
```

`checksums.txt` contains exactly two entries: the archive digest under its full archive filename and the extracted executable digest under `revia-1.0.0-rc.1-darwin-arm64`.

## Rejection conditions

The public repository rejects the export for any missing or extra file, symlink, nested directory, hash or size mismatch, non-canonical JSON, identity drift, unmeasured target claim, archive traversal or inventory drift, license/notice/manifest mismatch, source-code extension, source map, local home path, credential-like value, or internal governance marker.

The four evidence wrappers must point to distinct, versioned measured report
identities. Native/node-free, capability, multi-module, and bounded Server
evidence each carries the actual report/evidence digest and stable digest from
its own run. `unversioned-source-report`, duplicated evidence presented as two
domains, or an input hash without a result digest is rejected.

Run:

```bash
./scripts/verify-rc1-export.sh /path/to/sealed-export
```

Acceptance by this static verifier is necessary but not sufficient. The GitHub release gate must still execute the candidate on native macOS arm64 with repository credentials removed, and it must verify the public download after publication.

Before publication, the RC gate also verifies the complete twelve-asset draft inventory. It downloads every manifest, evidence file, license/notice, runtime archive, and trial-kit archive from the draft, compares public metadata byte-for-byte with this tree, checks the runtime archive checksum, and runs the trial-kit verifier against the downloaded archive. A green runtime smoke cannot hide a missing or mismatched companion asset.

发行前，RC 门禁还会核对草稿中的完整十二项资产：从草稿下载全部 manifest、证据、许可/声明、运行时归档和 trial-kit 归档，与本树公开元数据逐字节比较，复算运行时归档摘要，并对下载后的试用归档运行 verifier。因此运行时 smoke 通过并不等于可以忽略缺失或不匹配的配套资产。
