# Public RC1 Alignment and Trials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the public release repository honest and usable while preparing it to accept a verified `v1.0.0-rc.1` sealed candidate and expanding only currently supported public trial examples.

**Architecture:** The public repository has two independent trust boundaries. Preview examples and launchers must remain runnable against the published preview asset. RC files remain readiness controls until a sealed export and trial kit pass their public verifiers; candidate import is an atomic public release-identity change. The RC gate uses an explicit seven-report list so trial-kit metadata cannot contaminate the eleven-file main-export contract.

**Tech Stack:** POSIX shell, PowerShell, GitHub Actions, canonical JSON, SHA-256, GitHub CLI.

---

### Task 1: Add a public sample index and validated review challenge

**Files:**
- Modify: `examples/README.md`
- Create: `examples/agent-evidence-boundary.re`
- Create: `examples/agent-evidence-boundary/README.md`
- Test: `scripts/test-public-examples.sh`

- [ ] **Step 1: Write the failing public-example contract test**

Create `scripts/test-public-examples.sh` with this first assertion set:

```sh
#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
test -f examples/agent-evidence-boundary.re
grep -Fq 'agent-evidence-boundary' examples/README.md
./bin/revia check examples/agent-evidence-boundary.re
test "$(./bin/revia run examples/agent-evidence-boundary.re)" = 'case=evidence-boundary
next=compare-manifest'
./bin/revia manifest examples/agent-evidence-boundary.re | grep -Fq 'graph_revision'
./bin/revia view --locale en-US --format html examples/agent-evidence-boundary.re | grep -Fq 'capability:@stdout'
```

- [ ] **Step 2: Run the new test and verify it fails because the sample is absent**

Run: `sh scripts/test-public-examples.sh`  
Expected: non-zero exit after `examples/agent-evidence-boundary.re` is missing.

- [ ] **Step 3: Add the minimal runnable sample and its bilingual review guide**

Create `examples/agent-evidence-boundary.re`:

```re
re 0.1 compact

unit @agent_evidence_boundary

cap @stdout: process.stdout@0.1.0

fn @main() -> process.status {
  %printed = @stdout.write("case=evidence-boundary\nnext=compare-manifest\n")
  return match %printed {
    ok(_) => process.exit(0)
    err(_) => process.exit(1)
  }
}
```

Create a README that commands `check`, `run`, `manifest`, and `view`, labels
the stdout as an observed effect rather than a complete graph claim, and asks
whether a reviewer can distinguish the declared authority, static branch, and
observed output. Add one matching entry to `examples/README.md`.

- [ ] **Step 4: Run the sample contract and existing compact contract**

Run: `sh scripts/test-public-examples.sh && sh scripts/test-compact-determinism-contract.sh`  
Expected: both commands exit `0`.

- [ ] **Step 5: Commit the sample change**

```bash
git add examples/README.md examples/agent-evidence-boundary.re \
  examples/agent-evidence-boundary/README.md scripts/test-public-examples.sh
git commit -m "examples: add evidence-boundary review challenge"
```

### Task 2: Prevent RC trial-kit metadata from entering the sealed main export

**Files:**
- Modify: `.github/workflows/rc1-release-gate.yml`
- Test: `scripts/test-rc1-gate-contract.sh`

- [ ] **Step 1: Write a failing workflow contract test**

Create `scripts/test-rc1-gate-contract.sh`:

```sh
#!/bin/sh
set -eu
workflow=.github/workflows/rc1-release-gate.yml
! grep -Fq 'runtime/rc1/*.json' "$workflow"
for report in export-manifest candidate-manifest target-matrix native-evidence capability-evidence multi-module-evidence server-evidence; do
  grep -Fq "runtime/rc1/$report.json" "$workflow"
done
```

- [ ] **Step 2: Run the workflow contract and verify it fails on the wildcard**

Run: `sh scripts/test-rc1-gate-contract.sh`  
Expected: non-zero exit because the gate copies `runtime/rc1/*.json`.

- [ ] **Step 3: Replace the wildcard with the exact seven-file copy list**

In the `Verify sealed public export` step, replace the wildcard with:

```bash
for report in export-manifest candidate-manifest target-matrix native-evidence \
  capability-evidence multi-module-evidence server-evidence; do
  cp "runtime/rc1/$report.json" "sealed/$report.json"
done
```

This keeps `trial-manifest.json` outside the eleven-file export contract.

- [ ] **Step 4: Verify the contract and shell formatting**

Run: `sh scripts/test-rc1-gate-contract.sh && git diff --check`  
Expected: both commands exit `0`.

- [ ] **Step 5: Commit the RC export-boundary correction**

```bash
git add .github/workflows/rc1-release-gate.yml scripts/test-rc1-gate-contract.sh
git commit -m "release: isolate RC trial kit from sealed export"
```

