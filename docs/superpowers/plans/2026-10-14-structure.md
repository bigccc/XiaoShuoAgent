# 结构导航 Implementation Plan

> **Execution:** 原生逐任务实施、测试先行，末尾一次独立审查；沿用已授权范围及本地集成。

**Goal:** 作者可导航场景、主支线、人物提及、视角与伏笔，并按明确范围生成待审稿。
**Architecture:** 结构工作区持久化作者计划/忽略记录，SQLite分页投影；修订复用SceneService/RevisionRunner。
**Tech Stack:** Electron/React/TypeScript/SQLite/Vitest/Playwright。
**Spec:** `docs/structure-design.md`。

## Global Constraints

- 五视图、最多40行/页；50线程、120标题/1000说明，关联总1000、忽略1000、历史10。
- 不把计划/提及/候选当已发生事实，不自动推断主支线；场景源状态完整验证在修订服务。
- v9升级前备份，旧包兼容，ID重映射及原子导入；poll无结构全文。
- 修订只选段/当前章，进入待审稿，默认预算100000；不真实付费评测/安装/推送，保留tutorial-video。

## Review Focus

- Task1：跨作品/重复链接/伪造ID、历史失效链接、忽略依据改变及原子导入。
- Task2：5000章不能通过snapshot加载全文；分页/章序/别名/零匹配与重复正文；计划/候选状态不得冒充事实。
- Task2：待审回收不隐藏原采纳埋设提醒，元信息提醒依据可解释且忽略后新依据重新出现。
- Task3：页内选择不能清除页外关联；脏导航/保存后动作/异步刷新不覆盖编辑。
- Task3：陈旧章/卡片、无原文绑定、越界来源、模型回应/采纳并发；段外原文逐字保留。

### Task 1: 结构工作区与v9
**Files:** Create shared/structure.ts、main/structure.ts、tests/structure.test.ts、tests/structure-files.test.ts；Modify store/types/files/services/API/IPC。
**Interfaces:** StructureWorkspace含threads/dismissed/history；StructureCommand线程保存/归档、忽略/历史恢复；StructureService.config(projectId,history=false)、command(c)。StructureQuery/Row/Page供Task2/3。
- [ ] 失败测试：线程与关联身份、重复/异作品拒绝、历史/归档、忽略来源版本、v8备份/旧包/重映射/原子拒绝。
- [ ] 实现限额/服务及v9迁移/作品包，目标+类型检查通过并提交。

### Task 2: 有界投影与提醒
**Files:** Modify main/structure.ts、main/store.ts；Create tests/structure-query.test.ts、scripts/benchmark-structure.mjs。
**Interfaces:** StructureService.query(q):StructurePage；Store分页场景/人物匹配/伏笔投影/源元信息方法。Row含标题/来源版本/显式类别/最多3项提醒，无正文全文。
- [ ] 失败测试：五视图、筛选/范围/40分页、人物姓名/别名、候选与采纳伏笔、逾期/忽略与来源改变、5000章不读全文snapshot。
- [ ] 实现SQLite筛选/排序、按页来源检查与可解释提醒，固定性能/响应基准、目标+全套/types通过提交。

### Task 3: 作者界面及问题型修订
**Files:** Create renderer/structure.tsx、tests/structure-revision.test.ts、tests/e2e/structure.spec.ts；Modify main.tsx/style/services/API。
**Interfaces:** structureQuery/config按需IPC；structure.revise通过StructureService生成受控revision.start并在同一主进程操作启动；复用sceneSource/原文版本保护，无新增回写许可。
- [ ] 桌面/HTTP失败验证线程编辑保留页外选择、脏导航、五视图定位/提醒忽略、历史恢复、窄屏、修订原文范围与源变拒绝。
- [ ] 实现界面与明确问题/范围/预算入口，目标+全部服务/types/build/Electron通过提交。

### Task 4: 验证及集成
**Files:** docs/structure-verification.md、README/roadmap/verification、JSON基准证据。
- [ ] 完整服务/types/build/桌面与结构+旧四组基准；缺测真实文学效果保持明确。
- [ ] 一次独立审查，重要问题统一红绿修复，完整复验；更新文档、选择性提交、main复验、归档工作区。
