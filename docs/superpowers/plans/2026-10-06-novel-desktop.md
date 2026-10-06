# Novel Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver an installable Chinese macOS writing application implementing the accepted novel workflow, reliable local content, model tasks, materials and portable exports.

**Architecture:** Electron main process owns SQLite, files, credentials and asynchronous model tasks. A typed, validated IPC bridge exposes operations to a React renderer. Domain operations persist atomically and preserve content provenance and versions.

**Tech Stack:** Electron, React, TypeScript, electron-vite, Electron Forge, built-in node:sqlite, Vitest, Playwright Electron, fflate, fast-xml-parser, explicit typed runtime validation. Resolve current compatible package versions at installation and lock them. Node 22.13+ development runtime; use a current Electron with node:sqlite and verify inside packaged runtime.

**Spec:** docs/product-spec.md; domain vocabulary: CONTEXT.md.

## Global Constraints

- macOS arm64 and x64 packages; users need no development environment. Actual installation and signature verification are separate evidence.
- Chinese UI, local works, per-user API keys; no demo AI text or silent simulated successes in production.
- Draft is never implicitly confirmed. Confirmed text is not overwritten by setting or model changes; revisions and restore remain available.
- Explicit batches of 3—5 chapters, temporary network errors at most two retries, missing provider usage is unknown rather than zero.
- Automatic local save, 15-minute recovery snapshots retaining 20, manual export never automatically deleted.
- TXT and DOCX materials and exports; full project backup excludes secrets and imports as a copy.
- Tests use real domain/SQLite and local HTTP fixtures at provider boundary. No paid/provider calls without supplied config. Do not inspect other projects for API secrets.

## Review Focus

1. Rapid edit then navigate/reload must preserve final content; failed save must stay visible and retain editable text (Task 3).
2. Model completes while chapter/setting changed: preserve edits and mark generated candidate stale, never overwrite (Tasks 1, 2).
3. Interrupted SSE/retry must preserve fragments, avoid duplicate chapter and charge missing usage conservatively (Task 2).
4. Malformed backup/AI JSON must fail atomically with helpful error; exclude credential fields (Tasks 1, 2).
5. Confirm/rewrite/restore upstream text must invalidate downstream context while preserving confirmed versions (Task 1).

### Task 1: Typed contracts and durable domain

**Files:** package.json/lock, tsconfig*, vitest.config.ts, src/shared/types.ts, src/shared/validation.ts, src/main/store.ts, src/main/domain.ts, tests/domain.test.ts, tests/store.test.ts.

**Interfaces:** Define and export AppState, Project, Chapter, ChapterVersion, Note, Material, ModelProfile, TaskRecord, CheckIssue, Command and CommandResult. IDs are strings, timestamps ISO, revision counters for optimistic concurrency. Project fields include title/background/genre/style/pace/targetWords/chapterWords; notes typed character/world/location/storyline/outline/chapterOutline; chapter includes ordinal/title/content/status(draft|confirmed)/needsReview/revision/style/pace; version retains original content and reason. Material includes expression|plot, source, content, explanation, approved and project references. Provider profiles have id/name/baseUrl/model/purpose and masked hasKey in snapshots, never secret. Task records preserve request snapshot, result/partial, status/usage/calls/source revisions.

Produce `Store` backed by node:sqlite, `DomainService` exposing `snapshot(): AppState` and `execute(command: Command): CommandResult` synchronously. Commands cover project.create/update/archive, note.save/delete, chapter.create/save/confirm/restore, material.save/delete/link, profile.save/delete, issue.resolve, task metadata persistence through explicit Store methods. `save` expects prior revision; conflict fails instead of overwriting. AI writes use separate method creating candidate/version without replacing confirmed/current edited content. Define exact shared command union and document how Task 2 uses it in report.

- [x] Add configuration and tests first; verify empty title, stale revision and nonexisting project mutations fail, real SQLite persists through reopen, restore preserves both histories, setting change invalidates later drafts and confirmed content unchanged.
- [x] Implement schema/versioned initialization and transactional domain changes. All renderer inputs use shared validation; user-visible error messages in Chinese. User data not stored in checkout. Back up prior DB before schema migration, no migration destructive fallback.
- [x] Implement domain commands and content/version provenance. General notes suffice for settings but title/type/body/source references must be explicit; keep normal editing separate from confirmation.
- [x] Run `npm test` and `npm run typecheck` with zero failures, self-review and commit only scoped files. Record actual RED and GREEN in report.

### Task 2: AI orchestration, materials and portable files

**Files:** src/main/provider.ts, context.ts, tasks.ts, files.ts, services.ts; tests/provider.test.ts, tasks.test.ts, files.test.ts. May extend shared contracts and Store carefully.

