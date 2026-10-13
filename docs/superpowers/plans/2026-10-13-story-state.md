# 故事状态与伏笔 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可提取、审阅、确认、追溯和复核的故事状态及伏笔记录。

**Architecture:** 独立SQLite记录与提取任务，按来源版本派生状态投影；受控IPC分页查询，创作仅注入有证据的稳定事实或同批临时状态。数据库/作品包v6迁移备份及旧包归一化同步交付。

**Tech Stack:** Electron、React、TypeScript、SQLite、ChatProvider、Vitest、Playwright。

**Spec:** `docs/story-state-design.md`，前序 `docs/optimization-roadmap.md`。

## Global Constraints

- 只实施第二阶段；保留三步主流程、稿件版本与待审机制。
- candidate/confirmed/rejected与叙述性质分开；草稿不能成为稳定事实。
- 证据最多4处、每处4000字符；需复核记录不可自动回退成旧状态；恢复需再确认。
- 提取20章/16000字符段/300重叠，100000默认Token、1000000最大；重启手动继续，不隐藏加费。
- 新v6迁移前备份；旧包兼容、引用与身份重映射；不改生产作品、不发布或替换安装应用。

## Review Focus

- 同章多次正常取放和回忆/猜测/谎言：Task1状态投影测试。
- 作者改正文/实体/状态与模型并发、恢复旧版本：Task1/4来源及状态摘要测试。
- 伏笔planned不当作埋设，resolved两边证据失效：Task1/5测试。
- v5迁移失败保护、恶意跨作品/伪造原文与导入历史：Task1/2真实SQLite与包测试。
- 超长章、输出格式、未知用量、取消、重启与轮询体积：Task3/5服务和桌面测试。

---

### Task 1: 记录、证据、状态投影与迁移

**Files:** Create `src/shared/story-state.ts`, `src/main/story-state.ts`, `src/main/story-context.ts`, `tests/story-state.test.ts`; Modify `src/shared/types.ts`, `src/main/store.ts`。

**Interfaces:** `StoryRecord`/`StoryEntry`/`StoryEvidence`/`StoryProposal`/`StoryExtractionJob`；`StoryStateService.command(StoryCommand):CommandResult`、`capture(projectId,chapter,proposals,origin):{ids,warnings}`、`workspace(query):StoryWorkspace`、`record(id):StoryRecord`。`storyContext(state,beforeOrdinal,writingJobId?):{documents,stamp}`与`storyStampCurrent(state,stamp):boolean`。

- [x] 写失败测试：正常转交、候选/回忆不覆盖现在、最新事实失效不回退、源/实体变化、伏笔双证据、恢复/拒绝、跨作品与伪造位置、v5备份迁移。
- [x] 跑 `npm test -- tests/story-state.test.ts` 确认行为失败，再实现记录/校验、投影、版本历史、v6新表与按需查询。
- [x] 跑目标测试、类型检查与全套；选择性提交。

### Task 2: 作品包、恢复和受控接口

**Files:** Modify `src/main/files.ts`, `src/main/services.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/api.ts`; Create `tests/story-state-files.test.ts`。

**Interfaces:** AppState可选storyRecords/storyJobs；IPC `storyWorkspace(query)` / `storyRecord(id)`。Command包含StoryCommand与StoryJobCommand，现有服务捕获错误并保持域边界。

- [x] 写包/恢复失败测试：v5归一化、记录/历史/任务ID重映射、跨作品证据拒绝、当前原文哈希/偏移校验、模型ID剔除、删除历史来源可恢复。
- [x] 修正v6文件与服务接口；轮询只保留故事任务进度，记录及历史由页面按需获取。
- [x] 跑目标与全套回归，选择性提交。

### Task 3: 持久化提取任务

**Files:** Create `src/main/story-extraction.ts`, `tests/story-extraction.test.ts`; Modify `src/main/services.ts`, `src/shared/story-state.ts`。

**Interfaces:** `StoryExtractionRunner.start(StoryJobStart):ID`, `command(StoryJobCommand):ID`, `dispose():Promise<void>`；调用Task1.capture，原文引用必须来自当前检查段。

- [x] 写真实HTTP失败用例：分段/重复去重、格式或假证据不采纳、共用预算、未知用量、取消/重启续跑、源变阻止旧候选。
- [x] 实现单请求无嵌套重试的有界任务；候选与步骤推进同事务，重启不自动调用。
- [x] 目标测试、全套和类型检查，选择性提交。

### Task 4: 连续写作候选与状态上下文

**Files:** Modify `src/main/writing.ts`, `src/main/context.ts`, `src/main/conversation.ts`; Test `tests/writing.test.ts`, `tests/context.test.ts`, `tests/conversation.test.ts`。

**Interfaces:** 可选`states:StoryProposal[]`仅生成状态候选；原文保存后capture，已有正文待审稿不提前产生事实。BuiltContext可选storyStamp；写作/对话返回前重新校验；临时状态只用于同任务此前章节。

- [x] 写失败用例：没有额外模型请求、错引用不破坏正文、候选仅同批使用、早章无未来状态、已确认状态并发改变拒绝旧回复。
- [x] 接入Task1接口并保持原文证据/预算/授权；复核上下文不能把合成状态值当作原文quote。
- [x] 跑相关测试与全套，选择性提交。

### Task 5: 作者界面、全量复验与交付

**Files:** Create `src/renderer/story-state.tsx`, `tests/e2e/story-state.spec.ts`, `docs/story-state-verification.md`; Modify `src/renderer/main.tsx`, `src/renderer/style.css`, `README.md`, `docs/verification.md`, `docs/optimization-roadmap.md`。

**Interfaces:** 页面使用分页workspace/详情接口；手动表单选择章/引用位置，沿用useManualGuard；来源定位到正文与版本。

- [x] 写桌面失败用例：记录建立、正文确认/候选采纳、来源变化、伏笔回收与历史、提取任务恢复及窄屏。
- [x] 实现页面并跑目标UI；跑 `npm test`、typecheck、build、完整Playwright和第一阶段召回基准。
- [x] 一次只读独立审查；重要问题先复现再修复，全套复验；明确真实模型/安装未验，选择性提交并同步到本地项目。

## 执行方式

沿用已接受的当前会话原生实施＋末尾独立审查，直接执行第二阶段授权，不再请求方案确认。开发在独立工作区，使用已安装Node v22.22.1；保留原目录 `tutorial-video/`。

## 执行结果

2026-10-14：第二阶段实施、一次独立审查与5项Important统一修复完成。489项服务测试、类型检查、构建、46项完整开发Electron桌面回归及第一阶段6/6召回基准通过。证据和边界见 `docs/story-state-verification.md`；真实模型与安装包未验，第三至六阶段待实施。
