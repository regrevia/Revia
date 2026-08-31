# Revia V1.0 RC1 Public Release Design

## 1. Goal

Publish `v1.0.0-rc.1` as a source-closed, macOS arm64 native prerelease that
developers and Agents can use for non-production development, deep evaluation,
public benchmark experiments, and academic research. The public repository must
not contain the private compiler/runtime source, private governance state,
credentials, machine paths, or source maps.

The existing `v0.1-preview.1` tag and assets remain immutable historical
previews. The repository does not claim Stable V1.0 until every row in
`docs/stable-release-gate.md` has machine-readable evidence.

## 2. Release Identity

- Release version: `1.0.0-rc.1`.
- Git tag: `v1.0.0-rc.1`.
- GitHub Release type: prerelease.
- Initial measured target: `darwin-arm64` only.
- Other declared targets: `darwin-x64`, `linux-arm64`, `linux-x64`,
  `windows-arm64`, and `windows-x64`, all recorded as `pending`.
- Product claim: `V1.0 release candidate / measured native bounded slice`.
- Explicitly excluded claims: Stable V1.0, production backend, complete Server
  profile, cross-platform equivalence, production performance, TLS/auth,
  production database lifecycle, and complete scheduler.

`VERSION`, the native CLI `--version`, archive names, release metadata,
checksums, build metadata, and release notes must all use the same version.
`VERSION` changes only in the commit whose candidate assets exist and pass the
public prerelease gate; the readiness commit keeps `0.1-preview.1` active.

## 3. Licensing Boundary

The RC uses a source-closed developer evaluation license. It permits:

- free individual and team use for non-production development and evaluation;
- automated use by Agents;
- creation of private test projects and generated evaluation artifacts;
- publication of reproducible benchmarks, research results, and critical
  reviews with accurate version and environment disclosure.

It prohibits production deployment, commercial hosted service use,
redistribution of the binary/package, reverse engineering, removal of notices,
and representation of the RC as Stable V1.0. Existing third-party notices remain
bundled. The repository must state that this is a release policy choice, not
legal advice, and that stable licensing may change before `v1.0.0`.

## 4. Two-Repository Release Bridge

### 4.1 Private development repository

The private repository is the only place where the native Rust source is built.
A dedicated release work package binds the reviewed baseline, version, target,
toolchain, source inventory, release lock, binary digest, and public evidence.
It produces a temporary export directory containing only allowlisted files.

The private export process must:

1. build the release binary in a cleared environment for `darwin-arm64`;
2. run the native project, toolchain, runtime bundle, capability comparison,
   multi-module, and bounded Server gates using the release binary;
3. generate canonical, path-free public evidence documents;
4. package the binary with the RC license, notices, release lock, build
   metadata, and checksums;
5. create a public-export manifest containing the private baseline commit,
   schema versions, per-file SHA-256 values, and tree digest;
6. reject symlinks, unknown files, private paths, credentials, source maps,
   compiler/runtime source, debug binaries, and non-canonical JSON.

The export directory is disposable and is never committed to the private
repository. Only its verified files are imported into the public repository or
uploaded as draft Release assets.

### 4.2 Public release repository

The public repository accepts only the verified export manifest and files. A
public verifier independently recomputes every digest and checks an exact file
allowlist. It does not need access to the private repository or a build token.

The initial public evidence set contains sanitized versions of:

- native release candidate manifest and target matrix;
- Node-free/native release evidence summary;
- deterministic identity and fresh-process comparison summary;
- runtime-bundle and capability-comparison summary;
- multi-module gate summary;
- bounded HTTP/JSON/SQLite Server gate summary;
- known limitations and pending target records.

Evidence must identify the reviewed private baseline by commit hash while
excluding private repository URLs, local paths, source inventory names beyond
the public allowlist, test-only secrets, temporary directories, and internal
relay/governance fields.

## 5. Public Repository Milestone Update

The public update is delivered in two commits.

### 5.1 RC readiness commit

This commit keeps `VERSION=0.1-preview.1` and adds:

- the RC developer evaluation license and a license comparison page;
- machine-readable RC gate status;
- the public export/evidence schema and verifier;
- a Darwin arm64 RC draft-gate workflow with zero default permissions;
- cross-platform evidence instructions distinguishing native VM, self-hosted,
  emulated, and cross-compiled evidence;
- a deep-trial project kit and language-neutral comparison protocol;
- updated README, Quickstart, compatibility, security, development status,
  release policy, release notes, and Stable V1 gate pages.

The readiness commit must not create a tag, release, or binary download.

### 5.2 Candidate publication commit

After the private export passes verification, this commit:

- changes `VERSION` to `1.0.0-rc.1`;
- imports sanitized evidence and binds the already-public project/experiment
  inputs to the candidate digests;
- updates build metadata and repository checksums;
- updates POSIX/PowerShell launchers to resolve RC assets without exposing
  unavailable targets as supported;
