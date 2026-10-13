# 下载与安装小说工坊

首个公开版本为 **v0.1.0 预览版**，支持 macOS 13.0 及以上。应用包含所需运行环境，不需要安装 Node.js、Python 或数据库。

## 选择下载包

在苹果菜单「关于本机」查看芯片或处理器：

| 电脑 | 安装包 |
| --- | --- |
| Apple Silicon（M 系列芯片） | [arm64 DMG](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.1.0/XiaoShuoAgent-0.1.0-arm64.dmg) |
| Intel 处理器 | [x64 DMG](https://github.com/bigccc/XiaoShuoAgent/releases/download/v0.1.0/XiaoShuoAgent-0.1.0-x64.dmg) |

[完整发布页](https://github.com/bigccc/XiaoShuoAgent/releases/tag/v0.1.0) 同时提供 ZIP 备用包和 `SHA256SUMS.txt`。DMG 和 ZIP 安装的是相同应用，只需选择一种。

## 安装和首次打开

1. 下载对应 DMG，双击打开，把 `XiaoShuoAgent.app` 拖入 `Applications`。
2. 推出磁盘镜像，在「应用程序」中打开小说工坊。
3. 本预览版尚无 Developer ID 签名或 Apple 公证。如果系统提示无法验证开发者，在确认下载来自本项目且文件完整后，先尝试打开应用，再到「系统设置 → 隐私与安全性」选择「仍要打开」，按提示确认。操作依据 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。受管理的电脑可能由管理员限制这项操作。

保存或使用 API 密钥时，macOS 可能要求允许小说工坊访问钥匙串。请在系统对话框中自行确认，需要密码时仅在系统对话框输入自己的 Mac 登录密码。临时签名在更新后可能再次触发授权，详见 [Electron safeStorage 说明](https://www.electronjs.org/docs/latest/api/safe-storage)。离线编辑不主动访问钥匙串。

若显示文件损坏，请重新下载并核对 SHA-256；仍有问题时，在 [Issues](https://github.com/bigccc/XiaoShuoAgent/issues) 附上 macOS 版本、芯片类型、包名和提示截图。

可以使用 `shasum -a 256 下载文件路径` 计算下载包的 SHA-256，与发布页 `SHA256SUMS.txt` 中同名文件那一行对照。

## 开始使用

1. 在空书架中新建作品，进入「创作」，填写自己的想法或让助手提供灵感。
2. 在「设置 → AI 连接」选择服务商，填写自己的 API 密钥。DeepSeek 预设自动填写地址和模型；其他兼容服务在高级设置填写。
3. 按「定故事 → 做准备 → 开始写」推进。阅读与改稿在「看稿」，人物、世界和大纲在「故事资料」。

模型连接未配置时，本机编辑、版本、导出与备份仍可使用。AI 请求需要网络和使用者自己的模型账户，费用由对应服务商收取；作品保存在本机，但参与 AI 请求的正文与资料会发往所配置的模型接口。

## 更新和备份

更新前在「导出 → 完整作品包」保存 `.novel` 备份，退出应用，再用新版本覆盖 Applications 中的应用。不要直接复制正在运行的 `works.sqlite` 主文件。应用数据目录通常为 `~/Library/Application Support/小说工坊`；覆盖应用本身不会主动清空作品。模型密钥不进入作品包，换机后需要重新配置。

## 验证范围

本发布提供 Apple Silicon 和 Intel 两种包。Apple Silicon 使用本机安装副本验证；Intel 使用 Apple Silicon 上的 Rosetta 运行 x64 安装副本验证，尚未在原生 Intel Mac 上验收。签名和公证尚未完成；历史真实模型验证、当前安装回归和已知限制分别记录在 [验证文档](verification.md)。
