# Simpler Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver chapters with fewer interruptions and remove spending gates from every AI operation.
**Architecture:** Keep the persistent request ledger, remove authorization semantics and legacy cumulative guards. Prepare a source-backed chapter brief locally; checkpoint targeted repair and verification separately from full checks. Present one decision card for unresolved problems.
**Tech Stack:** TypeScript, Electron, React, SQLite, Vitest, Playwright.
**Spec:** docs/simpler-authoring-design.md

## Global Constraints

- No money or cumulative Token limits; missing prices mean unknown cost, not refusal.
- Preserve single-response output limits, bounded retries, author ownership and source revisions.
- No default extra AI preparation call; no whole-chapter automatic rewrite.
- One automatic repair round; one execution per explicit author decision.
- Work in the attached isolated checkout; no publication or installation in this task.

## Review Focus

- Old paused jobs and explicit tiny legacy budgets must resume without top-up (Task 1).
- Missing prices/usage and background sync must retain request records without false zero cost (Task 1).
- An author editing or confirming a chapter during repair must prevent overwrite (Task 3).
- Large context and remote facts must retain source identity; future chapters must not become past facts (Task 3).
- Confirmation must execute repair once; pause/restart must not repeat an already attempted repair (Task 3).

### Task 1: Non-blocking usage accounting

**Files:** src/main/billing.ts, provider.ts, tasks.ts, writing.ts, revision.ts, story-extraction.ts, scene-writing.ts, voice-extraction.ts; tests/billing*.test.ts and affected runner tests.
**Interfaces:** BillingService.dispatch/reserve/settle remain compatible with persisted records; summary reports known/unknown cost. Legacy tokenBudget values remain readable but do not control execution.
- [x] Add failing real-service tests for unpriced, absent/zero budget, resume and unknown ledger entries.
- [x] Run `npm test -- tests/billing.test.ts tests/billing-integration.test.ts` and verify expected failures.
- [x] Remove monetary and cumulative guards; retain historical schema and request price snapshots.
- [x] Update obsolete budget tests to exercise uninterrupted execution, cancellation and restart.
- [x] Run affected tests and typecheck; retain changes for final review.

### Task 2: Remove cost approval UI

**Files:** src/renderer/main.tsx, billing.tsx, profiles.tsx, author-experience.ts, writing-progress.tsx, revisions.tsx and usage panels; tests/e2e/billing.spec.ts, tests/billing-ui.test.ts.
**Interfaces:** run(command) invokes directly; CostSummary displays estimates/unknown values without remaining budget.
- [x] Replace approval E2E expectations with direct execution without prices, and resume without top-up.
- [x] Remove approval queue/dialog and obsolete budget controls/copy; price metadata remains optional.
- [x] Run typecheck, UI regression tests and Electron E2E.

### Task 3: Prepare chapter evidence and execute author decisions

**Files:** src/main/writing.ts, new src/main/chapter-brief.ts, src/shared/writing.ts, src/renderer/writing-progress.tsx; tests/writing.test.ts, tests/writing-storage.test.ts, tests/e2e/writing.spec.ts.
**Interfaces:** local chapter brief and optional persisted repair verification state compatible with older jobs; writing.resume with repair=true and author text schedules one explicit repair only for a current new draft with valid evidence.
- [x] Add failing tests for shared source-backed brief, post-limit author decision executing a real patch, verification limited to modified passages, and unverified findings remaining nonblocking.
- [x] Implement local brief preparation and prompt integration without a new model request.
- [x] Checkpoint repair attempts, changed spans and explicit decisions; verify changed passages once and preserve unrelated findings.
- [x] Consolidate unresolved issues into a single decision card with a recommended combined action.
- [x] Run writing/ownership/context/storage regressions and UI tests.

### Task 4: Verification and handoff

**Files:** docs/simpler-authoring-verification-20261024.md, README.md as needed.
- [x] Run full tests, typecheck, contrast audit and build.
- [x] Run relevant Electron flows on isolated data.
- [x] Review whole diff with a fresh reviewer; fix material findings and verify them.
- [x] Record fixture baseline/comparison and state actual-model evaluation separately.
- [x] Commit verified local changes; leave publication/installation separate.
