# Authoring Sync Implementation Plan

**Goal:** Implement the approved three-stage, bidirectional, free-text sync design.

**Spec:** `docs/authoring-sync-design.md` and the user's full approved plan.

**Architecture:** Shared binding/job/batch DTOs, deterministic projection and validated line-based normalization; central StageSyncService owns transactional changes, scheduler, barrier and reverse projection. Existing conversation generation submits bundles to the same service. SQLite/portable packages upgrade to v3. Existing dirty authoring implementation is the working baseline.

## Tasks

- [x] Shared contract and core sync service, test-first: generation/normalization, stable identity, concurrency, histories/archives, reverse updates, scheduling and barriers.
- [x] Persistence/portable compatibility, delegated: Store v3 pre-backup, syncJobs/syncBatches, v1/v2 import normalization, v3 strict references and remapping; preserve existing QA fixes.
- [x] UI, delegated after contract: statuses, summary, retry/cancel/conflict choices, history restore, archive access; Electron flow regression.
- [x] Integrate conversation and auxiliary commands/AI barriers; no duplicated commits or synchronization echo.
- [x] Independent reviews, final typecheck/service/Electron suites, bounded live isolated provider check when feasible, final arm64 package/install verification.
- [x] Documentation, selective commit preserving unrelated changes, delivery artifact and evidence.

## Implementation rulings

- Remain in current feature checkout as in prior phases; do not lose the existing uncommitted base.
- One implementation subagent at a time per SDD skill; root implements the tightly coupled sync core while the delegate owns disjoint persistence files, then UI.
- Blocks reference project fields or stable noteIds. Plain content compatibility uses explicit source-line ownership; unclassified content is retained, not invented.
- A canceled/failed sync never advances stages. Auto scheduling is 5 seconds after latest local edit; new application startup keeps unresolved work visible and requires retry/continue.

Verified 2026-10-11: typecheck and 214 full-workspace service tests; developer Electron 28; final DMG installed copy 27 passed / 1 existing dev-only skip; real DeepSeek three stages + two-way edits + v3 roundtrip passed. Selective staged snapshot typecheck + 168 service tests green. See docs/verification.md for delivery/hash and retained-baseline boundaries.
