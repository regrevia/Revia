# Release gate hardening plan

## Scope

Harden the public release repository against the review findings without
claiming capabilities that are not present in `v0.1-preview.1`.

## Work items

1. **Permission boundary**
   - Remove workflow-level write permission.
   - Grant `contents: read` only to smoke jobs and `contents: write` only to
     the publish job.
   - Disable checkout credential persistence.
   - Keep draft download/authentication in a separate step from candidate
     execution and explicitly scrub token variables before running the
     downloaded executable.

2. **Post-publication availability evidence**
   - Add an unauthenticated public-asset smoke after the draft is published in
     the same workflow, so it does not rely on a `release: published` event
     emitted by `GITHUB_TOKEN`.

3. **Truthful release policy and status**
   - Mark signatures, SBOM, and attestation as future roadmap items until a
     gate enforces them.
   - Keep the live work-package status in `docs/development-status.md`; make
     release notes link to it instead of duplicating contradictory status.

4. **Runtime JSON contracts**
   - Replace the inaccurate shared-envelope claim with command-specific
     contracts for `check` and `audit` based on the shipped binary.
   - Add a runtime contract check that executes both commands and fails on
     drift, rather than relying on documentation string matches.

5. **Verification**
   - Run the public-tree validator, JSON contract check, determinism contract
     and report probes, and `git diff --check`.
   - Review the final workflow diff for secret exposure and publish ordering,
     then commit and push `main`.

## Exit criteria

- A candidate executable never receives a repository write token.
- A published release is checked through its public download path in the same
  gate.
- Policy/status documents agree with the currently enforced behavior.
- Runtime JSON output and its documented schemas agree for `check` and `audit`.
- All local verification commands pass; no release is created by this change.
