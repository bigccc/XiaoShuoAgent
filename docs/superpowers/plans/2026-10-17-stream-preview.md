# 小说工坊键盘、流式预览和对比度实施计划

Goal: 键盘可达、可信流式预览、对比度审计；交付本地DMG和隔离真实验收。
Architecture: 现有SSE onChunk -> 主进程内存预览 -> 固定IPC -> 渲染局部预览。正式校验、保存和检查仍为结果依据。

## 已确认范围
- 对话message、artifacts内容或blocks文本、试写chapters正文、连续写作生成与整章修订content。检查/规划/定点修正/格式修复只显示阶段。
- 临时只读预览不写数据库/历史/导出/上下文。重试重置、取消拒绝迟到事件、重载同步、完成刷新后移除预览。
- 主进程基于字段路径解析JSON字符串，处理切片/转义/Unicode/嵌套/乱序；解析失败退化到阶段提示，不能放宽最终校验。
- onGenerationDelta(handler)返回取消订阅函数；generationPreview(projectId)返回当前快照。事件标识project/task/attempt/sequence/path，区分reset/append/status/end。
- 首片立即，后续最多每50ms批送；敏感字符串跨片脱敏；输入沿用provider上限。
- 不包含样式全面拆分、轮询整体改造、骨架屏、字体/纸色、新手引导及虚拟滚动。

## Task 1: 键盘和保存
- 原生dialog共享组件，初始焦点、Tab圈定、背景不可交互、ESC与焦点恢复。
- 未保存弹窗ESC=返回编辑，结束离开请求；保存中禁关闭/重复操作。
- Cmd+S区分保存与离开：自动表单flush，手动表单校验并保存，错误保留正文；Cmd+1..5书架/创作/看稿/故事资料/设置，无作品2..4不执行。
- modal/IME/repeat时全局快捷键不执行，保留Cmd+Enter，提供快捷键提示。
- Playwright键盘回归含手动表单/失败/焦点/输入法。

## Task 2: 流式
- 共用预览服务、增量JSON解析、类型和IPC；接入ConversationRunner/completeConversation和WritingRunner。
- 消费者先订阅再快照，sequence去重/缺口同步；仅目标作品，清理订阅。
- 文本展示而非HTML，preview自滚动只在底部，读屏只播阶段。
- 自动重试新attempt，修复只显示状态；失败/取消清除；完成持有预览直到正式状态刷新。
- Vitest解析/服务/恢复测试与Electron受控SSE交互回归。

## Task 3: 对比度
- scripts/audit-contrast.mjs + npm run audit:contrast；从tokens读取明暗颜色，明确pair清单；4.5正文、3大字/必要控件/焦点，装饰禁用单列。
- 测试计算已知通过/失败；Playwright测实际透明合成/继承/hover/focus；仅修有关颜色。
- npm run check串联类型、单测、审计、构建。

## Task 4: 交付
- baseline npm test，已有dirty diff保存在.tmp/stream-preview-20261017；在codex/writing-stream-preview保留原改造增量实现。
- 最终typecheck/full unit/audit/build/受影响Electron；模拟首片到UI <500ms且早于结束。
- arm64 DMG只读挂载复制后测试安装副本，checksum；不替换Applications、不发布不推送。
- 隔离真实作品：一轮规划、一次试写、两章连续；20请求/300000 token预算/20分钟任一停止，请求前输入+max输出预留，未知用量保留。
- 不预读真实Response以免破坏流式；证据仅元数据，不含正文/提示词/密钥；各验收独立报告。
