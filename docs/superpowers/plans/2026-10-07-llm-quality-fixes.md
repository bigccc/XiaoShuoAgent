# 真实 LLM 质量问题修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复已记录的一致性误报、漏报、无关引用和字数偏离，保留作者控制和调用预算。
**Architecture:** 强化检查任务的矛盾与证据契约，非空疑点增加一次有预算的复核；生成任务明确记录本次字数，计数后最多修订两次，保留两个候选版本。旧任务和作品包继续可读。
**Tech Stack:** TypeScript、Electron、SQLite、React、Vitest、Playwright。
**Spec:** `docs/deepseek-live-acceptance.md` 的四项未通过质量记录及 `docs/product-spec.md` 的作者控制、预算、版本与恢复要求。

## Global Constraints

- 密钥只经现有 protected storage 使用，不写入代码、报告或作品包。
- 不降低逐字引文与来源版本校验，不自动替换或确认作者正文。
- 修订和复核均进入调用计数、预算及取消／恢复流程。
- 旧已保存任务不回写成新协议；当前工作区上一轮改动完整保留。

## Review Focus

- 模型将通过意见当成issues：必须经复核移除，并披露初检和复核差异。
- 真实冲突被误删：用干净样例和年龄／物体状态冲突成对验证。
- 字数修订被取消：原候选版本和修订片段必须都保留，续跑不能重复无限修订。
- 字数预算不足：保留原候选，暂停提示；不扩大预算。
- 重启／导入旧任务：新字段可选且严格校验，导入版本来源仍可验证。

## Task 1: 一致性检查与证据复核

**Files:** 新建 `src/main/quality.ts`；修改 `src/main/tasks.ts`；测试 `tests/tasks.test.ts`。
**Interfaces:** `consistencyInstruction` 和 `reviewInstruction` 返回生产检查提示，最终结果继续使用原 `ParsedCheck` 结构。

- [x] 加入真实loopback服务测试：初检通过项被复核移除；真实冲突保留双方相关引文；复核输出伪造原文必须失败；复核预算不足不能算通过。
- [x] 先运行对应测试并确认RED。
- [x] 实现提示契约、独立原文复核（包括初检空结果）及差异披露；初检为空时同样执行复核。
- [x] 运行任务与完整服务测试，确认GREEN。

## Task 2: 有限字数修订

**Files:** 修改 `src/shared/types.ts`、`src/shared/validation.ts`、`src/main/tasks.ts`、`src/renderer/tasks.tsx`；新建 `src/shared/prose.ts`；测试 `tests/tasks.test.ts`。
**Interfaces:** `ai.chapter.chapterWords?: number`、`countProse(text): number`；候选可选 `lengthAttempts: 1 | 2`，任务阶段新增 `length`。旧命令缺省按旧策略，当前界面明确传字数。

- [x] 加入超长修订一次、修订仍不达标暂停、原候选版本不丢、修订取消／重启继续及旧记录校验测试；先确认RED。
- [x] 增加本次章节字数控件、正文计数（不含标题／空白），使用±20%范围，超出最多修订两次；继续作者审阅仍不自动确认。
- [x] 运行类型检查、服务及Electron界面回归。

## Task 3: 真实复验与交付

- [x] 使用当前已保存DeepSeek配置，真实检查原干净三章、年龄冲突及信纸状态矛盾；重复关键样例，逐项阅读引文。
- [x] 用250字目标真实生成三章，验证计数、作者草稿、任务与候选版本。
- [x] 重新构建两架构安装包；验收当前arm64包并检查包完整性。
- [x] 保存新证据与限制，更新验收记录；不以有限样本宣称LLM永不误报漏报。

执行：本会话直接执行已授权修复；不另开用户聊天，不提交或推送Git。

复验促成的调整：Pro非思考仍不稳定，最终检查开启低强度思考、每次最多8000输出Token并要求至少4000可用预算；唯一空白差异还原为实际原文，歧义与改写仍拒绝；两次字数修订应对198字这类轻微未达标。原复杂样例的推断性疑点和截断失败在最终记录中保留。
