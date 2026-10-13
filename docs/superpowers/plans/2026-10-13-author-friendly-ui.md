# Author-friendly UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement confirmed author navigation, onboarding and progressive disclosure.

**Architecture:** Reuse existing renderer components and domain commands. Regroup routes rather than migrate data. Map direction confirmation to existing planning delegation; preserve manual guards and candidate review.

**Tech Stack:** Electron, React, TypeScript, Vitest, Playwright.

**Spec:** docs/author-friendly-ui-design.md

## Global Constraints

- Current dirty codex/macos-authoring checkout is the baseline; preserve unrelated edits, no blanket staging/reset/commit.
- No dependency or schema change; no live model calls in tests.
- Preserve histories, source evidence, incomplete checks and credential protection.
- Execute natively in this authorized session, then independent final code review.

## Review Focus

- Legacy books with partial planning remain navigable/editable.
- Unsaved connection/material edits still block navigation until resolved.
- Preview prose never confirms planning or delegates it accidentally.
- Exhausted jobs have explicit finite continuation, not automatic cap increases.
- Narrow windows, export and backup remain usable.

### Task 1: Navigation

**Files:** renderer/main.tsx, style.css; tests/e2e/author-ui.spec.ts and navigation helpers.
**Interfaces:** Existing View routes, Run, flush, register unchanged.
- [x] Add failing Electron navigation/edit-preservation/export-access test.
- [x] Build and run test to confirm missing new navigation fails.
- [x] Regroup routes into context tabs, visible actions and collapsed legacy operations.
- [x] Update navigation regressions and verify.

### Task 2: Author workflow

**Files:** renderer/author-experience.ts, conversation.tsx, authoring.tsx, writing-progress.tsx, revisions.tsx, tasks.tsx; tests/author-experience.test.ts.
**Interfaces:** prepareAuthorMessage(text, workflow): string; authorStep(stage): overview|preparation|writing.
- [x] Test acceptance delegation and empty/stale/preview/existing-book protections.
- [x] Run failing Vitest before implementation.
- [x] Add two start choices, three-step navigation, chapter actions and narrow pane switch.
- [x] Fold technical settings and usage; add finite explicit continuation allowance.
- [x] Verify helper and Electron creation/review flows.

### Task 3: AI connections

**Files:** renderer/profiles.tsx; author-ui.spec.ts.
**Interfaces:** profile.save/model.test and manual guard unchanged.
- [x] Test preset creation and custom connection/credential preservation.
- [x] Add verified DeepSeek preset and advanced custom fields; no automatic test request.
- [x] Verify connection and dirty-navigation tests.

### Task 4: Closeout

**Files:** README.md, docs/verification.md, this plan.
- [x] Typecheck, full unit and Electron regressions; repair failures.
- [x] Inspect wide/narrow screenshots.
- [x] Independent review against pre-task baseline and fix important findings.
- [x] Document tested boundaries separately from live API/installed app; no release claim.


## Completion evidence

2026-10-13: typecheck/build and git diff --check passed; unit suite 435/435; final full Electron suite 41/41. Wide/narrow screenshots inspected. Independent review findings fixed and verified by failing-to-passing budget/navigation regressions. No live provider call, packaging, installation replacement or Git commit/push in this scope.
