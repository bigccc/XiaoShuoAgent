# 桌面版验证记录

日期：2026-10-06。环境：Apple Silicon arm64、macOS 27.0、Node 22.22.1、npm 10.9.4。应用运行时 Electron 44.5.1，内置 Node 24.21.0，SQLite 随 Electron 运行；最低系统版本从其 Info.plist 的 LSMinimumSystemVersion=13.0 确认。开发机运行验证不代表最低系统版本设备已测试。

本次模型请求全部由每条测试创建的 loopback HTTP fixture 响应。生产应用没有 fixture 分支、预置作品或虚构生成结果。原生对话框在 E2E 中只替换选择边界，导入、导出、备份和数据库仍使用真实 AppServices。每次测试独立 userData，关闭时等待保存与 services.dispose。

| 边界                     | 实际状态／证据                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整服务层               | 5 文件 60 测试（原 57 加 3 条来源图回归），SQLite／兼容 HTTP／上下文／DOCX／备份等；不替代 UI 验收                                                                |
| Electron 开发构建        | 实际运行所有控件工作流；作品、设定、确认、恢复、重启持久化通过                                                                                                    |
| Electron node:sqlite     | 实际创建／重开数据库；不只在宿主 Node 中测试                                                                                                                      |
| API 配置与保护           | 本机 Electron safeStorage 保存 fixture 密钥并发起连接；快照只显示 hasKey，作品包验证无密钥；真实服务商接入未测                                                    |
| 规划／提取／正文         | 实际 UI 发起真实 HTTP，候选单独保存，作者审阅后采纳；来源二次变化令旧复核授权失效                                                                                 |
| 批量／失败恢复           | 未授权三章拒绝且零 HTTP；授权连续三章取消后继续，三份候选且正文仍为空；真实 SSE 取消保留片段并续写通过；后端另测失败／重写／预算                                  |
| 一致性                   | fixture 返回逐字章节证据，UI 展示并标为处理；不证明 AI 对真实文学作品的检测能力                                                                                   |
| 保存                     | 防抖序列化、立即导航、pending close、重启持久化、真实 revision 冲突后阻止离开并保留文字；轮询不覆写脏编辑                                                         |
| 素材                     | 粘贴、审核／引用、TXT 文件导入、AI 提取候选审核入库经实际控件通过                                                                                                 |
| 导出／备份               | UI 真实 TXT/DOCX/完整作品包导出；导入副本保留素材且原作品存在；文件路径只在主进程原生对话框中处理                                                                 |
| DOCX 排版                | 根任务用真实 ProjectFiles 导出中文两章，再用 bundled LibreOffice renderer 渲染一页并人工看图；中文、emoji、换行和顺序通过，无裁切；WPS／Microsoft Word 本体未验证 |
| 窗口与无障碍             | 1440×920 和最小 1050×680；阅读／动作可见、页面内部滚动；Field 显式 label/id，重新挂载仍保持精确名称；已检查截图                                                   |
| arm64 .app / ZIP / DMG   | Forge 本机实际生成，独立启动／保存验证；FIX1 arm64 ASAR 11 条 Electron E2E 通过／1 条 bootstrap 跳过（29.6s）；最终候选提示再测 2 条通过（6.9s）                  |
| x64 .app / ZIP / DMG     | Forge 交叉架构实际生成；FIX1 direct Rosetta 启动成功、原生基础验收由控制器补证；未在 Intel 物理 Mac 安装／执行                                                    |
| Apple Developer ID／公证 | 未执行；本机 0 有效签名身份；本地包不是已公证公开发行版                                                                                                           |
| 真实 API 三角色          | 未执行；需要作者的真实配置并接受相应服务商调用费用                                                                                                                |
| 连续二十章约 3000 字质量 | 未执行；需真实生成后人工阅读连贯性、可读性、误报与修改记录                                                                                                        |
| 两台 Mac 实体迁移        | 文件包导入副本自动验证；不同物理 Mac 的钥匙串／安装／完整迁移未执行                                                                                               |

## 测试与产物

开发步骤：`npm ci`、`npm run typecheck`、`npm test`、`npm run e2e`、`npm audit`、`git diff --check`。

任务 3 初始 RED 用只显示应用名的空 Electron shell 运行完整行为测试：书架空态／新建和模型设置缺失，2 条测试按预期失败。实现后逐步 GREEN。额外真实 RED：旧来源规划仍可采纳；复核后来源再次变化未清除授权；未保存素材导航被丢弃；重新挂载 textarea 名称带正文。这些分别由禁用采纳＋显式复核、按当前来源版本绑定复核授权、离开前保存提示和显式 label/id 修复。最终命令／结果在任务报告中保留。

Forge 首次失败：默认 `out/` 输出目录自动被排除，与构建 `out/main/index.js` 冲突；配置 outDir=`release` 后通过。默认 maker-dmg 链的 image-size ICNS 解析存在高危依赖公告；移除此完整 dev 链，使用 Forge maker-base 加系统 hdiutil 的窄 DMG maker，npm audit 回到 0，不采用宽泛依赖升级。

