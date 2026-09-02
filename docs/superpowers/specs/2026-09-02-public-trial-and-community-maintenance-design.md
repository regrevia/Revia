# Public Trial and Community Maintenance Design

**Date:** 2026-09-02  
**Status:** Approved for implementation

## Goal

Keep the source-closed public repository accurate and useful while the
`v1.0.0-rc.1` sealed candidate is being accepted. Give developers and Agents
small, honest ways to evaluate Revia's public strengths without claiming an
unreleased runtime, unmeasured platform, or private implementation detail.

## Scope and boundaries

This work changes only the public release repository and public community
records. It does not read, modify, reconstruct, or publish private development
source. A sealed candidate may be accepted only through the existing public
export and trial-kit verifiers.

The current public release remains `v0.1-preview.1`. Community messages may
invite tests of that release and may say that a source-closed RC is under
sealed-candidate verification. They must not state or imply that RC1 has been
published, that all six targets are current, or that Stable V1.0 is available.

## Trial examples

The public example surface has three levels.

1. **Runnable now:** small checked programs that expose one declared
   capability, one observable effect, a typed result, and explicit success and
   failure handling. These use only already documented preview syntax and are
   validated by the public launcher.
2. **Review challenges:** compact inputs and README guidance that ask an Agent
   to compare `check`, `run`, `manifest`, and `view`, distinguish static versus
   observed evidence, and submit a smallest reproducible counterexample.
   They are not described as defect reproductions unless a public run supports
   them.
3. **RC-bound tracks:** project workflow, multi-module, capability, and bounded
   Server tracks remain under `experiments/rc1/`. Their exact commands and
   expected digests come only from an accepted sealed trial kit; before then
   they remain explicitly pending.

Each new runnable sample gets a bilingual README section or an entry in
`examples/README.md` with its purpose, command, expected visible output, and
the review question it answers. No sample silently reads input and discards it
when the claimed purpose is to demonstrate an input-to-effect workflow.

## Release-maintenance closure

The RC release gate must copy the seven main-export JSON reports by explicit
name rather than `runtime/rc1/*.json`; trial-kit metadata must never alter the
eleven-file sealed-export inventory. Public validation must branch by the
declared version:

- `0.1-preview.1` retains its historical six-target preview checks.
- `1.0.0-rc.1` accepts a verified Darwin arm64 candidate only and tests that
  other target launchers fail closed with a pending-target status.

The actual version switch, asset import, tag, draft, publication, and RC
release-gate dispatch remain conditional on receipt and independent public
verification of the sealed export and trial kit.

## Community maintenance

Read public replies before classifying them. Store only public, technical
feedback with a platform, time, public handle/source link, observed behavior or
proposal, evidence status, classification, and next action. Do not convert a
third-party claim into a Revia defect without a Revia reproduction.

Use one concise challenge message per available community instead of repeated
mass replies. The message asks for an independently runnable project or
reproduction and points to the public repository. Replies to older discussions
invite a rerun against the current preview release and request exact version,
platform, command, input bytes, output, and exit status. Do not send
credentials, private paths, unpublished asset hashes, or private-source
details.

## Verification

- Run `git diff --check`, `./scripts/validate-public-tree.sh`, launcher tests,
  and the relevant compact-determinism contract after public changes.
- Run all new example commands through the public launcher and verify their
  stated output or diagnostic behavior.
- Before an RC candidate is imported, run both public sealed-export verifiers
  and a fresh native candidate smoke without repository credentials.
- Before every social send, confirm the exact destination and final public text
  at action time.
