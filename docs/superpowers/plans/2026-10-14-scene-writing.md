# 场景卡与定向修订 Implementation Plan

> **For agentic workers:** Use the already accepted native implementation method, task by task with TDD and one independent review at the end. Steps use checkbox syntax.

**Goal:** 交付可编辑、可恢复、有来源保护的章内场景计划及仅修改绑定片段的待审稿。

**Architecture:** scenePlans/sceneJobs独立SQLite表，受控按章查询；显式规划用持久单次任务，默认卡片复用生成响应。定向修订复用RevisionRunner，增加sceneSource并强制候选审阅。

**Tech Stack:** Electron、React、TypeScript、SQLite、ChatProvider、Vitest、Playwright。

**Spec:** `docs/scene-writing-design.md`。

## Global Constraints

- 仅第三阶段；2—4卡、每卡/总计划1—16000字、合计相等、历史最多50。
- 计划不作为事实；原文依据逐字校验，失效不自动使用，作者计划不被模型覆盖。
- 默认生成不额外调用；显式规划100000默认/1000000最大Token，单次4000输出、1次尝试，重启手动继续。
- 定向改稿进入待审，前缀后缀标题不变；重大方向变更暂停，无来源越权。
- v7迁移前备份、旧包归一化及引用重映射；不改生产作品、不发布、不付费模型验收。

## Review Focus

- 重复原文/来源修订/外国作品/隐藏空事实：Task1保存与导入测试。
- 规划期间编辑卡片/正文/状态及未知用量：Task2真实HTTP测试。
- 200和2500字、模型省略或破坏可选cards不丢正文：Task2写作测试及固定比较。
- 作者在修订后编辑卡片/源稿/状态，或重大方向变更：Task3复验拒绝旧稿且段外不变。
- 折叠重开/切章/重启脏编辑及导入任务不自动调用：Task4桌面与Task1/2包测试。

### Task 1: 场景卡、历史与v7作品包

**Files:** Create `src/shared/scenes.ts`, `src/main/scenes.ts`, `tests/scenes.test.ts`, `tests/scenes-files.test.ts`; Modify types/store/files/services及IPC/preload/API。

**Interfaces:** SceneCardDraft/SceneCard/ScenePlan/SceneJob/SceneCommand；SceneService.save(c):ScenePlan、restore(id,revision,historyRevision):ScenePlan、workspace(chapterId):SceneWorkspace、record(id):ScenePlan、capture(chapter,raw,sources,stamp):warnings。current(plan):boolean包括原文/来源/状态，query不传history；sceneStamp用于改稿。

- [x] 写行为测试：2/4卡合计、无卡/5卡/异作品/原文偏移拒绝，作者编辑历史恢复，源变需复核，v6备份、旧包、新ID和原子拒绝。
- [x] 跑目标确认失败，实现类型/服务及v7存储/包/接口，目标及全套通过后选择性提交。

### Task 2: 规划任务与连续写作

**Files:** Create `src/main/scene-writing.ts`, `tests/scene-writing.test.ts`; Modify main/writing、services和相关tests。

**Interfaces:** ScenePlanningRunner.start(c):ID、command(c):ID、dispose():Promise<void>；调用Task1 SceneService.save/capture/current。WritingRunner在input提供有效scenePlan，返回前校验计划版本；可选scenes只对新稿capture。

- [x] 写失败用例：计划成功/变更暂停、源/卡/状态并发保护、预算/未知用量/取消/重启/导入；同次生成含场景、不增加请求、错cards保留正文、作者计划不覆盖。
- [x] 实现预算预留与任务记录、来源保护及写作接入，目标+全套/typecheck通过后提交。

### Task 3: 定向改稿与作者采纳

**Files:** Modify shared/revision、main/revision、services/files；Test `tests/scene-revision.test.ts`。

**Interfaces:** scene.revise绑定planId/revision/cardId/text/tokenBudget，SceneService.revisionStart(c)返回RevisionCommand start带sceneSource {id,revision,cardId,storyStamp?}；RevisionRunner核对sceneSource，只拼接selection并保留标题，selection+sceneSource进入awaiting-author。

- [x] 写失败测试：目标/冲突/视角指令、段外与标题逐字不变、候选需采纳；卡片/正文/状态变更拒绝，重大变更零回写；导入引用复映射。
- [x] 实现入口、返回/恢复/采纳保护，跑相关+全套后提交。

### Task 4: 作者界面、比较基准与交付

**Files:** Create `src/renderer/scenes.tsx`, `tests/e2e/scenes.spec.ts`, `scripts/benchmark-scenes.mjs`, `docs/scene-writing-verification.md`; Modify chapters.tsx、style.css、README、verification、roadmap。

**Interfaces:** 按需sceneWorkspace/scenePlan，使用manualGuard；绑定原文明确匹配位置；计划与候选通过Run命令；修订结果沿用Revisions显示。

- [x] 先桌面失败用例：规划/编辑/历史、选段修订待审、源变、未保存导航、预算重启续跑及窄屏。
- [x] 实现折叠界面，固定200及2500字比较协议/预算/采纳指标；npm test/typecheck/build、完整Playwright及召回基准。
- [x] 一次独立审查，重要问题红绿统一修复，再全量复验；同步文档、选择性提交/本地集成与主目录复验。

## 授权与自检

用户已接受全量路线图并继续第三阶段，沿用原生实施＋末尾独立审查，无需重问执行方式。隔离工作区 `codex/novel-scene-writing`，初始489项服务通过，保留主目录tutorial-video。各任务接口一致；Task1存储供Task2/3，Task3选段候选供Task4，范围与上述Spec逐项覆盖。

## 执行结果

2026-10-14：实现及开发验收完成，526项服务、类型/构建、50项完整Electron及两组基准通过。一次独立审查4项Important统一红绿修复，无Critical或Minor；原生实施方式保留。真实模型文学质量、采纳率和账单比较尚未执行，不据fixture作提升结论。证据见 `docs/scene-writing-verification.md`。