- Apple Silicon：`release/XiaoShuoAgent-darwin-arm64/XiaoShuoAgent.app`
- Intel：`release/XiaoShuoAgent-darwin-x64/XiaoShuoAgent.app`
- ZIP：`release/make/zip/darwin/{arm64,x64}/XiaoShuoAgent-darwin-{arch}-0.1.0.zip`
- DMG：`release/make/dmg/{arm64,x64}/XiaoShuoAgent-0.1.0-{arch}.dmg`
- 实际 UI 截图：`docs/screenshots/`（仅验收数据）
- DOCX 渲染原始记录：`.superpowers/sdd/2026-10-06-novel-desktop/docx-qa/verification.md`

## 实用限制

使用启发式 Token 估算，不声称精确费用；改预算需新任务。AI 检查与清洁样例不保证检测所有冲突。TXT/DOCX 素材导入只提取正文文本，不导入图片布局或自动拆分整本小说。来源版本保存到任务／章节版本，旧设定内容没有独立全量版本历史；作者应对照当前来源复核。API 密钥不能从备份恢复，换机后重新配置。未签名包的 Gatekeeper 行为、Intel 运行及最低 macOS13 实体设备均需另行验证。

来源图修复没有 schema 迁移：采纳新派生记录沿来源方向保护上游人物／世界及其已确认章节，不反向令来源过期；更新原人物沿依赖边标记派生世界／大纲，更新正文标记摘要／知情记录，原文保留。无来源手工大纲采用保守的后续规划复核规则。真实 DomainService＋buildContext 三条回归先 RED（全部失败），修复后完整 60 测试 GREEN。

首次 arm64 应用只读启动核实：应用名“小说工坊”，userData 为 /Users/dave/Library/Application Support/小说工坊，Electron44.5.1，Node24.21.0，arm64，safeStorage.isEncryptionAvailable=true。未创建假作品。真实 sender 边界验证：第二窗口即使同一应用页面和 preload，也无法调用主窗口 IPC；renderer 无 Node require 及密钥读取接口。

Task3 初次匹配构建检验：npm ci、typecheck、60 服务测试、npm audit（0 漏洞）、两架构 Forge make 均成功；当时 arm64 ASAR 应用 9 条 E2E 全通过（23.0s），bundle index-DIiB-XAm.js。当前 FIX1 构建与验证见下。

## FIX1：离线启动与任务审阅保护

独立审查复现：原启动路径先同步检查钥匙串，系统等待可能令数据库和窗口均未创建；规划建议及多份提取素材的本地审阅修改没有参与离开守护。修复后主进程只在实际加／解密时检查保护能力，禁止明文回退；界面使用全部表单注册集合，依次检查每份候选，切换任务、自动选择新任务、导航与关闭均使用同一 flush。规划的退出动作明确为“采纳为新设定并离开”，不会静默采纳；素材提示明确指出当前候选名称并保留原审核选择。

真实 Electron 三条回归先 RED（3/3 失败），后 GREEN（3/3 通过，7.6s）。其中测试专用 bootstrap 在导入实际编译 main 前拦截所有 safeStorage 方法：离线启动、创作与确认 0 次调用；显式保存密钥才访问保护能力，失败不保存配置或明文。规划修改通过切换任务、导航和关闭守护，取消后保留文字，明确采纳后才创建设定；两个提取候选逐一守护，一个已审核、一个未审核，修改与审核状态均保留。

完整服务测试 60 项、typecheck 和 audit（0 漏洞）通过；开发 Electron 12 项通过（29.7s）；arm64 实际 ASAR 应用 11 项通过（29.6s），仅编译 main 的 Keychain 拦截 bootstrap 在打包模式跳过（开发模式已验证）。两架构 .app、ZIP、DMG 已重新生成并通过包完整性检验。新增实际 guard 截图在 docs/screenshots；最终 bundle／checksum 见 FIX1 任务报告。

**x64 运行边界：** 控制器重试修复后的实际 x64 包时，Playwright 调试入口曾在 15 秒内未获得窗口；确认 ASAR 包含延迟修复。随后 direct launch 在 Rosetta 下成功，原生 CUA 读到真实窗口及 release/x64 的 ASAR 页面 URL，隔离目录 /tmp/xiaoshuo-intel-fixed-direct-20261006 创建 works.sqlite。因此调试入口超时不能等同实际 app 失败。基础创建／保存 smoke 仍由控制器验证并补证；物理 Intel Mac 未验，未自动授权或修改 Keychain。

最终 FIX1 bundle：index-DQydBrK5.js。针对多表单提示增加明确候选名后，最终 .app 两项审阅回归再次通过（6.9s），并人工看过弹窗截图，无裁切。两架构包再次生成、DMG 与 ZIP 完整性通过；SHA-256 记录在任务报告的 FIX1 段。
