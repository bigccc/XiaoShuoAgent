# 连续写作 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让“写完前五章”成为可持续推进、可恢复、有预算和质量结果的写作任务。

**Architecture:** LangGraph JS 在主进程组织任务节点，应用 SQLite 保存权威进度，节点通过受控业务接口读写章节。已有章节只产生待审改稿，新章节自动落稿并保留历史。

**Tech Stack:** Electron / TypeScript / React / node:sqlite / LangGraph JS / Vitest / Playwright。

**Spec:** `docs/continuous-writing-design.md`

## Global Constraints

- 保留当前工作区全部既有改动；不自动提交、推送或替换安装应用。
- 最多两轮自动修订；重大创作变更和影响后文的未解决冲突暂停。
- 已有非空正文修改先待审；新稿落库和步骤推进必须原子化。
- 默认任务预算100000 Token，覆盖所有调用与重试；未知用量保留预留值。
- 重启不自动调用模型，继续任务不清零用量、不重复创建章节。
- 资料、原文与模型回复不是操作指令；严格限定作品和章节范围。

## Review Focus

- 写完前五章/帮我把前五章写完/接着写五章的范围不同，否定句不能误触发（任务1）。
- 写入后重启不能重复创建章节或版本，已付费用量不能丢失（任务2）。
- 已有章节改稿候选不能直接覆盖正文，手改后旧结果不能被采纳（任务2）。
- 两轮后硬冲突暂停，软问题继续但不宣称检查全部通过（任务2）。
- 备份导入重映射任务引用，不携带密钥、不自动续跑；轮询不搬运长正文（任务1、3）。

### Task 1: 任务契约与持久化

**Files:** `src/shared/writing.ts`（新增）、`src/shared/types.ts`、`src/main/store.ts`、`src/main/files.ts`，必要的对话状态扩展；`tests/writing-storage.test.ts`（新增）。

**Interfaces:** 定义 WritingGoal、WritingProgress、WritingIssue、WritingCommand；提供 `detectWritingGoal(text: string, lastOrdinal: number): WritingGoal | null` 和持久任务验证。节点状态中只保存有界计划、进度、原文引用和候选引用。

- [x] 添加范围语义、旧记录兼容、状态恢复和导入引用的失败测试并观察失败。
- [x] 实现并验证共享契约、存储/投影及备份校验。
- [x] 运行针对性测试、记录结果；不提交既有工作。

### Task 2: 有界连续写作执行器

**Files:** `src/main/writing.ts`、`src/main/writing-check.ts`（新增）、`src/main/services.ts`、`package.json`、`package-lock.json`；`tests/writing.test.ts`（新增）。

**Interfaces:** `WritingRunner.start` 返回任务ID；`command` 支持暂停、取消、继续；`dispose` 取消调用并保留进度。AppServices 在明确连续写作目标时分流，其余对话和显式改稿保持原语义。

- [x] 用真实AppServices/SQLite/HTTP fixture 先复现多章执行、已有正文保护、预算和恢复失败。
- [x] 锁定LangGraph/core/zod版本，构建StateGraph规划/逐章生成/检查/有限修订/跨章复核节点。
- [x] 实现共享调用账本、版本校验、幂等落稿和暂停原因；复用来源证据校验和现有待审稿。
- [x] 覆盖两轮修订边界、软硬问题、空响应、超限、取消、手改和退出后续跑。
- [x] 运行针对性测试并记录结果。

### Task 3: 对话中的任务进度与控制

**Files:** `src/renderer/writing-progress.tsx`（新增）、`src/renderer/conversation.tsx`、`src/renderer/style.css`，必要的IPC声明；`tests/e2e/writing.spec.ts`（新增）。

**Interfaces:** 读取精简任务状态，调用 WritingCommand；使用现有正文和待审稿界面查看产物。

- [x] 添加Electron用例：一句话启动、逐章保存、状态可见、暂停/继续、预算不足和待审入口。
- [x] 实现目标范围/进度/质量状态/预算控制；不会将软问题或未检查状态显示成全部完成。
- [x] 验证最小窗口布局与重启后进度；修复发现的问题。

### Task 4: 整体验证与交付记录

**Files:** `docs/continuous-writing-verification.md`（新增）、`README.md`。

- [x] 运行 `npm run typecheck`、`npm test`、`npm run e2e`。
- [x] 独立审查本轮增量，修复影响需求或数据正确性的问题。
- [x] 验证构建中LangGraph依赖可加载；真实模型与安装包验证如未执行必须单独标明。
- [x] 更新使用说明、具体通过项及剩余限制，交付文件链接。

## 执行记录

- 用户已确认设计建议并要求继续；采用本会话实现，独立子代理负责可并行部分和最终审查。
- 改造前基线：2026-10-12 `npm test` 15文件284项通过；`npm run typecheck`通过。

- 已完成实现与独立审查修复：最终430项单测、38项开发版桌面回归、5项DMG安装副本回归。真实模型已保存并检查五章，其中两章篇幅仍待作者处理；并非全面质量通过。详见 `docs/continuous-writing-verification.md`。
