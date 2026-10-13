# 质量基线与远章召回 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加作者配置的条件下，为对话和连续写作召回版本化远章原文，并提供可重复的质量基线。

**Architecture:** 在主进程当前快照上做有界的关键词/名称召回，复用原有上下文、来源校验与SQLite任务持久化。可选引用字段向后兼容v5作品包；渲染器仅展示实际注入的片段。

**Tech Stack:** TypeScript、Intl.Segmenter、React、Electron、SQLite、Vitest、Playwright、Vite。

**Spec:** `docs/context-recall-design.md`；全量后续计划为 `docs/optimization-roadmap.md`。

## Global Constraints

- 用户本轮选择全量计划、仅实施第一阶段。
- 保留三步主流程、版本保护、待审稿、重启手动继续及预算语义。
- 最多6个远章、每片段480字符、24词条；仅同作品、当前章之前、已确认且无需复核的正文。
- 实际提示词有界；引用片段不是完整读章或改章授权。
- 不新增数据库服务、向量模型或付费模型请求；不替换安装应用、不发布。

## Review Focus

- 当前章之前的范围，尤其回改早章与多章任务的未来信息：Task2/3服务测试。
- 前章编辑、删除、版本恢复和来源切换：Task1/3/4测试。
- 长章、大资料造成预算不足：Task2/3完整目标保护与实际引用测试。
- 旧任务、作品包和恶意跨作品引用：Task4兼容性与导入验证测试。
- 重启和轮询体积，以及引用内容与真实模型输入一致：Task3/4/5测试。

---

### Task 1: 召回核心与固定基准

**Files:** Create `src/shared/recall.ts`, `src/main/recall.ts`, `tests/recall.test.ts`, `tests/fixtures/recall-cases.ts`, `scripts/benchmark-recall.mjs`; Modify `package.json`.

**Interfaces:** `RecallReference` 为 `{source: SourceRevision & {kind:"chapter"}, ordinal, title, start, end, excerpt, matchedTerms:string[]}`；`RecallOptions` 为 `{query:string,beforeOrdinal:number,excludeChapterIds?:string[]}`；`recallPassages(state:AppState,projectId:string,options:RecallOptions):RecallReference[]`。

- [ ] 先写失败用例：第8章钥匙到120章召回，原文偏移逐字一致；草稿、未来、他书、needsReview不命中；名称/别名；空/泛操作无词不召回；源改后取新版。
- [ ] 运行 `npm test -- tests/recall.test.ts`，确认在空实现上因缺失行为失败。
- [ ] 实现有界查询、单章最佳片段与稳定排序，补固定样本和`npm run benchmark:recall`，报告baseline与recall的实际差别和5000章耗时。
- [ ] 运行目标测试与 `npm test`，记录基准。选择性提交本任务文件。

### Task 2: 上下文片段与全文保护

**Files:** Modify `src/main/context.ts`, `tests/context.test.ts`。

**Interfaces:** `ContextDocument` 增加 `reference?:RecallReference` 与 `required?:boolean`。`buildContext` 可接第8参数 `recall?:RecallOptions`；`boundContext` 保留required全文（超限时披露而不假称完整），引用片段只在余量中加入，返回的reference与text一致。

- [ ] 写失败用例：新增引用的sources进入保护；既有required完整目标优先；预算不足时引用不记录为已读；无recall参数保持旧行为。
- [ ] 运行 `npm test -- tests/context.test.ts` 验证失败，接入Task1接口并使其通过。
- [ ] 运行 `npm test`，选择性提交。

### Task 3: 对话与连续写作实际接入

**Files:** Modify `src/main/conversation.ts`, `src/main/writing.ts`, `src/shared/types.ts`, `src/shared/conversation.ts`, `src/shared/writing.ts`, `tests/conversation.test.ts`, `tests/writing.test.ts`。

**Interfaces:** ConversationTurn/WritingJob 增加可选 `contextReferences?:RecallReference[]`，共享 `validateRecallReferences(value:unknown):void` 在两种记录校验中调用。旧记录无该字段有效。

- [ ] 写真实SQLite/HTTP失败用例：旧章片段进入发送给模型的上下文，保存相同出处；早章参考不含后章；旧章片段不取得整章覆盖权限；模型返回前旧章修订后拒绝陈旧结果。
- [ ] 运行上述相关用例确认失败，接入召回与记录；连续任务生成/单章检查使用相同查询来源，required目标不能截断改稿。
- [ ] 执行相关测试、类型检查与`npm test`，选择性提交。

### Task 4: 引用可见、恢复与作品包

**Files:** Create `src/renderer/context-references.tsx`; Modify `src/renderer/conversation.tsx`, `src/renderer/writing-progress.tsx`, `src/main/files.ts`; Test `tests/recall-storage.test.ts`, `tests/e2e/recall.spec.ts`。

**Interfaces:** `ContextReferences({references,chapters})` 基于章节ID/revision判别当前/已改变/已移除，只显示已有快照的片段，不拉全书正文；沿用作品包nested引用重映射。

- [ ] 写失败用例：重启保留、导入副本引用重新映射、跨作品引用拒绝、已删除来源仍可备份；桌面折叠出处和源更改提示。
- [ ] 运行失败用例，补包校验与组件；不新增强制步骤。
- [ ] 执行单测、构建、桌面召回用例与既有作者流程，选择性提交。

### Task 5: 完整复验、独立审查与交付记录

**Files:** Update `README.md`, `docs/verification.md`, this plan; Create `docs/context-recall-verification.md`, `docs/research/2026-10-13-recall-benchmark.json`。

**Interfaces:** `npm run benchmark:recall` stdout 为机器可读JSON；验证记录分别列基准、自动化、界面和未做的真实模型/安装验证。

- [ ] 跑 `npm test`、`npm run typecheck`、`npm run build`、完整桌面回归、基准，检查退出码与结果。
- [ ] 请求一次只读独立代码审查，重点为上述Review Focus；重要问题先复现再修复，补全套复验。
- [ ] 核对所有Task与Spec交付，选择性提交并将完成记录写入文档；后续阶段保持明确未实施。

## 执行记录

采用当前会话原生实施，末尾一次独立审查；用户已明确本轮实施范围，无需再次确认。当前目录435项测试的基线在隔离工作区重跑通过；Homebrew默认Node因缺失simdjson无法启动，执行命令使用已安装Node v22.22.1，未修改系统运行时。
