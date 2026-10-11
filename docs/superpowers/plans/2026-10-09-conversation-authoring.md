# Conversation Authoring Implementation Plan

> **For agentic workers:** Implement task-by-task using the established test-first workflow. The author has confirmed the design and authorized implementation; proceed natively in the current checkout, preserving pre-existing changes.

**Goal:** Make novel creation a persistent conversation with automatic, reversible manuscript and setting updates.

**Architecture:** Add a separately persisted conversation runner behind typed IPC. Validate structured model responses and atomically apply changes against a captured revision snapshot. Reuse the provider, domain editor and chapter history; make the conversation workspace the default entrance.

**Tech Stack:** Existing Electron / React / TypeScript / SQLite / Vitest / Playwright; no new dependencies.

**Spec:** `docs/conversation-design.md`

## Global Constraints

- Preserve existing uncommitted work and the advanced task workflow.
- No simulated AI success; use configured providers and honest failure states.
- Default one chapter per turn; opening continuation stays in its chapter.
- Preserve source revisions and old manuscript versions; do not overwrite concurrent edits.
- Preserve conversations through restart and portable backup; keep credentials out of backups.

## Review Focus

- Existing database / old backup: new empty conversation history without loss of old content.
- Cancellation, invalid JSON, output truncation: no partial automatic mutations; retryable saved turn.
- Editing during inference: reject stale changes without losing either author text or response.
- Large old books: bounded context with disclosure; no rewrite of incompletely supplied chapters.
- Switching works / restarting: conversations, pending questions and selected chapter remain coherent.

### Task 1: Persistence and conversation orchestration

**Files:** `src/shared/types.ts`, `src/shared/conversation.ts`, `src/main/store.ts`, `src/main/conversation.ts`, `src/main/services.ts`, `tests/conversation.test.ts`, `tests/store.test.ts`.

**Interfaces:** `conversation.send` accepts projectId, text, optional profileId / chapterId / proposalTurnId; `conversation.cancel` and `conversation.retry` accept turn id. `AppState.conversations` carries author text, assistant reply, state, suggestions, progress, chapter links, revision proposal, usage and compact memory.

- [x] Write failing service tests for saved conversation, automatic setting/manuscript application, opening continuation, revision scope, concurrent edit rejection, cancellation/retry, invalid response and restart.
- [x] Run `npm test -- tests/conversation.test.ts` and verify failures describe missing commands.
- [x] Add migration with pre-upgrade backup, validated response contract and async runner. Capture current project data and bounded recent dialogue. Apply valid responses atomically via domain commands; persist turn status and chapter stage.
- [x] Run conversation, store and domain tests; verify the expected state transitions and saved versions.

### Task 2: Portable conversations

**Files:** `src/main/files.ts`, `src/main/services.ts`, `tests/files.test.ts`.

**Interfaces:** project/recovery packages include conversations, remap record references on import, mark running turns interrupted, omit model configuration. Legacy v1 packages normalize empty conversation arrays before validation.

- [x] Write failing tests for new conversation backup round-trip and legacy import.
- [x] Run targeted files tests and verify red.
- [x] Implement versioned package validation/remapping, recovery capture and interrupted-state normalization.
- [x] Verify files tests pass including malformed/foreign references.

### Task 3: Conversation workspace

**Files:** `src/renderer/conversation.tsx`, `src/renderer/main.tsx`, `src/renderer/bookcase.tsx`, `src/renderer/chapters.tsx`, `src/renderer/style.css`, `tests/e2e/conversation.spec.ts`, `tests/e2e/desktop.spec.ts`.

**Interfaces:** workspace consumes `AppState.conversations` and shared `Run`, `Register`, `Flush`; conversation sends flush current editor first. Auxiliary navigation remains available in a collapsed section. `ChapterEditor` has a conversation variant omitting redundant confirmation controls.

- [x] Write failing Electron test for title-optional start, setup link, dialogue recommendations, automatic draft/note save, inline edit, continuation, history and restart.
- [x] Implement persistent composer draft, submit/cancel/retry, scoped proposal confirmation and status display. Keep dialogue separate from readable editable manuscript.
- [x] Update legacy E2E navigation to explicitly enter auxiliary tools, retaining all original behavior assertions.
- [x] Run E2E tests and inspect screenshots at default and minimum window sizes.

### Task 4: Verification and documentation

**Files:** `README.md`, `docs/verification.md`, this plan.

- [x] Run `npm run typecheck`, `npm test`, `npm run e2e`.
- [x] Perform independent code review; address substantiated findings and rerun affected checks.
- [x] Record exact verification and limitations. Do not equate fixture tests with live provider acceptance or packaged release.


## Execution evidence

Completed in the original checkout over the pre-existing uncommitted changes. Native implementation with independent read-only code review. Tests were written and observed failing before the core service, migration, backup and scope fixes. Added setting history after review confirmed automatically updated settings also need restoration. See `docs/verification.md` for exact commands, desktop evidence and delivery status. No Git commit/push or production data edits.
