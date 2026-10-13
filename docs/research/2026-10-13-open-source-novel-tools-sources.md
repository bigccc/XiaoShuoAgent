# 同类型开源小说创作工具：一手来源调研

调研日期：2026-10-13（亚洲/上海）；外部仓库提交时间下文使用 GitHub 返回的 UTC 日期。

## 范围与证据限制

本笔记比较 6 个代表项目：4 个面向中文或支持中文的 AI 长篇创作项目、1 个 CLI 创作工具、1 个传统作者编辑器。采用项目官方 README、实际源码、官方使用文档及实时 GitHub API；关键代码链接固定到本轮读取的提交，避免默认分支继续变化。没有安装运行外部项目、没有调用其 AI 服务，也没有做作品质量盲测、端到端稳定性或性能测试。因此“有实现”仅表示对应代码可见，不能理解为成熟可用或生成质量更好。未采信星数、宣传节省比例、“可签约”“百万字”等质量结论。

同名项目较多，本文的 NovelForge 特指 `LunaRime/novelforge`，OpenNovel 特指 `Yaemikoreal/OpenNovel`。传统编辑器 novelWriter 的原 `vkbo/novelWriter` 已重定向到 `saga-soft/novelWriter`。未将同名 `gitstq/NovelForge` 当作成熟标杆。

## 精简比较

