# Staged Authoring Implementation Plan

> **For agentic workers:** Implement natively, test-first, with an independent final review. The author has confirmed all workflow choices; continue in the existing checkout and preserve unrelated changes.

**Goal:** Make conversation advance through synopsis, settings, outline and prose with persistent author confirmations.

**Architecture:** Add an optional versioned authoring state to project records (compatible with existing SQLite v2 records). Pure workflow functions infer legacy progress, resolve each request and apply validated stage artifacts. The conversation runner owns mutations and keeps its atomic revision checks. Editable stage documents use the existing autosave/flush contract and retain history.

**Tech Stack:** Existing TypeScript, React, Electron, SQLite, Vitest and Playwright; no runtime dependency additions.

**Spec:** `docs/staged-authoring-design.md`

## Global Constraints

- Model output cannot grant confirmations or skip stages by itself.
- Explicit early prose remains supported and does not falsely complete planning.
- Explicit delegated scope bounds which documents may be generated.
- Existing manuscript, chapter scopes, cancellation, retry and concurrency protections remain effective.
- Stage state and document history persist across restart and portable backup; old records remain readable.

## Review Focus

- Bare continue with an empty or stale stage must not approve missing content.
- Cancel/retry and failures must not advance or double-approve stages.
- Viewing an earlier document must not silently change workflow progress.
- Changing upstream content invalidates downstream approvals while preserving history/manuscript.
- Legacy books and imported state must not acquire fabricated approvals or unvalidated document content.

### Task 1 — Stage state and orchestration

Files: `src/shared/authoring.ts`, `src/shared/types.ts`, `src/shared/conversation.ts`, `src/main/authoring.ts`, `src/main/conversation.ts`, `src/main/services.ts`, `src/main/files.ts`, `tests/authoring.test.ts`.

- [x] Add failing service tests for the stage chain, early sample return, delegated planning, upstream revision, manual save, stale response, restart and backup.
- [x] Add `Project.authoring`, response `artifacts`, and optional turn workflow intent. Derive legacy starting state without modifying old works on read.
- [x] Add bounded stage request resolution and response validation. Apply confirmations/artifacts within the same transaction as generated changes. Add `authoring.save` with optimistic project revision.
- [x] Validate optional stage state on package import; verify all new service tests pass.

### Task 2 — Editable stage workspace

Files: `src/renderer/authoring.tsx`, `src/renderer/conversation.tsx`, `src/renderer/style.css`, `tests/e2e/authoring.spec.ts`.

- [x] Write an Electron workflow test exercising the visible four-stage progression and return from early sample.
- [x] Add progress tabs, editable documents and history, stage-specific prompts and confirmation suggestions. Flush edits before sends/navigation; viewing tabs does not mutate progress.
- [x] Update old tests only where the newly approved meaning of bare continue intentionally differs.
- [x] Inspect desktop/minimum window screenshots and run the full desktop regression.

### Task 3 — Verification and delivery

- [x] Independent review, fix substantive findings, typecheck and full unit suite.
- [x] Build arm64 package, verify installed copy with isolated test data, record exact outcomes and live-provider limits.
- [x] Update README and verification record; keep previous conversation delivery and existing production installation intact.


## Execution evidence

Implemented in the original checkout with prior changes preserved. Final typecheck and 164 service tests passed; development desktop regression passed 22 tests, final DMG-installed copy passed 21 with one existing development-only Keychain skip. Independent review findings were reproduced and fixed. See docs/verification.md for package hash, screenshots, exact evidence and real-provider limits.
