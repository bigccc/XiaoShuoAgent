# 小说工坊 · XiaoShuoAgent

个人网文创作桌面应用。作品、设定、章节、版本、素材与任务保存在本机；规划、生成和检查使用作者自行配置的 OpenAI 兼容聊天 API。全新启动是空书架，没有预置小说或模拟 AI 输出。

## 使用与安装

要求 macOS 13.0 或更新版本（依据 Electron 44.5.1 的应用 Info.plist）。Apple Silicon 使用 arm64 包，Intel 使用 x64 包。将 DMG 中的 `XiaoShuoAgent.app` 拖到 Applications，或解压 ZIP 后复制应用。使用者无需安装 Node、Python或数据库。

当前本机构建没有 Developer ID 签名或 Apple 公证，不能当作已经通过 Gatekeeper 的正式公开发行版。Intel 安装与真实设备启动尚未验证；详见 [验证记录](docs/verification.md)。

1. 在书架新建作品，填写创意、背景、题材、风格和字数目标。
2. 整理人物／世界、故事线、大纲与章纲。设定、作品字段和正文自动保存；导航与关闭前等待保存完成，失败会保留编辑器内容并阻止离开。
3. 在正文区新建章节、编辑与确认，历史版本可对比和恢复。修改已确认正文形成草稿，旧版保留。AI 候选需作者采用为草稿，再单独确认。
4. 配置自己的模型：API 地址、模型名称与 API 密钥，分别设置规划／正文／检查用途。保存后密钥仅显示已保护状态；留空保留现有密钥。测试连接会发起一次真实请求。
5. 右侧选择模型与 Token 预算。展开上下文设置，可明确纳入草稿、设定、已审核素材、独立检查模型。连续生成须选连续 3—5 章并明确授权；没有授权不会调用服务商。
6. 在任务中审阅规划／提取结果、候选、原文来源、截断披露、用量和错误。取消保留片段与已有候选；继续或重写未完成部分。更改模型或预算需要新任务。来源变化后须重新复核，不能自动覆盖正文。
7. 素材可以粘贴或导入 TXT／DOCX，先审核再引用。引用保留当时快照。旧 `.doc` 请先转换为 `.docx`。AI 不会把提取内容标为已验证的“爆款”。
8. 一致性检查展示人物、时间、地点、规则、知情范围与伏笔的原文证据，由作者处理或忽略。模型无法保证找出所有问题。

Token 用量标明服务商报告或估算／预算预留。预算是调用 Token 上限，不是精确费用上限。模型未配置时本机编辑、版本、导出和备份仍可用。素材与模型表单采用明确保存，离开有未保存修改时会提示保存、返回或放弃。任务审阅里的规划和每份提取素材同样保护修改，切换任务、导航或关闭都会先询问；规划必须明确选择采纳，素材的审核状态按作者勾选保留。

## 备份与数据

正常应用使用 Electron 的 `userData`，macOS 一般位于 `~/Library/Application Support/小说工坊`（已用未覆写的最终 arm64 应用实际确认）；数据库为 `works.sqlite`。**不要直接复制运行中的数据库主文件作为备份。** 在“导出与备份”选择完整作品包 `.novel`，再在另一台 Mac 导入为独立副本。API 配置与明文／密文密钥都不进入作品包。

每 15 分钟内容变化时产生一致的自动恢复文件，`userData/recovery` 保留最近 20 份，关闭时也尝试保存恢复快照。恢复文件可以通过“导入作品／恢复备份”选择。自动恢复错误会显示在界面；重要迁移前请另存手动作品包。TXT 为 UTF-8，Word 导出为真正的 DOCX，默认仅已确认章节，也可明确勾选包含草稿。

密钥由 Electron `safeStorage` 在主进程通过 macOS Keychain 保护，只在实际保存或使用凭据时检查和访问，不在离线启动时调用可阻塞的可用性检查；运行时不可用时拒绝保存非空密钥，并保留本机创作能力。不能从界面读回密钥。正式发行需要一致签名并验证升级后的钥匙串访问。

## 开发

开发要求 Node.js 22.13+，本机已验证 Node 22.22.1 / npm 10.9.4。依赖版本写死并由 `package-lock.json` 锁定，无需修改全局工具。

```sh
npm ci
npm run dev         # Electron + renderer 热更新
npm run build       # out/main、out/preload、out/renderer
npm start           # 启动构建结果
npm run typecheck
npm test            # 真实 SQLite / loopback HTTP 服务层测试
npm run e2e         # 构建并运行真实 Electron 控件工作流
npm run package     # 当前架构 .app
npm run make:arm64   # Forge .app + ZIP + DMG
npm run make:x64
```

开发主进程和界面职责分离；只经 `window.novel.invoke(command)` 与 `snapshot()` 调用受控 AppServices。主进程验证发送者主框架及 URL，禁用 Node 集成、启用隔离与沙箱；无任意路径或凭据读取接口。SQLite 使用 Electron 内置 `node:sqlite`，不需要原生数据库重建。

E2E 仅在独立临时目录运行，HTTP 仅访问当前测试创建的 loopback fixture，不调用外部付费模型。`NOVEL_TEST=1` 配合绝对 `NOVEL_DATA_DIR` 可显式选择测试数据目录；正常打包应用忽略该覆盖，测试不替换真实作品。测试通过主进程对原生文件选择框的边界注入所选临时文件，所有后续解析／持久化／导出仍走真实 AppServices。

打包结果在 `release/`；Forge 自定义 DMG maker 仅调用系统 `hdiutil`，没有额外安装工具。可选 `MAC_SIGN_IDENTITY` 启用签名，`APPLE_NOTARIZATION_PROFILE` 选择已有 notarytool keychain profile。签名／公证须由持证者配置，项目不含 Apple 或模型凭据；本次未使用这些变量。

对真实 arm64 包运行同一组验收：

```sh
NOVEL_PACKAGED_EXECUTABLE="$PWD/release/XiaoShuoAgent-darwin-arm64/XiaoShuoAgent.app/Contents/MacOS/XiaoShuoAgent" npx playwright test
```

打包、自动测试、真实 API、长篇阅读、两架构设备安装与签名公证的状态分别见 [docs/verification.md](docs/verification.md)。