### Task 3: Make public validation version-aware without fabricating platform support

**Files:**
- Modify: `scripts/validate-public-tree.sh`
- Modify: `.github/workflows/validate.yml`
- Modify: `scripts/test-launchers.sh`
- Test: `scripts/test-rc1-validate-contract.sh`

- [ ] **Step 1: Write a failing RC validation contract test**

Create `scripts/test-rc1-validate-contract.sh` that requires `validate-public-tree.sh`
to contain a `0.1-preview.1` branch, a `1.0.0-rc.1` branch, the exact
Darwin archive name, and all five pending targets; it must also require the
workflow to run preview smoke only when `VERSION` is `0.1-preview.1` and to
assert exit `69` for pending targets when it is RC1.

```sh
#!/bin/sh
set -eu
grep -Fq '0.1-preview.1)' scripts/validate-public-tree.sh
grep -Fq '1.0.0-rc.1)' scripts/validate-public-tree.sh
grep -Fq 'revia-1.0.0-rc.1-darwin-arm64.tar.gz' scripts/validate-public-tree.sh
for target in darwin-x64 linux-arm64 linux-x64 windows-arm64 windows-x64; do
  grep -Fq "$target" scripts/validate-public-tree.sh
done
grep -Fq 'pending-target' .github/workflows/validate.yml
```

- [ ] **Step 2: Run the contract and verify it fails before the version-aware implementation exists**

Run: `sh scripts/test-rc1-validate-contract.sh`  
Expected: non-zero exit because no RC1 validation branch exists.

- [ ] **Step 3: Implement the minimal branching behavior**

Keep common leak/schema checks outside the version switch. Replace the
hard-coded preview `VERSION` assertion and six-asset loop with:

```sh
case "$VERSION" in
  0.1-preview.1)
    # Retain the six existing archive and binary checksum assertions.
    ;;
  1.0.0-rc.1)
    # Require the accepted Darwin arm64 archive/binary pair and the public
    # RC evidence directory; require the five other target labels to be pending.
    ;;
  *)
    printf '%s\n' "unsupported public release identity: $VERSION" >&2
    exit 65
    ;;
esac
```

In `validate.yml`, retain all historical preview jobs within a guarded shell
branch. For RC1, Linux and Windows must execute `--version` and a real command
that fails `69` with a `pending target` message; only the RC release gate runs
candidate commands on `macos-15`. Keep `windows-launcher` parsing and source
byte checks in both versions.

Update `scripts/test-launchers.sh` to make the missing-curl expectation
preview-only; in RC mode, assert the unsupported-target branch before any
download attempt on the local non-Darwin host.

- [ ] **Step 4: Run the new contract plus current preview validation**

Run: `sh scripts/test-rc1-validate-contract.sh && ./scripts/validate-public-tree.sh && sh scripts/test-launchers.sh`  
Expected: all exit `0` while the repository remains `0.1-preview.1`.

- [ ] **Step 5: Commit the truthful version-aware validation**

```bash
git add scripts/validate-public-tree.sh .github/workflows/validate.yml \
  scripts/test-launchers.sh scripts/test-rc1-validate-contract.sh
git commit -m "release: validate pending RC targets truthfully"
```

### Task 4: Receive and independently verify the sealed RC handoff

**Files:**
- Create: `runtime/rc1/*.json` (only after verification)
- Create or modify: `experiments/rc1/**` (only exact accepted trial-kit fixtures)
- Modify: `runtime/checksums.txt`, `runtime/build-metadata.json`, `VERSION`, `bin/revia`, `bin/revia.ps1`, public documentation (only in the atomic import commit)

- [ ] **Step 1: Require a sealed handoff, not private source**

Accept only a directory that passes:

```bash
./scripts/verify-rc1-export.sh /absolute/path/to/sealed-export
./scripts/verify-rc1-trial-kit.sh /absolute/path/to/trial-kit \
  /absolute/path/to/sealed-export/export-manifest.json
```

Reject any handoff missing a fresh byte-identical peer export, a native
`revia native 1.0.0-rc.1` result, or the exact public license/notice bytes.

- [ ] **Step 2: Independently smoke the sealed Darwin archive without credentials**

Run in a fresh temporary directory with `GH_TOKEN` and `GITHUB_TOKEN` unset:

```bash
tar -xzf /absolute/path/to/sealed-export/revia-1.0.0-rc.1-darwin-arm64.tar.gz -C "$TMPDIR"
"$TMPDIR/revia" --version
"$TMPDIR/revia" --help
```

Expected: exact native RC version and the declared project commands. If the
host is not Darwin arm64, record the native smoke as a release-gate obligation
rather than substituting emulation.

- [ ] **Step 3: Import only public reports and exact public trial fixtures**

