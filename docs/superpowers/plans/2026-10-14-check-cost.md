# 检查与成本优化 Implementation Plan

**Goal:** 复用仍有效的完整检查窗口、局部重查、可靠去重及作者可控快速试写。
**Spec:** `docs/check-cost-design.md`。
**Execution:** 已授权原生实施、逐任务红绿测试、末尾一次独立审查；不重新征求已确定范围。
**Global Constraints:** 默认认真定稿；缓存非作者数据/不导出，256条/作品、512KB/条；来源/模型/规则/要求变化失效，初检与独立复核分开；失败/中断/重大变更不缓存；未知用量保留预留；无真实付费评测/安装/推送；保留tutorial-video。

## Review Focus

- Task1/2：相同文本不同版本/模型/规则/范围，陈旧来源或脏缓存不能命中；冷/热结果证据一致。
- Task2：多窗只重查依赖窗口；旧完成进度不能掩盖检查未覆盖；失败/预算/取消/并发不入缓存。
- Task2：相同证据顺序/理由变化可去重，不同类别/版本不可；作者处理状态保留。
- Task3：快速试写不得呈现“检查通过”；重启不调用、继续累计预算、手改稿保留。
- Task4：仅确定性协议/成本对照，真实质量缺测保留null；v8旧包兼容，缓存不随包走。

### Task 1: 有界持久缓存与证据身份
**Files:** Create main/check-cache.ts、tests/check-cache.test.ts；Modify main/store.ts。
**Interfaces:** CheckCache.key({projectId,context,profile,protocol,request}):string；get(projectId,key):string|undefined、put(projectId,key,raw):void、remove；issueIdentity(issue):string。Store.getCheckCache/putCheckCache/deleteCheckCache为独立派生表接口。
- [x] 写失败测试：精确键隔离、原文/版本/规则/模型/要求失效、256条边界、重启、坏条目、按证据集合去重。
- [x] 实现并运行目标回归、类型检查及提交。

### Task 2: 检查流程复用、局部重查与用量
**Files:** Modify main/tasks.ts、main/writing.ts、shared/validation.ts、shared/writing.ts；Create tests/check-cost.test.ts。
**Interfaces:** TaskResult与WritingJob可选checkCacheHits/checkCacheMisses整数；完整窗口查找/解析/来源检查/记录；旧任务默认0。Store.saveIssue只对新增疑点按issueIdentity查已有，不改变作者状态。
- [x] 真实HTTP失败测试：相同请求2→0、改变来源/模型/要求、后窗变化保留前窗命中、取消/失败/并发不缓存、未知用量预算预留及重启、包导入缓存为空。
- [x] 接入Task初检+独立复核组合及Writing逐章/跨章各自协议；缓存再次解析证据，依赖检查贯穿返回；疑点集合去重；目标+全部服务/types通过提交。

### Task 3: 作者控制的快速试写与界面
**Files:** Modify shared/writing.ts、main/writing.ts、renderer/conversation.tsx、writing-progress.tsx、tasks.tsx；Add service/Electron tests。
**Interfaces:** WritingCommand.start.mode?:quick|thorough；WritingJob.mode同值；quick单章新稿，checking入口等待作者；resume从quick转thorough保留预算/源保护。
- [x] 失败服务测试和桌面测试：快速试写2调用并未检查、重启零自动调用、手动继续剩余检查、手改稿保留、多章/已有正文拒绝。
- [x] 在作者连续写作设置提供模式，快速模式固定一章并说明检查范围；进度及任务显示复用统计与继续认真定稿，目标+全服务/types/build通过提交。

### Task 4: 对照基准与集成
**Files:** Create scripts/benchmark-check-cost.mjs、docs/check-cost-verification.md；Modify README/roadmap/verification，保留JSON证据。
- [x] 冲突及正常迁移对照记录冷/热检出、误报、原文覆盖、请求/fixture Token；真实模型指标null。完整服务/types/build/Electron及旧三组基准。
- [x] 一次独立审查，重要问题统一红绿修复及完整复验；更新文档、选择性提交、合入main复验并归档工作区。
