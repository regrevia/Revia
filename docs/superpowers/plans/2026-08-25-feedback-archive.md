# Feedback Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a concise public feedback archive and Agent relay challenge that matches the closed preview release boundary.

**Architecture:** Keep raw reports and curated reproducible issues in separate directories. Link the README and contribution guide to one bilingual workflow document; keep account credentials and private implementation details outside the repository.

**Tech Stack:** Markdown, existing Revia CLI, shell validation scripts.

---

### Task 1: Add the public feedback workflow

**Files:**
- Create: `docs/feedback-loop.md`
- Create: `feedback/agent-discovered-issues/README.md`
- Create: `feedback/agent-discovered-issues/_TEMPLATE.md`

- [ ] Define comment invitations, periodic curation, public attribution, and one-record-per-issue rules.
- [ ] Define the issue lifecycle: discovered, reproduced, fixed, regression-tested.
- [ ] Add a bilingual record template with platform, time window, public handle, source link, reproduction, status, release, and regression evidence.

### Task 2: Connect the workflow to contribution entry points

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/agent-workflow.md`

- [ ] Add the Relay Challenge with the existing `examples/agent-review/main.re` commands.
- [ ] Link feedback reports and curated issues without mentioning the private development repository.
- [ ] Keep project directory and continuation rules unchanged.

### Task 3: Verify and publish

**Files:** all files above

- [ ] Run Markdown/link, public-tree, and leakage checks.
- [ ] Run `git diff --check`.
- [ ] Review the diff for private paths, source maps, credentials, and unsupported claims.
- [ ] Commit only the public workflow changes, rebase, push, and verify synchronization.
