# 小说工坊中文使用教程

1920 × 1080 横屏，30 fps，时长 3 分 20 秒。包含当前软件界面、操作位置放大、中文配音与同步字幕。

## 预览

在本目录运行 `npm run dev -- --no-open --port=3123`，打开 `http://localhost:3123/XiaoShuoTutorial`。Studio 的 Scenes 文件夹可单独查看、编辑九个段落。

| 起点 | 内容 |
| --- | --- |
| 00:00 | 开场与使用路线 |
| 00:13 | 设置 AI 连接 |
| 00:36 | 新建作品与输入灵感 |
| 00:56 | 确认方向、准备人物与大纲 |
| 01:23 | 写作与连续写作进度 |
| 01:51 | 看稿与选段批注 |
| 02:16 | 改稿范围与故事资料 |
| 02:40 | 导出正文与完整作品备份 |
| 03:08 | 操作路线回顾 |

## 内容与素材

操作依据为本仓库 2026-10-13 的 renderer 和 README。截图来自当前构建的 Electron 应用，使用独立临时数据目录拍摄。示例作品《雨巷里的猫》及回复由本地演示服务提供，未调用外部模型，也不使用用户现有作品或密钥。示例只说明操作方法，不代表真实模型输出质量。

配音使用 macOS 系统的 Tingting 普通话声音，语速 210。旁白按句生成，依据每句实际音频时长排字幕。无背景音乐，便于听清操作说明。

- `src/scenes/`：九个可单独预览的段落。
- `src/SceneFrame.tsx`：公共画面与按钮标注。
- `public/screens/`：当前软件界面素材。
- `public/audio/`：各段配音。
- `public/小说工坊使用教程.srt`：完整外部字幕。
- `scripts/storyboard.json`：旁白与分镜内容。
- `src/storyboard.json`：包含实际时长与字幕的生成清单。

## 修改与验证

直接编辑 `src/scenes/` 保留 Studio 中的修改。只有需要从原始分镜重新生成时才运行 `node scripts/build-narration.mjs` 和 `node scripts/build-scenes.mjs`，因为后者会重写场景文件。

类型检查使用 `npx tsc --noEmit`。`node scripts/check-scenes.mjs` 对全部截图切换各导出一帧检查图，同时核对音频时长与字幕边界。检查图在 `generated/qa/`；此检查不会导出完整 MP4。

根据需要，可在 Studio 点击 Render 导出 H.264 MP4，或运行 `npx remotion render src/index.ts XiaoShuoTutorial out/小说工坊使用教程.mp4 --codec=h264`。
