# RC2 Native Target Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the source-closed public RC channel only when Linux x64, Windows x64, and Linux arm64 each arrive as independently verifiable sealed native exports; establish Android arm64/Termux as a separate experimental evidence track.

**Architecture:** `v1.0.0-rc.1` remains immutable historical evidence and is never relabeled. Each new desktop target is a complete independently sealed archive and trial kit with a target-specific public verifier result. Android is not a substitute for an outstanding six-target Stable requirement: emulator results are recorded as `measured-emulated`, while a real arm64 device result is required before claiming native Android support.

**Tech Stack:** POSIX shell, PowerShell, GitHub Actions hosted runners, canonical JSON, SHA-256, GitHub Release assets.

---

### Task 1: Record the public acceptance boundary before receiving assets

**Files:**
- Create: `docs/rc2-target-expansion-contract.md`
- Create: `docs/android-termux-experimental-contract.md`
- Modify: `docs/cross-platform-evidence.md`

- [ ] **Step 1: Add target-expansion acceptance requirements**

Document that Linux x64 (`ubuntu-24.04`), Windows x64 (`windows-2025`), and Linux arm64 (`ubuntu-24.04-arm`) each require a separate source-free sealed export, canonical target evidence, archive/executable SHA-256, and a bounded seven-trial kit.

- [ ] **Step 2: Add the Android experimental contract**

Document ABI `android-arm64`, Termux/Bionic compatibility declaration, the Android-specific host-boundary report, and the distinction between x86_64 emulator (`measured-emulated`) and a physical arm64 device (`measured-native`). State that Android does not close any existing Stable V1.0 six-target row.

- [ ] **Step 3: Link the contracts from the cross-platform procedure**

Add a next-expansion section that lists the three desktop targets as pending acceptance work and links the Android contract as experimental only.

- [ ] **Step 4: Verify document invariants**

Run:

```bash
grep -Fq 'ubuntu-24.04' docs/rc2-target-expansion-contract.md
grep -Fq 'windows-2025' docs/rc2-target-expansion-contract.md
grep -Fq 'ubuntu-24.04-arm' docs/rc2-target-expansion-contract.md
grep -Fq 'measured-emulated' docs/android-termux-experimental-contract.md
git diff --check
```

Expected: all commands exit `0` and the matrix in `runtime/rc1/target-matrix.json` remains unchanged.

- [ ] **Step 5: Commit the public controls**

```bash
git add docs/rc2-target-expansion-contract.md docs/android-termux-experimental-contract.md \
  docs/cross-platform-evidence.md docs/superpowers/plans/2026-09-02-rc2-native-target-expansion.md
git commit -m "docs: define RC2 native target expansion boundary"
```

### Task 2: Receive the three desktop sealed exports

**Files:**
- Create: `runtime/rc2/<target>/` only after acceptance
- Create: `experiments/rc2/<target>/kit/` only after acceptance
- Create: `scripts/verify-rc2-export.sh`
- Create: `scripts/verify-rc2-trial-kit.sh`

- [ ] **Step 1: Require exactly one target per sealed handoff**

Reject any handoff that combines targets, contains source or private material, omits archive/executable checksums, has non-canonical JSON, or lacks a runner-specific native evidence record. Required targets are exactly `linux-x64`, `windows-x64`, and `linux-arm64`.

- [ ] **Step 2: Write failing verifier tests from a deliberately incomplete fixture**

Create a scratch fixture with one missing evidence file and assert:

```bash
set +e
./scripts/verify-rc2-export.sh scratch/incomplete-linux-x64
test $? -eq 65
```

Expected: verifier reports the absent required file, proving it cannot accept an incomplete export.

- [ ] **Step 3: Implement a parameterized target verifier**

The verifier accepts `<version> <target> <sealed-export-directory>` and requires: exact inventory, canonical JSON, version/tag/target binding, archive format (`tar.gz` on Linux; `zip` only if the Windows binary contract requires it), archive/executable SHA-256, no symlinks, no source/private data, and a measured-native evidence binding for that exact target.

- [ ] **Step 4: Verify each received desktop target independently**

Run the verifier separately for Linux x64, Windows x64, and Linux arm64. Preserve only the public-safe output consisting of version, target, archive hash, and verifier result.

