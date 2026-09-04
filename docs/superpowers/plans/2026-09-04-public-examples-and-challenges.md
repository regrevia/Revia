# Public Examples And Challenges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the public Revia examples and challenge entry points while keeping every claim inside the measured public preview boundary.

**Architecture:** Add independent, stdout-based `.re` workloads that use the already validated compact syntax, plus a challenge guide that routes reproducible findings through the existing project layout. Update the bilingual README navigation without changing its visual hierarchy or publishing WP-307 as implemented.

**Tech Stack:** Revia compact source, Markdown, POSIX shell tests, `jq`, Git.

---

### Task 1: Add inspectable workloads

**Files:**
- Create: `examples/agent-review-packet.re`
- Create: `examples/agent-release-check.re`
- Create: `examples/agent-counterexample.re`

- [ ] **Step 1: Add the three sources**

Each file must declare only `process.stdout@0.1.0`, return a checked
`process.status`, and expose both success and failure branches through
`match`.

- [ ] **Step 2: Run each source**

Run `./bin/revia check`, `./bin/revia digest`, `./bin/revia manifest`, and
`./bin/revia translate` for all three files from the repository root. Record
structural assertions in the test script. Do not use the legacy single-file
`run` command because it is not part of the current RC surface.

### Task 2: Add challenge navigation

**Files:**
- Create: `examples/challenges/README.md`
- Modify: `examples/README.md`

- [ ] **Step 1: Document the three challenge tracks**

Document a review-packet challenge, a release-evidence challenge, and a
counterexample challenge. Require exact commands, OS/architecture, observed
output, expected behavior, and one falsifiable claim. Distinguish source
inspection from fixed trial-kit execution evidence.

- [ ] **Step 2: Document the PR path**

Require one independent directory under
`projects/YYYY-MM-DD-agent-project/` containing `main.re`, `README.md`, and
`HANDOFF.md`. State that the answer key is not public.

- [ ] **Step 3: Link the progression**

Update `examples/README.md` so visitors can move from `hello.re` to a complete
review workload, then to adversarial review and the challenge tracks.

### Task 3: Update bilingual public entry points

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add the current development pulse**

State that WP-307 is pending private development work for interface projection
and generated clients; link only to public integration boundaries and evidence.

- [ ] **Step 2: Add challenge links**

Link the new challenge guide beside the existing examples and collaboration
links without restructuring the page.

### Task 4: Extend verification

**Files:**
- Modify: `scripts/test-public-examples.sh`

- [ ] **Step 1: Add exact checks**

For each new workload, assert `check`, a SHA-256 digest, a manifest containing
`graph_revision`, and translated bytecode output.

- [ ] **Step 2: Run the public gates**

Run:

```bash
sh scripts/test-public-examples.sh
sh scripts/test-adversarial-review-contract.sh
sh scripts/test-launchers.sh
bash scripts/validate-public-tree.sh
git diff --check
```

- [ ] **Step 3: Inspect the final diff**

Confirm no private path, source map, credential, or WP-307 implementation
appears in the public diff before committing.
