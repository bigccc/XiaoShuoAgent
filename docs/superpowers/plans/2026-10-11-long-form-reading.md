# Long-form Reading Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent reading, reader UI and revision modules; review each module and the integrated result. Steps use checkbox syntax for tracking.

**Goal:** Deliver scalable reading, persistent review annotations and safe conversational revision from a selected passage through an entire novel.

**Architecture:** SQLite owns full prose, review workspaces and revision jobs. Lightweight UI snapshots carry chapter metadata and job summaries; individual chapters, histories, candidate details and paged search results are queried separately. Revision generation produces persisted candidates and applies them only against verified source text.

**Tech Stack:** TypeScript, React, Electron IPC, node:sqlite, Vitest, Playwright.

**Spec:** docs/long-form-reading-design.md

## Global Constraints

- Preserve current codex/macos-authoring checkout and its existing uncommitted changes.
- Source edits, review annotations and revision jobs are local durable data. Model secrets never enter snapshots or backups.
- Default single chapter/selection edits save with history; multi-chapter edits require candidate adoption.
- Test 5,000 chapters / 15 million characters without sending full prose/history in recurring UI snapshots.
- No repeated authorization for already specified chapter scope; a genuine plot ambiguity may pause generation.

## Review Focus

- Duplicate selected quotations must not attach a comment or replacement to the wrong passage.
- Source changes during generation/adoption must not overwrite manual edits.
- Restart, cancel and budget exhaustion must preserve candidates and accurate coverage.
- Partial multi-chapter adoption must not silently apply shared settings against rejected chapter changes.
- Backups must remap annotations, review baselines, candidates and scope identities together.

### Task 1: Durable reading workspace

Files: src/shared/reader.ts, src/main/reading.ts, tests/reading.test.ts.
Interfaces: ReaderCommand; ReadingService(store, domain).dispatch(command), search(projectId, query, offset); ReadingWorkspace with volumes, annotations, reviews and position.

- [x] Write and observe failing service tests for version-bound annotation selection, duplicate quote ambiguity, review baselines after edits, volume overlap rejection and persistent position.
- [x] Implement transactional commands and paged literal search with location offsets.
- [x] Run tests/reading.test.ts, review API validation and source protections.

### Task 2: Lightweight transport and portable persistence

Files: src/shared/types.ts, src/main/store.ts, src/main/services.ts, src/main/index.ts, src/preload/index.ts, src/renderer/api.ts, src/main/files.ts, tests/reader-storage.test.ts.
Interfaces: novel.workspaceSnapshot(projectId?, since?), novel.chapter(id), novel.chapterVersions(id), novel.search(projectId, query, offset?), novel.revisionJob(id).

- [x] Write failing transport tests proving unchanged poll returns no payload and a 5,000-chapter snapshot excludes content and versions.
- [x] Add safe migration with backup, persisted readingWorkspaces/revisionJobs, mutation generation and SQL projections.
- [x] Add trusted IPC and portable backup validation/remapping; old packages normalize new collections to empty.
- [x] Verify storage/backup tests, source snapshots and credential exclusion.

### Task 3: Reader and review UI

Files: src/renderer/reader.tsx, src/renderer/revisions.tsx, src/renderer/main.tsx, src/renderer/conversation.tsx, src/renderer/chapters.tsx, src/renderer/style.css, tests/e2e/reader.spec.ts.
Interfaces: Reader with state/projectId/run/flush/register/onRevisionRequest; hydrated chapter/history queries; scoped revision commands.

- [x] Add failing UI workflows for continuous reading, search jump, selected annotation, review marking and restart recovery.
- [x] Implement bounded directory rendering, bounded adjacent chapter cache, mode switch, typography and persistent position.
- [x] Connect explicit selection and chosen annotation targets to chat; render pending jobs, coverage and paragraph differences.
- [x] Run new and existing desktop tests at regular/minimum window sizes.

### Task 4: Safe conversational revision

Files: src/main/revision.ts, src/shared/revision.ts, src/main/services.ts, tests/revision.test.ts.
Interfaces: RevisionRunner(store, domain, provider, credentials, sync).start(command), command(command), get(id), dispose(); RevisionCommand and RevisionJob.

- [x] Write failing tests for selection-only replacement, stale sources, multi-chapter candidate generation, partial acceptance, budget/pause/restart and full-scope coverage.
- [x] Implement sequential bounded batches, usage reservation, durable checkpoints, linked material proposals and conflict-aware adoption.
- [x] Route explicitly scoped conversation revision requests into this runner; retain existing creation conversation behavior.
- [x] Verify targeted services, then full regression and independent integrated review.

### Task 5: Integrated acceptance

- [x] Run npm run typecheck, npm test, npm run e2e.
- [x] Inspect screenshots, verify 5,000 chapter transport size and interactions, measure results.
- [x] Document implemented behavior, actual model-validation boundary and build/package status.

## Execution rulings

The user has approved the full design and told us to start implementation. Execute continuously without another plan approval. Use the current feature branch because prerequisite changes are uncommitted here and a fresh HEAD worktree would omit them. Independent modules may be implemented concurrently with disjoint file ownership; integration and review remain sequential. No automatic commit of pre-existing work.
