# 简化写作 Implementation Plan

> **For agentic workers:** Execute task-by-task in this session. User has already confirmed the design and authorized implementation; do not add another approval round.

**Goal:** 用户只给章数、字数与要求，系统自动写作、检查、修正与维护资料。

**Architecture:** WritingRunner 继续负责持久化任务与保护作者正文；新增共享写作策略统一自动预算与字数范围。保留旧显式预算调用，默认 UI 使用自动预算；辅助资料按可追溯来源加入后续上下文，完成状态与建议分离。

**Tech Stack:** TypeScript、React、Electron、SQLite、Vitest、Playwright。

**Spec:** `docs/simple-writing-design.md`

## Global Constraints

- 字数 ±10%；保持有限重试、取消、恢复、来源及版本检查。
- 不覆盖已有/作者编辑正文；自动资料不得伪称作者确认。
- 在当前未提交改动上增量修改，不回退已有文件。

## Review Focus

- 较长前文与多章任务：自动预算应覆盖不同任务规模，异常续跑不清零已用额度。
- 文风建议反复出现：不自动来回重写、不把建议显示为失败。
- 作者中途编辑：保留作者内容，采纳前检查来源版本。
- 自动状态跨批次使用：来源过期/删除/拒绝后不能复活旧状态。
- 旧保存任务：显式额度仍受限，备份及恢复校验保持兼容。

### Task 1: 自动预算、字数与完成标准

Files: `src/shared/writing.ts`, `src/shared/writing-policy.ts`, `src/main/writing.ts`, `src/main/services.ts`, `tests/writing.test.ts`, `tests/writing-policy.test.ts`.

- [x] 添加并运行失败用例：无 Token 的任务、多章预算、±10% 修订、局部建议完成、异常恢复。
- [x] 实现 `estimateWritingBudget(chapterCount, targetWords, contextChars)`、`writingWordRange(target)`；主进程保存任务目标与自动预算模式，续跑重新估算剩余工作。
- [x] 仅事实问题/篇幅需要自动修正；局部建议不使任务进入作者决策状态。
- [x] 运行服务测试与类型检查。

### Task 2: 自动辅助资料

Files: `src/main/story-context.ts`, `src/main/story-state.ts`, `src/main/writing.ts`, `src/renderer/story-state.tsx`, `tests/story-state.test.ts`, `tests/writing.test.ts`.

- [x] 添加并运行失败用例：完成批次的来源可供下批引用；过期来源、拒绝记录不能使用。
- [x] 以来源校验后的自动参考参与状态选择，保留作者确认优先与当前任务临时状态，不伪造确认。
- [x] 更新辅助资料文案与状态；验证原文改动失效与已有手动确认链。

### Task 3: 简化界面与可执行处理

Files: `src/renderer/conversation.tsx`, `src/renderer/writing-progress.tsx`, `src/renderer/main.tsx`, `src/renderer/tasks.tsx`, `src/renderer/revisions.tsx`, `tests/e2e/writing.spec.ts`, `tests/e2e/writing-notices.spec.ts`.

- [x] 通过真实 IPC 添加桌面用例：不填 Token/不选模式即可写作，建议不阻断，异常一键继续，已有正文可在当前流程看差异并采用。
- [x] 主入口只显示章数、字数、额外要求；旧入口归为专业工具并指向统一写作入口。
- [x] 状态聚焦成稿、当前进度或一个需决定事项；展开即可看依据、差异，技术设置收起。
- [x] 运行有影响的 Electron 套件并检查截图。

### Task 4: 整体验证与交付记录

- [x] 运行 `npm run typecheck`、`npm test`、`npm run build` 与相关 Electron 回归。
- [x] 检查本轮增量 diff，记录与未修改代码的边界、实际验证结果。

验证结果见 `docs/simple-writing-verification-20261017.md`。实现中的参考资料资格与续跑边界经只读审查修正；没有进行 Git 提交、安装替换或真实模型调用。