- [ ] **Step 5: Commit only accepted public evidence**

```bash
git add runtime/rc2 experiments/rc2 scripts/verify-rc2-export.sh scripts/verify-rc2-trial-kit.sh
git commit -m "release: accept sealed RC2 native target evidence"
```

### Task 3: Build target-aware release gates

**Files:**
- Create: `.github/workflows/rc2-release-gate.yml`
- Modify: `.github/workflows/release-smoke.yml`
- Modify: `scripts/validate-public-tree.sh`
- Create: `scripts/test-rc2-gate-contract.sh`

- [ ] **Step 1: Write a failing gate contract**

Assert that the workflow has three distinct jobs and native runners:

```bash
grep -Fq 'runs-on: ubuntu-24.04' .github/workflows/rc2-release-gate.yml
grep -Fq 'runs-on: windows-2025' .github/workflows/rc2-release-gate.yml
grep -Fq 'runs-on: ubuntu-24.04-arm' .github/workflows/rc2-release-gate.yml
! grep -Fq 'runtime/rc2/*.json' .github/workflows/rc2-release-gate.yml
```

Expected: fail before the workflow exists.

- [ ] **Step 2: Implement credential separation**

Use a narrowly scoped draft-download step, then run every downloaded candidate with `GH_TOKEN` and `GITHUB_TOKEN` removed and checkout credentials disabled. Publish only if all three target jobs pass; include a public-download smoke for each asset after publication.

- [ ] **Step 3: Run static workflow and tree contracts**

```bash
sh scripts/test-rc2-gate-contract.sh
./scripts/validate-public-tree.sh
git diff --check
```

Expected: all exit `0`.

- [ ] **Step 4: Commit the gate**

```bash
git add .github/workflows/rc2-release-gate.yml .github/workflows/release-smoke.yml \
  scripts/validate-public-tree.sh scripts/test-rc2-gate-contract.sh
git commit -m "ci: gate RC2 native target expansion"
```

### Task 4: Publish a new RC without changing RC1

**Files:**
- Modify: `VERSION`, `runtime/checksums.txt`, `runtime/build-metadata.json`, launchers, docs, and release notes only in one version-bound import commit

- [ ] **Step 1: Confirm all three verifiers and public CI are green**

Run the three target verifiers, `./scripts/validate-public-tree.sh`, and the relevant GitHub Actions validations. Stop if any target is missing or only emulated.

- [ ] **Step 2: Create an RC2 draft release**

Upload exact accepted assets, per-target evidence, trial kits, checksums, RC license and notice. Do not alter `v1.0.0-rc.1` assets or tag.

- [ ] **Step 3: Dispatch the three native gates**

Publish only after Linux x64, Windows x64, and Linux arm64 all independently pass native execution and public-download smoke.

- [ ] **Step 4: Update the matrix truthfully**

Mark only successful desktop targets `measured-native`; retain macOS x64 and Windows arm64 as pending. Keep Android out of this desktop RC matrix unless it has a separately accepted physical-device evidence record.

### Task 5: Run Android as an experimental track

**Files:**
- Create: `experiments/android-arm64/` only after public-safe fixtures exist
- Create: `runtime/android-arm64/` only after accepted device evidence exists

- [ ] **Step 1: Run emulator diagnostics without making a native claim**

Use a GitHub-hosted Linux runner with Android SDK acceleration to build/install/test the Android package. Publish only a result marked `measured-emulated` and include emulator ABI/image identity.

- [ ] **Step 2: Run physical-device evidence**

Use an arm64 Android device attached to a self-hosted Actions runner or a controlled device lab. Run the sealed Termux binary and the bounded public trial kit. Record device ABI, Android API level, exact binary hash, commands, exit status, and output hashes; never record device identifiers, accounts, or credentials.

- [ ] **Step 3: Publish Android evidence only when it is native**

If the physical run passes, publish an Android experimental release record with `measured-native`; otherwise retain the emulator diagnostic and `measured-emulated` status.

## Plan Self-Review

- The three requested desktop targets are covered by Tasks 1–4, each with independent sealed handoff, verification, native CI, and publication.
- Android/Termux is separated in Tasks 1 and 5 and cannot silently satisfy a desktop Stable V1.0 requirement.
- No task imports private source or labels an emulator result as native.