**Interfaces:** Consume Task 1 types and domain. Produce `AppServices` containing domain and `dispatch(command: Command): Promise<CommandResult>` for use by IPC; `snapshot(): AppState`; `dispose()`. Inject dataDir, credential encryption codec, file-dialog adapter (choose open/save path), and optional fetch for tests. Publish exact constructor/options in report. Async commands: model.test, ai.plan (step/type+instruction), ai.chapter (chapter IDs+explicit draft authorization+token budget), ai.check, ai.extract (source text or chosen file); task.cancel/resume; file.importMaterial/exportText/exportDocx/backup/importBackup. UI can poll state every 1 second. Never expose filesystem paths/arbitrary IPC to renderer.

- [x] Write and watch tests fail: local HTTP compatible-chat response/SSE stream fragmentation/error retries; user cancels during output; context excludes unrelated unconfirmed draft; edited source after request never overwritten; backup roundtrip and tamper rejection; DOCX Chinese text extraction roundtrip; private profile keys excluded.
- [x] Implement chat-completions-compatible adapter with URL validation, bounded request timeout, stream parser (including usage), abort, transient-only max two retries, no automatic retry after content emitted; preserve partial. Tokens tracked as provider-reported or estimated/unknown, don't pretend exact currency limit. Enforce remaining budget before calls and cap max output.
- [x] Implement planning suggestions saved to task result for user acceptance; chapter generation candidates, explicit draft context, 3—5 batch continuation with per-chapter checks and pause; consistency check structured evidence against stored source IDs/content (invalid JSON = error not silent empty result); material extraction with review before approval. Author must apply suggestions explicitly. Keep prompt sizes bounded with referenced context and truncation disclosure.
- [x] Implement encrypted credentials through injected codec, masked snapshots, no secret logs/backups; text and DOCX parsing (limit size), well-formed TXT/DOCX export, SHA256 versioned project backup validated before import-as-copy, ID/provenance remapping and cited material snapshots. Automatic periodic coherent recovery snapshots, mark running tasks interrupted at startup.
- [x] Run focused tests then `npm test`/typecheck, self-review and scoped commit. Report limitations honestly; no provider credential is available so local HTTP fixture is not live provider proof.

### Task 3: Desktop shell, full writing UI and packaged verification

**Files:** src/main/index.ts, src/preload/index.ts, src/renderer/**/*, electron.vite.config.ts, forge.config.*, scripts/*, tests/e2e/*, README.md, docs/verification.md. Update package.json scripts and dependency lock as needed.

**Interfaces:** Consume AppServices via preload `window.novel.invoke(command)` and `window.novel.snapshot()`, expose only typed operations. Electron main validates sender and input, uses safeStorage, native dialogs and userData dir. App-specific --user-data-dir test override permitted via explicit dev/test env; never replace real user data.

- [x] Add behavioral Electron E2E first: create project, edit and navigate immediately, reopen SQLite, create notes/chapters/versions, confirm, restore, export; credentials/config/error state; mock provider fixture for actual app task pipeline. Run failing tests before feature implementation.
- [x] Build polished Chinese desktop UI: warm paper/ink aesthetic, restrained teal accent, generous readable chapter editor, macOS window chrome. No fake seeded works. Empty bookcase clearly offers new work and import backup; onboarding guides API config. Left work navigation, central editor, context/suggestion side pane, compact stats and save indicator. Full title/background/style fields; structured settings and outlines; ordered chapters and word count; task result review/apply, history compare/restore, six checks and resolution; materials import/extract/edit/approve/select references; role-specific model profiles/test; task budget/batch/explicit draft inclusion/cancel/resume/rewrite. Errors visible, loading and empty states deliberate, keyboard focus and labelled controls.
- [x] Bind all operations to real service; auto-save serialized/debounced with flush before navigation/closing and conflict feedback. Protect unsaved edit state from polling. AI result acceptance cannot bypass revision/confirmation protections.
- [x] Add Forge packaging for arm64/x64 .app, ZIP and DMG where supported; environment-driven optional signing/notarization, no embedded credentials. Add safe non-destructive app shutdown and file handlers. Build, run Electron E2E, capture UI screenshots and personally inspect. Package current arch and x64; record actual build/runtime/platform limitations separately. Current host arm64; do not label x64 executed unless actually tested.
- [x] Write README with development/start/build/test and user install/model/config/backup guidance; verification matrix including unrun live model, twenty chapters, x64 installation and signing. Run full test/typecheck/build and tests with actual packaged runtime when possible; scoped commit and report.

## Completion

- [x] Fresh final review across entire codebase; fix important correctness gaps with covering tests.
- [x] Verify user-visible app and output artifacts; record file paths and concrete limitations. No push, public release or Apple credential changes as part of local development.

## Execution result

Completed local implementation and independent task/whole-branch reviews at code commit `46db508`; final fix scoped re-review approved. Verified 77 service tests, 14 development Electron workflows, 13 packaged arm64 workflows (1 development-only bootstrap skipped). Final x64 package passed Rosetta offline create/edit/confirm/persistence smoke. Current artifacts, checksums, implementation choices and unperformed external acceptance are recorded in `docs/verification.md`.