| 项目 / 准确仓库 | 许可证 | 可核实的区别机制 | 借鉴重点 |
| --- | --- | --- | --- |
| [NovelForge](https://github.com/LunaRime/novelforge) | GPL-3.0 | 章节、卷、全书记忆；过期标记；按任务选择模型；角色声音分析 | 远章记忆及失效传播，成本分工，角色文风 |
| [OpenNovel](https://github.com/Yaemikoreal/OpenNovel) | MIT | SQLite 事件账本、因果字段、角色事件与语义内容双轨召回、结构化伏笔状态 | 人物在故事中的状态与因果，精确召回结合语义召回 |
| [AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | AGPL-3.0 | 当前版为 Web 重写；卷→篇章→场景→章计划；伏笔状态绑定正文修订证据 | 场景规划，伏笔可核查与原文改变后复核 |
| [Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT) | 未确认：API 未识别、当前文件树未发现 LICENSE | 大纲/剧情与正文块映射，局部写作、批量审阅和改写 | 大作品改写的定位与关联规划更新；仅机制参照 |
| [StoryCraftr](https://github.com/raestrada/storycraftr) | MIT | 作品目录里的 Markdown 章节、世界观、纲要；针对名字/动机/连贯的改写命令 | “我要解决什么问题”的修订入口，而非泛化聊天 |
| [novelWriter](https://github.com/saga-soft/novelWriter) | GPL-3.0 | 章/场景标题层级、人物/地点标签引用、大纲视图、手稿构建 | 作者视角的场景索引和阅读/编辑导航 |

许可证根据仓库 LICENSE 或 GitHub 许可证元数据核实：[NovelForge LICENSE](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/LICENSE)、[OpenNovel LICENSE](https://github.com/Yaemikoreal/OpenNovel/blob/2ac8371c52e69a4f55ab40806907e50a5ddeb67a/LICENSE)、[AI_NovelGenerator LICENSE](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/LICENSE)、[StoryCraftr LICENSE](https://github.com/raestrada/storycraftr/blob/73a77097d14e57070ac1a6f04b5badfbc9be91b1/LICENSE)、[novelWriter LICENSE](https://github.com/saga-soft/novelWriter/blob/6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c/LICENSE.md)。Long-Novel-GPT 不猜许可证；上述机制建议优先自行实现，本笔记不评估代码复制的许可兼容性。

## 1. NovelForge：可失效的记忆和按用途调用模型

- **记忆并非只有最近几章全文。** 章节记忆记录关键事件、角色、伏笔、新设定、当前状态等；章节条目齐备后聚合卷文件，再以既有记忆重建全书文件。全书聚合是确定性的拼装，不是每层都调用模型做二次压缩，故不能把“三级摘要”理解成无限长上下文的解决方案。源码：[chapter-memory.ts](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/memory/chapter-memory.ts)、[book-memory.ts](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/memory/book-memory.ts)。
- **修改后追踪派生记忆。** 卷边界修改会从旧、新卷范围收集受影响章节记忆和卷文件，并经 IPC 标记 stale；重建全书时过滤 stale 卷文件，全部卷失效时返回失败，避免静默退化。值得借鉴的是“旧记忆不能继续当事实”，仍需我们补源版本/哈希与依赖关系，不能直接假设其全部失效边界都覆盖。源码：[memory-invalidation.ts](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/memory/memory-invalidation.ts)、[全书重建](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/memory/book-memory.ts)。
- **按任务选择模型。** 正文创作、审稿分析、摘要/分类分配不同层级；没配置有效路由时回退，且排除纯 embedding 模型。费用估算函数内明确标注价格过时，应只借鉴路由机制，不能沿用其价格表或 README 节省比例。源码：[model-router.ts](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/llm/model-router.ts)。
- **人物声音有具体特征。** 源码提取对话后计算高频词、平均句长、例句、敬语频率，并增量合并档案；属于启发式特征，不代表已证明准确识别人说话。可为我们“作者样本文风 + 角色声音”提供可解释字段参照。源码：[character-voice-analyzer.ts](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/src/services/character-voice-analyzer.ts)。

维护证据：默认分支提交 2026-10-02，最新发布 `v0.1.7-beta.1`（2026-09-25，预发布）；README 明示 0.y.z 早期阶段、接口与工作流未稳定。应作机制来源，不以此认定稳定商用品质。[默认分支快照](https://github.com/LunaRime/novelforge/commit/3e860f8b08ba2083787c695182ae4ae0dcbd862a)、[发布记录](https://github.com/LunaRime/novelforge/releases)、[版本阶段说明](https://github.com/LunaRime/novelforge/blob/3e860f8b08ba2083787c695182ae4ae0dcbd862a/README.en.md)。

## 2. OpenNovel：精确事实与语义内容分别召回

- **有类型的事件账本。** 事件包含章节、故事内时间、角色 ID、事件类型和 `caused_by`；类型涵盖受伤、痊愈、物品获得/失去、知情、位置和关系变化。相较自由文本笔记，这让“某人物何时知道什么”和“某物件谁持有”有可查询入口。数据结构并不自动保证提取正确。源码：[event.py](https://github.com/Yaemikoreal/OpenNovel/blob/2ac8371c52e69a4f55ab40806907e50a5ddeb67a/opennovel/schemas/event.py)。
- **双轨检索。** `HybridRetriever` 一侧取高因果影响事件和角色事件，另一侧语义查询设定/潜意识内容，再返回统一结构。具体实现按角色最多取 5 条；虽然参数有 `chapter_id`，读取的函数体未实际用它进行章节边界过滤。因此可借鉴 SQL + 语义检索分工，但我们应额外防止回看早章时注入未来事实。源码：[hybrid_retriever.py](https://github.com/Yaemikoreal/OpenNovel/blob/2ac8371c52e69a4f55ab40806907e50a5ddeb67a/opennovel/core/hybrid_retriever.py)。
- **伏笔有生命周期。** `buried / in_progress / closed` 分别表达埋设、推进、收束，另有埋设章、预计回收区间和关联角色；适合扩展我们已有文本 Note，使待回收事项可以排序和提醒。源码：[foreshadowing.py](https://github.com/Yaemikoreal/OpenNovel/blob/2ac8371c52e69a4f55ab40806907e50a5ddeb67a/opennovel/schemas/foreshadowing.py)。

维护证据：默认分支最后提交 2026-08-01 为依赖更新合并；官方 Releases API 本轮返回空列表。不能从“最后提交”推导其功能仍持续更新，也不能因测试宣称多就当作我们验证过。[默认分支快照](https://github.com/Yaemikoreal/OpenNovel/commit/2ac8371c52e69a4f55ab40806907e50a5ddeb67a)、[官方 Releases API](https://api.github.com/repos/Yaemikoreal/OpenNovel/releases?per_page=1)。

## 3. AI_NovelGenerator：场景规划和绑定版本的伏笔证据

本轮以当前 `main` 为准，搜索缓存中的 CustomTkinter/V1.4.4 属于旧版本。当前 README 明确重写为 Next.js + FastAPI + MongoDB，旧版在 `old`；数据结构不同。作者可分层编辑卷、篇章、场景与章计划，候选审核后保存。[当前版 README](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/README.zh-CN.md)。

- **场景为规划实体。** `ScenePlanningV1` 继承篇章规划字段，不直接存正文；场景关联卷、篇章，有稳定 ID、排序、统计和版本，更新需传 `expected_version`。可为我们细化“这一章各场景要达成什么、在哪、谁参与、起止状态”提供参照。源码：[scene_contract.py](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/backend/services/novel/scene_contract.py)。
- **计划和实际完成分开。** 伏笔状态为 `planned / planted / resolved / abandoned`；计划位置可指卷/篇章/场景，实际埋设和回收分别绑定已保存章节修订、原文位置、引用文本和 SHA-256。服务端核对引用是否与修订一致；当前正文变化后返回 needs_review，已回收状态要求存在两侧证据。源码：[foreshadowing_contract.py](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/backend/services/novel/foreshadowing_contract.py)、[foreshadowing_service.py](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/backend/services/novel/foreshadowing_service.py)。

维护证据：默认分支提交 2026-10-12；本轮 Releases API 无发布记录。当前 README 明确旧版 Issue/PR 因重写统一关闭，并不代表旧问题全部修复；部署需要 MongoDB 副本集及多服务，操作复杂度要与我们的本地 SQLite 和新手流程分开比较。[默认分支快照](https://github.com/YILING0013/AI_NovelGenerator/commit/da3cbbe1c579e855c52562c7cd3f494aa1587c0b)、[版本与环境说明](https://github.com/YILING0013/AI_NovelGenerator/blob/da3cbbe1c579e855c52562c7cd3f494aa1587c0b/README.zh-CN.md)、[官方 Releases API](https://api.github.com/repos/YILING0013/AI_NovelGenerator/releases?per_page=1)。

## 4. Long-Novel-GPT：把剧情与正文建立映射

官方流程包括导入旧作、拆书、检索相关正文和剧情纲要、局部改写后更新纲要。实际 `Writer` 使用 `chunk_pairs` 维持两层文本关系，提供分块、映射、批量创作及审阅后改写；这一机制适合作为“改了正文，还要知道相关剧情计划是否过期”的参照，不能仅凭 README 推断长篇质量或完整 RAG 在所有入口生效。[官方流程](https://github.com/MaoXiaoYuZ/Long-Novel-GPT/blob/107c31e54686947a6d00404e332475a60b66e630/readme.md)、[writer.py](https://github.com/MaoXiaoYuZ/Long-Novel-GPT/blob/107c31e54686947a6d00404e332475a60b66e630/core/writer.py)。

维护证据：默认分支最后提交 2025-11-05 为 README 更新；本轮 Releases API 返回空，API license 为 null，当前递归树未发现许可证文件。可参考交互和分块思路，但不列为许可证已确认的代码复用来源。[默认分支快照](https://github.com/MaoXiaoYuZ/Long-Novel-GPT/commit/107c31e54686947a6d00404e332475a60b66e630)、[仓库 API](https://api.github.com/repos/MaoXiaoYuZ/Long-Novel-GPT)、[发布 API](https://api.github.com/repos/MaoXiaoYuZ/Long-Novel-GPT/releases?per_page=1)。

## 5. StoryCraftr：把全书改写拆成作者能理解的任务

模板源码将章节、总纲、人物摘要、情节点、章梗概及世界观分别组织为 Markdown 文件；修订源码有名字一致性、人物动机、核心主题与跨章一致性的具体命令。可借鉴“修正名字/强化某角色动机/检查时间矛盾”的任务入口，结合我们已有待审稿，而不是让作者先理解提示词。[作品模板](https://github.com/raestrada/storycraftr/blob/73a77097d14e57070ac1a6f04b5badfbc9be91b1/storycraftr/templates/folder_story.py)、[修订任务源码](https://github.com/raestrada/storycraftr/blob/73a77097d14e57070ac1a6f04b5badfbc9be91b1/storycraftr/agent/story/iterate.py)。

注意，插章实现涉及直接重命名文件和重写相邻章；这里没有验证其版本保护和失败回滚。我们的版本保护与待审机制应保留。不要将这个实现直接当作安全范本。

维护证据：默认分支最后提交 2025-11-07；`pushed_at` 为 2026-03-06，与默认分支提交不是同一概念；最新 Release `v0.12.0-beta10`（2025-11-06，标签含 beta）。应作为 CLI 工作流参照而非面向新手的桌面体验标杆。[默认分支快照](https://github.com/raestrada/storycraftr/commit/73a77097d14e57070ac1a6f04b5badfbc9be91b1)、[仓库 API](https://api.github.com/repos/raestrada/storycraftr)、[发布记录](https://github.com/raestrada/storycraftr/releases)。

## 6. novelWriter：大作品的场景和引用导航

这是相邻的传统作者工具，不以 AI 生成作为核心。官方文档用四级标题表达部分、章、场景、片段；场景工作标题可与最终手稿输出的分隔符分离。标签与引用系统关联人物、地点及视角，大纲视图和引用面板据此导航。值得借鉴的是“作者查看哪些角色出现在哪些场景、某场景使用谁的视角”，而不是只以章节目录作为全书地图。[章与场景文档](https://github.com/saga-soft/novelWriter/blob/6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c/docs/source/usage/chapters_and_scenes.rst)、[标签与引用文档](https://github.com/saga-soft/novelWriter/blob/6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c/docs/source/usage/tags_and_references.rst)。

维护证据：默认分支提交 2026-10-11，正式 Release `v26.2.2`（2026-10-11，非 prerelease）；README 区分 `main` 新功能/预发布与 `release` 正式版本。即使维护证据更清晰，也不表示其具备 AI 长篇闭环或我们已验证中文 UX。[默认分支快照](https://github.com/saga-soft/novelWriter/commit/6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c)、[发布记录](https://github.com/saga-soft/novelWriter/releases)、[分支说明](https://github.com/saga-soft/novelWriter/blob/6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c/README.md)。

## 面向小说工坊的机制优先级

以下是从外部机制作出的产品推断，需结合本地能力与作者反馈决定，不是竞品实测结论：

1. **远章相关记忆及可重建派生物。** 保留最近章节全文，再结合章节/卷摘要、人物和事实精确查询、相关旧章片段召回；返回来源章节与版本。先做确定性关键词/实体召回，再按评测需要加入向量，防止把所有 Note 全塞进上下文。
2. **伏笔、时间线、知情和物品状态。** 把状态、有效章节范围、人物 ID、原文证据、源修订和待复核状态做成明确字段；AI 只提出候选，作者确认后才成为事实。重点参考 AI_NovelGenerator 的证据合同，而不仅是自动扫描宣传。
3. **场景级目标与可视化导航。** 最小场景卡包含视角、人物、地点、目标、冲突、起止状态、预计字数与关联伏笔；允许作者跳过细化，避免给新手强加工作流画布。
4. **作者样本与角色声音。** 作者挑选自己认可的片段形成风格档案和示例；角色对话另有声音卡。样本来源和更新由作者控制，避免把质量较差的 AI 稿自动学习成默认风格。
5. **成本分工要与质量评测绑定。** 正文、检查、结构化提取配置不同模型，保留单模型默认；先测每章调用成本、源版本失效处理和远章矛盾发现率，再谈节省比例。批量并行生成连续章可能损伤上下文，应优先并行独立分析任务。

## 复核快照

| 仓库 | 固定读取 SHA | 默认分支最后提交 UTC | 最新 Release（本轮 API） |
| --- | --- | --- | --- |
| `LunaRime/novelforge` | `3e860f8b08ba2083787c695182ae4ae0dcbd862a` | 2026-10-02T09:09:25Z | v0.1.7-beta.1 / 2026-09-25T13:58:02Z |
| `Yaemikoreal/OpenNovel` | `2ac8371c52e69a4f55ab40806907e50a5ddeb67a` | 2026-08-01T09:26:43Z | 无记录 |
| `YILING0013/AI_NovelGenerator` | `da3cbbe1c579e855c52562c7cd3f494aa1587c0b` | 2026-10-12T16:05:54Z | 无记录 |
| `MaoXiaoYuZ/Long-Novel-GPT` | `107c31e54686947a6d00404e332475a60b66e630` | 2025-11-05T03:18:41Z | 无记录 |
| `raestrada/storycraftr` | `73a77097d14e57070ac1a6f04b5badfbc9be91b1` | 2025-11-07T01:40:44Z | v0.12.0-beta10 / 2025-11-06T17:37:21Z |
| `saga-soft/novelWriter` | `6b595c9443a93c788ad4b6aa3eadbdf47eeabe0c` | 2026-10-11T23:25:42Z | v26.2.2 / 2026-10-11T17:07:27Z |

所有仓库本轮 API 的 archived 均为 false；仅表示没有被标记归档。维护日期来自各仓库 `/commits?per_page=1`，发布记录来自 `/releases?per_page=1`，不使用 stars 判定维护状态。