Use `apply_patch` to add the accepted JSON reports to `runtime/rc1` and public
fixture text to `experiments/rc1`. Do not add the archive or executable to Git.
Verify `LICENSE-RC.md` and `NOTICE-RC.md` against the sealed copies with `cmp`.

- [ ] **Step 4: Atomically change the public identity and launchers**

In one commit, set `VERSION` to `1.0.0-rc.1`, replace checksums with the two
accepted Darwin records, set `runtime/build-metadata.json` to only the measured
candidate, and update both launchers. POSIX downloads only `darwin-arm64`;
all other identified targets exit `69` and name the compatibility document.
PowerShell reports Windows targets pending with exit `69` and does not attempt
a release download. Update README, Quickstart, compatibility, evidence,
release policy, release notes, development status, and cross-platform evidence
to state measured/pending status, evaluation license, trial command, and
Stable blockers.

- [ ] **Step 5: Verify the atomic candidate commit before pushing**

Run:

```bash
git diff --check
./scripts/validate-public-tree.sh
sh scripts/test-launchers.sh
sh scripts/test-public-examples.sh
sh scripts/verify-rc1-export.sh /absolute/path/to/sealed-export
sh scripts/verify-rc1-trial-kit.sh /absolute/path/to/trial-kit runtime/rc1/export-manifest.json
```

Expected: all exit `0`. Commit only the public files named in Step 3 and 4.

### Task 5: Publish only after candidate CI and the native RC gate pass

**Files:**
- Modify: public release notes only after publication if their state needs to change

- [ ] **Step 1: Push the public candidate and verify the public boundary workflow**

```bash
git pull --rebase origin main
git push origin HEAD:main
gh run list --repo tangshuang631/Revia --limit 1
```

Expected: the candidate's `Validate public boundary` run completes successfully.

- [ ] **Step 2: Create the RC tag and draft with only approved public assets**

```bash
git tag -a v1.0.0-rc.1 -m 'Revia 1.0.0-rc.1'
git push origin v1.0.0-rc.1
gh release create v1.0.0-rc.1 --repo tangshuang631/Revia --draft --prerelease \
  --title 'Revia 1.0.0-rc.1' --notes-file RELEASE_NOTES.md \
  /absolute/path/to/sealed-export/revia-1.0.0-rc.1-darwin-arm64.tar.gz \
  /absolute/path/to/sealed-export/checksums.txt \
  /absolute/path/to/sealed-export/export-manifest.json \
  LICENSE-RC.md NOTICE-RC.md
```

- [ ] **Step 3: Dispatch and verify the credential-free native gate**

```bash
gh workflow run rc1-release-gate.yml --repo tangshuang631/Revia -f tag=v1.0.0-rc.1
gh run watch RUN_ID --repo tangshuang631/Revia --exit-status
```

Expected: gate, publish, and public-download smoke all succeed; release remains
a prerelease. Verify `v0.1-preview` and `v0.1-preview.1` remain unchanged.

### Task 6: Curate feedback and communicate a truthful challenge

**Files:**
- Create: `feedback/submissions/YYYY-MM-DD-agent-feedback.md` only if a new public technical record meets the repository schema
- Modify: none when no qualifying record exists

- [ ] **Step 1: Inspect GitHub and accessible public community replies**

Record a new feedback entry only when it has a public platform, date, handle,
source link, exact claim/reproduction or proposal, evidence status,
classification, and next action. Do not create a placeholder record for an
empty audit.

- [ ] **Step 2: Prepare platform-specific, non-misleading challenge text**

Use the current state until RC1 is actually published:

```text
Revia is inviting independent review—not applause. Start from the public
v0.1-preview.1 package: run check, run, manifest, and view on one small
handoff. Then publish the smallest counterexample where those surfaces disagree,
or submit the project bytes, commands, platform, exit status, and output.
The source-closed RC1 candidate is under sealed verification; it is not a
cross-platform or Stable V1.0 claim.
https://github.com/tangshuang631/Revia
```

- [ ] **Step 3: Confirm exact destination and final text immediately before each send**

Do not send unless the active browser session has the destination page loaded,
the account is visibly authenticated, and the user gives the required
action-time confirmation. Store only resulting public links and technical
replies, never cookies, tokens, private messages, or local paths.

## Plan self-review

Coverage: Task 1 implements runnable/review examples; Tasks 2–3 close the two
identified RC gate defects; Tasks 4–5 conditionally align the public repository
to an independently verified sealed handoff; Task 6 governs feedback and
outreach. No task assumes an unpublished candidate exists or treats a private
claim as evidence. All code/config behavior has a preceding failing contract
test, except the conditional asset import where the external accepted artifact
is the input and both existing public verifiers are the acceptance tests.