- records `darwin-arm64=measured` and five targets as `pending`;
- creates the prerelease draft and uploads the source-closed Darwin arm64
  archive plus checksums.

The public gate publishes the draft only after the downloaded asset passes
checksum, version, help, command-discovery, JSON-contract, determinism,
project/developer, runtime-bundle, capability, multi-module, and Server smoke
checks without a repository token. A second zero-permission job downloads the
published asset through the public URL and repeats the availability smoke.

## 6. Deep-Trial Developer and Agent Kit

The public repository provides a self-contained `experiments/rc1/` kit whose
inputs are source examples and machine contracts, not compiler/runtime source.

The kit includes:

- `hello`: minimal check/canonical/manifest/run flow;
- `agent-review`: structured manifest, audit, semantic view, and stable fact
  identity flow;
- `capabilities`: explicit args, file read, file write, typed error, receipt,
  and sandbox inspection tasks;
- `multi-module`: a two-module exact-pin project with project manifest,
  deterministic build, translation, and execution-plan inputs;
- `server-bounded`: the public two-module HTTP/JSON/SQLite conformance input,
  with explicit limitations;
- `comparison`: language-neutral workload descriptions, input bytes, expected
  semantic outcome schema, measurement schema, and result template for Revia,
  Node.js, Go, Rust, JVM, or other implementations.

Every experiment has exact commands, expected exit codes, expected schemas,
failure examples, cleanup instructions, and a machine-readable result file.
Scripts create temporary state outside the repository and never require API
keys. Benchmark results separate semantic correctness from timing and cannot
mark an unexecuted backend as measured.

Agents receive one concise entry document describing how to inspect help,
validate source, run a project, inspect authority/effects, alter one bounded
input, rerun gates, and submit a reproducible issue or comparison result.

## 7. Cross-Platform Evidence Model

Each target record uses one of four statuses:

- `measured-native`: built and executed on the declared OS and architecture;
- `measured-vm`: executed on a genuine target OS virtual machine with recorded
  image and architecture;
- `emulated-preflight`: executed under emulation and never used for performance
  or final support claims;
- `cross-compiled-only`: artifact built but not executed, never considered
  supported.

Functional release evidence may use GitHub-hosted or self-hosted genuine target
VMs. Performance qualification requires native architecture without QEMU,
Rosetta, or binary translation. Future private workflows build on official
macOS, Ubuntu, and Windows x64/arm64 runners and export only sealed assets and
evidence; the public repository performs independent asset smoke tests.

## 8. Security and Failure Handling

The release bridge fails closed on:

- version, tag, target, checksum, manifest, or release-lock mismatch;
- unknown, missing, duplicate, symlink, device, or non-regular export entries;
- private absolute paths, repository secrets, PAT/API-key patterns, private key
  blocks, internal relay markers, source maps, or compiler/runtime source;
- debug binary or unexpected dynamic/runtime dependency;
- non-canonical or synchronously re-signed evidence;
- public smoke that requires a credential or writes to the repository;
- a candidate that reports an unsupported target as measured;
- partial evidence or asset publication.

Release upload creates a draft prerelease. Failure preserves the draft for
inspection and never edits existing preview releases. Publication credentials
exist only in the metadata/publish step; candidate execution steps explicitly
remove `GH_TOKEN` and `GITHUB_TOKEN` and use checkout with
`persist-credentials: false`.

## 9. Verification

Before publishing RC1, the following evidence is required:

- private workspace tests, formatting, linting, release build, focused native
  gates, fresh empty-`PATH` smoke, and grammar fuzz classification;
- public export verifier and two independent export runs with byte-identical
  manifest/tree digests;
- public repository boundary validation and credential/path/source-map scan;
- RC license/notice/package exact-file validation;
- public Darwin arm64 draft asset checksum and binary checksum;
- runtime `--version`, help, command help, exit-code, JSON schema, deterministic
  artifact, project, comparison, multi-module, and bounded Server smoke;
- public post-publication unauthenticated download smoke;
- GitHub Actions success linked from the prerelease record.

The release record lists all pending Stable V1.0 gates and five pending target
platforms. No test result is converted into a production or cross-platform
claim beyond its recorded environment.

## 10. Completion Criteria

This milestone is complete when:

1. the readiness commit is on public `main` and its validation workflow passes;
2. the private Darwin arm64 RC export is reproducible and leak-free;
3. the candidate publication commit is on public `main`;
4. `v1.0.0-rc.1` is published as a GitHub prerelease with verified Darwin arm64
   asset, checksum, license/notices, build metadata, and evidence;
5. a fresh user or Agent can install the RC, complete every deep-trial
   experiment, and emit a comparison result without private-repository access;
6. existing preview tags and assets are unchanged;
7. Stable V1.0 and all unmeasured targets remain visibly pending.
